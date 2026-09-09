/**
 * Interest Manager — Step 6G: Interest Payment Integration Service
 *
 * Integrates persisted interest records (Step 6F) with the payment and transaction system (Part 5).
 *
 * Orchestration Flow:
 *   Payment Transaction (INTEREST_RECEIVED)
 *         ↓
 *   Interest Allocation (interest_allocations junction)
 *         ↓
 *   Interest Record Update (paid_amount, status: PARTIALLY_PAID / PAID)
 *         ↓
 *   Balance Determination (Recorded, Paid, Outstanding)
 *
 * Guarantees:
 *   - Financial Immutability: Recorded interest, principal basis, rate, and period are NEVER rewritten.
 *   - Settlement Updates: Only paid_amount and status transition (PENDING -> PARTIALLY_PAID -> PAID).
 *   - Overpayment Cascading: Overpayments beyond outstanding interest continue to remaining rules (principal).
 *   - Principal Protection: Interest payments do not unintentionally modify principal.
 *   - Multiple Records: Allocates across multiple interest records in deterministic FIFO order (period_start ASC, id ASC).
 *   - Junction Tracking: Every allocation is recorded in interest_allocations linking payment to interest record.
 *   - Reversal & Settlement Guardrails: Rejects payment to REVERSED records or fully settled records (no negative outstanding).
 *   - Account Guardrails: Rejects allocation across mismatched accounts.
 *   - Idempotency & Transactional Atomicity.
 */

const { queryOne, queryAll } = require('../db/helpers');
const { saveDatabase } = require('../db/connection');
const { normalizeDate } = require('./dateCalculationService');
const { getAccountInterestBalance } = require('./interestService');

/**
 * Calculates and returns the derived balance for a specific interest record.
 * Uses the actual persisted amounts from SQLite.
 *
 * @param {Object} db - Database connection
 * @param {Object|number} recordOrId - Interest record row or record ID
 * @returns {Object} Structured balance descriptor
 */
function getInterestRecordBalance(db, recordOrId) {
    let record = recordOrId;
    if (recordOrId && typeof recordOrId !== 'object') {
        if (!db) {
            const err = new Error('Database connection is required to fetch interest record by ID');
            err.statusCode = 500;
            throw err;
        }
        record = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [Number(recordOrId)]);
        if (!record) {
            const err = new Error(`Interest record #${recordOrId} not found`);
            err.statusCode = 404;
            throw err;
        }
    }

    if (!record || typeof record !== 'object') {
        const err = new Error('A valid interest record or record ID is required');
        err.statusCode = 400;
        throw err;
    }

    const recordedPaisa = Number(record.interest_amount);
    const paidPaisa = Number(record.paid_amount || 0);
    const isReversed = record.status === 'REVERSED';
    const outstandingPaisa = isReversed ? 0 : Math.max(0, recordedPaisa - paidPaisa);

    return {
        id: Number(record.id),
        interest_record_id: Number(record.id),
        account_id: Number(record.account_id),
        period_start: record.period_start,
        period_end: record.period_end,
        principal_basis: Number(record.principal_basis) / 100,
        principal_basis_paisa: Number(record.principal_basis),
        interest_rate: Number(record.interest_rate),
        calculation_method: record.calculation_method,
        // Recorded interest
        recorded_interest: recordedPaisa / 100,
        recorded_interest_paisa: recordedPaisa,
        interest_amount: recordedPaisa / 100,
        interest_amount_paisa: recordedPaisa,
        // Paid interest
        paid_interest: paidPaisa / 100,
        paid_interest_paisa: paidPaisa,
        paid_amount: paidPaisa / 100,
        paid_amount_paisa: paidPaisa,
        // Outstanding interest
        outstanding_interest: outstandingPaisa / 100,
        outstanding_interest_paisa: outstandingPaisa,
        outstanding_amount: outstandingPaisa / 100,
        outstanding_amount_paisa: outstandingPaisa,
        status: record.status,
        is_settled: outstandingPaisa === 0 && !isReversed,
        is_reversed: isReversed,
        created_at: record.created_at
    };
}

/**
 * Validates whether a payment allocation to an interest record is permissible.
 *
 * @param {Object} db - Database connection
 * @param {Object} params - Allocation parameters
 * @returns {Object} Validated entities { record, account, amountPaisa }
 */
function validateRecordAllocation(db, params) {
    const recordId = Number(params.interest_record_id || params.record_id);
    if (!recordId || isNaN(recordId) || recordId <= 0) {
        const err = new Error('A valid interest_record_id is required');
        err.statusCode = 400;
        throw err;
    }

    const record = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [recordId]);
    if (!record) {
        const err = new Error(`Interest record #${recordId} not found`);
        err.statusCode = 404;
        throw err;
    }

    // Account validation
    if (params.account_id !== undefined && params.account_id !== null) {
        const reqAccId = Number(params.account_id);
        if (reqAccId !== Number(record.account_id)) {
            const err = new Error(`Interest record #${recordId} belongs to Account #${record.account_id}, not Account #${reqAccId}`);
            err.statusCode = 400;
            throw err;
        }
    }

    const account = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [record.account_id]);
    if (!account) {
        const err = new Error(`Account #${record.account_id} not found`);
        err.statusCode = 404;
        throw err;
    }

    // Status checks
    if (record.status === 'REVERSED') {
        const err = new Error(`Cannot allocate payment to reversed interest record #${recordId}`);
        err.statusCode = 400;
        throw err;
    }

    const outstandingPaisa = Math.max(0, record.interest_amount - (record.paid_amount || 0));
    if (record.status === 'PAID' || outstandingPaisa <= 0) {
        const err = new Error(`Interest record #${recordId} is already fully settled (outstanding: ₹0.00)`);
        err.statusCode = 400;
        throw err;
    }

    // Amount validation
    const rawAmount = params.amount !== undefined ? params.amount : params.payment_amount;
    const isPaisa = params.is_paisa === true || params.isPaisa === true;
    const amountPaisa = isPaisa ? Math.round(Number(rawAmount)) : Math.round(Number(rawAmount) * 100);

    if (isNaN(amountPaisa) || amountPaisa <= 0) {
        const err = new Error('Payment allocation amount must be greater than zero');
        err.statusCode = 400;
        throw err;
    }

    return {
        record,
        account,
        amountPaisa
    };
}

/**
 * Allocates a payment directly to a specific interest record.
 * Handles partial payment, exact payment, and overpayment (capping allocation to outstanding).
 *
 * @param {Object} db - Database connection
 * @param {Object} params - Parameters:
 *   - interest_record_id: Target interest record ID
 *   - account_id: Optional matching account ID
 *   - amount: Payment amount (in rupees or paisa if is_paisa=true)
 *   - payment_method: 'CASH', 'UPI', 'BANK_TRANSFER', 'OTHER' (default 'CASH')
 *   - payment_date: Transaction date (YYYY-MM-DD or DD/MM/YYYY)
 *   - transaction_id: Existing transaction ID (optional, creates one if omitted)
 *   - payment_id: Payment group ID (optional)
 *   - reference: Payment reference (optional)
 *   - notes: Notes (optional)
 * @param {Object} [options] - Additional options (e.g. idempotencyKey)
 * @returns {Object} Allocation result DTO
 */
function allocatePaymentToInterestRecord(db, params, options = {}) {
    if (!db) {
        const err = new Error('Database connection is required for payment allocation');
        err.statusCode = 500;
        throw err;
    }

    // 1. Validate inputs and eligibility
    const { record, account, amountPaisa } = validateRecordAllocation(db, params);
    const recordId = record.id;
    const accountId = account.id;

    // Idempotency check: check if the exact transaction or payment was already allocated to this record
    if (params.transaction_id) {
        const existingAlloc = queryOne(db, `
            SELECT * FROM interest_allocations
            WHERE interest_record_id = ? AND transaction_id = ?
        `, [recordId, Number(params.transaction_id)]);

        if (existingAlloc) {
            const currentBal = getInterestRecordBalance(db, record);
            return {
                status: 'ALREADY_ALLOCATED',
                allocation_id: existingAlloc.id,
                interest_record_id: recordId,
                account_id: accountId,
                transaction_id: existingAlloc.transaction_id,
                allocated_amount: existingAlloc.amount / 100,
                allocated_amount_paisa: existingAlloc.amount,
                remaining_payment: 0,
                remaining_payment_paisa: 0,
                recorded_interest: currentBal.recorded_interest,
                paid_interest: currentBal.paid_interest,
                outstanding_interest: currentBal.outstanding_interest,
                new_status: currentBal.status,
                is_duplicate: true,
                is_settled: currentBal.is_settled,
                message: `Payment transaction #${params.transaction_id} is already allocated to interest record #${recordId}`
            };
        }
    }

    // 2. Compute allocation and overpayment
    const neededPaisa = record.interest_amount - (record.paid_amount || 0);
    const allocatedPaisa = Math.min(amountPaisa, neededPaisa);
    const remainingPaisa = amountPaisa - allocatedPaisa;

    const newPaidPaisa = (record.paid_amount || 0) + allocatedPaisa;
    const newStatus = newPaidPaisa >= record.interest_amount ? 'PAID' : 'PARTIALLY_PAID';

    const dateStr = normalizeDate(params.payment_date || params.transaction_date) || new Date().toISOString().split('T')[0];
    const method = params.payment_method || 'CASH';
    const paymentId = params.payment_id || ('PAY-' + Date.now() + '-' + Math.floor(Math.random() * 1000).toString().padStart(3, '0'));
    const refText = params.reference ? String(params.reference).trim() : null;
    const notesText = params.notes ? String(params.notes).trim() : null;

    let transactionId = params.transaction_id ? Number(params.transaction_id) : null;
    let createdTransaction = null;
    let allocationRow = null;

    try {
        db.run('BEGIN TRANSACTION');

        // Fresh check inside transaction lock
        const freshRecord = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [recordId]);
        if (freshRecord.status === 'REVERSED') {
            const err = new Error(`Cannot allocate payment to reversed interest record #${recordId}`);
            err.statusCode = 400;
            throw err;
        }
        const freshNeeded = freshRecord.interest_amount - (freshRecord.paid_amount || 0);
        if (freshNeeded <= 0) {
            const err = new Error(`Interest record #${recordId} is already fully settled`);
            err.statusCode = 400;
            throw err;
        }

        // Create transaction if not provided
        if (!transactionId) {
            db.run(`
                INSERT INTO transactions (
                    account_id, person_id, transaction_type, amount,
                    payment_method, transaction_date, payment_id, reference, notes
                ) VALUES (?, ?, 'INTEREST_RECEIVED', ?, ?, ?, ?, ?, ?)
            `, [accountId, account.person_id, allocatedPaisa, method, dateStr, paymentId, refText, notesText]);

            const lastTx = queryOne(db, 'SELECT last_insert_rowid() as id');
            transactionId = lastTx.id;
            createdTransaction = queryOne(db, 'SELECT * FROM transactions WHERE id = ?', [transactionId]);

            db.run(`
                INSERT INTO audit_logs (entity_type, entity_id, action, new_value)
                VALUES ('TRANSACTION', ?, 'CREATE', ?)
            `, [transactionId, JSON.stringify(createdTransaction)]);
        }

        // Update interest record (paid_amount, status) — FINANCIAL IMMUTABILITY preserved
        db.run(`
            UPDATE interest_records
            SET paid_amount = ?, status = ?
            WHERE id = ?
        `, [newPaidPaisa, newStatus, recordId]);

        // Insert into interest_allocations junction
        db.run(`
            INSERT INTO interest_allocations (account_id, interest_record_id, transaction_id, amount)
            VALUES (?, ?, ?, ?)
        `, [accountId, recordId, transactionId, allocatedPaisa]);

        const lastAlloc = queryOne(db, 'SELECT last_insert_rowid() as id');
        allocationRow = queryOne(db, 'SELECT * FROM interest_allocations WHERE id = ?', [lastAlloc.id]);

        // Audit the payment allocation
        const auditPayload = {
            event_type: 'PAYMENT_ALLOCATED_TO_INTEREST',
            account_id: accountId,
            interest_record_id: recordId,
            transaction_id: transactionId,
            payment_id: paymentId,
            allocated_amount: allocatedPaisa,
            allocated_amount_rupees: allocatedPaisa / 100,
            remaining_amount: remainingPaisa,
            remaining_amount_rupees: remainingPaisa / 100,
            previous_paid_amount: record.paid_amount || 0,
            new_paid_amount: newPaidPaisa,
            new_status: newStatus,
            allocated_at: new Date().toISOString()
        };

        db.run(`
            INSERT INTO audit_logs (entity_type, entity_id, action, new_value)
            VALUES ('INTEREST_RECORD', ?, 'PAYMENT_ALLOCATED', ?)
        `, [recordId, JSON.stringify(auditPayload)]);

        db.run('COMMIT');
        saveDatabase();
    } catch (err) {
        try { db.run('ROLLBACK'); } catch (_) {}
        throw err;
    }

    const outstandingAfterPaisa = record.interest_amount - newPaidPaisa;

    return {
        status: 'SUCCESS',
        allocation_id: allocationRow ? allocationRow.id : null,
        interest_record_id: recordId,
        account_id: accountId,
        payment_id: paymentId,
        transaction_id: transactionId,
        allocated_amount: allocatedPaisa / 100,
        allocated_amount_paisa: allocatedPaisa,
        remaining_payment: remainingPaisa / 100,
        remaining_payment_paisa: remainingPaisa,
        // Balances
        recorded_interest: record.interest_amount / 100,
        recorded_interest_paisa: record.interest_amount,
        paid_interest: newPaidPaisa / 100,
        paid_interest_paisa: newPaidPaisa,
        outstanding_interest: outstandingAfterPaisa / 100,
        outstanding_interest_paisa: outstandingAfterPaisa,
        previous_status: record.status,
        new_status: newStatus,
        is_settled: newStatus === 'PAID',
        is_duplicate: false
    };
}

/**
 * Allocates a payment with cascading overpayment logic:
 *   Payment -> Outstanding Interest (FIFO or target record) -> Excess to Principal.
 *
 * Preserves principal protection: Principal is untouched unless an overpayment remains
 * that explicitly cascades to principal.
 *
 * @param {Object} db - Database connection
 * @param {Object} data - Payment data { account_id, total_amount, payment_method, payment_date, interest_record_id, reference, notes }
 * @param {string} [idempotencyKey] - Optional idempotency key
 * @returns {Object} Structured payment result DTO
 */
async function allocatePaymentWithCascading(db, data, idempotencyKey = null) {
    const { allocatePayment } = require('./transactionService');

    const accountId = Number(data.account_id);
    if (!accountId || isNaN(accountId)) {
        const err = new Error('Valid account_id is required');
        err.statusCode = 400;
        throw err;
    }

    const totalAmount = Number(data.total_amount !== undefined ? data.total_amount : data.amount);
    if (isNaN(totalAmount) || totalAmount <= 0) {
        const err = new Error('Total payment amount must be greater than zero');
        err.statusCode = 400;
        throw err;
    }

    const totalPaisa = Math.round(totalAmount * 100);

    // Determine target interest capacity
    let targetInterestPaisa = 0;

    if (data.interest_record_id) {
        // Targeted allocation to a specific interest record
        const recordBal = getInterestRecordBalance(db, data.interest_record_id);
        if (recordBal.account_id !== accountId) {
            const err = new Error(`Interest record #${data.interest_record_id} belongs to Account #${recordBal.account_id}, not Account #${accountId}`);
            err.statusCode = 400;
            throw err;
        }
        if (recordBal.is_reversed) {
            const err = new Error(`Cannot allocate payment to reversed interest record #${data.interest_record_id}`);
            err.statusCode = 400;
            throw err;
        }
        if (recordBal.outstanding_interest_paisa <= 0) {
            const err = new Error(`Interest record #${data.interest_record_id} is already fully settled (outstanding: ₹0.00)`);
            err.statusCode = 400;
            throw err;
        }
        targetInterestPaisa = recordBal.outstanding_interest_paisa;
    } else {
        // Account-wide interest capacity in FIFO order
        const interestBalance = getAccountInterestBalance(db, accountId);
        targetInterestPaisa = interestBalance.interestOutstandingPaisa;
    }

    // Split between interest and principal
    let interestPaisa = 0;
    let principalPaisa = 0;

    if (data.interest_amount !== undefined && data.principal_amount !== undefined && !data.auto_allocate && !data.cascade_overpayment) {
        // Caller explicitly provided both portions; respect explicit split
        interestPaisa = Math.round(Number(data.interest_amount) * 100);
        principalPaisa = Math.round(Number(data.principal_amount) * 100);
    } else if (data.interest_amount !== undefined && data.principal_amount === undefined) {
        // Caller specified interest amount; cap to available capacity and cascade remainder to principal
        const requestedInterestPaisa = Math.round(Number(data.interest_amount) * 100);
        interestPaisa = Math.min(requestedInterestPaisa, targetInterestPaisa);
        principalPaisa = totalPaisa - interestPaisa;
    } else {
        // Auto-allocation / cascading: interest first, excess to principal
        interestPaisa = Math.min(totalPaisa, targetInterestPaisa);
        principalPaisa = totalPaisa - interestPaisa;
    }

    const payload = {
        ...data,
        total_amount: totalPaisa / 100,
        interest_amount: interestPaisa / 100,
        principal_amount: principalPaisa / 100
    };

    return allocatePayment(db, payload, idempotencyKey);
}

module.exports = {
    getInterestRecordBalance,
    validateRecordAllocation,
    allocatePaymentToInterestRecord,
    allocatePaymentWithCascading
};
