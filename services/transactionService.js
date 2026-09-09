/**
 * Interest Manager — Transaction Creation Service
 * Reusable backend service for creating financial transactions safely.
 * Implements strict validation, account/person verification, idempotency protection, and audit logging.
 * IMPORTANT: Does NOT modify account outstanding principal or interest balances in Step 4A.
 */

const { queryOne, queryAll } = require('../db/helpers');
const { saveDatabase } = require('../db/connection');
const { getAccountInterestBalance, allocateInterestPaymentToRecords } = require('./interestService');

const VALID_TRANSACTION_TYPES = [
    'MONEY_RECEIVED', 'MONEY_LENT',
    'INTEREST_RECEIVED', 'INTEREST_PAID',
    'PRINCIPAL_RECEIVED', 'PRINCIPAL_PAID',
    'EXPENSE', 'LOSS', 'OTHER'
];

const VALID_PAYMENT_METHODS = ['CASH', 'UPI', 'BANK_TRANSFER', 'OTHER'];

// Memory cache for recent idempotency keys (cleared automatically)
const recentIdempotencyKeys = new Map();

/**
 * Validate transaction data object.
 * Returns array of error messages (empty if valid).
 */
function validateTransactionInput(data) {
    const errors = [];

    // Account ID required
    if (!data.account_id || isNaN(Number(data.account_id))) {
        errors.push('Valid account_id is required');
    }

    // Transaction Type required and valid
    if (!data.transaction_type || !VALID_TRANSACTION_TYPES.includes(data.transaction_type)) {
        errors.push(`Transaction type is invalid. Allowed: ${VALID_TRANSACTION_TYPES.join(', ')}`);
    }

    // Payment Method
    const method = data.payment_method || 'CASH';
    if (!VALID_PAYMENT_METHODS.includes(method)) {
        errors.push(`Payment method is invalid. Allowed: ${VALID_PAYMENT_METHODS.join(', ')}`);
    }

    // Amount must be > 0
    const amt = Number(data.amount);
    if (data.amount === undefined || data.amount === null || isNaN(amt) || amt <= 0) {
        errors.push('Transaction amount must be greater than zero');
    }

    // Date required
    if (!data.transaction_date || typeof data.transaction_date !== 'string') {
        errors.push('Valid transaction_date is required (YYYY-MM-DD or DD/MM/YYYY)');
    }

    return errors;
}

/**
 * Convert date string to canonical DB format YYYY-MM-DD
 */
function normalizeDate(dateStr) {
    if (!dateStr) return '';
    const trimmed = dateStr.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(trimmed)) {
        const [d, m, y] = trimmed.split('/');
        return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    return trimmed;
}

/**
 * Create a transaction.
 * @param {object} db - sql.js database instance
 * @param {object} data - transaction creation data
 * @param {string} [idempotencyKey] - optional idempotency key to prevent duplicates
 * @returns {object} created transaction object
 */
async function createTransaction(db, data, idempotencyKey = null) {
    // 1. Check idempotency key if provided
    const key = idempotencyKey || data.idempotency_key;
    if (key && recentIdempotencyKeys.has(key)) {
        const cachedTx = recentIdempotencyKeys.get(key);
        return { transaction: cachedTx, isDuplicate: true };
    }

    // 2. Validate input
    const validationErrors = validateTransactionInput(data);
    if (validationErrors.length > 0) {
        const err = new Error(validationErrors.join('. '));
        err.statusCode = 400;
        err.errors = validationErrors;
        throw err;
    }

    const accountId = Number(data.account_id);
    const method = data.payment_method || 'CASH';
    const txDate = normalizeDate(data.transaction_date);

    // Validate date format YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(txDate)) {
        const err = new Error('transaction_date must be a valid date format');
        err.statusCode = 400;
        throw err;
    }

    // 3. Verify referenced account exists
    const account = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accountId]);
    if (!account) {
        const err = new Error(`Account #${accountId} not found`);
        err.statusCode = 404;
        throw err;
    }

    // Verify person_id matches account.person_id
    if (data.person_id && Number(data.person_id) !== account.person_id) {
        const err = new Error(`Person #${data.person_id} does not match owner of Account #${accountId} (Person #${account.person_id})`);
        err.statusCode = 400;
        throw err;
    }
    const personId = account.person_id;
    const person = queryOne(db, 'SELECT * FROM people WHERE id = ?', [personId]);
    if (!person) {
        const err = new Error(`Person #${personId} not found`);
        err.statusCode = 404;
        throw err;
    }

    // Direction & Transaction Type Validation:
    // MONEY_GIVEN accounts allow: MONEY_LENT, INTEREST_RECEIVED, PRINCIPAL_RECEIVED
    // MONEY_TAKEN accounts allow: MONEY_RECEIVED, INTEREST_PAID, PRINCIPAL_PAID
    if (data.transaction_type === 'MONEY_LENT' && account.direction !== 'MONEY_GIVEN') {
        const err = new Error('Transaction type MONEY_LENT is only allowed for Money Lent (MONEY_GIVEN) accounts');
        err.statusCode = 400;
        throw err;
    }
    if (data.transaction_type === 'INTEREST_RECEIVED' && account.direction !== 'MONEY_GIVEN') {
        const err = new Error('Transaction type INTEREST_RECEIVED is only allowed for Money Lent (MONEY_GIVEN) accounts');
        err.statusCode = 400;
        throw err;
    }
    if (data.transaction_type === 'PRINCIPAL_RECEIVED' && account.direction !== 'MONEY_GIVEN') {
        const err = new Error('Transaction type PRINCIPAL_RECEIVED is only allowed for Money Lent (MONEY_GIVEN) accounts');
        err.statusCode = 400;
        throw err;
    }
    if (data.transaction_type === 'MONEY_RECEIVED' && account.direction !== 'MONEY_TAKEN') {
        const err = new Error('Transaction type MONEY_RECEIVED is only allowed for Money Taken (MONEY_TAKEN) accounts');
        err.statusCode = 400;
        throw err;
    }
    if (data.transaction_type === 'INTEREST_PAID' && account.direction !== 'MONEY_TAKEN') {
        const err = new Error('Transaction type INTEREST_PAID is only allowed for Money Taken (MONEY_TAKEN) accounts');
        err.statusCode = 400;
        throw err;
    }
    if (data.transaction_type === 'PRINCIPAL_PAID' && account.direction !== 'MONEY_TAKEN') {
        const err = new Error('Transaction type PRINCIPAL_PAID is only allowed for Money Taken (MONEY_TAKEN) accounts');
        err.statusCode = 400;
        throw err;
    }

    // Convert amount to paisa integer if decimal rupees provided
    let amountPaisa = Number(data.amount);
    if (data.isPaisa) {
        amountPaisa = Math.round(amountPaisa);
    } else {
        amountPaisa = Math.round(amountPaisa * 100);
    }

    if (amountPaisa <= 0) {
        const err = new Error('Transaction amount must be greater than zero');
        err.statusCode = 400;
        throw err;
    }

    // Initial funding transaction amount check (cannot exceed account.principal)
    if ((data.transaction_type === 'MONEY_LENT' || data.transaction_type === 'MONEY_RECEIVED') && amountPaisa > account.principal) {
        const err = new Error(`Transaction amount cannot exceed account principal (${account.principal / 100} INR)`);
        err.statusCode = 400;
        throw err;
    }

    // Principal payment amount check (cannot exceed current outstanding_principal)
    if (data.transaction_type === 'PRINCIPAL_RECEIVED' && amountPaisa > account.outstanding_principal) {
        const maxRupees = account.outstanding_principal / 100;
        const err = new Error(`Principal payment amount (₹${amountPaisa / 100}) cannot exceed current outstanding principal (₹${maxRupees})`);
        err.statusCode = 400;
        throw err;
    }

    // 4. Server-side rapid duplicate check (within last 5 seconds) if no explicit idempotency key
    if (!key) {
        const duplicateCheck = queryOne(db, `
            SELECT * FROM transactions
            WHERE account_id = ? AND transaction_type = ? AND amount = ? AND transaction_date = ? AND payment_method = ?
            AND datetime(created_at) >= datetime('now', '-5 seconds')
        `, [accountId, data.transaction_type, amountPaisa, txDate, method]);

        if (duplicateCheck) {
            return { transaction: duplicateCheck, isDuplicate: true };
        }
    }

    // 5. Execute atomic transaction (Transaction Creation + Account Balance Update if PRINCIPAL_RECEIVED)
    const refText = data.reference ? data.reference.trim() : null;
    const notesText = data.notes ? data.notes.trim() : null;

    let newTxId;
    let newTx;

    try {
        db.run('BEGIN TRANSACTION');

        // Re-verify current account balance inside transaction (concurrency protection)
        const freshAccount = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accountId]);
        if (!freshAccount) {
            const err = new Error(`Account #${accountId} not found`);
            err.statusCode = 404;
            throw err;
        }

        if (data.transaction_type === 'PRINCIPAL_RECEIVED' && amountPaisa > freshAccount.outstanding_principal) {
            const maxRupees = freshAccount.outstanding_principal / 100;
            const err = new Error(`Principal payment amount (₹${amountPaisa / 100}) cannot exceed current outstanding principal (₹${maxRupees})`);
            err.statusCode = 400;
            throw err;
        }

        // Insert transaction record
        const paymentId = data.payment_id || null;
        db.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount,
                payment_method, transaction_date, payment_id, reference, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [accountId, personId, data.transaction_type, amountPaisa, method, txDate, paymentId, refText, notesText]);

        const result = queryOne(db, 'SELECT last_insert_rowid() as id');
        newTxId = result.id;

        newTx = queryOne(db, `
            SELECT t.*, p.name as person_name
            FROM transactions t
            JOIN people p ON t.person_id = p.id
            WHERE t.id = ?
        `, [newTxId]);

        // Insert audit log for transaction
        db.run(
            `INSERT INTO audit_logs (entity_type, entity_id, action, new_value)
             VALUES ('TRANSACTION', ?, 'CREATE', ?)`,
            [newTxId, JSON.stringify(newTx)]
        );

        // If PRINCIPAL_RECEIVED, reduce account outstanding principal
        if (data.transaction_type === 'PRINCIPAL_RECEIVED') {
            const newOutstanding = freshAccount.outstanding_principal - amountPaisa;
            const newStatus = newOutstanding === 0 ? 'CLOSED' : (newOutstanding < freshAccount.principal ? 'PARTIALLY_PAID' : freshAccount.status);

            db.run(`
                UPDATE accounts
                SET outstanding_principal = ?, status = ?, updated_at = datetime('now')
                WHERE id = ?
            `, [newOutstanding, newStatus, accountId]);

            // Insert audit log for account balance change
            const updatedAccount = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accountId]);
            db.run(
                `INSERT INTO audit_logs (entity_type, entity_id, action, old_value, new_value)
                 VALUES ('ACCOUNT', ?, 'UPDATE', ?, ?)`,
                [accountId, JSON.stringify(freshAccount), JSON.stringify(updatedAccount)]
            );
        }

        db.run('COMMIT');
    } catch (err) {
        try { db.run('ROLLBACK'); } catch (_) {}
        throw err;
    }

    // Save DB to disk
    saveDatabase();

    // Cache idempotency key if provided
    if (key) {
        recentIdempotencyKeys.set(key, newTx);
        setTimeout(() => recentIdempotencyKeys.delete(key), 60000); // clear after 1 min
    }

    return { transaction: newTx, isDuplicate: false };
}

/**
 * Allocate a payment between Interest and Principal (Step 4E)
 * @param {object} db - sql.js database instance
 * @param {object} data - allocation data: { account_id, total_amount, interest_amount, principal_amount, payment_method, payment_date, reference, notes }
 * @param {string} [idempotencyKey] - optional idempotency key
 * @returns {object} { payment_id, transactions, isDuplicate, account }
 */
async function allocatePayment(db, data, idempotencyKey = null) {
    const key = idempotencyKey || data.idempotency_key;
    if (key && recentIdempotencyKeys.has(key)) {
        const cached = recentIdempotencyKeys.get(key);
        return { ...cached, isDuplicate: true };
    }

    const accountId = Number(data.account_id);
    if (!accountId || isNaN(accountId)) {
        const err = new Error('Valid account_id is required');
        err.statusCode = 400;
        throw err;
    }

    const account = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accountId]);
    if (!account) {
        const err = new Error(`Account #${accountId} not found`);
        err.statusCode = 404;
        throw err;
    }

    // Step 4E: Only MONEY_GIVEN accounts supported for payment allocation
    if (account.direction !== 'MONEY_GIVEN') {
        const err = new Error('Payment allocation is only supported for Money Lent (MONEY_GIVEN) accounts');
        err.statusCode = 400;
        throw err;
    }

    if (data.person_id && Number(data.person_id) !== account.person_id) {
        const err = new Error(`Person #${data.person_id} does not match owner of Account #${accountId} (Person #${account.person_id})`);
        err.statusCode = 400;
        throw err;
    }
    const personId = account.person_id;
    const method = data.payment_method || 'CASH';
    if (!VALID_PAYMENT_METHODS.includes(method)) {
        const err = new Error(`Payment method is invalid. Allowed: ${VALID_PAYMENT_METHODS.join(', ')}`);
        err.statusCode = 400;
        throw err;
    }

    const dateStr = normalizeDate(data.payment_date || data.transaction_date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const err = new Error('Valid payment_date is required (YYYY-MM-DD or DD/MM/YYYY)');
        err.statusCode = 400;
        throw err;
    }

    // Convert amounts to paisa
    const totalPaisa = Math.round(Number(data.total_amount !== undefined ? data.total_amount : data.amount) * 100);
    if (isNaN(totalPaisa) || totalPaisa <= 0) {
        const err = new Error('Total payment amount must be greater than zero');
        err.statusCode = 400;
        throw err;
    }

    // Step 6G: Support targeted interest_record_id validation & capacity check
    let targetRecord = null;
    let targetRecordOutstandingPaisa = 0;
    if (data.interest_record_id) {
        const recId = Number(data.interest_record_id);
        targetRecord = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [recId]);
        if (!targetRecord) {
            const err = new Error(`Interest record #${recId} not found`);
            err.statusCode = 404;
            throw err;
        }
        if (Number(targetRecord.account_id) !== accountId) {
            const err = new Error(`Interest record #${recId} belongs to Account #${targetRecord.account_id}, not Account #${accountId}`);
            err.statusCode = 400;
            throw err;
        }
        if (targetRecord.status === 'REVERSED') {
            const err = new Error(`Cannot allocate payment to reversed interest record #${recId}`);
            err.statusCode = 400;
            throw err;
        }
        targetRecordOutstandingPaisa = Math.max(0, targetRecord.interest_amount - (targetRecord.paid_amount || 0));
        if (targetRecord.status === 'PAID' || targetRecordOutstandingPaisa <= 0) {
            const err = new Error(`Interest record #${recId} is already fully settled (outstanding: ₹0.00)`);
            err.statusCode = 400;
            throw err;
        }
    }

    let interestPaisa = data.interest_amount !== undefined ? Math.round(Number(data.interest_amount) * 100) : null;
    let principalPaisa = data.principal_amount !== undefined ? Math.round(Number(data.principal_amount) * 100) : null;

    // Step 6G: Auto-allocation & Overpayment Cascading
    const interestBalance = getAccountInterestBalance(db, accountId);
    const maxAvailableInterest = targetRecord ? targetRecordOutstandingPaisa : interestBalance.interestOutstandingPaisa;

    if (data.auto_allocate === true || (interestPaisa === null && principalPaisa === null)) {
        interestPaisa = Math.min(totalPaisa, maxAvailableInterest);
        principalPaisa = totalPaisa - interestPaisa;
    } else if (data.cascade_overpayment === true || (data.interest_record_id && principalPaisa === null)) {
        if (interestPaisa === null) interestPaisa = totalPaisa;
        if (interestPaisa > maxAvailableInterest) {
            const excess = interestPaisa - maxAvailableInterest;
            interestPaisa = maxAvailableInterest;
            principalPaisa = (principalPaisa || 0) + excess;
        } else {
            principalPaisa = totalPaisa - interestPaisa;
        }
    } else {
        if (interestPaisa === null) interestPaisa = 0;
        if (principalPaisa === null) principalPaisa = 0;
    }

    if (isNaN(interestPaisa) || interestPaisa < 0) {
        const err = new Error('Interest portion must be greater than or equal to zero');
        err.statusCode = 400;
        throw err;
    }
    if (isNaN(principalPaisa) || principalPaisa < 0) {
        const err = new Error('Principal portion must be greater than or equal to zero');
        err.statusCode = 400;
        throw err;
    }

    // Allocation equality check: interest + principal === total
    if (interestPaisa + principalPaisa !== totalPaisa) {
        const totalRupees = totalPaisa / 100;
        const interestRupees = interestPaisa / 100;
        const principalRupees = principalPaisa / 100;
        const err = new Error(`Allocation mismatch: Total payment (₹${totalRupees}) must equal sum of interest (₹${interestRupees}) and principal (₹${principalRupees})`);
        err.statusCode = 400;
        throw err;
    }

    // Principal cannot exceed current outstanding_principal
    if (principalPaisa > account.outstanding_principal) {
        const maxRupees = account.outstanding_principal / 100;
        const principalRupees = principalPaisa / 100;
        const err = new Error(`Principal allocation (₹${principalRupees}) cannot exceed current outstanding principal (₹${maxRupees})`);
        err.statusCode = 400;
        throw err;
    }

    // Step 5I / 6G: Interest cannot exceed current outstanding interest (if interest records exist)
    if (interestBalance.hasRecords) {
        if (interestPaisa > 0 && interestBalance.interestOutstandingPaisa === 0) {
            const err = new Error(`Cannot allocate interest payment: Account #${accountId} has ₹0 outstanding interest`);
            err.statusCode = 400;
            throw err;
        }
        if (targetRecord && interestPaisa > targetRecordOutstandingPaisa) {
            const maxInterestRupees = targetRecordOutstandingPaisa / 100;
            const interestRupees = interestPaisa / 100;
            const err = new Error(`Interest allocation (₹${interestRupees}) cannot exceed target interest record #${targetRecord.id} outstanding (₹${maxInterestRupees})`);
            err.statusCode = 400;
            throw err;
        }
        if (!targetRecord && interestPaisa > interestBalance.interestOutstandingPaisa) {
            const maxInterestRupees = interestBalance.interestOutstandingPaisa / 100;
            const interestRupees = interestPaisa / 100;
            const err = new Error(`Interest allocation (₹${interestRupees}) cannot exceed current outstanding interest (₹${maxInterestRupees})`);
            err.statusCode = 400;
            throw err;
        }
    }

    // Duplicate check within last 5 seconds if no key
    if (!key) {
        const recentDup = queryOne(db, `
            SELECT payment_id FROM transactions
            WHERE account_id = ? AND transaction_date = ? AND payment_method = ?
            AND datetime(created_at) >= datetime('now', '-5 seconds')
            AND payment_id IS NOT NULL
            GROUP BY payment_id
            HAVING SUM(amount) = ?
        `, [accountId, dateStr, method, totalPaisa]);

        if (recentDup) {
            const txs = queryAll(db, 'SELECT * FROM transactions WHERE payment_id = ?', [recentDup.payment_id]);
            return { payment_id: recentDup.payment_id, transactions: txs, isDuplicate: true };
        }
    }

    const refText = data.reference ? data.reference.trim() : null;
    const notesText = data.notes ? data.notes.trim() : null;
    const paymentId = 'PAY-' + Date.now() + '-' + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const createdTransactions = [];
    let updatedAccount = null;

    try {
        db.run('BEGIN TRANSACTION');

        // Re-verify fresh account inside transaction (concurrency protection)
        const freshAccount = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accountId]);
        if (!freshAccount) {
            const err = new Error(`Account #${accountId} not found`);
            err.statusCode = 404;
            throw err;
        }
        if (principalPaisa > freshAccount.outstanding_principal) {
            const maxRupees = freshAccount.outstanding_principal / 100;
            const principalRupees = principalPaisa / 100;
            const err = new Error(`Principal allocation (₹${principalRupees}) cannot exceed current outstanding principal (₹${maxRupees})`);
            err.statusCode = 400;
            throw err;
        }

        // Fresh interest check inside transaction (Step 5I)
        const freshInterestBalance = getAccountInterestBalance(db, accountId);
        if (freshInterestBalance.hasRecords) {
            if (interestPaisa > 0 && freshInterestBalance.interestOutstandingPaisa === 0) {
                const err = new Error(`Cannot allocate interest payment: Account #${accountId} has ₹0 outstanding interest`);
                err.statusCode = 400;
                throw err;
            }
            if (interestPaisa > freshInterestBalance.interestOutstandingPaisa) {
                const maxInterestRupees = freshInterestBalance.interestOutstandingPaisa / 100;
                const interestRupees = interestPaisa / 100;
                const err = new Error(`Interest allocation (₹${interestRupees}) cannot exceed current outstanding interest (₹${maxInterestRupees})`);
                err.statusCode = 400;
                throw err;
            }
        }

        // 1. If interest portion > 0, insert INTEREST_RECEIVED transaction
        if (interestPaisa > 0) {
            db.run(`
                INSERT INTO transactions (
                    account_id, person_id, transaction_type, amount,
                    payment_method, transaction_date, payment_id, reference, notes
                ) VALUES (?, ?, 'INTEREST_RECEIVED', ?, ?, ?, ?, ?, ?)
            `, [accountId, personId, interestPaisa, method, dateStr, paymentId, refText, notesText]);

            const txIdRes = queryOne(db, 'SELECT last_insert_rowid() as id');
            const interestTx = queryOne(db, `
                SELECT t.*, p.name as person_name
                FROM transactions t JOIN people p ON t.person_id = p.id
                WHERE t.id = ?
            `, [txIdRes.id]);

            db.run(
                `INSERT INTO audit_logs (entity_type, entity_id, action, new_value)
                 VALUES ('TRANSACTION', ?, 'CREATE', ?)`,
                [interestTx.id, JSON.stringify(interestTx)]
            );

            createdTransactions.push(interestTx);

            // Step 5I / 6G: Associate with interest_records
            if (data.interest_record_id) {
                const { allocatePaymentToInterestRecord } = require('./interestPaymentService');
                allocatePaymentToInterestRecord(db, {
                    interest_record_id: data.interest_record_id,
                    account_id: accountId,
                    transaction_id: interestTx.id,
                    payment_id: paymentId,
                    amount: interestPaisa,
                    is_paisa: true
                });
            } else if (freshInterestBalance.hasRecords) {
                allocateInterestPaymentToRecords(db, accountId, interestTx.id, interestPaisa);
            }
        }

        // 2. If principal portion > 0, insert PRINCIPAL_RECEIVED transaction
        if (principalPaisa > 0) {
            db.run(`
                INSERT INTO transactions (
                    account_id, person_id, transaction_type, amount,
                    payment_method, transaction_date, payment_id, reference, notes
                ) VALUES (?, ?, 'PRINCIPAL_RECEIVED', ?, ?, ?, ?, ?, ?)
            `, [accountId, personId, principalPaisa, method, dateStr, paymentId, refText, notesText]);

            const txIdRes = queryOne(db, 'SELECT last_insert_rowid() as id');
            const principalTx = queryOne(db, `
                SELECT t.*, p.name as person_name
                FROM transactions t JOIN people p ON t.person_id = p.id
                WHERE t.id = ?
            `, [txIdRes.id]);

            db.run(
                `INSERT INTO audit_logs (entity_type, entity_id, action, new_value)
                 VALUES ('TRANSACTION', ?, 'CREATE', ?)`,
                [principalTx.id, JSON.stringify(principalTx)]
            );

            createdTransactions.push(principalTx);

            // Update account balance
            const newOutstanding = freshAccount.outstanding_principal - principalPaisa;
            const newStatus = newOutstanding === 0 ? 'CLOSED' : (newOutstanding < freshAccount.principal ? 'PARTIALLY_PAID' : freshAccount.status);

            db.run(`
                UPDATE accounts
                SET outstanding_principal = ?, status = ?, updated_at = datetime('now')
                WHERE id = ?
            `, [newOutstanding, newStatus, accountId]);

            updatedAccount = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accountId]);
            db.run(
                `INSERT INTO audit_logs (entity_type, entity_id, action, old_value, new_value)
                 VALUES ('ACCOUNT', ?, 'UPDATE', ?, ?)`,
                [accountId, JSON.stringify(freshAccount), JSON.stringify(updatedAccount)]
            );
        } else {
            updatedAccount = freshAccount;
        }

        // Write payment allocation audit log
        db.run(
            `INSERT INTO audit_logs (entity_type, entity_id, action, new_value)
             VALUES ('PAYMENT_ALLOCATION', ?, 'CREATE', ?)`,
            [accountId, JSON.stringify({
                payment_id: paymentId,
                total_amount: totalPaisa,
                interest_amount: interestPaisa,
                principal_amount: principalPaisa,
                transactions: createdTransactions.map(t => t.id)
            })]
        );

        db.run('COMMIT');
    } catch (err) {
        try { db.run('ROLLBACK'); } catch (_) {}
        throw err;
    }

    saveDatabase();

    const result = {
        payment_id: paymentId,
        transactions: createdTransactions,
        account: updatedAccount,
        isDuplicate: false
    };

    if (key) {
        recentIdempotencyKeys.set(key, result);
        setTimeout(() => recentIdempotencyKeys.delete(key), 60000);
    }

    return result;
}

module.exports = {
    createTransaction,
    allocatePayment,
    validateTransactionInput,
    VALID_TRANSACTION_TYPES,
    VALID_PAYMENT_METHODS
};
