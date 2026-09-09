/**
 * Interest Manager — Step 7A: Dashboard Service
 *
 * READ-ONLY aggregation layer that provides dashboard KPI summaries
 * by consuming existing financial data from People, Accounts, Transactions,
 * and Interest Records.
 *
 * Conceptual Pipeline:
 *   People
 *      ↓
 *   Loans / Accounts
 *      ↓
 *   Transactions
 *      ↓
 *   Interest Records
 *      ↓
 *   Dashboard Aggregation (this service)
 *      ↓
 *   DashboardSummary DTO
 *
 * Guarantees:
 *   - READ-ONLY: Zero database writes. Never creates, modifies, or deletes
 *     people, accounts, transactions, interest records, or balances.
 *   - NO DUPLICATE BUSINESS LOGIC: Uses authoritative database columns
 *     (accounts.outstanding_principal, interest_records.interest_amount,
 *     interest_records.paid_amount) rather than recalculating from transactions.
 *   - ZERO-DATA SAFE: All counts default to 0 and all monetary totals default
 *     to 0 (never null) when no data exists.
 *   - AUTHORIZATION: Supports optional person_id scoping to restrict results
 *     to a single person's accounts, matching the project's existing isolation model.
 *   - EFFICIENT: Uses database-level aggregate queries (SUM, COUNT) rather than
 *     loading all records into application memory.
 *
 * KPI Definitions:
 *
 *   total_people           — Count of people records in the system.
 *   total_accounts         — Count of all account/loan records.
 *   active_accounts        — Accounts with status NOT IN ('CLOSED', 'WRITTEN_OFF').
 *   closed_accounts        — Accounts with status = 'CLOSED'.
 *   total_principal        — SUM(accounts.principal) in paisa. The original loan amounts.
 *   outstanding_principal  — SUM(accounts.outstanding_principal) in paisa. The authoritative
 *                            balance maintained by the existing transaction service (Part 3/5).
 *   total_interest         — SUM(interest_records.interest_amount) for non-REVERSED records
 *                            in paisa. Uses recorded interest from Part 6.
 *   outstanding_interest   — (total_interest - total_interest_paid) in paisa, floored at 0.
 *                            Uses interest_records.paid_amount from Part 6G.
 *   total_paid             — SUM of PRINCIPAL_RECEIVED + INTEREST_RECEIVED transaction amounts
 *                            in paisa. The authoritative payment source of truth from Part 5.
 *
 * Money Representation:
 *   All monetary values are provided in both representations:
 *     - _paisa suffix: Integer paisa (source of truth, no floating-point error)
 *     - Without suffix: Rupees as decimal (paisa / 100, for display convenience)
 */

const { queryOne, queryAll } = require('../db/helpers');
const {
    getDueOverdueSummary: getDueTrackingSummary,
    getCollectionItems: getDueTrackingCollectionItems
} = require('./dueTrackingService');

/**
 * Retrieves the complete dashboard KPI summary.
 *
 * @param {Object} db - Database connection (sql.js instance)
 * @param {Object} [options={}] - Optional filters
 * @param {number|string} [options.person_id] - Restrict dashboard to a single person's data
 * @returns {Object} DashboardSummary DTO
 */
function getDashboardSummary(db, options = {}) {
    if (!db) {
        const err = new Error('Database connection is required');
        err.statusCode = 500;
        throw err;
    }

    const personId = options.person_id || options.personId;
    const hasPersonFilter = personId !== undefined && personId !== null;
    const pId = hasPersonFilter ? Number(personId) : null;

    if (hasPersonFilter && (isNaN(pId) || pId <= 0)) {
        const err = new Error('A valid person_id is required');
        err.statusCode = 400;
        throw err;
    }

    // If person_id filter is provided, verify the person exists
    if (hasPersonFilter) {
        const person = queryOne(db, 'SELECT id FROM people WHERE id = ?', [pId]);
        if (!person) {
            const err = new Error(`Person #${pId} not found`);
            err.statusCode = 404;
            throw err;
        }
    }

    // ─── 1. People Count ─────────────────────────────────────
    let totalPeople = 0;
    if (hasPersonFilter) {
        // When scoped to a person, count is always 1 (already verified above)
        totalPeople = 1;
    } else {
        const peopleRow = queryOne(db, 'SELECT COUNT(*) as total FROM people');
        totalPeople = peopleRow ? Number(peopleRow.total) : 0;
    }

    // ─── 2. Account/Loan Aggregates ──────────────────────────
    const accountWhere = hasPersonFilter ? 'WHERE person_id = ?' : '';
    const accountParams = hasPersonFilter ? [pId] : [];

    const accountRow = queryOne(db, `
        SELECT
            COUNT(*)                                                                     as total_accounts,
            COALESCE(SUM(CASE WHEN status NOT IN ('CLOSED', 'WRITTEN_OFF') THEN 1 ELSE 0 END), 0) as active_accounts,
            COALESCE(SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END), 0)             as closed_accounts,
            COALESCE(SUM(principal), 0)                                                  as total_principal_paisa,
            COALESCE(SUM(outstanding_principal), 0)                                      as outstanding_principal_paisa
        FROM accounts
        ${accountWhere}
    `, accountParams);

    const totalAccounts        = accountRow ? Number(accountRow.total_accounts)            : 0;
    const activeAccounts       = accountRow ? Number(accountRow.active_accounts)           : 0;
    const closedAccounts       = accountRow ? Number(accountRow.closed_accounts)           : 0;
    const totalPrincipalPaisa  = accountRow ? Number(accountRow.total_principal_paisa)     : 0;
    const outstandingPrincipalPaisa = accountRow ? Number(accountRow.outstanding_principal_paisa) : 0;

    // ─── 3. Interest Aggregates ──────────────────────────────
    // Uses recorded interest from Part 6 (interest_records table).
    // Excludes REVERSED records to match the established convention.
    const interestWhere = hasPersonFilter
        ? "WHERE r.status != 'REVERSED' AND a.person_id = ?"
        : "WHERE r.status != 'REVERSED'";
    const interestParams = hasPersonFilter ? [pId] : [];

    const interestRow = queryOne(db, `
        SELECT
            COALESCE(SUM(r.interest_amount), 0) as total_interest_paisa,
            COALESCE(SUM(r.paid_amount), 0)     as total_interest_paid_paisa
        FROM interest_records r
        ${hasPersonFilter ? 'JOIN accounts a ON r.account_id = a.id' : ''}
        ${interestWhere}
    `, interestParams);

    const totalInterestPaisa       = interestRow ? Number(interestRow.total_interest_paisa)      : 0;
    const totalInterestPaidPaisa   = interestRow ? Number(interestRow.total_interest_paid_paisa) : 0;
    const outstandingInterestPaisa = Math.max(0, totalInterestPaisa - totalInterestPaidPaisa);

    // ─── 4. Total Paid (Payments) ────────────────────────────
    // Uses the authoritative transaction source of truth from Part 5.
    // Counts PRINCIPAL_RECEIVED + INTEREST_RECEIVED transaction amounts.
    const paidWhere = hasPersonFilter
        ? "WHERE t.transaction_type IN ('PRINCIPAL_RECEIVED', 'INTEREST_RECEIVED') AND t.person_id = ?"
        : "WHERE t.transaction_type IN ('PRINCIPAL_RECEIVED', 'INTEREST_RECEIVED')";
    const paidParams = hasPersonFilter ? [pId] : [];

    const paidRow = queryOne(db, `
        SELECT COALESCE(SUM(t.amount), 0) as total_paid_paisa
        FROM transactions t
        ${paidWhere}
    `, paidParams);

    const totalPaidPaisa = paidRow ? Number(paidRow.total_paid_paisa) : 0;

    // ─── 5. Build DashboardSummary DTO ───────────────────────
    const summary = {
        // Counts
        total_people:                totalPeople,
        total_loans:                 totalAccounts,
        total_accounts:              totalAccounts,
        active_loans:                activeAccounts,
        active_accounts:             activeAccounts,
        closed_loans:                closedAccounts,
        closed_accounts:             closedAccounts,

        // Principal (paisa + rupees)
        total_principal:             Number((totalPrincipalPaisa / 100).toFixed(2)),
        total_principal_paisa:       totalPrincipalPaisa,
        outstanding_principal:       Number((outstandingPrincipalPaisa / 100).toFixed(2)),
        outstanding_principal_paisa: outstandingPrincipalPaisa,

        // Interest (paisa + rupees)
        total_interest:              Number((totalInterestPaisa / 100).toFixed(2)),
        total_interest_paisa:        totalInterestPaisa,
        outstanding_interest:        Number((outstandingInterestPaisa / 100).toFixed(2)),
        outstanding_interest_paisa:  outstandingInterestPaisa,

        // Payments (paisa + rupees)
        total_paid:                  Number((totalPaidPaisa / 100).toFixed(2)),
        total_paid_paisa:            totalPaidPaisa,

        // Metadata
        generated_at:                new Date().toISOString()
    };

    // Include person scope metadata if filtered
    if (hasPersonFilter) {
        summary.person_id = pId;
    }

    return summary;
}

/**
 * Retrieves summarized information for loans/accounts to power
 * loan cards or summary sections on the dashboard.
 *
 * Implements Step 7C contract:
 *   LoanSummary
 *   ├── loan_id
 *   ├── person_id
 *   ├── person_name
 *   ├── loan_status
 *   ├── original_principal
 *   ├── outstanding_principal
 *   ├── total_paid
 *   ├── total_interest
 *   ├── outstanding_interest
 *   └── relevant_date
 *
 * Guarantees:
 *   - READ-ONLY: Zero database writes.
 *   - AUTHORITATIVE: Uses accounts.principal, accounts.outstanding_principal,
 *     interest_records, and transactions.
 *   - MULTIPLE LOANS: Preserves 1:N person-to-loan relationships independently.
 *   - DETERMINISTIC ORDER: Ordered by start_date DESC, id DESC.
 *   - PERFORMANCE: Single aggregated query with LEFT JOINs; zero N+1 queries.
 *
 * @param {Object} db - Database connection (sql.js instance)
 * @param {Object} [options={}] - Optional filters
 * @param {number|string} [options.person_id] - Filter by specific person (authorization scope)
 * @param {string} [options.status] - Filter by loan status (e.g. 'ACTIVE', 'CLOSED')
 * @param {string} [options.direction] - Filter by direction ('MONEY_GIVEN', 'MONEY_TAKEN')
 * @returns {Array<Object>} List of LoanSummary DTOs
 */
function getLoanSummaries(db, options = {}) {
    if (!db) {
        const err = new Error('Database connection is required');
        err.statusCode = 500;
        throw err;
    }

    const personId = options.person_id || options.personId;
    const hasPersonFilter = personId !== undefined && personId !== null;
    const pId = hasPersonFilter ? Number(personId) : null;

    if (hasPersonFilter && (isNaN(pId) || pId <= 0)) {
        const err = new Error('A valid person_id is required');
        err.statusCode = 400;
        throw err;
    }

    // Verify person exists if person_id filter provided
    if (hasPersonFilter) {
        const person = queryOne(db, 'SELECT id FROM people WHERE id = ?', [pId]);
        if (!person) {
            const err = new Error(`Person #${pId} not found`);
            err.statusCode = 404;
            throw err;
        }
    }

    const conditions = [];
    const params = [];

    if (hasPersonFilter) {
        conditions.push('a.person_id = ?');
        params.push(pId);
    }

    const statusFilter = options.status || options.loan_status;
    if (statusFilter && typeof statusFilter === 'string' && statusFilter.trim()) {
        conditions.push('a.status = ?');
        params.push(statusFilter.trim().toUpperCase());
    }

    const directionFilter = options.direction;
    if (directionFilter && typeof directionFilter === 'string' && directionFilter.trim()) {
        conditions.push('a.direction = ?');
        params.push(directionFilter.trim().toUpperCase());
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Single efficient aggregation query with deterministic ordering
    const sql = `
        SELECT
            a.id as loan_id,
            a.person_id,
            p.name as person_name,
            a.status as loan_status,
            a.direction,
            a.principal as original_principal_paisa,
            a.outstanding_principal as outstanding_principal_paisa,
            a.start_date,
            a.due_date,
            a.created_at,
            COALESCE(tx.total_paid_paisa, 0) as total_paid_paisa,
            COALESCE(ir.total_interest_paisa, 0) as total_interest_paisa,
            COALESCE(ir.total_interest_paid_paisa, 0) as total_interest_paid_paisa
        FROM accounts a
        JOIN people p ON a.person_id = p.id
        LEFT JOIN (
            SELECT
                account_id,
                SUM(amount) as total_paid_paisa
            FROM transactions
            WHERE transaction_type IN ('PRINCIPAL_RECEIVED', 'INTEREST_RECEIVED')
            GROUP BY account_id
        ) tx ON tx.account_id = a.id
        LEFT JOIN (
            SELECT
                account_id,
                SUM(interest_amount) as total_interest_paisa,
                SUM(paid_amount) as total_interest_paid_paisa
            FROM interest_records
            WHERE status != 'REVERSED'
            GROUP BY account_id
        ) ir ON ir.account_id = a.id
        ${whereClause}
        ORDER BY a.start_date DESC, a.id DESC
    `;

    const rows = queryAll(db, sql, params);

    return rows.map(row => {
        const totalInterestPaisa = Number(row.total_interest_paisa);
        const totalInterestPaidPaisa = Number(row.total_interest_paid_paisa);
        const outstandingInterestPaisa = Math.max(0, totalInterestPaisa - totalInterestPaidPaisa);

        const originalPrincipalPaisa = Number(row.original_principal_paisa);
        const outstandingPrincipalPaisa = Number(row.outstanding_principal_paisa);
        const totalPaidPaisa = Number(row.total_paid_paisa);

        return {
            loan_id: row.loan_id,
            account_id: row.loan_id,
            person_id: row.person_id,
            person_name: row.person_name,
            loan_status: row.loan_status,
            status: row.loan_status,
            direction: row.direction,

            // Monetary values in rupees (2 decimals) and paisa (integer)
            original_principal: Number((originalPrincipalPaisa / 100).toFixed(2)),
            original_principal_paisa: originalPrincipalPaisa,

            outstanding_principal: Number((outstandingPrincipalPaisa / 100).toFixed(2)),
            outstanding_principal_paisa: outstandingPrincipalPaisa,

            total_paid: Number((totalPaidPaisa / 100).toFixed(2)),
            total_paid_paisa: totalPaidPaisa,

            total_interest: Number((totalInterestPaisa / 100).toFixed(2)),
            total_interest_paisa: totalInterestPaisa,

            outstanding_interest: Number((outstandingInterestPaisa / 100).toFixed(2)),
            outstanding_interest_paisa: outstandingInterestPaisa,

            // Date representations
            relevant_date: row.start_date || row.created_at,
            start_date: row.start_date,
            due_date: row.due_date,
            created_at: row.created_at
        };
    });
}

/**
 * Retrieves aggregated dashboard information for each person across all of their loans/accounts.
 *
 * Implements Step 7D contract:
 *   PersonSummary
 *   ├── person_id
 *   ├── person_name
 *   ├── total_loans
 *   ├── active_loans
 *   ├── closed_loans
 *   ├── total_principal
 *   ├── outstanding_principal
 *   ├── total_paid
 *   ├── total_interest
 *   └── outstanding_interest
 *
 * Guarantees:
 *   - READ-ONLY: Zero database writes.
 *   - MULTIPLE LOANS: Correctly aggregates across 1:N person-to-loan relationships.
 *   - PEOPLE WITH ZERO LOANS: Preserves people without loans, showing 0 for counts and totals.
 *   - CLOSED LOANS: Preserves closed loans in totals.
 *   - AUTHORIZATION: Supports optional person_id scoping to restrict results.
 *   - PERFORMANCE: Single aggregated query with LEFT JOINs; zero N+1 queries.
 *   - MONEY PRECISION: Both integer paisa (_paisa) and 2-decimal rupees.
 *
 * @param {Object} db - Database connection (sql.js instance)
 * @param {Object} [options={}] - Optional filters
 * @param {number|string} [options.person_id] - Filter by specific person (authorization scope)
 * @returns {Array<Object>} List of PersonSummary DTOs
 */
function getPeopleSummaries(db, options = {}) {
    if (!db) {
        const err = new Error('Database connection is required');
        err.statusCode = 500;
        throw err;
    }

    const personId = options.person_id || options.personId;
    const hasPersonFilter = personId !== undefined && personId !== null;
    const pId = hasPersonFilter ? Number(personId) : null;

    if (hasPersonFilter && (isNaN(pId) || pId <= 0)) {
        const err = new Error('A valid person_id is required');
        err.statusCode = 400;
        throw err;
    }

    // Verify person exists if person_id filter provided
    if (hasPersonFilter) {
        const person = queryOne(db, 'SELECT id FROM people WHERE id = ?', [pId]);
        if (!person) {
            const err = new Error(`Person #${pId} not found`);
            err.statusCode = 404;
            throw err;
        }
    }

    const whereClause = hasPersonFilter ? 'WHERE p.id = ?' : '';
    const params = hasPersonFilter ? [pId] : [];

    const sql = `
        SELECT
            p.id as person_id,
            p.name as person_name,
            p.phone,
            COALESCE(acc.total_loans, 0) as total_loans,
            COALESCE(acc.active_loans, 0) as active_loans,
            COALESCE(acc.closed_loans, 0) as closed_loans,
            COALESCE(acc.total_principal_paisa, 0) as total_principal_paisa,
            COALESCE(acc.outstanding_principal_paisa, 0) as outstanding_principal_paisa,
            COALESCE(tx.total_paid_paisa, 0) as total_paid_paisa,
            COALESCE(ir.total_interest_paisa, 0) as total_interest_paisa,
            COALESCE(ir.total_interest_paid_paisa, 0) as total_interest_paid_paisa
        FROM people p
        LEFT JOIN (
            SELECT
                person_id,
                COUNT(*) as total_loans,
                COALESCE(SUM(CASE WHEN status NOT IN ('CLOSED', 'WRITTEN_OFF') THEN 1 ELSE 0 END), 0) as active_loans,
                COALESCE(SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END), 0) as closed_loans,
                COALESCE(SUM(principal), 0) as total_principal_paisa,
                COALESCE(SUM(outstanding_principal), 0) as outstanding_principal_paisa
            FROM accounts
            GROUP BY person_id
        ) acc ON acc.person_id = p.id
        LEFT JOIN (
            SELECT
                person_id,
                COALESCE(SUM(amount), 0) as total_paid_paisa
            FROM transactions
            WHERE transaction_type IN ('PRINCIPAL_RECEIVED', 'INTEREST_RECEIVED')
            GROUP BY person_id
        ) tx ON tx.person_id = p.id
        LEFT JOIN (
            SELECT
                a.person_id,
                COALESCE(SUM(r.interest_amount), 0) as total_interest_paisa,
                COALESCE(SUM(r.paid_amount), 0) as total_interest_paid_paisa
            FROM interest_records r
            JOIN accounts a ON r.account_id = a.id
            WHERE r.status != 'REVERSED'
            GROUP BY a.person_id
        ) ir ON ir.person_id = p.id
        ${whereClause}
        ORDER BY p.name COLLATE NOCASE ASC, p.id ASC
    `;

    const rows = queryAll(db, sql, params);

    return rows.map(row => {
        const totalInterestPaisa = Number(row.total_interest_paisa);
        const totalInterestPaidPaisa = Number(row.total_interest_paid_paisa);
        const outstandingInterestPaisa = Math.max(0, totalInterestPaisa - totalInterestPaidPaisa);

        const totalPrincipalPaisa = Number(row.total_principal_paisa);
        const outstandingPrincipalPaisa = Number(row.outstanding_principal_paisa);
        const totalPaidPaisa = Number(row.total_paid_paisa);

        const totalLoans = Number(row.total_loans);
        const activeLoans = Number(row.active_loans);
        const closedLoans = Number(row.closed_loans);

        return {
            person_id: row.person_id,
            person_name: row.person_name,
            phone: row.phone,

            total_loans: totalLoans,
            total_accounts: totalLoans,
            active_loans: activeLoans,
            active_accounts: activeLoans,
            closed_loans: closedLoans,
            closed_accounts: closedLoans,

            total_principal: Number((totalPrincipalPaisa / 100).toFixed(2)),
            total_principal_paisa: totalPrincipalPaisa,

            outstanding_principal: Number((outstandingPrincipalPaisa / 100).toFixed(2)),
            outstanding_principal_paisa: outstandingPrincipalPaisa,

            total_paid: Number((totalPaidPaisa / 100).toFixed(2)),
            total_paid_paisa: totalPaidPaisa,

            total_interest: Number((totalInterestPaisa / 100).toFixed(2)),
            total_interest_paisa: totalInterestPaisa,

            outstanding_interest: Number((outstandingInterestPaisa / 100).toFixed(2)),
            outstanding_interest_paisa: outstandingInterestPaisa
        };
    });
}

/**
 * Retrieves aggregated interest and payment summary information for the dashboard.
 *
 * Implements Step 7E contract:
 *   InterestPaymentSummary
 *   ├── interest
 *   │   ├── total_interest
 *   │   ├── paid_interest
 *   │   ├── outstanding_interest
 *   │   └── interest_record_count
 *   └── payments
 *       ├── total_paid
 *       ├── payment_count
 *       └── average_payment
 *
 * Guarantees:
 *   - READ-ONLY: Zero database writes.
 *   - AUTHORITATIVE: Reuses Part 5 transactions and Part 6 interest records.
 *   - CORRECTION/REVERSAL SAFE: Ignores status = 'REVERSED' records so superseded
 *     records are never double-counted.
 *   - AUTHORIZATION: Supports person_id and account_id scoping for data isolation.
 *   - ZERO-DATA SAFE: Returns 0 for all counts, monetary values, and average when empty.
 *   - PERFORMANCE: Database-level aggregations (COUNT, SUM); zero N+1 queries.
 *   - MONEY PRECISION: Integer paisa (_paisa) and exact 2-decimal rupees.
 *
 * @param {Object} db - Database connection (sql.js instance)
 * @param {Object} [options={}] - Optional filters
 * @param {number|string} [options.person_id] - Filter by specific person (authorization scope)
 * @param {number|string} [options.account_id] - Filter by specific account/loan
 * @returns {Object} InterestPaymentSummary DTO
 */
function getInterestPaymentSummary(db, options = {}) {
    if (!db) {
        const err = new Error('Database connection is required');
        err.statusCode = 500;
        throw err;
    }

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
        // If both person_id and account_id provided, verify relationship
        if (hasPersonFilter && account.person_id !== pId) {
            const err = new Error(`Account #${aId} does not belong to Person #${pId}`);
            err.statusCode = 403;
            throw err;
        }
    }

    // ─── 1. Interest Aggregation ─────────────────────────────
    // Query non-REVERSED interest records (excludes superseded/corrected records)
    const interestConditions = ["r.status != 'REVERSED'"];
    const interestParams = [];

    if (hasAccountFilter) {
        interestConditions.push('r.account_id = ?');
        interestParams.push(aId);
    } else if (hasPersonFilter) {
        interestConditions.push('a.person_id = ?');
        interestParams.push(pId);
    }

    const interestWhere = `WHERE ${interestConditions.join(' AND ')}`;
    const interestJoin = (hasPersonFilter && !hasAccountFilter) ? 'JOIN accounts a ON r.account_id = a.id' : '';

    const interestRow = queryOne(db, `
        SELECT
            COUNT(*)                            as interest_record_count,
            COALESCE(SUM(r.interest_amount), 0) as total_interest_paisa,
            COALESCE(SUM(r.paid_amount), 0)     as paid_interest_paisa
        FROM interest_records r
        ${interestJoin}
        ${interestWhere}
    `, interestParams);

    const interestRecordCount = interestRow ? Number(interestRow.interest_record_count) : 0;
    const totalInterestPaisa = interestRow ? Number(interestRow.total_interest_paisa) : 0;
    const paidInterestPaisa = interestRow ? Number(interestRow.paid_interest_paisa) : 0;
    const outstandingInterestPaisa = Math.max(0, totalInterestPaisa - paidInterestPaisa);

    // ─── 2. Payment Aggregation ──────────────────────────────
    // Query actual payment transactions: PRINCIPAL_RECEIVED + INTEREST_RECEIVED
    const paymentConditions = ["t.transaction_type IN ('PRINCIPAL_RECEIVED', 'INTEREST_RECEIVED')"];
    const paymentParams = [];

    if (hasAccountFilter) {
        paymentConditions.push('t.account_id = ?');
        paymentParams.push(aId);
    } else if (hasPersonFilter) {
        paymentConditions.push('t.person_id = ?');
        paymentParams.push(pId);
    }

    const paymentWhere = `WHERE ${paymentConditions.join(' AND ')}`;

    const paymentRow = queryOne(db, `
        SELECT
            COUNT(*)                   as payment_count,
            COALESCE(SUM(t.amount), 0) as total_paid_paisa
        FROM transactions t
        ${paymentWhere}
    `, paymentParams);

    const paymentCount = paymentRow ? Number(paymentRow.payment_count) : 0;
    const totalPaidPaisa = paymentRow ? Number(paymentRow.total_paid_paisa) : 0;
    const avgPaymentPaisa = paymentCount > 0 ? Math.round(totalPaidPaisa / paymentCount) : 0;

    const totalInterestRupees = Number((totalInterestPaisa / 100).toFixed(2));
    const paidInterestRupees = Number((paidInterestPaisa / 100).toFixed(2));
    const outstandingInterestRupees = Number((outstandingInterestPaisa / 100).toFixed(2));
    const totalPaidRupees = Number((totalPaidPaisa / 100).toFixed(2));
    const avgPaymentRupees = Number((avgPaymentPaisa / 100).toFixed(2));

    return {
        interest: {
            total_interest: totalInterestRupees,
            total_interest_paisa: totalInterestPaisa,
            paid_interest: paidInterestRupees,
            paid_interest_paisa: paidInterestPaisa,
            outstanding_interest: outstandingInterestRupees,
            outstanding_interest_paisa: outstandingInterestPaisa,
            interest_record_count: interestRecordCount
        },
        payments: {
            total_paid: totalPaidRupees,
            total_paid_paisa: totalPaidPaisa,
            payment_count: paymentCount,
            average_payment: avgPaymentRupees,
            average_payment_paisa: avgPaymentPaisa
        },
        // Direct top-level fields for convenience
        total_interest: totalInterestRupees,
        total_interest_paisa: totalInterestPaisa,
        paid_interest: paidInterestRupees,
        paid_interest_paisa: paidInterestPaisa,
        outstanding_interest: outstandingInterestRupees,
        outstanding_interest_paisa: outstandingInterestPaisa,
        interest_record_count: interestRecordCount,
        total_paid: totalPaidRupees,
        total_paid_paisa: totalPaidPaisa,
        payment_count: paymentCount,
        average_payment: avgPaymentRupees,
        average_payment_paisa: avgPaymentPaisa,

        metadata: {
            generated_at: new Date().toISOString(),
            ...(hasPersonFilter ? { person_id: pId } : {}),
            ...(hasAccountFilter ? { account_id: aId } : {})
        }
    };
}

/**
 * Internal helper to evaluate and classify active accounts into due, overdue, and current.
 *
 * @param {Object} db - Database connection
 * @param {Object} options - Scoping options
 * @returns {Array<Object>} Evaluated account items
 */
function evaluateDueCollectionAccounts(db, options = {}) {
    if (!db) {
        const err = new Error('Database connection is required');
        err.statusCode = 500;
        throw err;
    }

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

    // Determine reference "today" date (clock abstraction for deterministic tests)
    const asOfDate = options.as_of_date || options.asOfDate || options.current_date || options.currentDate || new Date().toISOString().slice(0, 10);

    const conditions = ["a.status NOT IN ('CLOSED', 'WRITTEN_OFF')"];
    const params = [];

    if (hasPersonFilter) {
        conditions.push('a.person_id = ?');
        params.push(pId);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Query active accounts with authoritative outstanding principal and Part 6 outstanding interest
    const sql = `
        SELECT
            a.id as loan_id,
            a.person_id,
            p.name as person_name,
            a.status as status,
            a.due_date,
            a.outstanding_principal as outstanding_principal_paisa,
            COALESCE(ir.outstanding_interest_paisa, 0) as outstanding_interest_paisa
        FROM accounts a
        JOIN people p ON a.person_id = p.id
        LEFT JOIN (
            SELECT
                account_id,
                COALESCE(SUM(interest_amount), 0) - COALESCE(SUM(paid_amount), 0) as outstanding_interest_paisa
            FROM interest_records
            WHERE status != 'REVERSED'
            GROUP BY account_id
        ) ir ON ir.account_id = a.id
        ${whereClause}
        ORDER BY a.due_date ASC, a.id ASC
    `;

    const rows = queryAll(db, sql, params);

    const asOfUtc = Date.parse(asOfDate + 'T00:00:00Z');

    return rows.map(row => {
        const outstandingPrincipalPaisa = Number(row.outstanding_principal_paisa);
        const outstandingInterestPaisa = Math.max(0, Number(row.outstanding_interest_paisa));
        const totalOutstandingPaisa = outstandingPrincipalPaisa + outstandingInterestPaisa;

        // Fully satisfied loans are neither due nor overdue
        if (totalOutstandingPaisa <= 0) {
            return {
                loan_id: row.loan_id,
                person_id: row.person_id,
                person_name: row.person_name,
                due_date: row.due_date,
                status: row.status,
                is_due: false,
                is_overdue: false,
                is_current: false,
                days_overdue: 0,
                outstanding_principal_paisa: 0,
                outstanding_interest_paisa: 0,
                total_outstanding_paisa: 0,
                amount_due_paisa: 0,
                amount_overdue_paisa: 0
            };
        }

        const hasDueDate = Boolean(row.due_date);
        const dueDateUtc = hasDueDate ? Date.parse(row.due_date + 'T00:00:00Z') : NaN;
        const isOverdue = row.status === 'OVERDUE' || (hasDueDate && row.due_date < asOfDate);
        const isDue = !isOverdue && (hasDueDate && row.due_date === asOfDate);
        const isCurrent = !isOverdue && !isDue;

        let daysOverdue = 0;
        if (isOverdue && !isNaN(dueDateUtc) && !isNaN(asOfUtc)) {
            daysOverdue = Math.max(1, Math.floor((asOfUtc - dueDateUtc) / (24 * 60 * 60 * 1000)));
        }

        return {
            loan_id: row.loan_id,
            person_id: row.person_id,
            person_name: row.person_name,
            due_date: row.due_date,
            status: isOverdue ? 'OVERDUE' : row.status,
            is_due: isDue,
            is_overdue: isOverdue,
            is_current: isCurrent,
            days_overdue: daysOverdue,
            outstanding_principal_paisa: outstandingPrincipalPaisa,
            outstanding_interest_paisa: outstandingInterestPaisa,
            total_outstanding_paisa: totalOutstandingPaisa,
            amount_due_paisa: isDue ? totalOutstandingPaisa : 0,
            amount_overdue_paisa: isOverdue ? totalOutstandingPaisa : 0
        };
    });
}

/**
 * Retrieves due and overdue collection summary for the dashboard.
 *
 * Implements Step 7F contract:
 *   DueCollectionSummary
 *   ├── due_loan_count
 *   ├── overdue_loan_count
 *   ├── due_amount
 *   ├── overdue_amount
 *   └── collection_amount
 *
 * Guarantees:
 *   - READ-ONLY: Zero database writes.
 *   - AUTHORITATIVE: Uses accounts.outstanding_principal and Part 6 interest_records.
 *   - FULLY PAID EXCLUSION: Fully satisfied obligations (balance = 0) are excluded.
 *   - CLOSED LOANS EXCLUSION: Closed/written-off accounts are excluded.
 *   - PERFORMANCE: Evaluates via single indexed aggregation query.
 *   - CLOCK ABSTRACTION: Accepts options.as_of_date for deterministic evaluation.
 *
 * @param {Object} db - Database connection
 * @param {Object} [options={}] - Filters and options (person_id, as_of_date)
 * @returns {Object} DueCollectionSummary DTO
 */
function getDueCollectionSummary(db, options = {}) {
    return getDueTrackingSummary(db, options);
}

/**
 * Retrieves individual collection items requiring attention (due or overdue).
 * Delegates to Part 8 DueTrackingService with include_due = true.
 *
 * @param {Object} db - Database connection
 * @param {Object} [options={}] - Filters and options (person_id, as_of_date)
 * @returns {Array<Object>} List of CollectionItem DTOs
 */
function getCollectionItems(db, options = {}) {
    return getDueTrackingCollectionItems(db, { ...options, include_due: true });
}


const DEFAULT_RECENT_ACTIVITY_LIMIT = 10;
const MAX_RECENT_ACTIVITY_LIMIT = 100;

/**
 * Retrieves recent financial activity summary for the dashboard.
 *
 * Implements Step 7G RecentActivity contract:
 *   RecentActivity
 *   ├── activity_id
 *   ├── activity_type
 *   ├── person_id
 *   ├── person_name
 *   ├── loan_id
 *   ├── amount
 *   ├── date/time
 *   └── status
 *
 * Guarantees:
 *   - READ-ONLY: Zero database writes.
 *   - SOURCE REUSED: Directly queries authoritative transactions table.
 *   - DETERMINISTIC ORDER: ORDER BY transaction_date DESC, id DESC.
 *   - BOUNDED LIMIT: Defaults to 10, configurable up to 100.
 *   - NO DUPLICATES: Direct row mapping from transactions without artificial duplicates.
 *   - AUTHORIZATION: Supports optional person_id and account_id scoping.
 *
 * @param {Object} db - Database connection
 * @param {Object} [options={}] - Scoping & pagination options
 * @param {number|string} [options.person_id] - Restrict to a single person's activity
 * @param {number|string} [options.account_id] - Restrict to a single account/loan
 * @param {number|string} [options.limit=10] - Number of activity items (max 100)
 * @returns {Array<Object>} List of RecentActivity DTOs
 */
function getRecentActivity(db, options = {}) {
    if (!db) {
        const err = new Error('Database connection is required');
        err.statusCode = 500;
        throw err;
    }

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

    // Determine limit
    let limit = DEFAULT_RECENT_ACTIVITY_LIMIT;
    if (options.limit !== undefined && options.limit !== null) {
        const parsed = parseInt(options.limit, 10);
        if (!isNaN(parsed) && parsed > 0) {
            limit = Math.min(parsed, MAX_RECENT_ACTIVITY_LIMIT);
        }
    }

    const conditions = [];
    const params = [];

    if (hasPersonFilter) {
        conditions.push('t.person_id = ?');
        params.push(pId);
    }

    if (hasAccountFilter) {
        conditions.push('t.account_id = ?');
        params.push(aId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Check if transactions table has a 'status' column dynamically
    const tableCols = queryAll(db, 'PRAGMA table_info(transactions)');
    const hasStatusCol = tableCols.some(col => col.name === 'status');

    const selectStatus = hasStatusCol ? 't.status as status,' : '';

    const sql = `
        SELECT
            t.id as activity_id,
            t.transaction_type as activity_type,
            t.account_id as loan_id,
            t.person_id,
            p.name as person_name,
            t.amount as amount_paisa,
            t.payment_method,
            t.transaction_date,
            t.reference,
            t.notes,
            t.created_at,
            ${selectStatus}
            a.status as account_status
        FROM transactions t
        JOIN people p ON t.person_id = p.id
        JOIN accounts a ON t.account_id = a.id
        ${whereClause}
        ORDER BY t.transaction_date DESC, t.id DESC
        LIMIT ?
    `;

    params.push(limit);

    const rows = queryAll(db, sql, params);

    return rows.map(row => {
        let status = 'COMPLETED';
        if (row.status) {
            status = row.status;
        } else if (row.notes && row.notes.toUpperCase().includes('REVERSED')) {
            status = 'REVERSED';
        }

        return {
            activity_id: row.activity_id,
            transaction_id: row.activity_id,
            activity_type: row.activity_type,
            transaction_type: row.activity_type,
            person_id: row.person_id,
            person_name: row.person_name,
            loan_id: row.loan_id,
            account_id: row.loan_id,
            amount: Number((row.amount_paisa / 100).toFixed(2)),
            amount_paisa: row.amount_paisa,
            date_time: row.transaction_date,
            transaction_date: row.transaction_date,
            created_at: row.created_at,
            payment_method: row.payment_method,
            reference: row.reference || null,
            notes: row.notes || null,
            status: status
        };
    });
}

/**
 * Retrieves the fully integrated dashboard data response.
 *
 * Implements Step 7H contract:
 *   DashboardData
 *   ├── summary
 *   ├── loans
 *   ├── people
 *   ├── financial
 *   ├── due_collection
 *   └── recent_activity
 *
 * Guarantees:
 *   - READ-ONLY: Zero database writes.
 *   - ORCHESTRATION: Reuses existing dashboard services (7B–7G) without duplicating financial logic.
 *   - CONSISTENCY: Section totals (summary, financial, people, loans, collections) agree.
 *   - AUTHORIZATION: Applies customer-level scoping across all sub-services.
 *   - BOUNDED LIMITS: Respects configured/default limits.
 *   - ERROR INTEGRITY: Propagates genuine service errors; does not fake valid zero balances on error.
 *
 * @param {Object} db - Database connection (sql.js instance)
 * @param {Object} [options={}] - Scoping and filter options
 * @param {number|string} [options.person_id] - Restrict dashboard to a single person's data
 * @param {string} [options.as_of_date] - Reference date for due/overdue calculation
 * @param {number|string} [options.limit] - Limit for recent activity
 * @param {string} [options.status] - Optional filter for loans
 * @param {string} [options.direction] - Optional filter for loans
 * @returns {Object} DashboardData DTO
 */
function getIntegratedDashboard(db, options = {}) {
    if (!db) {
        const err = new Error('Database connection is required');
        err.statusCode = 500;
        throw err;
    }

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

    // Orchestrate existing services without duplicate calculations
    const summary = getDashboardSummary(db, options);
    const loanItems = getLoanSummaries(db, options);
    const peopleItems = getPeopleSummaries(db, options);
    const financial = getInterestPaymentSummary(db, options);
    const dueSummary = getDueCollectionSummary(db, options);
    const collectionItems = getCollectionItems(db, options);
    const activityItems = getRecentActivity(db, options);

    return {
        summary: summary,
        loans: {
            items: loanItems,
            count: loanItems.length
        },
        people: {
            items: peopleItems,
            count: peopleItems.length
        },
        financial: financial,
        due_collection: {
            ...dueSummary,
            items: collectionItems,
            count: collectionItems.length
        },
        recent_activity: {
            items: activityItems,
            count: activityItems.length
        }
    };
}

module.exports = {
    getDashboardSummary,
    getLoanSummaries,
    getPeopleSummaries,
    getInterestPaymentSummary,
    getDueCollectionSummary,
    getCollectionItems,
    getRecentActivity,
    getIntegratedDashboard,
    getDashboardData: getIntegratedDashboard
};
