/**
 * Interest Manager — Part 8: Due / Overdue Tracking Service
 *
 * Dedicated domain service responsible for:
 *   - 8A: Business Rules evaluation (DUE, CURRENT, PAID, OVERDUE, PARTIALLY_PAID)
 *   - 8B: Obligation model handling & status classifications
 *   - 8C: Due amount calculation using authoritative principal & Part 6 interest
 *   - 8D: Overdue detection engine with deterministic clock abstraction
 *   - 8E: Grace period & explicit status transition logic
 *   - 8F: Due/overdue query services & summary DTOs
 *   - 8G: Collection attention list with deterministic ordering
 *   - 8H: Dashboard integration source of truth
 *
 * Guarantees:
 *   - READ-ONLY: Pure read operations perform zero database mutations.
 *   - NO DUPLICATE ENGINES: Reuses accounts.outstanding_principal and Part 6 interest_records.
 *   - EXACT MONEY: All internal arithmetic uses integer paisa; 2-decimal rupee representations provided.
 *   - DETERMINISTIC: Clock abstraction (as_of_date) enables reproducible evaluation without depending on system clock.
 *   - AUTHORIZATION: Customer-level scoping via person_id and loan_id.
 */

const { queryOne, queryAll } = require('../db/helpers');

/**
 * Normalizes and resolves reference as_of_date string (YYYY-MM-DD).
 */
function resolveAsOfDate(options = {}) {
    return options.as_of_date ||
           options.asOfDate ||
           options.current_date ||
           options.currentDate ||
           options.date ||
           new Date().toISOString().slice(0, 10);
}

/**
 * Validates scoping options and verifies person/account existence.
 */
function validateScoping(db, options = {}) {
    const personId = options.person_id || options.personId;
    const hasPersonFilter = personId !== undefined && personId !== null;
    const pId = hasPersonFilter ? Number(personId) : null;

    if (hasPersonFilter && (isNaN(pId) || pId <= 0)) {
        const err = new Error('A valid person_id is required');
        err.statusCode = 400;
        throw err;
    }

    if (hasPersonFilter) {
        const person = queryOne(db, 'SELECT id FROM people WHERE id = ?', [pId]);
        if (!person) {
            const err = new Error(`Person #${pId} not found`);
            err.statusCode = 404;
            throw err;
        }
    }

    const accountId = options.account_id || options.accountId || options.loan_id || options.loanId;
    const hasAccountFilter = accountId !== undefined && accountId !== null;
    const aId = hasAccountFilter ? Number(accountId) : null;

    if (hasAccountFilter && (isNaN(aId) || aId <= 0)) {
        const err = new Error('A valid account_id is required');
        err.statusCode = 400;
        throw err;
    }

    if (hasAccountFilter) {
        const account = queryOne(db, 'SELECT id, person_id FROM accounts WHERE id = ?', [aId]);
        if (!account) {
            const err = new Error(`Account #${aId} not found`);
            err.statusCode = 404;
            throw err;
        }
        if (hasPersonFilter && account.person_id !== pId) {
            const err = new Error(`Account #${aId} does not belong to Person #${pId}`);
            err.statusCode = 403;
            throw err;
        }
    }

    return { pId, aId, hasPersonFilter, hasAccountFilter };
}

/**
 * Core evaluation engine (8A, 8D, 8E).
 * Evaluates the status, due amounts, and overdue status of a single loan record.
 *
 * @param {Object} account - Raw or enriched account record
 * @param {string} asOfDate - ISO Date string YYYY-MM-DD
 * @param {Object} [options={}] - Evaluation options (grace_period override)
 * @returns {Object} Evaluated obligation object
 */
function evaluateObligation(account, asOfDate, options = {}) {
    const originalPrincipalPaisa = Number(account.original_principal_paisa || account.principal || 0);
    const outstandingPrincipalPaisa = Math.max(0, Number(account.outstanding_principal_paisa !== undefined ? account.outstanding_principal_paisa : (account.outstanding_principal || 0)));
    const outstandingInterestPaisa = Math.max(0, Number(account.outstanding_interest_paisa !== undefined ? account.outstanding_interest_paisa : (account.outstanding_interest || 0)));
    const totalPaidPaisa = Math.max(0, Number(account.total_paid_paisa !== undefined ? account.total_paid_paisa : (account.total_paid || 0)));

    const totalOutstandingPaisa = outstandingPrincipalPaisa + outstandingInterestPaisa;
    const dueDate = account.due_date;
    const hasDueDate = Boolean(dueDate);

    // Grace period resolution: account level or options override
    let gracePeriodDays = 0;
    if (options.grace_period !== undefined && options.grace_period !== null) {
        gracePeriodDays = Math.max(0, parseInt(options.grace_period, 10) || 0);
    } else if (account.grace_period !== undefined && account.grace_period !== null) {
        gracePeriodDays = Math.max(0, parseInt(account.grace_period, 10) || 0);
    }

    // Compute grace period boundary
    let dueDateMs = NaN;
    let graceEndMs = NaN;
    let graceEndDate = dueDate;
    let asOfMs = NaN;

    if (hasDueDate) {
        dueDateMs = Date.parse(dueDate + 'T00:00:00Z');
        if (!isNaN(dueDateMs)) {
            graceEndMs = dueDateMs + (gracePeriodDays * 24 * 60 * 60 * 1000);
            graceEndDate = new Date(graceEndMs).toISOString().slice(0, 10);
        }
    }
    if (asOfDate) {
        asOfMs = Date.parse(asOfDate + 'T00:00:00Z');
    }

    const currentStatus = (account.loan_status || account.status || 'ACTIVE').toUpperCase();

    // ─── 1. Closed or Written-Off Obligations ─────────────────
    if (currentStatus === 'CLOSED' || currentStatus === 'WRITTEN_OFF') {
        return {
            loan_id: account.loan_id || account.id,
            account_id: account.loan_id || account.id,
            person_id: account.person_id,
            person_name: account.person_name,
            due_date: dueDate,
            grace_period: gracePeriodDays,
            grace_end_date: graceEndDate,
            status: currentStatus,
            persisted_status: currentStatus,

            is_closed: true,
            is_paid: totalOutstandingPaisa <= 0,
            is_current: false,
            is_partially_paid: false,
            is_due: false,
            is_overdue: false,

            days_overdue: 0,
            overdue_since: null,

            original_principal_paisa: originalPrincipalPaisa,
            outstanding_principal_paisa: outstandingPrincipalPaisa,
            outstanding_interest_paisa: outstandingInterestPaisa,
            total_outstanding_paisa: totalOutstandingPaisa,
            total_paid_paisa: totalPaidPaisa,

            amount_due_paisa: 0,
            amount_overdue_paisa: 0,

            original_principal: Number((originalPrincipalPaisa / 100).toFixed(2)),
            outstanding_principal: Number((outstandingPrincipalPaisa / 100).toFixed(2)),
            outstanding_interest: Number((outstandingInterestPaisa / 100).toFixed(2)),
            outstanding_amount: Number((totalOutstandingPaisa / 100).toFixed(2)),
            paid_amount: Number((totalPaidPaisa / 100).toFixed(2)),
            amount_due: 0,
            amount_overdue: 0,
            direction: account.direction,
            start_date: account.start_date,
            interest_rate: account.interest_rate,
            interest_frequency: account.interest_frequency,
            calculation_method: account.calculation_method
        };
    }

    // ─── 2. Fully Satisfied Obligations (8A.3, 8I.4) ──────────
    // A fully paid obligation is NEVER overdue, regardless of historical due date
    if (totalOutstandingPaisa <= 0) {
        return {
            loan_id: account.loan_id || account.id,
            account_id: account.loan_id || account.id,
            person_id: account.person_id,
            person_name: account.person_name,
            due_date: dueDate,
            grace_period: gracePeriodDays,
            grace_end_date: graceEndDate,
            status: 'PAID',
            persisted_status: currentStatus,

            is_closed: false,
            is_paid: true,
            is_current: false,
            is_partially_paid: false,
            is_due: false,
            is_overdue: false,

            days_overdue: 0,
            overdue_since: null,

            original_principal_paisa: originalPrincipalPaisa,
            outstanding_principal_paisa: 0,
            outstanding_interest_paisa: 0,
            total_outstanding_paisa: 0,
            total_paid_paisa: totalPaidPaisa,

            amount_due_paisa: 0,
            amount_overdue_paisa: 0,

            original_principal: Number((originalPrincipalPaisa / 100).toFixed(2)),
            outstanding_principal: 0,
            outstanding_interest: 0,
            outstanding_amount: 0,
            paid_amount: Number((totalPaidPaisa / 100).toFixed(2)),
            amount_due: 0,
            amount_overdue: 0,
            direction: account.direction,
            start_date: account.start_date,
            interest_rate: account.interest_rate,
            interest_frequency: account.interest_frequency,
            calculation_method: account.calculation_method
        };
    }

    // ─── 3. Active Obligations with Remaining Balance ─────────
    let status = 'CURRENT';
    let isCurrent = false;
    let isPartiallyPaid = false;
    let isDue = false;
    let isOverdue = false;
    let daysOverdue = 0;
    let overdueSince = null;

    if (!hasDueDate) {
        // No due date defined -> defaults to CURRENT
        status = totalPaidPaisa > 0 ? 'PARTIALLY_PAID' : 'CURRENT';
        isCurrent = status === 'CURRENT';
        isPartiallyPaid = status === 'PARTIALLY_PAID';
    } else if (asOfDate < dueDate) {
        // Future due date (8A.2, 8I.1, 8I.5)
        if (totalPaidPaisa > 0) {
            status = 'PARTIALLY_PAID';
            isPartiallyPaid = true;
        } else {
            status = 'CURRENT';
            isCurrent = true;
        }
    } else if (asOfDate <= graceEndDate) {
        // Due date reached, within grace period (8A.1, 8I.2, 8I.6)
        status = 'DUE';
        isDue = true;
    } else {
        // Grace period expired, obligation is OVERDUE (8A.4, 8I.3, 8I.5, 8I.6)
        status = 'OVERDUE';
        isOverdue = true;
        overdueSince = graceEndDate;
        if (!isNaN(dueDateMs) && !isNaN(asOfMs)) {
            daysOverdue = Math.max(1, Math.floor((asOfMs - dueDateMs) / (24 * 60 * 60 * 1000)));
        }
    }

    // Amount classifications
    const amountDuePaisa = isDue ? totalOutstandingPaisa : 0;
    const amountOverduePaisa = isOverdue ? totalOutstandingPaisa : 0;

    return {
        loan_id: account.loan_id || account.id,
        account_id: account.loan_id || account.id,
        person_id: account.person_id,
        person_name: account.person_name,
        due_date: dueDate,
        grace_period: gracePeriodDays,
        grace_end_date: graceEndDate,
        status: status,
        persisted_status: currentStatus,

        is_closed: false,
        is_paid: false,
        is_current: isCurrent,
        is_partially_paid: isPartiallyPaid,
        is_due: isDue,
        is_overdue: isOverdue,

        days_overdue: daysOverdue,
        overdue_since: overdueSince,

        original_principal_paisa: originalPrincipalPaisa,
        outstanding_principal_paisa: outstandingPrincipalPaisa,
        outstanding_interest_paisa: outstandingInterestPaisa,
        total_outstanding_paisa: totalOutstandingPaisa,
        total_paid_paisa: totalPaidPaisa,

        amount_due_paisa: amountDuePaisa,
        amount_overdue_paisa: amountOverduePaisa,

        original_principal: Number((originalPrincipalPaisa / 100).toFixed(2)),
        outstanding_principal: Number((outstandingPrincipalPaisa / 100).toFixed(2)),
        outstanding_interest: Number((outstandingInterestPaisa / 100).toFixed(2)),
        outstanding_amount: Number((totalOutstandingPaisa / 100).toFixed(2)),
        paid_amount: Number((totalPaidPaisa / 100).toFixed(2)),
        amount_due: Number((amountDuePaisa / 100).toFixed(2)),
        amount_overdue: Number((amountOverduePaisa / 100).toFixed(2)),
        direction: account.direction,
        start_date: account.start_date,
        interest_rate: account.interest_rate,
        interest_frequency: account.interest_frequency,
        calculation_method: account.calculation_method
    };
}

/**
 * Queries accounts with authoritative principal, Part 5 payments, and Part 6 interest.
 */
function fetchAccountsWithFinancials(db, options = {}) {
    const { pId, aId, hasPersonFilter, hasAccountFilter } = validateScoping(db, options);

    const conditions = [];
    const params = [];

    if (hasPersonFilter) {
        conditions.push('a.person_id = ?');
        params.push(pId);
    }

    if (hasAccountFilter) {
        conditions.push('a.id = ?');
        params.push(aId);
    }

    // Optional status filter
    const statusFilter = options.status || options.loan_status;
    if (statusFilter) {
        conditions.push('a.status = ?');
        params.push(statusFilter.toUpperCase());
    }

    // Optional direction filter
    if (options.direction) {
        conditions.push('a.direction = ?');
        params.push(options.direction);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Check if grace_period column exists in accounts table
    const tableCols = queryAll(db, 'PRAGMA table_info(accounts)');
    const hasGracePeriodCol = tableCols.some(c => c.name === 'grace_period');
    const selectGrace = hasGracePeriodCol ? 'COALESCE(a.grace_period, 0) as grace_period,' : '0 as grace_period,';

    const sql = `
        SELECT
            a.id as loan_id,
            a.person_id,
            p.name as person_name,
            p.phone as person_phone,
            a.direction,
            a.principal as original_principal_paisa,
            a.outstanding_principal as outstanding_principal_paisa,
            a.interest_rate,
            a.interest_frequency,
            a.calculation_method,
            a.start_date,
            a.due_date,
            ${selectGrace}
            a.status as loan_status,
            COALESCE(tx.total_paid_paisa, 0) as total_paid_paisa,
            COALESCE(ir.outstanding_interest_paisa, 0) as outstanding_interest_paisa,
            COALESCE(ir.total_interest_paisa, 0) as total_interest_paisa,
            COALESCE(ir.paid_interest_paisa, 0) as paid_interest_paisa
        FROM accounts a
        JOIN people p ON a.person_id = p.id
        LEFT JOIN (
            SELECT
                account_id,
                COALESCE(SUM(amount), 0) as total_paid_paisa
            FROM transactions
            WHERE transaction_type IN ('PRINCIPAL_RECEIVED', 'INTEREST_RECEIVED')
            GROUP BY account_id
        ) tx ON tx.account_id = a.id
        LEFT JOIN (
            SELECT
                account_id,
                COALESCE(SUM(interest_amount), 0) as total_interest_paisa,
                COALESCE(SUM(paid_amount), 0) as paid_interest_paisa,
                COALESCE(SUM(interest_amount), 0) - COALESCE(SUM(paid_amount), 0) as outstanding_interest_paisa
            FROM interest_records
            WHERE status != 'REVERSED'
            GROUP BY account_id
        ) ir ON ir.account_id = a.id
        ${whereClause}
        ORDER BY a.due_date ASC, a.id ASC
    `;

    const rows = queryAll(db, sql, params);
    const asOfDate = resolveAsOfDate(options);

    return rows.map(row => evaluateObligation(row, asOfDate, options));
}

/**
 * Retrieves the comprehensive Due / Overdue KPI Summary (8F.1).
 *
 * @param {Object} db - Database connection
 * @param {Object} [options={}] - Scoping and evaluation options
 * @returns {Object} DueOverdueSummary DTO
 */
function getDueOverdueSummary(db, options = {}) {
    const evaluated = fetchAccountsWithFinancials(db, options);
    const asOfDate = resolveAsOfDate(options);

    let currentCount = 0;
    let dueCount = 0;
    let overdueCount = 0;
    let paidCount = 0;
    let closedCount = 0;

    let dueAmountPaisa = 0;
    let overdueAmountPaisa = 0;

    for (const item of evaluated) {
        if (item.is_closed) {
            closedCount++;
        } else if (item.is_paid) {
            paidCount++;
        } else if (item.is_due) {
            dueCount++;
            dueAmountPaisa += item.amount_due_paisa;
        } else if (item.is_overdue) {
            overdueCount++;
            overdueAmountPaisa += item.amount_overdue_paisa;
        } else if (item.is_current || item.is_partially_paid) {
            currentCount++;
        }
    }

    const collectionAmountPaisa = dueAmountPaisa + overdueAmountPaisa;

    return {
        current_count: currentCount,
        due_count: dueCount,
        due_loan_count: dueCount,
        overdue_count: overdueCount,
        overdue_loan_count: overdueCount,
        paid_count: paidCount,
        closed_count: closedCount,
        total_count: evaluated.length,

        due_amount: Number((dueAmountPaisa / 100).toFixed(2)),
        due_amount_paisa: dueAmountPaisa,

        overdue_amount: Number((overdueAmountPaisa / 100).toFixed(2)),
        overdue_amount_paisa: overdueAmountPaisa,

        collection_amount: Number((collectionAmountPaisa / 100).toFixed(2)),
        collection_amount_paisa: collectionAmountPaisa,

        as_of_date: asOfDate,
        ...(options.person_id ? { person_id: Number(options.person_id) } : {})
    };
}

/**
 * Retrieves list of loans currently due (8F.2).
 *
 * @param {Object} db - Database connection
 * @param {Object} [options={}] - Scoping & pagination options
 * @returns {Array<Object>} List of DueItem DTOs
 */
function getDueLoans(db, options = {}) {
    const evaluated = fetchAccountsWithFinancials(db, options);
    let dueItems = evaluated.filter(item => item.is_due);

    // Apply limit if specified
    if (options.limit) {
        const limit = Math.max(1, parseInt(options.limit, 10) || 50);
        dueItems = dueItems.slice(0, limit);
    }

    return dueItems.map(item => ({
        loan_id: item.loan_id,
        account_id: item.loan_id,
        person_id: item.person_id,
        person_name: item.person_name,
        due_date: item.due_date,
        status: 'DUE',
        loan_status: item.persisted_status,
        required_amount: item.outstanding_amount,
        paid_amount: item.paid_amount,
        outstanding_amount: item.outstanding_amount,
        outstanding_amount_paisa: item.total_outstanding_paisa,
        outstanding_principal: item.outstanding_principal,
        outstanding_principal_paisa: item.outstanding_principal_paisa,
        outstanding_interest: item.outstanding_interest,
        outstanding_interest_paisa: item.outstanding_interest_paisa
    }));
}

/**
 * Retrieves list of loans currently overdue (8F.3).
 *
 * @param {Object} db - Database connection
 * @param {Object} [options={}] - Scoping & pagination options
 * @returns {Array<Object>} List of OverdueItem DTOs
 */
function getOverdueLoans(db, options = {}) {
    const evaluated = fetchAccountsWithFinancials(db, options);
    let overdueItems = evaluated.filter(item => item.is_overdue);

    // Default ordering: oldest due date first (most overdue first)
    overdueItems.sort((a, b) => {
        if (a.due_date !== b.due_date) {
            return a.due_date.localeCompare(b.due_date);
        }
        return a.loan_id - b.loan_id;
    });

    if (options.limit) {
        const limit = Math.max(1, parseInt(options.limit, 10) || 50);
        overdueItems = overdueItems.slice(0, limit);
    }

    return overdueItems.map(item => ({
        loan_id: item.loan_id,
        account_id: item.loan_id,
        person_id: item.person_id,
        person_name: item.person_name,
        due_date: item.due_date,
        overdue_since: item.overdue_since,
        days_overdue: item.days_overdue,
        overdue_amount: item.amount_overdue,
        overdue_amount_paisa: item.amount_overdue_paisa,
        outstanding_amount: item.outstanding_amount,
        outstanding_amount_paisa: item.total_outstanding_paisa,
        outstanding_principal: item.outstanding_principal,
        outstanding_interest: item.outstanding_interest,
        status: 'OVERDUE'
    }));
}

/**
 * Retrieves dedicated collection attention list (8G).
 *
 * Inclusion criteria:
 *   OVERDUE obligations with remaining positive balance (outstanding > 0).
 *   Ordered by oldest due date first (most overdue first), secondary loan_id ASC.
 *
 * @param {Object} db - Database connection
 * @param {Object} [options={}] - Scoping & pagination options
 * @returns {Array<Object>} List of CollectionItem DTOs
 */
function getCollectionItems(db, options = {}) {
    const evaluated = fetchAccountsWithFinancials(db, options);

    // Filter to collection targets: overdue with positive balance (or due if include_due specified)
    const targets = evaluated.filter(item => {
        if (options.include_due) {
            return (item.is_overdue || item.is_due) && item.total_outstanding_paisa > 0;
        }
        return item.is_overdue && item.total_outstanding_paisa > 0;
    });

    // Sort: Overdue items first (oldest due date first), then due items
    targets.sort((a, b) => {
        if (a.is_overdue && !b.is_overdue) return -1;
        if (!a.is_overdue && b.is_overdue) return 1;
        if (a.due_date !== b.due_date) {
            return a.due_date.localeCompare(b.due_date);
        }
        return a.loan_id - b.loan_id;
    });

    let result = targets;
    if (options.limit) {
        const limit = Math.max(1, parseInt(options.limit, 10) || 50);
        result = result.slice(0, limit);
    }

    return result.map(item => ({
        loan_id: item.loan_id,
        account_id: item.loan_id,
        person_id: item.person_id,
        person_name: item.person_name,
        due_date: item.due_date,
        overdue_since: item.overdue_since || item.due_date,
        days_overdue: item.days_overdue,
        is_due: item.is_due,
        is_overdue: item.is_overdue,
        outstanding_amount: item.outstanding_amount,
        outstanding_amount_paisa: item.total_outstanding_paisa,
        outstanding_principal: item.outstanding_principal,
        outstanding_principal_paisa: item.outstanding_principal_paisa,
        outstanding_interest: item.outstanding_interest,
        outstanding_interest_paisa: item.outstanding_interest_paisa,
        overdue_amount: item.amount_overdue,
        overdue_amount_paisa: item.amount_overdue_paisa,
        amount_overdue: item.amount_overdue,
        amount_overdue_paisa: item.amount_overdue_paisa,
        amount_due: item.amount_due,
        amount_due_paisa: item.amount_due_paisa,
        status: item.status
    }));
}

module.exports = {
    evaluateObligation,
    fetchAccountsWithFinancials,
    getDueOverdueSummary,
    getDueLoans,
    getOverdueLoans,
    getCollectionItems,
    resolveAsOfDate
};
