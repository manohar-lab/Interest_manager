/**
 * Interest Manager — Step 6H: Interest History Service
 *
 * Provides a reliable, read-only historical view of interest records and their
 * settlement/payment allocation state without modifying the underlying financial records.
 *
 * Conceptual Pipeline:
 *   Person
 *      ↓
 *   Loan / Account
 *      ↓
 *   Interest Records (Snapshots from Step 6F)
 *      ↓
 *   Payment Allocations (Settlement from Step 6G)
 *      ↓
 *   Structured Interest History DTO
 *
 * Guarantees:
 *   - Read-Only Guarantee: Zero database writes, zero modifications to accounts, records, or payments.
 *   - Historical Snapshot Fidelity: Always displays the original recorded values (rate, principal basis, amount)
 *     stored on the record, never recalculating historical records from current loan settings.
 *   - Settlement Exposure: Displays recorded, paid, and outstanding amounts using Step 6G logic.
 *     Outstanding is never negative.
 *   - Data Isolation: Strictly confines account-level queries to the target account, and person-level
 *     queries to accounts belonging to that person.
 *   - Deterministic Ordering: Chronological order by period_start ASC, id ASC by default.
 *   - Preserves Reversed Records: Includes REVERSED records with accurate status and outstanding = 0.
 *   - Filtering & Pagination: Supports filtering by status, date range, account, and person.
 */

const { queryOne, queryAll } = require('../db/helpers');
const {
    normalizeDate,
    calculateElapsedDays
} = require('./dateCalculationService');

/**
 * Normalizes an interest record database row into a clean public history item DTO.
 *
 * @param {Object} r - Database row from interest_records
 * @param {Array} [allocations=[]] - Associated payment allocations
 * @returns {Object} Public history item DTO
 */
function formatHistoryItem(r, allocations = []) {
    const recordedPaisa = Number(r.interest_amount);
    const paidPaisa = Number(r.paid_amount || 0);
    const isReversed = r.status === 'REVERSED';
    const outstandingPaisa = isReversed ? 0 : Math.max(0, recordedPaisa - paidPaisa);

    let days = 0;
    try {
        days = calculateElapsedDays(r.period_start, r.period_end).elapsedDays;
    } catch (_) {
        days = 0;
    }

    return {
        id: Number(r.id),
        interest_record_id: Number(r.id),
        account_id: Number(r.account_id),
        loan_id: Number(r.account_id),
        person_id: r.person_id ? Number(r.person_id) : undefined,
        person_name: r.person_name || null,
        period_start: r.period_start,
        period_end: r.period_end,
        principal: Number(r.principal_basis) / 100,
        principal_basis: Number(r.principal_basis) / 100,
        principal_basis_paisa: Number(r.principal_basis),
        rate: Number(r.interest_rate),
        interest_rate: Number(r.interest_rate),
        calculation_method: r.calculation_method,
        days: days,
        number_of_days: days,
        interest_amount: recordedPaisa / 100,
        interest_amount_paisa: recordedPaisa,
        recorded_interest: recordedPaisa / 100,
        paid_amount: paidPaisa / 100,
        paid_amount_paisa: paidPaisa,
        paid_interest: paidPaisa / 100,
        outstanding_amount: outstandingPaisa / 100,
        outstanding_amount_paisa: outstandingPaisa,
        outstanding_interest: outstandingPaisa / 100,
        status: r.status,
        source: r.source || 'MANUAL',
        scheduler_run_id: r.scheduler_run_id || null,
        reversal_reason: r.reversal_reason || null,
        reversed_at: r.reversed_at || null,
        corrects_record_id: r.corrects_record_id || null,
        corrected_by_record_id: r.corrected_by_record_id || null,
        created_at: r.created_at,
        allocations: allocations
    };
}

/**
 * Fetches allocations for a list of interest record IDs.
 *
 * @param {Object} db - Database connection
 * @param {Array<number>} recordIds - List of record IDs
 * @returns {Map<number, Array>} Map of recordId -> allocations
 */
function fetchAllocationsForRecords(db, recordIds) {
    const map = new Map();
    if (!recordIds || recordIds.length === 0) return map;

    const placeholders = recordIds.map(() => '?').join(', ');
    const rows = queryAll(db, `
        SELECT a.id, a.account_id, a.interest_record_id, a.transaction_id, a.amount as amount_paisa,
               a.allocated_at, t.payment_id, t.payment_method, t.transaction_date, t.reference, t.notes
        FROM interest_allocations a
        LEFT JOIN transactions t ON a.transaction_id = t.id
        WHERE a.interest_record_id IN (${placeholders})
        ORDER BY a.allocated_at ASC, a.id ASC
    `, recordIds);

    for (const row of rows) {
        const recId = Number(row.interest_record_id);
        if (!map.has(recId)) {
            map.set(recId, []);
        }
        map.get(recId).push({
            id: Number(row.id),
            transaction_id: Number(row.transaction_id),
            payment_id: row.payment_id || null,
            allocated_amount: Number(row.amount_paisa) / 100,
            allocated_amount_paisa: Number(row.amount_paisa),
            payment_method: row.payment_method || null,
            payment_date: row.transaction_date || null,
            reference: row.reference || null,
            notes: row.notes || null,
            allocated_at: row.allocated_at
        });
    }

    return map;
}

/**
 * Retrieves interest history for a specific loan/account.
 * Enforces strict account isolation.
 *
 * @param {Object} db - Database connection
 * @param {number|string} accountId - Account ID
 * @param {Object} [options] - Options & filters:
 *   - status: 'PENDING' | 'PARTIALLY_PAID' | 'PAID' | 'REVERSED'
 *   - from / startDate: Filter period_start >= from
 *   - to / endDate: Filter period_end <= to
 *   - order: 'ASC' (default) or 'DESC'
 *   - limit: Maximum items to return
 *   - offset: Items to skip
 * @returns {Object} Structured history descriptor: { items, total, summary, account }
 */
function getAccountInterestHistory(db, accountId, options = {}) {
    if (!db) {
        const err = new Error('Database connection is required');
        err.statusCode = 500;
        throw err;
    }

    const accId = Number(accountId);
    if (!accId || isNaN(accId) || accId <= 0) {
        const err = new Error('A valid account_id is required');
        err.statusCode = 400;
        throw err;
    }

    const account = queryOne(db, `
        SELECT a.*, p.name as person_name
        FROM accounts a
        LEFT JOIN people p ON a.person_id = p.id
        WHERE a.id = ?
    `, [accId]);

    if (!account) {
        const err = new Error(`Account #${accId} not found`);
        err.statusCode = 404;
        throw err;
    }

    // Build query with filters
    const conditions = ['r.account_id = ?'];
    const params = [accId];

    if (options.status) {
        conditions.push('r.status = ?');
        params.push(String(options.status).trim().toUpperCase());
    }

    const fromDate = options.from || options.startDate;
    if (fromDate) {
        const fromIso = normalizeDate(fromDate);
        if (fromIso) {
            conditions.push('r.period_start >= ?');
            params.push(fromIso);
        }
    }

    const toDate = options.to || options.endDate;
    if (toDate) {
        const toIso = normalizeDate(toDate);
        if (toIso) {
            conditions.push('r.period_end <= ?');
            params.push(toIso);
        }
    }

    const orderDir = String(options.order || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    const whereClause = conditions.join(' AND ');

    // Total count query
    const countRow = queryOne(db, `
        SELECT COUNT(*) as total_count,
               COALESCE(SUM(CASE WHEN r.status != 'REVERSED' THEN r.interest_amount ELSE 0 END), 0) as total_recorded,
               COALESCE(SUM(CASE WHEN r.status != 'REVERSED' THEN r.paid_amount ELSE 0 END), 0) as total_paid
        FROM interest_records r
        WHERE ${whereClause}
    `, params);

    const totalRecords = countRow ? countRow.total_count : 0;
    const totalRecordedPaisa = countRow ? countRow.total_recorded : 0;
    const totalPaidPaisa = countRow ? countRow.total_paid : 0;
    const totalOutstandingPaisa = Math.max(0, totalRecordedPaisa - totalPaidPaisa);

    // Fetch items query
    let querySql = `
        SELECT r.*, a.person_id, p.name as person_name
        FROM interest_records r
        JOIN accounts a ON r.account_id = a.id
        LEFT JOIN people p ON a.person_id = p.id
        WHERE ${whereClause}
        ORDER BY r.period_start ${orderDir}, r.id ${orderDir}
    `;

    const queryParams = [...params];

    if (options.limit !== undefined && !isNaN(Number(options.limit))) {
        querySql += ' LIMIT ?';
        queryParams.push(Number(options.limit));
        if (options.offset !== undefined && !isNaN(Number(options.offset))) {
            querySql += ' OFFSET ?';
            queryParams.push(Number(options.offset));
        }
    }

    const rows = queryAll(db, querySql, queryParams);
    const recordIds = rows.map(r => r.id);
    const allocMap = fetchAllocationsForRecords(db, recordIds);

    const items = rows.map(r => formatHistoryItem(r, allocMap.get(r.id) || []));

    return {
        account_id: accId,
        loan_id: accId,
        account: {
            id: accId,
            person_id: account.person_id,
            person_name: account.person_name,
            principal: account.principal / 100,
            outstanding_principal: account.outstanding_principal / 100,
            interest_rate: account.interest_rate,
            direction: account.direction,
            status: account.status
        },
        items: items,
        total: totalRecords,
        count: items.length,
        summary: {
            total_records: totalRecords,
            total_recorded: totalRecordedPaisa / 100,
            total_recorded_paisa: totalRecordedPaisa,
            total_paid: totalPaidPaisa / 100,
            total_paid_paisa: totalPaidPaisa,
            total_outstanding: totalOutstandingPaisa / 100,
            total_outstanding_paisa: totalOutstandingPaisa
        }
    };
}

/**
 * Retrieves interest history across all loans/accounts belonging to a specific person.
 * Enforces strict person-level isolation.
 *
 * @param {Object} db - Database connection
 * @param {number|string} personId - Person ID
 * @param {Object} [options] - Filters & options (status, from, to, order, limit, offset)
 * @returns {Object} Structured history descriptor: { items, total, summary, person }
 */
function getPersonInterestHistory(db, personId, options = {}) {
    if (!db) {
        const err = new Error('Database connection is required');
        err.statusCode = 500;
        throw err;
    }

    const pId = Number(personId);
    if (!pId || isNaN(pId) || pId <= 0) {
        const err = new Error('A valid person_id is required');
        err.statusCode = 400;
        throw err;
    }

    const person = queryOne(db, 'SELECT * FROM people WHERE id = ?', [pId]);
    if (!person) {
        const err = new Error(`Person #${pId} not found`);
        err.statusCode = 404;
        throw err;
    }

    const conditions = ['a.person_id = ?'];
    const params = [pId];

    if (options.status) {
        conditions.push('r.status = ?');
        params.push(String(options.status).trim().toUpperCase());
    }

    const fromDate = options.from || options.startDate;
    if (fromDate) {
        const fromIso = normalizeDate(fromDate);
        if (fromIso) {
            conditions.push('r.period_start >= ?');
            params.push(fromIso);
        }
    }

    const toDate = options.to || options.endDate;
    if (toDate) {
        const toIso = normalizeDate(toDate);
        if (toIso) {
            conditions.push('r.period_end <= ?');
            params.push(toIso);
        }
    }

    const orderDir = String(options.order || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    const whereClause = conditions.join(' AND ');

    // Summary counts
    const countRow = queryOne(db, `
        SELECT COUNT(*) as total_count,
               COALESCE(SUM(CASE WHEN r.status != 'REVERSED' THEN r.interest_amount ELSE 0 END), 0) as total_recorded,
               COALESCE(SUM(CASE WHEN r.status != 'REVERSED' THEN r.paid_amount ELSE 0 END), 0) as total_paid
        FROM interest_records r
        JOIN accounts a ON r.account_id = a.id
        WHERE ${whereClause}
    `, params);

    const totalRecords = countRow ? countRow.total_count : 0;
    const totalRecordedPaisa = countRow ? countRow.total_recorded : 0;
    const totalPaidPaisa = countRow ? countRow.total_paid : 0;
    const totalOutstandingPaisa = Math.max(0, totalRecordedPaisa - totalPaidPaisa);

    let querySql = `
        SELECT r.*, a.person_id, p.name as person_name
        FROM interest_records r
        JOIN accounts a ON r.account_id = a.id
        JOIN people p ON a.person_id = p.id
        WHERE ${whereClause}
        ORDER BY r.period_start ${orderDir}, r.id ${orderDir}
    `;

    const queryParams = [...params];

    if (options.limit !== undefined && !isNaN(Number(options.limit))) {
        querySql += ' LIMIT ?';
        queryParams.push(Number(options.limit));
        if (options.offset !== undefined && !isNaN(Number(options.offset))) {
            querySql += ' OFFSET ?';
            queryParams.push(Number(options.offset));
        }
    }

    const rows = queryAll(db, querySql, queryParams);
    const recordIds = rows.map(r => r.id);
    const allocMap = fetchAllocationsForRecords(db, recordIds);

    const items = rows.map(r => formatHistoryItem(r, allocMap.get(r.id) || []));

    return {
        person_id: pId,
        person: {
            id: person.id,
            name: person.name,
            phone: person.phone
        },
        items: items,
        total: totalRecords,
        count: items.length,
        summary: {
            total_records: totalRecords,
            total_recorded: totalRecordedPaisa / 100,
            total_recorded_paisa: totalRecordedPaisa,
            total_paid: totalPaidPaisa / 100,
            total_paid_paisa: totalPaidPaisa,
            total_outstanding: totalOutstandingPaisa / 100,
            total_outstanding_paisa: totalOutstandingPaisa
        }
    };
}

/**
 * General interest history query with multi-attribute filtering.
 *
 * @param {Object} db - Database connection
 * @param {Object} [filters] - Filters { account_id, person_id, status, from, to }
 * @param {Object} [options] - Options { order, limit, offset }
 * @returns {Object} { items, total, summary }
 */
function getInterestHistory(db, filters = {}, options = {}) {
    if (!db) {
        const err = new Error('Database connection is required');
        err.statusCode = 500;
        throw err;
    }

    if (filters.account_id || filters.accountId) {
        return getAccountInterestHistory(db, filters.account_id || filters.accountId, { ...filters, ...options });
    }

    if (filters.person_id || filters.personId) {
        return getPersonInterestHistory(db, filters.person_id || filters.personId, { ...filters, ...options });
    }

    const conditions = [];
    const params = [];

    if (filters.status) {
        conditions.push('r.status = ?');
        params.push(String(filters.status).trim().toUpperCase());
    }

    const fromDate = filters.from || filters.startDate;
    if (fromDate) {
        const fromIso = normalizeDate(fromDate);
        if (fromIso) {
            conditions.push('r.period_start >= ?');
            params.push(fromIso);
        }
    }

    const toDate = filters.to || filters.endDate;
    if (toDate) {
        const toIso = normalizeDate(toDate);
        if (toIso) {
            conditions.push('r.period_end <= ?');
            params.push(toIso);
        }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderDir = String(options.order || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    const countRow = queryOne(db, `
        SELECT COUNT(*) as total_count,
               COALESCE(SUM(CASE WHEN r.status != 'REVERSED' THEN r.interest_amount ELSE 0 END), 0) as total_recorded,
               COALESCE(SUM(CASE WHEN r.status != 'REVERSED' THEN r.paid_amount ELSE 0 END), 0) as total_paid
        FROM interest_records r
        ${whereClause}
    `, params);

    const totalRecords = countRow ? countRow.total_count : 0;
    const totalRecordedPaisa = countRow ? countRow.total_recorded : 0;
    const totalPaidPaisa = countRow ? countRow.total_paid : 0;
    const totalOutstandingPaisa = Math.max(0, totalRecordedPaisa - totalPaidPaisa);

    let querySql = `
        SELECT r.*, a.person_id, p.name as person_name
        FROM interest_records r
        JOIN accounts a ON r.account_id = a.id
        LEFT JOIN people p ON a.person_id = p.id
        ${whereClause}
        ORDER BY r.period_start ${orderDir}, r.id ${orderDir}
    `;

    const queryParams = [...params];
    if (options.limit !== undefined && !isNaN(Number(options.limit))) {
        querySql += ' LIMIT ?';
        queryParams.push(Number(options.limit));
        if (options.offset !== undefined && !isNaN(Number(options.offset))) {
            querySql += ' OFFSET ?';
            queryParams.push(Number(options.offset));
        }
    }

    const rows = queryAll(db, querySql, queryParams);
    const recordIds = rows.map(r => r.id);
    const allocMap = fetchAllocationsForRecords(db, recordIds);

    const items = rows.map(r => formatHistoryItem(r, allocMap.get(r.id) || []));

    return {
        items: items,
        total: totalRecords,
        count: items.length,
        summary: {
            total_records: totalRecords,
            total_recorded: totalRecordedPaisa / 100,
            total_recorded_paisa: totalRecordedPaisa,
            total_paid: totalPaidPaisa / 100,
            total_paid_paisa: totalPaidPaisa,
            total_outstanding: totalOutstandingPaisa / 100,
            total_outstanding_paisa: totalOutstandingPaisa
        }
    };
}

/**
 * Retrieves detailed historical information for a single interest record.
 *
 * @param {Object} db - Database connection
 * @param {number|string} recordId - Interest record ID
 * @returns {Object} Structured detail DTO
 */
function getInterestRecordDetails(db, recordId) {
    if (!db) {
        const err = new Error('Database connection is required');
        err.statusCode = 500;
        throw err;
    }

    const recId = Number(recordId);
    if (!recId || isNaN(recId) || recId <= 0) {
        const err = new Error('A valid record ID is required');
        err.statusCode = 400;
        throw err;
    }

    const row = queryOne(db, `
        SELECT r.*, a.person_id, p.name as person_name, a.direction, a.status as account_status
        FROM interest_records r
        JOIN accounts a ON r.account_id = a.id
        LEFT JOIN people p ON a.person_id = p.id
        WHERE r.id = ?
    `, [recId]);

    if (!row) {
        const err = new Error(`Interest record #${recId} not found`);
        err.statusCode = 404;
        throw err;
    }

    const allocMap = fetchAllocationsForRecords(db, [recId]);
    return formatHistoryItem(row, allocMap.get(recId) || []);
}

module.exports = {
    formatHistoryItem,
    fetchAllocationsForRecords,
    getAccountInterestHistory,
    getPersonInterestHistory,
    getInterestHistory,
    getInterestRecordDetails
};
