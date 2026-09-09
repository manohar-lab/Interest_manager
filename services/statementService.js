/**
 * Interest Manager — Part 10: Person Statement Service
 *
 * Dedicated domain presentation and reporting service responsible for:
 *   - 10A: Statement architecture & DTO contracts (Person & Loan statements)
 *   - 10B: Authoritative data aggregation across People, Loans, Transactions, Interest, and Due/Overdue
 *   - 10C: Authoritative Opening and Closing Balance derivation
 *   - 10D: Chronological Transaction History with running balance computation
 *   - 10E: Part 6 Interest & Part 8 Due/Overdue status integration
 *   - 10F: Strict validation and customer-level authorization
 *
 * Guarantees:
 *   - READ-ONLY: Pure aggregation queries, zero database mutations.
 *   - NO SECOND ENGINES: Strictly reuses accounts.outstanding_principal (Part 3/5),
 *     interest_records (Part 6), and dueTrackingService (Part 8).
 *   - DETERMINISTIC: Clock abstraction (as_of_date) & deterministic secondary sorting.
 *   - EXACT MONEY: Arithmetic in integer paisa; 2-decimal rupee precision for display.
 *   - AUTHORIZED: Enforces customer ownership of requested loans.
 */

const { queryOne, queryAll } = require('../db/helpers');
const {
    fetchAccountsWithFinancials,
    evaluateObligation,
    resolveAsOfDate
} = require('./dueTrackingService');

/**
 * Validates request parameters and scoping for statements (10F.2).
 */
function validateStatementRequest(db, personId, options = {}) {
    const pId = Number(personId);
    if (!personId || isNaN(pId) || pId <= 0) {
        const err = new Error('A valid person_id is required');
        err.statusCode = 400;
        throw err;
    }

    const person = queryOne(db, 'SELECT id, name, phone, address, notes, created_at FROM people WHERE id = ?', [pId]);
    if (!person) {
        const err = new Error(`Person #${pId} not found`);
        err.statusCode = 404;
        throw err;
    }

    const accountId = options.loan_id || options.loanId || options.account_id || options.accountId;
    let aId = null;
    if (accountId !== undefined && accountId !== null && accountId !== '') {
        aId = Number(accountId);
        if (isNaN(aId) || aId <= 0) {
            const err = new Error('A valid loan_id is required');
            err.statusCode = 400;
            throw err;
        }

        const account = queryOne(db, 'SELECT id, person_id, status FROM accounts WHERE id = ?', [aId]);
        if (!account) {
            const err = new Error(`Loan #${aId} not found`);
            err.statusCode = 404;
            throw err;
        }
        if (account.person_id !== pId) {
            const err = new Error(`Loan #${aId} does not belong to Person #${pId}`);
            err.statusCode = 403;
            throw err;
        }
    }

    const startDate = options.start_date || options.startDate || null;
    const endDate = options.end_date || options.endDate || null;

    if (startDate && endDate && startDate > endDate) {
        const err = new Error('start_date cannot be after end_date');
        err.statusCode = 400;
        throw err;
    }

    return { person, pId, aId, startDate, endDate };
}

/**
 * Generates a comprehensive financial statement for a person (10B).
 * Optionally filters to a single authorized loan.
 *
 * @param {Object} db - Database connection (sql.js)
 * @param {number|string} personId - ID of the person
 * @param {Object} [options={}] - Statement options (start_date, end_date, loan_id, as_of_date)
 * @returns {Object} Complete Statement DTO
 */
function generatePersonStatement(db, personId, options = {}) {
    if (!db) {
        const err = new Error('Database connection is required');
        err.statusCode = 500;
        throw err;
    }

    const { person, pId, aId, startDate, endDate } = validateStatementRequest(db, personId, options);
    const asOfDate = resolveAsOfDate(options);

    // ─── 1. Gather Loans & Obligations (10B.2, 10B.3, 10B.4) ────────
    const evaluatedAccounts = fetchAccountsWithFinancials(db, {
        person_id: pId,
        account_id: aId,
        as_of_date: asOfDate,
        grace_period: options.grace_period
    });

    const targetAccountIds = evaluatedAccounts.map(a => a.loan_id);

    // ─── 2. Calculate Opening Balance (10C.1, 10C.3) ─────────────────
    // If no start_date: opening balance is 0 paisa
    // If start_date: authoritative balance immediately prior to start_date
    let openingBalancePaisa = 0;

    if (startDate && targetAccountIds.length > 0) {
        const placeholders = targetAccountIds.map(() => '?').join(',');

        // 2a. Principal lent prior to start_date
        const priorPrincipalRow = queryOne(db, `
            SELECT COALESCE(SUM(principal), 0) as total_principal_paisa
            FROM accounts
            WHERE id IN (${placeholders}) AND start_date < ?
        `, [...targetAccountIds, startDate]);
        const priorPrincipalGivenPaisa = priorPrincipalRow ? Number(priorPrincipalRow.total_principal_paisa || 0) : 0;

        // 2b. Payments received prior to start_date
        const priorTxRow = queryOne(db, `
            SELECT COALESCE(SUM(amount), 0) as total_paid_paisa
            FROM transactions
            WHERE account_id IN (${placeholders})
              AND transaction_type IN ('PRINCIPAL_RECEIVED', 'INTEREST_RECEIVED', 'MONEY_RECEIVED')
              AND transaction_date < ?
        `, [...targetAccountIds, startDate]);
        const priorPaidPaisa = priorTxRow ? Number(priorTxRow.total_paid_paisa || 0) : 0;

        // 2c. Interest accrued prior to start_date
        const priorInterestRow = queryOne(db, `
            SELECT COALESCE(SUM(interest_amount), 0) as total_interest_paisa
            FROM interest_records
            WHERE account_id IN (${placeholders})
              AND period_end < ?
              AND status != 'REVERSED'
        `, [...targetAccountIds, startDate]);
        const priorInterestAccruedPaisa = priorInterestRow ? Number(priorInterestRow.total_interest_paisa || 0) : 0;

        openingBalancePaisa = Math.max(0, priorPrincipalGivenPaisa + priorInterestAccruedPaisa - priorPaidPaisa);
    }

    // ─── 3. Chronological Transactions & Running Balance (10D) ─────────
    const txConditions = [];
    const txParams = [];

    if (targetAccountIds.length > 0) {
        const placeholders = targetAccountIds.map(() => '?').join(',');
        txConditions.push(`t.account_id IN (${placeholders})`);
        txParams.push(...targetAccountIds);
    } else {
        txConditions.push('1 = 0');
    }

    if (startDate) {
        txConditions.push('t.transaction_date >= ?');
        txParams.push(startDate);
    }
    if (endDate) {
        txConditions.push('t.transaction_date <= ?');
        txParams.push(endDate);
    }

    const txWhere = txConditions.length > 0 ? `WHERE ${txConditions.join(' AND ')}` : '';
    const txSql = `
        SELECT
            t.id as transaction_id,
            t.account_id as loan_id,
            t.person_id,
            p.name as person_name,
            t.transaction_type,
            t.amount as amount_paisa,
            t.payment_method,
            t.transaction_date,
            t.payment_id,
            t.reference,
            t.notes
        FROM transactions t
        JOIN people p ON t.person_id = p.id
        ${txWhere}
        ORDER BY t.transaction_date ASC, t.id ASC
    `;

    const txRows = targetAccountIds.length > 0 ? queryAll(db, txSql, txParams) : [];

    let runningBalancePaisa = openingBalancePaisa;
    let periodDebitPaisa = 0;
    let periodCreditPaisa = 0;

    const paymentTypes = new Set(['PRINCIPAL_RECEIVED', 'INTEREST_RECEIVED', 'MONEY_RECEIVED']);

    const statementTransactions = txRows.map(r => {
        const amt = Number(r.amount_paisa || 0);
        let debitPaisa = 0;
        let creditPaisa = 0;
        let description = '';

        if (paymentTypes.has(r.transaction_type)) {
            // Payment received reduces customer balance (Credit)
            creditPaisa = amt;
            periodCreditPaisa += amt;
            runningBalancePaisa = Math.max(0, runningBalancePaisa - amt);
            description = r.transaction_type === 'INTEREST_RECEIVED'
                ? `Interest payment received via ${r.payment_method}`
                : `Payment received via ${r.payment_method}`;
        } else {
            // Disbursement / lending increases customer balance (Debit)
            debitPaisa = amt;
            periodDebitPaisa += amt;
            runningBalancePaisa += amt;
            description = r.transaction_type === 'MONEY_LENT'
                ? `Loan disbursement via ${r.payment_method}`
                : `Disbursement via ${r.payment_method}`;
        }

        if (r.reference) {
            description += ` (Ref: ${r.reference})`;
        }

        return {
            id: r.transaction_id,
            transaction_id: r.transaction_id,
            loan_id: r.loan_id,
            account_id: r.loan_id,
            date: r.transaction_date,
            transaction_date: r.transaction_date,
            type: r.transaction_type,
            transaction_type: r.transaction_type,
            description,
            payment_method: r.payment_method,
            reference: r.reference,
            payment_id: r.payment_id,
            notes: r.notes,

            amount: Number((amt / 100).toFixed(2)),
            amount_paisa: amt,

            debit: Number((debitPaisa / 100).toFixed(2)),
            debit_paisa: debitPaisa,

            credit: Number((creditPaisa / 100).toFixed(2)),
            credit_paisa: creditPaisa,

            running_balance: Number((runningBalancePaisa / 100).toFixed(2)),
            running_balance_paisa: runningBalancePaisa
        };
    });

    // ─── 4. Interest Section (10E.1) ─────────────────────────────────
    let totalInterestPaisa = 0;
    let paidInterestPaisa = 0;
    let outstandingInterestPaisa = 0;
    let interestRecordsCount = 0;

    if (targetAccountIds.length > 0) {
        const placeholders = targetAccountIds.map(() => '?').join(',');
        const intConditions = [`account_id IN (${placeholders})`, "status != 'REVERSED'"];
        const intParams = [...targetAccountIds];

        if (startDate) {
            intConditions.push('period_start >= ?');
            intParams.push(startDate);
        }
        if (endDate) {
            intConditions.push('period_end <= ?');
            intParams.push(endDate);
        }

        const intSql = `
            SELECT
                COALESCE(SUM(interest_amount), 0) as total_interest_paisa,
                COALESCE(SUM(paid_amount), 0) as paid_interest_paisa,
                COUNT(*) as count
            FROM interest_records
            WHERE ${intConditions.join(' AND ')}
        `;
        const intRow = queryOne(db, intSql, intParams);
        if (intRow) {
            totalInterestPaisa = Number(intRow.total_interest_paisa || 0);
            paidInterestPaisa = Number(intRow.paid_interest_paisa || 0);
            outstandingInterestPaisa = Math.max(0, totalInterestPaisa - paidInterestPaisa);
            interestRecordsCount = Number(intRow.count || 0);
        }

        const intRecordsSql = `
            SELECT id, account_id, period_start, period_end, principal_basis, interest_rate, interest_amount, paid_amount, status, created_at
            FROM interest_records
            WHERE ${intConditions.join(' AND ')}
            ORDER BY period_start ASC, id ASC
        `;
        const rawIntRecords = queryAll(db, intRecordsSql, intParams);
        var intRecords = rawIntRecords.map(r => ({
            id: r.id,
            account_id: r.account_id,
            period_start: r.period_start,
            period_end: r.period_end,
            principal_basis: Number((r.principal_basis / 100).toFixed(2)),
            principal_basis_paisa: r.principal_basis,
            interest_rate: r.interest_rate,
            interest_amount: Number((r.interest_amount / 100).toFixed(2)),
            interest_amount_paisa: r.interest_amount,
            paid_amount: Number((r.paid_amount / 100).toFixed(2)),
            paid_amount_paisa: r.paid_amount,
            outstanding_amount: Number(((r.interest_amount - r.paid_amount) / 100).toFixed(2)),
            outstanding_amount_paisa: r.interest_amount - r.paid_amount,
            status: r.status,
            created_at: r.created_at
        }));
    } else {
        var intRecords = [];
    }

    // ─── 5. Due / Overdue Section (10E.2, 10E.3, 10E.4) ──────────────
    let dueAmountPaisa = 0;
    let overdueAmountPaisa = 0;
    let dueCount = 0;
    let overdueCount = 0;
    let overallStatus = 'PAID';

    const loansList = evaluatedAccounts.map(loan => {
        if (loan.is_due) {
            dueCount++;
            dueAmountPaisa += loan.amount_due_paisa;
        }
        if (loan.is_overdue) {
            overdueCount++;
            overdueAmountPaisa += loan.amount_overdue_paisa;
        }

        return {
            id: loan.loan_id,
            loan_id: loan.loan_id,
            account_id: loan.loan_id,
            direction: loan.direction,
            start_date: loan.start_date,
            due_date: loan.due_date,
            grace_period: loan.grace_period,
            grace_end_date: loan.grace_end_date,
            status: loan.status,
            loan_status: loan.persisted_status,
            interest_rate: loan.interest_rate,
            interest_frequency: loan.interest_frequency,
            calculation_method: loan.calculation_method,
            days_overdue: loan.days_overdue,
            overdue_since: loan.overdue_since,

            principal: loan.original_principal,
            principal_paisa: loan.original_principal_paisa,

            paid: loan.paid_amount,
            paid_paisa: loan.total_paid_paisa,

            outstanding_principal: loan.outstanding_principal,
            outstanding_principal_paisa: loan.outstanding_principal_paisa,

            interest: loan.outstanding_interest,
            interest_paisa: loan.outstanding_interest_paisa,

            outstanding: loan.outstanding_amount,
            outstanding_paisa: loan.total_outstanding_paisa,

            amount_due: loan.amount_due,
            amount_due_paisa: loan.amount_due_paisa,

            amount_overdue: loan.amount_overdue,
            amount_overdue_paisa: loan.amount_overdue_paisa
        };
    });

    // Derive overall status for the person/statement
    if (overdueCount > 0) {
        overallStatus = 'OVERDUE';
    } else if (dueCount > 0) {
        overallStatus = 'DUE';
    } else if (evaluatedAccounts.some(a => a.is_partially_paid)) {
        overallStatus = 'PARTIALLY_PAID';
    } else if (evaluatedAccounts.some(a => a.is_current)) {
        overallStatus = 'CURRENT';
    } else if (evaluatedAccounts.some(a => a.is_closed)) {
        overallStatus = evaluatedAccounts.every(a => a.is_closed) ? 'CLOSED' : 'PAID';
    }

    // ─── 6. Closing Balance (10C.2, 10C.4, 10C.5) ─────────────────────
    // If no end_date: closing balance is the current total outstanding
    // If end_date specified: balance derived from opening + debits - credits
    let closingBalancePaisa = 0;
    if (!endDate || endDate >= asOfDate) {
        closingBalancePaisa = evaluatedAccounts.reduce((sum, a) => sum + a.total_outstanding_paisa, 0);
    } else {
        closingBalancePaisa = runningBalancePaisa;
    }

    // ─── 7. Statement Summary Totals ──────────────────────────────────
    const totalPrincipalPaisa = evaluatedAccounts.reduce((sum, a) => sum + a.original_principal_paisa, 0);
    const totalPaidPaisa = evaluatedAccounts.reduce((sum, a) => sum + a.total_paid_paisa, 0);
    const outstandingPrincipalPaisa = evaluatedAccounts.reduce((sum, a) => sum + a.outstanding_principal_paisa, 0);
    const allOutstandingInterestPaisa = evaluatedAccounts.reduce((sum, a) => sum + a.outstanding_interest_paisa, 0);
    const totalOutstandingPaisa = outstandingPrincipalPaisa + allOutstandingInterestPaisa;

    const summary = {
        total_loans: evaluatedAccounts.length,
        active_loans: evaluatedAccounts.filter(a => !a.is_closed).length,
        closed_loans: evaluatedAccounts.filter(a => a.is_closed).length,

        total_principal: Number((totalPrincipalPaisa / 100).toFixed(2)),
        total_principal_paisa: totalPrincipalPaisa,

        total_paid: Number((totalPaidPaisa / 100).toFixed(2)),
        total_paid_paisa: totalPaidPaisa,
        total_payments: Number((totalPaidPaisa / 100).toFixed(2)),
        total_payments_paisa: totalPaidPaisa,

        outstanding_principal: Number((outstandingPrincipalPaisa / 100).toFixed(2)),
        outstanding_principal_paisa: outstandingPrincipalPaisa,

        total_interest: Number((totalInterestPaisa / 100).toFixed(2)),
        total_interest_paisa: totalInterestPaisa,

        outstanding_interest: Number((allOutstandingInterestPaisa / 100).toFixed(2)),
        outstanding_interest_paisa: allOutstandingInterestPaisa,

        total_outstanding: Number((totalOutstandingPaisa / 100).toFixed(2)),
        total_outstanding_paisa: totalOutstandingPaisa,

        opening_balance: Number((openingBalancePaisa / 100).toFixed(2)),
        opening_balance_paisa: openingBalancePaisa,

        closing_balance: Number((closingBalancePaisa / 100).toFixed(2)),
        closing_balance_paisa: closingBalancePaisa,

        period_debits: Number((periodDebitPaisa / 100).toFixed(2)),
        period_debits_paisa: periodDebitPaisa,
        total_debit: Number((periodDebitPaisa / 100).toFixed(2)),
        total_debit_paisa: periodDebitPaisa,

        period_credits: Number((periodCreditPaisa / 100).toFixed(2)),
        period_credits_paisa: periodCreditPaisa,
        total_credit: Number((periodCreditPaisa / 100).toFixed(2)),
        total_credit_paisa: periodCreditPaisa,

        due_amount: Number((dueAmountPaisa / 100).toFixed(2)),
        due_amount_paisa: dueAmountPaisa,

        overdue_amount: Number((overdueAmountPaisa / 100).toFixed(2)),
        overdue_amount_paisa: overdueAmountPaisa,
        total_overdue: Number((overdueAmountPaisa / 100).toFixed(2)),
        total_overdue_paisa: overdueAmountPaisa,

        status: overallStatus
    };

    return {
        statement_type: aId ? 'LOAN_STATEMENT' : 'PERSON_STATEMENT',
        generated_at: new Date().toISOString(),
        as_of_date: asOfDate,
        person: {
            person_id: person.id,
            id: person.id,
            name: person.name,
            phone: person.phone,
            address: person.address || 'N/A',
            created_at: person.created_at
        },
        period: {
            start_date: startDate || 'All History',
            end_date: endDate || asOfDate,
            has_start_date: Boolean(startDate),
            has_end_date: Boolean(endDate)
        },
        filters: {
            person_id: pId,
            loan_id: aId,
            start_date: startDate,
            end_date: endDate,
            as_of_date: asOfDate
        },
        summary,
        loans: loansList,
        opening_balance: Number((openingBalancePaisa / 100).toFixed(2)),
        opening_balance_paisa: openingBalancePaisa,
        transactions: statementTransactions,
        interest: {
            records: intRecords,
            records_count: intRecords.length,
            total_interest: Number((totalInterestPaisa / 100).toFixed(2)),
            total_interest_paisa: totalInterestPaisa,
            paid_interest: Number((paidInterestPaisa / 100).toFixed(2)),
            paid_interest_paisa: paidInterestPaisa,
            outstanding_interest: Number((outstandingInterestPaisa / 100).toFixed(2)),
            outstanding_interest_paisa: outstandingInterestPaisa,
            summary: {
                total_interest: Number((totalInterestPaisa / 100).toFixed(2)),
                total_interest_paisa: totalInterestPaisa,
                paid_interest: Number((paidInterestPaisa / 100).toFixed(2)),
                paid_interest_paisa: paidInterestPaisa,
                outstanding_interest: Number((outstandingInterestPaisa / 100).toFixed(2)),
                outstanding_interest_paisa: outstandingInterestPaisa,
                records_count: intRecords.length
            }
        },
        due_overdue: {
            obligations: loansList,
            due_count: dueCount,
            overdue_count: overdueCount,
            due_amount: Number((dueAmountPaisa / 100).toFixed(2)),
            due_amount_paisa: dueAmountPaisa,
            overdue_amount: Number((overdueAmountPaisa / 100).toFixed(2)),
            overdue_amount_paisa: overdueAmountPaisa,
            total_overdue: Number((overdueAmountPaisa / 100).toFixed(2)),
            status: overallStatus,
            summary: {
                due_count: dueCount,
                overdue_count: overdueCount,
                due_amount: Number((dueAmountPaisa / 100).toFixed(2)),
                due_amount_paisa: dueAmountPaisa,
                overdue_amount: Number((overdueAmountPaisa / 100).toFixed(2)),
                overdue_amount_paisa: overdueAmountPaisa,
                total_overdue: Number((overdueAmountPaisa / 100).toFixed(2)),
                status: overallStatus
            }
        },
        closing_balance: Number((closingBalancePaisa / 100).toFixed(2)),
        closing_balance_paisa: closingBalancePaisa
    };
}

const STATEMENT_TYPES = {
    PERSON_STATEMENT: 'PERSON_STATEMENT',
    LOAN_STATEMENT: 'LOAN_STATEMENT'
};

function getStatementByLoanId(db, loanId, options = {}) {
    if (!loanId) {
        const err = new Error('A valid loan_id is required');
        err.statusCode = 400;
        throw err;
    }
    const acc = queryOne(db, 'SELECT person_id FROM accounts WHERE id = ?', [loanId]);
    if (!acc) {
        const err = new Error(`Loan #${loanId} not found`);
        err.statusCode = 404;
        throw err;
    }
    return generatePersonStatement(db, acc.person_id, { ...options, loan_id: loanId });
}

module.exports = {
    STATEMENT_TYPES,
    generatePersonStatement,
    getStatementByLoanId,
    validateStatementRequest
};
