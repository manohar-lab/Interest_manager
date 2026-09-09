/**
 * Interest Manager — Part 9: Unified Report Service
 *
 * Dedicated domain reporting engine providing:
 *   - 9A: Common report architecture, pagination, scoping & DTO contracts
 *   - 9B: Loan Portfolio Report
 *   - 9C: People / Customer Report
 *   - 9D: Payment / Transaction Report
 *   - 9E: Interest Report
 *   - 9F: Due / Overdue Report
 *   - 9G: Collection Priority Report
 *   - 9H: Robust Date-Range Filtering (inclusive, validation, timezone consistency)
 *   - 9I: Unified entry point & API orchestration
 *
 * Guarantees:
 *   - READ-ONLY: Pure aggregation queries, zero database mutations.
 *   - AUTHORIZED: Customer & account scoping enforced BEFORE querying & aggregation.
 *   - DETERMINISTIC: Clock abstraction (as_of_date) & deterministic secondary sorting.
 *   - PAGINATED: Strict pagination with safe defaults (20) and caps (100).
 *   - EXACT MONEY: Integer paisa precision for arithmetic; 2-decimal rupee conversions for display.
 *   - RECONCILABLE: Reuses Part 3/5 balances, Part 6 interest, and Part 8 due/overdue tracking.
 */

const { queryOne, queryAll } = require('../db/helpers');
const {
    fetchAccountsWithFinancials,
    evaluateObligation,
    resolveAsOfDate
} = require('./dueTrackingService');

/**
 * Supported report type enum (9A.1).
 */
const REPORT_TYPES = Object.freeze({
    LOAN_PORTFOLIO: 'LOAN_PORTFOLIO',
    PEOPLE: 'PEOPLE',
    PAYMENTS: 'PAYMENTS',
    INTEREST: 'INTEREST',
    DUE_OVERDUE: 'DUE_OVERDUE',
    COLLECTION: 'COLLECTION'
});

/**
 * Normalizes input string to canonical ReportType enum.
 */
function normalizeReportType(typeStr) {
    if (!typeStr || typeof typeStr !== 'string') return null;
    const clean = typeStr.trim().toUpperCase().replace(/[- ]/g, '_');

    switch (clean) {
        case 'LOAN_PORTFOLIO':
        case 'LOANS':
        case 'LOAN':
        case 'PORTFOLIO':
            return REPORT_TYPES.LOAN_PORTFOLIO;
        case 'PEOPLE':
        case 'PERSON':
        case 'CUSTOMERS':
        case 'CUSTOMER':
            return REPORT_TYPES.PEOPLE;
        case 'PAYMENTS':
        case 'PAYMENT':
        case 'TRANSACTIONS':
        case 'TRANSACTION':
            return REPORT_TYPES.PAYMENTS;
        case 'INTEREST':
        case 'INTERESTS':
        case 'ACCRUALS':
            return REPORT_TYPES.INTEREST;
        case 'DUE_OVERDUE':
        case 'DUE':
        case 'OVERDUE':
            return REPORT_TYPES.DUE_OVERDUE;
        case 'COLLECTION':
        case 'COLLECTIONS':
            return REPORT_TYPES.COLLECTION;
        default:
            return null;
    }
}

/**
 * Validates scoping parameters (person_id, loan_id / account_id) (9A.5).
 */
function validateScoping(db, options = {}) {
    const personId = options.person_id || options.personId;
    const hasPersonFilter = personId !== undefined && personId !== null && personId !== '';
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
    const hasAccountFilter = accountId !== undefined && accountId !== null && accountId !== '';
    const aId = hasAccountFilter ? Number(accountId) : null;

    if (hasAccountFilter && (isNaN(aId) || aId <= 0)) {
        const err = new Error('A valid loan_id is required');
        err.statusCode = 400;
        throw err;
    }

    if (hasAccountFilter) {
        const account = queryOne(db, 'SELECT id, person_id FROM accounts WHERE id = ?', [aId]);
        if (!account) {
            const err = new Error(`Loan #${aId} not found`);
            err.statusCode = 404;
            throw err;
        }
        if (hasPersonFilter && account.person_id !== pId) {
            const err = new Error(`Loan #${aId} does not belong to Person #${pId}`);
            err.statusCode = 403;
            throw err;
        }
    }

    return { pId, aId, hasPersonFilter, hasAccountFilter };
}

/**
 * Validates date range parameters (9H).
 * Rejects inverted ranges (start_date > end_date) with 400.
 */
function validateDateRange(startDate, endDate) {
    if (startDate && endDate) {
        if (startDate > endDate) {
            const err = new Error('start_date cannot be after end_date');
            err.statusCode = 400;
            throw err;
        }
    }
}

/**
 * Standard pagination helper (9A.4).
 */
function paginate(items, options = {}) {
    if (options.all || options.export_all || options.unpaged) {
        return {
            pagedItems: items,
            pagination: {
                page: 1,
                page_size: items.length,
                total_records: items.length,
                total_pages: items.length > 0 ? 1 : 0
            }
        };
    }
    const page = Math.max(1, parseInt(options.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(options.page_size || options.pageSize || options.limit, 10) || 20));

    const totalRecords = items.length;
    const totalPages = Math.ceil(totalRecords / pageSize) || (totalRecords === 0 ? 0 : 1);
    const startIndex = (page - 1) * pageSize;
    const pagedItems = items.slice(startIndex, startIndex + pageSize);

    return {
        pagedItems,
        pagination: {
            page,
            page_size: pageSize,
            total_records: totalRecords,
            total_pages: totalPages
        }
    };
}


/**
 * Formats monetary amounts into paisa and rupee representations.
 */
function formatMoney(paisa) {
    const p = Math.max(0, Math.round(Number(paisa) || 0));
    return {
        paisa: p,
        rupees: Number((p / 100).toFixed(2))
    };
}

// ════════════════════════════════════════════════════════════════════
// 9B: LOAN PORTFOLIO REPORT
// ════════════════════════════════════════════════════════════════════

function generateLoanPortfolioReport(db, options = {}) {
    const { pId, aId, hasPersonFilter, hasAccountFilter } = validateScoping(db, options);

    const startDate = options.start_date || options.startDate || null;
    const endDate = options.end_date || options.endDate || null;
    validateDateRange(startDate, endDate);

    const statusFilter = options.status ? String(options.status).trim().toUpperCase() : null;

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
    if (statusFilter) {
        conditions.push('a.status = ?');
        params.push(statusFilter);
    }
    if (startDate) {
        conditions.push('a.start_date >= ?');
        params.push(startDate);
    }
    if (endDate) {
        conditions.push('a.start_date <= ?');
        params.push(endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
        SELECT
            a.id as loan_id,
            a.person_id,
            p.name as person_name,
            p.phone as person_phone,
            a.direction,
            a.principal as principal_paisa,
            a.outstanding_principal as outstanding_principal_paisa,
            a.interest_rate,
            a.interest_frequency,
            a.calculation_method,
            a.start_date,
            a.due_date,
            COALESCE(a.grace_period, 0) as grace_period,
            a.status as loan_status,
            COALESCE(tx.total_paid_paisa, 0) as total_paid_paisa,
            COALESCE(ir.total_interest_paisa, 0) as total_interest_paisa,
            COALESCE(ir.paid_interest_paisa, 0) as paid_interest_paisa,
            COALESCE(ir.outstanding_interest_paisa, 0) as outstanding_interest_paisa
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
        ORDER BY a.start_date DESC, a.id DESC
    `;

    const rows = queryAll(db, sql, params);

    let totalPrincipalPaisa = 0;
    let totalPaidPaisa = 0;
    let totalOutstandingPrincipalPaisa = 0;
    let totalInterestPaisa = 0;
    let totalOutstandingInterestPaisa = 0;
    let totalOutstandingPaisa = 0;
    let activeLoans = 0;
    let closedLoans = 0;

    const items = rows.map(r => {
        const principalPaisa = Number(r.principal_paisa || 0);
        const paidPaisa = Number(r.total_paid_paisa || 0);
        const outPrincipalPaisa = Number(r.outstanding_principal_paisa || 0);
        const interestPaisa = Number(r.total_interest_paisa || 0);
        const outInterestPaisa = Number(r.outstanding_interest_paisa || 0);
        const totalOutPaisa = outPrincipalPaisa + outInterestPaisa;

        totalPrincipalPaisa += principalPaisa;
        totalPaidPaisa += paidPaisa;
        totalOutstandingPrincipalPaisa += outPrincipalPaisa;
        totalInterestPaisa += interestPaisa;
        totalOutstandingInterestPaisa += outInterestPaisa;
        totalOutstandingPaisa += totalOutPaisa;

        const isClosed = r.loan_status === 'CLOSED';
        if (isClosed) closedLoans++;
        else if (r.loan_status !== 'WRITTEN_OFF') activeLoans++;

        return {
            loan_id: r.loan_id,
            person_id: r.person_id,
            person_name: r.person_name,
            person_phone: r.person_phone,
            direction: r.direction,
            loan_status: r.loan_status,
            status: r.loan_status,
            start_date: r.start_date,
            due_date: r.due_date,
            grace_period: r.grace_period,
            interest_rate: r.interest_rate,
            interest_frequency: r.interest_frequency,

            principal_amount: Number((principalPaisa / 100).toFixed(2)),
            principal_amount_paisa: principalPaisa,

            paid_amount: Number((paidPaisa / 100).toFixed(2)),
            paid_amount_paisa: paidPaisa,

            outstanding_principal: Number((outPrincipalPaisa / 100).toFixed(2)),
            outstanding_principal_paisa: outPrincipalPaisa,

            interest_amount: Number((interestPaisa / 100).toFixed(2)),
            interest_amount_paisa: interestPaisa,

            outstanding_interest: Number((outInterestPaisa / 100).toFixed(2)),
            outstanding_interest_paisa: outInterestPaisa,

            total_outstanding: Number((totalOutPaisa / 100).toFixed(2)),
            total_outstanding_paisa: totalOutPaisa
        };
    });

    const summary = {
        total_loans: items.length,
        active_loans: activeLoans,
        closed_loans: closedLoans,

        total_principal: Number((totalPrincipalPaisa / 100).toFixed(2)),
        total_principal_paisa: totalPrincipalPaisa,

        total_paid: Number((totalPaidPaisa / 100).toFixed(2)),
        total_paid_paisa: totalPaidPaisa,

        outstanding_principal: Number((totalOutstandingPrincipalPaisa / 100).toFixed(2)),
        outstanding_principal_paisa: totalOutstandingPrincipalPaisa,

        total_interest: Number((totalInterestPaisa / 100).toFixed(2)),
        total_interest_paisa: totalInterestPaisa,

        outstanding_interest: Number((totalOutstandingInterestPaisa / 100).toFixed(2)),
        outstanding_interest_paisa: totalOutstandingInterestPaisa,

        total_outstanding: Number((totalOutstandingPaisa / 100).toFixed(2)),
        total_outstanding_paisa: totalOutstandingPaisa
    };

    const { pagedItems, pagination } = paginate(items, options);

    return {
        report_type: REPORT_TYPES.LOAN_PORTFOLIO,
        generated_at: new Date().toISOString(),
        filters: {
            person_id: pId,
            loan_id: aId,
            status: statusFilter,
            start_date: startDate,
            end_date: endDate
        },
        summary,
        items: pagedItems,
        pagination
    };
}

// ════════════════════════════════════════════════════════════════════
// 9C: PEOPLE REPORT
// ════════════════════════════════════════════════════════════════════

function generatePeopleReport(db, options = {}) {
    const { pId, hasPersonFilter } = validateScoping(db, options);

    const startDate = options.start_date || options.startDate || null;
    const endDate = options.end_date || options.endDate || null;
    validateDateRange(startDate, endDate);

    const asOfDate = resolveAsOfDate(options);

    // Fetch all accounts evaluated with Part 8 engine for precision
    const allEvaluated = fetchAccountsWithFinancials(db, {
        person_id: pId,
        as_of_date: asOfDate
    });

    // Group accounts by person
    const peopleMap = new Map();

    // Query base people
    let peopleSql = 'SELECT id, name, phone, created_at FROM people';
    const peopleParams = [];
    if (hasPersonFilter) {
        peopleSql += ' WHERE id = ?';
        peopleParams.push(pId);
    }
    peopleSql += ' ORDER BY name ASC, id ASC';

    const peopleRows = queryAll(db, peopleSql, peopleParams);
    for (const p of peopleRows) {
        peopleMap.set(p.id, {
            person_id: p.id,
            person_name: p.name,
            person_phone: p.phone,
            created_at: p.created_at,
            loans: []
        });
    }

    // Attach evaluated accounts to corresponding people
    for (const acc of allEvaluated) {
        if (peopleMap.has(acc.person_id)) {
            peopleMap.get(acc.person_id).loans.push(acc);
        }
    }

    let totalPrincipalPaisa = 0;
    let totalPaidPaisa = 0;
    let totalOutstandingPaisa = 0;
    let totalOverduePaisa = 0;
    let totalLoansCount = 0;
    let peopleWithActiveLoans = 0;

    const items = [];

    for (const [personId, data] of peopleMap.entries()) {
        let personPrincipalPaisa = 0;
        let personPaidPaisa = 0;
        let personOutstandingPaisa = 0;
        let personOverduePaisa = 0;
        let activeLoanCount = 0;
        let closedLoanCount = 0;
        let overdueLoanCount = 0;

        for (const loan of data.loans) {
            personPrincipalPaisa += loan.original_principal_paisa;
            personPaidPaisa += loan.total_paid_paisa;
            personOutstandingPaisa += loan.total_outstanding_paisa;
            if (loan.is_overdue) {
                personOverduePaisa += loan.amount_overdue_paisa;
                overdueLoanCount++;
            }
            if (loan.is_closed) {
                closedLoanCount++;
            } else if (loan.status !== 'WRITTEN_OFF') {
                activeLoanCount++;
            }
        }

        if (activeLoanCount > 0) peopleWithActiveLoans++;

        totalPrincipalPaisa += personPrincipalPaisa;
        totalPaidPaisa += personPaidPaisa;
        totalOutstandingPaisa += personOutstandingPaisa;
        totalOverduePaisa += personOverduePaisa;
        totalLoansCount += data.loans.length;

        items.push({
            person_id: data.person_id,
            person_name: data.person_name,
            person_phone: data.person_phone,
            loan_count: data.loans.length,
            active_loan_count: activeLoanCount,
            closed_loan_count: closedLoanCount,
            overdue_loan_count: overdueLoanCount,

            total_principal: Number((personPrincipalPaisa / 100).toFixed(2)),
            total_principal_paisa: personPrincipalPaisa,

            total_paid: Number((personPaidPaisa / 100).toFixed(2)),
            total_paid_paisa: personPaidPaisa,

            total_outstanding: Number((personOutstandingPaisa / 100).toFixed(2)),
            total_outstanding_paisa: personOutstandingPaisa,

            overdue_amount: Number((personOverduePaisa / 100).toFixed(2)),
            overdue_amount_paisa: personOverduePaisa
        });
    }

    const summary = {
        total_people: items.length,
        people_with_active_loans: peopleWithActiveLoans,
        total_loans: totalLoansCount,

        total_principal: Number((totalPrincipalPaisa / 100).toFixed(2)),
        total_principal_paisa: totalPrincipalPaisa,

        total_paid: Number((totalPaidPaisa / 100).toFixed(2)),
        total_paid_paisa: totalPaidPaisa,

        total_outstanding: Number((totalOutstandingPaisa / 100).toFixed(2)),
        total_outstanding_paisa: totalOutstandingPaisa,

        total_overdue: Number((totalOverduePaisa / 100).toFixed(2)),
        total_overdue_paisa: totalOverduePaisa,
        as_of_date: asOfDate
    };

    const { pagedItems, pagination } = paginate(items, options);

    return {
        report_type: REPORT_TYPES.PEOPLE,
        generated_at: new Date().toISOString(),
        filters: {
            person_id: pId,
            start_date: startDate,
            end_date: endDate,
            as_of_date: asOfDate
        },
        summary,
        items: pagedItems,
        pagination
    };
}

// ════════════════════════════════════════════════════════════════════
// 9D: PAYMENT / TRANSACTION REPORT
// ════════════════════════════════════════════════════════════════════

function generatePaymentReport(db, options = {}) {
    const { pId, aId, hasPersonFilter, hasAccountFilter } = validateScoping(db, options);

    const startDate = options.start_date || options.startDate || null;
    const endDate = options.end_date || options.endDate || null;
    validateDateRange(startDate, endDate);

    const txTypeFilter = options.transaction_type || options.type ? String(options.transaction_type || options.type).trim().toUpperCase() : null;

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
    if (txTypeFilter) {
        conditions.push('t.transaction_type = ?');
        params.push(txTypeFilter);
    }
    if (startDate) {
        conditions.push('t.transaction_date >= ?');
        params.push(startDate);
    }
    if (endDate) {
        conditions.push('t.transaction_date <= ?');
        params.push(endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
        SELECT
            t.id as transaction_id,
            t.account_id,
            t.person_id,
            p.name as person_name,
            t.transaction_type,
            t.amount as amount_paisa,
            t.payment_method,
            t.transaction_date,
            t.payment_id,
            t.reference,
            t.notes,
            t.created_at
        FROM transactions t
        JOIN people p ON t.person_id = p.id
        ${whereClause}
        ORDER BY t.transaction_date DESC, t.id DESC
    `;

    const rows = queryAll(db, sql, params);

    let totalAmountPaisa = 0;
    let totalPaymentAmountPaisa = 0;
    let totalDisbursedAmountPaisa = 0;

    const paymentTypes = new Set(['PRINCIPAL_RECEIVED', 'INTEREST_RECEIVED', 'MONEY_RECEIVED']);
    const disbursementTypes = new Set(['MONEY_LENT', 'PRINCIPAL_PAID', 'INTEREST_PAID']);

    const items = rows.map(r => {
        const amtPaisa = Number(r.amount_paisa || 0);
        totalAmountPaisa += amtPaisa;

        if (paymentTypes.has(r.transaction_type)) {
            totalPaymentAmountPaisa += amtPaisa;
        } else if (disbursementTypes.has(r.transaction_type)) {
            totalDisbursedAmountPaisa += amtPaisa;
        }

        return {
            transaction_id: r.transaction_id,
            loan_id: r.account_id,
            account_id: r.account_id,
            person_id: r.person_id,
            person_name: r.person_name,
            transaction_type: r.transaction_type,
            amount: Number((amtPaisa / 100).toFixed(2)),
            amount_paisa: amtPaisa,
            payment_method: r.payment_method,
            transaction_date: r.transaction_date,
            reference: r.reference,
            payment_id: r.payment_id,
            notes: r.notes,
            created_at: r.created_at
        };
    });

    const summary = {
        transaction_count: items.length,

        total_amount: Number((totalAmountPaisa / 100).toFixed(2)),
        total_amount_paisa: totalAmountPaisa,

        total_payment_amount: Number((totalPaymentAmountPaisa / 100).toFixed(2)),
        total_payment_amount_paisa: totalPaymentAmountPaisa,

        total_disbursed_amount: Number((totalDisbursedAmountPaisa / 100).toFixed(2)),
        total_disbursed_amount_paisa: totalDisbursedAmountPaisa
    };

    const { pagedItems, pagination } = paginate(items, options);

    return {
        report_type: REPORT_TYPES.PAYMENTS,
        generated_at: new Date().toISOString(),
        filters: {
            person_id: pId,
            loan_id: aId,
            transaction_type: txTypeFilter,
            start_date: startDate,
            end_date: endDate
        },
        summary,
        items: pagedItems,
        pagination
    };
}

// ════════════════════════════════════════════════════════════════════
// 9E: INTEREST REPORT
// ════════════════════════════════════════════════════════════════════

function generateInterestReport(db, options = {}) {
    const { pId, aId, hasPersonFilter, hasAccountFilter } = validateScoping(db, options);

    const startDate = options.start_date || options.startDate || null;
    const endDate = options.end_date || options.endDate || null;
    validateDateRange(startDate, endDate);

    const statusFilter = options.status ? String(options.status).trim().toUpperCase() : null;

    const conditions = [];
    const params = [];

    // By default, exclude reversed records unless explicitly requested
    if (statusFilter) {
        conditions.push('ir.status = ?');
        params.push(statusFilter);
    } else {
        conditions.push("ir.status != 'REVERSED'");
    }

    if (hasPersonFilter) {
        conditions.push('a.person_id = ?');
        params.push(pId);
    }
    if (hasAccountFilter) {
        conditions.push('ir.account_id = ?');
        params.push(aId);
    }
    if (startDate) {
        conditions.push('ir.period_start >= ?');
        params.push(startDate);
    }
    if (endDate) {
        conditions.push('ir.period_end <= ?');
        params.push(endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sql = `
        SELECT
            ir.id as interest_id,
            ir.account_id as loan_id,
            a.person_id,
            p.name as person_name,
            ir.period_start,
            ir.period_end,
            ir.principal_basis as principal_basis_paisa,
            ir.interest_rate,
            ir.interest_amount as interest_amount_paisa,
            ir.paid_amount as paid_interest_paisa,
            (ir.interest_amount - ir.paid_amount) as outstanding_interest_paisa,
            ir.calculation_method,
            ir.status,
            ir.created_at
        FROM interest_records ir
        JOIN accounts a ON ir.account_id = a.id
        JOIN people p ON a.person_id = p.id
        ${whereClause}
        ORDER BY ir.period_start DESC, ir.id DESC
    `;

    const rows = queryAll(db, sql, params);

    let totalInterestPaisa = 0;
    let paidInterestPaisa = 0;
    let outstandingInterestPaisa = 0;

    const items = rows.map(r => {
        const intPaisa = Number(r.interest_amount_paisa || 0);
        const paidPaisa = Number(r.paid_interest_paisa || 0);
        const outPaisa = Math.max(0, intPaisa - paidPaisa);

        totalInterestPaisa += intPaisa;
        paidInterestPaisa += paidPaisa;
        outstandingInterestPaisa += outPaisa;

        return {
            interest_id: r.interest_id,
            id: r.interest_id,
            loan_id: r.loan_id,
            account_id: r.loan_id,
            person_id: r.person_id,
            person_name: r.person_name,
            period_start: r.period_start,
            period_end: r.period_end,
            interest_rate: r.interest_rate,
            calculation_method: r.calculation_method,
            status: r.status,

            principal_basis: Number((Number(r.principal_basis_paisa || 0) / 100).toFixed(2)),
            principal_basis_paisa: Number(r.principal_basis_paisa || 0),

            interest_amount: Number((intPaisa / 100).toFixed(2)),
            interest_amount_paisa: intPaisa,

            paid_interest: Number((paidPaisa / 100).toFixed(2)),
            paid_interest_paisa: paidPaisa,

            outstanding_interest: Number((outPaisa / 100).toFixed(2)),
            outstanding_interest_paisa: outPaisa,

            created_at: r.created_at
        };
    });

    const summary = {
        interest_record_count: items.length,

        total_interest: Number((totalInterestPaisa / 100).toFixed(2)),
        total_interest_paisa: totalInterestPaisa,

        paid_interest: Number((paidInterestPaisa / 100).toFixed(2)),
        paid_interest_paisa: paidInterestPaisa,

        outstanding_interest: Number((outstandingInterestPaisa / 100).toFixed(2)),
        outstanding_interest_paisa: outstandingInterestPaisa
    };

    const { pagedItems, pagination } = paginate(items, options);

    return {
        report_type: REPORT_TYPES.INTEREST,
        generated_at: new Date().toISOString(),
        filters: {
            person_id: pId,
            loan_id: aId,
            status: statusFilter,
            start_date: startDate,
            end_date: endDate
        },
        summary,
        items: pagedItems,
        pagination
    };
}

// ════════════════════════════════════════════════════════════════════
// 9F: DUE / OVERDUE REPORT
// ════════════════════════════════════════════════════════════════════

function generateDueOverdueReport(db, options = {}) {
    const { pId, aId } = validateScoping(db, options);

    const startDate = options.start_date || options.startDate || null;
    const endDate = options.end_date || options.endDate || null;
    validateDateRange(startDate, endDate);

    const asOfDate = resolveAsOfDate(options);
    const statusFilter = options.status ? String(options.status).trim().toUpperCase() : null;

    const evaluated = fetchAccountsWithFinancials(db, {
        person_id: pId,
        account_id: aId,
        as_of_date: asOfDate,
        grace_period: options.grace_period
    });

    // Apply date range and status filters
    let filtered = evaluated;

    if (startDate) {
        filtered = filtered.filter(item => item.due_date && item.due_date >= startDate);
    }
    if (endDate) {
        filtered = filtered.filter(item => item.due_date && item.due_date <= endDate);
    }
    if (statusFilter) {
        filtered = filtered.filter(item => item.status === statusFilter);
    }

    // Sort: due_date ASC, loan_id ASC
    filtered.sort((a, b) => {
        if (a.due_date && b.due_date && a.due_date !== b.due_date) {
            return a.due_date.localeCompare(b.due_date);
        }
        return a.loan_id - b.loan_id;
    });

    let currentCount = 0;
    let dueCount = 0;
    let overdueCount = 0;
    let paidCount = 0;
    let closedCount = 0;

    let dueAmountPaisa = 0;
    let overdueAmountPaisa = 0;

    for (const item of filtered) {
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

    const items = filtered.map(item => ({
        loan_id: item.loan_id,
        account_id: item.loan_id,
        person_id: item.person_id,
        person_name: item.person_name,
        due_date: item.due_date,
        grace_period: item.grace_period,
        grace_end_date: item.grace_end_date,
        status: item.status,
        loan_status: item.persisted_status,

        required_amount: item.outstanding_amount,
        paid_amount: item.paid_amount,

        outstanding_amount: item.outstanding_amount,
        outstanding_amount_paisa: item.total_outstanding_paisa,

        outstanding_principal: item.outstanding_principal,
        outstanding_principal_paisa: item.outstanding_principal_paisa,

        outstanding_interest: item.outstanding_interest,
        outstanding_interest_paisa: item.outstanding_interest_paisa,

        amount_due: item.amount_due,
        amount_due_paisa: item.amount_due_paisa,

        amount_overdue: item.amount_overdue,
        amount_overdue_paisa: item.amount_overdue_paisa,

        overdue_since: item.overdue_since,
        days_overdue: item.days_overdue
    }));

    const summary = {
        current_count: currentCount,
        due_count: dueCount,
        overdue_count: overdueCount,
        paid_count: paidCount,
        closed_count: closedCount,
        total_count: items.length,

        due_amount: Number((dueAmountPaisa / 100).toFixed(2)),
        due_amount_paisa: dueAmountPaisa,

        overdue_amount: Number((overdueAmountPaisa / 100).toFixed(2)),
        overdue_amount_paisa: overdueAmountPaisa,

        collection_amount: Number((collectionAmountPaisa / 100).toFixed(2)),
        collection_amount_paisa: collectionAmountPaisa,
        as_of_date: asOfDate
    };

    const { pagedItems, pagination } = paginate(items, options);

    return {
        report_type: REPORT_TYPES.DUE_OVERDUE,
        generated_at: new Date().toISOString(),
        filters: {
            person_id: pId,
            loan_id: aId,
            status: statusFilter,
            start_date: startDate,
            end_date: endDate,
            as_of_date: asOfDate
        },
        summary,
        items: pagedItems,
        pagination
    };
}

// ════════════════════════════════════════════════════════════════════
// 9G: COLLECTION REPORT
// ════════════════════════════════════════════════════════════════════

function generateCollectionReport(db, options = {}) {
    const { pId, aId } = validateScoping(db, options);

    const startDate = options.start_date || options.startDate || null;
    const endDate = options.end_date || options.endDate || null;
    validateDateRange(startDate, endDate);

    const asOfDate = resolveAsOfDate(options);

    const evaluated = fetchAccountsWithFinancials(db, {
        person_id: pId,
        account_id: aId,
        as_of_date: asOfDate,
        grace_period: options.grace_period
    });

    // Collection inclusion: OVERDUE and outstanding amount > 0 (8A.7, 9G.1)
    let collectionTargets = evaluated.filter(item => item.is_overdue && item.total_outstanding_paisa > 0);

    if (startDate) {
        collectionTargets = collectionTargets.filter(item => item.due_date && item.due_date >= startDate);
    }
    if (endDate) {
        collectionTargets = collectionTargets.filter(item => item.due_date && item.due_date <= endDate);
    }

    // Ordering: Oldest due date first (9G.3)
    collectionTargets.sort((a, b) => {
        if (a.due_date !== b.due_date) {
            return a.due_date.localeCompare(b.due_date);
        }
        return a.loan_id - b.loan_id;
    });

    let totalCollectionAmountPaisa = 0;

    const items = collectionTargets.map(item => {
        totalCollectionAmountPaisa += item.amount_overdue_paisa;
        return {
            loan_id: item.loan_id,
            account_id: item.loan_id,
            person_id: item.person_id,
            person_name: item.person_name,
            due_date: item.due_date,
            overdue_since: item.overdue_since || item.due_date,
            days_overdue: item.days_overdue,
            status: item.status,

            outstanding_amount: item.outstanding_amount,
            outstanding_amount_paisa: item.total_outstanding_paisa,

            outstanding_principal: item.outstanding_principal,
            outstanding_principal_paisa: item.outstanding_principal_paisa,

            outstanding_interest: item.outstanding_interest,
            outstanding_interest_paisa: item.outstanding_interest_paisa,

            overdue_amount: item.amount_overdue,
            overdue_amount_paisa: item.amount_overdue_paisa
        };
    });

    const summary = {
        collection_count: items.length,
        total_collection_amount: Number((totalCollectionAmountPaisa / 100).toFixed(2)),
        total_collection_amount_paisa: totalCollectionAmountPaisa,
        as_of_date: asOfDate
    };

    const { pagedItems, pagination } = paginate(items, options);

    return {
        report_type: REPORT_TYPES.COLLECTION,
        generated_at: new Date().toISOString(),
        filters: {
            person_id: pId,
            loan_id: aId,
            start_date: startDate,
            end_date: endDate,
            as_of_date: asOfDate
        },
        summary,
        items: pagedItems,
        pagination
    };
}

// ════════════════════════════════════════════════════════════════════
// 9I: UNIFIED ENTRY POINT
// ════════════════════════════════════════════════════════════════════

function generateReport(db, request = {}) {
    if (!db) {
        const err = new Error('Database connection is required');
        err.statusCode = 500;
        throw err;
    }

    const rawType = request.report_type || request.type || request.reportType;
    const reportType = normalizeReportType(rawType);

    if (!reportType) {
        const err = new Error(`Invalid report type: '${rawType}'. Must be one of ${Object.values(REPORT_TYPES).join(', ')}`);
        err.statusCode = 400;
        throw err;
    }

    switch (reportType) {
        case REPORT_TYPES.LOAN_PORTFOLIO:
            return generateLoanPortfolioReport(db, request);
        case REPORT_TYPES.PEOPLE:
            return generatePeopleReport(db, request);
        case REPORT_TYPES.PAYMENTS:
            return generatePaymentReport(db, request);
        case REPORT_TYPES.INTEREST:
            return generateInterestReport(db, request);
        case REPORT_TYPES.DUE_OVERDUE:
            return generateDueOverdueReport(db, request);
        case REPORT_TYPES.COLLECTION:
            return generateCollectionReport(db, request);
        default: {
            const err = new Error(`Unsupported report type: ${reportType}`);
            err.statusCode = 400;
            throw err;
        }
    }
}

module.exports = {
    REPORT_TYPES,
    normalizeReportType,
    generateReport,
    generateLoanPortfolioReport,
    generatePeopleReport,
    generatePaymentReport,
    generateInterestReport,
    generateDueOverdueReport,
    generateCollectionReport,
    paginate,
    validateDateRange,
    validateScoping
};
