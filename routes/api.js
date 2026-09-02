const express = require('express');
const { getDatabase, saveDatabase } = require('../db/connection');
const { queryAll, queryOne } = require('../db/helpers');
const { createTransaction, allocatePayment } = require('../services/transactionService');

const router = express.Router();

// ─── Health Check ────────────────────────────────────────────
router.get('/health', async (req, res) => {
    try {
        const db = await getDatabase();
        const result = queryOne(db, 'SELECT COUNT(*) as count FROM people');
        res.json({
            status: 'ok',
            database: 'connected',
            peopleCount: result.count,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// PEOPLE ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// ─── List all people (with optional search & category filter) ─
router.get('/people', async (req, res) => {
    try {
        const db = await getDatabase();
        const { search, category } = req.query;

        let sql, params = [];

        if (search && search.trim()) {
            const term = `%${search.trim()}%`;
            sql = `
                SELECT p.*,
                       COUNT(a.id) as account_count,
                       COALESCE(SUM(CASE WHEN a.direction = 'MONEY_GIVEN' THEN a.outstanding_principal ELSE 0 END), 0) as total_given,
                       COALESCE(SUM(CASE WHEN a.direction = 'MONEY_TAKEN' THEN a.outstanding_principal ELSE 0 END), 0) as total_taken,
                       GROUP_CONCAT(DISTINCT a.direction) as directions
                FROM people p
                LEFT JOIN accounts a ON a.person_id = p.id
                WHERE (p.name LIKE ? COLLATE NOCASE OR p.phone LIKE ?)
                GROUP BY p.id
                ORDER BY p.name COLLATE NOCASE
            `;
            params = [term, term];
        } else {
            sql = `
                SELECT p.*,
                       COUNT(a.id) as account_count,
                       COALESCE(SUM(CASE WHEN a.direction = 'MONEY_GIVEN' THEN a.outstanding_principal ELSE 0 END), 0) as total_given,
                       COALESCE(SUM(CASE WHEN a.direction = 'MONEY_TAKEN' THEN a.outstanding_principal ELSE 0 END), 0) as total_taken,
                       GROUP_CONCAT(DISTINCT a.direction) as directions
                FROM people p
                LEFT JOIN accounts a ON a.person_id = p.id
                GROUP BY p.id
                ORDER BY p.name COLLATE NOCASE
            `;
        }

        let people = queryAll(db, sql, params);

        if (category === 'MONEY_GIVEN') {
            people = people.filter(p => p.directions && p.directions.includes('MONEY_GIVEN'));
        } else if (category === 'MONEY_TAKEN') {
            people = people.filter(p => p.directions && p.directions.includes('MONEY_TAKEN'));
        }

        res.json({ data: people });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Get single person with account summary ──────────────────
router.get('/people/:id', async (req, res) => {
    try {
        const db = await getDatabase();
        const personId = Number(req.params.id);
        const person = queryOne(db, 'SELECT * FROM people WHERE id = ?', [personId]);
        if (!person) {
            return res.status(404).json({ error: 'Person not found' });
        }

        const accounts = queryAll(db, `
            SELECT id, direction, principal, outstanding_principal, interest_rate,
                   interest_frequency, calculation_method, start_date, due_date, status, notes
            FROM accounts
            WHERE person_id = ?
            ORDER BY start_date ASC
        `, [personId]);

        const givenAccounts = accounts.filter(a => a.direction === 'MONEY_GIVEN');
        const takenAccounts = accounts.filter(a => a.direction === 'MONEY_TAKEN');

        res.json({
            data: {
                ...person,
                accounts: accounts,
                account_count: accounts.length,
                given_count: givenAccounts.length,
                taken_count: takenAccounts.length,
                total_given: givenAccounts.reduce((s, a) => s + a.outstanding_principal, 0),
                total_taken: takenAccounts.reduce((s, a) => s + a.outstanding_principal, 0),
                total_principal: accounts.reduce((s, a) => s + a.principal, 0),
                directions: [...new Set(accounts.map(a => a.direction))]
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Create a person ─────────────────────────────────────────
router.post('/people', async (req, res) => {
    try {
        const db = await getDatabase();
        const { name, phone, address, notes } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Name is required' });
        }

        const trimmedName = name.trim();
        if (trimmedName.length > 200) {
            return res.status(400).json({ error: 'Name must be 200 characters or less' });
        }

        db.run(
            `INSERT INTO people (name, phone, address, notes) VALUES (?, ?, ?, ?)`,
            [trimmedName, phone ? phone.trim() : null, address ? address.trim() : null, notes ? notes.trim() : null]
        );

        const result = queryOne(db, 'SELECT last_insert_rowid() as id');
        const newPerson = queryOne(db, 'SELECT * FROM people WHERE id = ?', [result.id]);

        saveDatabase();

        res.status(201).json({
            message: 'Person created successfully',
            data: { ...newPerson, account_count: 0, directions: null }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Update a person ─────────────────────────────────────────
router.put('/people/:id', async (req, res) => {
    try {
        const db = await getDatabase();
        const personId = Number(req.params.id);
        const { name, phone, address, notes } = req.body;

        const existing = queryOne(db, 'SELECT * FROM people WHERE id = ?', [personId]);
        if (!existing) return res.status(404).json({ error: 'Person not found' });

        if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

        const trimmedName = name.trim();
        if (trimmedName.length > 200) return res.status(400).json({ error: 'Name must be 200 characters or less' });

        db.run(
            `INSERT INTO audit_logs (entity_type, entity_id, action, old_value, new_value)
             VALUES ('PERSON', ?, 'UPDATE', ?, ?)`,
            [personId, JSON.stringify(existing), JSON.stringify({ name: trimmedName, phone: phone?.trim(), address: address?.trim(), notes: notes?.trim() })]
        );

        db.run(
            `UPDATE people SET name = ?, phone = ?, address = ?, notes = ? WHERE id = ?`,
            [trimmedName, phone ? phone.trim() : null, address ? address.trim() : null, notes ? notes.trim() : null, personId]
        );

        const updated = queryOne(db, 'SELECT * FROM people WHERE id = ?', [personId]);
        saveDatabase();

        res.json({ message: 'Person updated successfully', data: updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Delete a person ─────────────────────────────────────────
router.delete('/people/:id', async (req, res) => {
    try {
        const db = await getDatabase();
        const personId = Number(req.params.id);

        const existing = queryOne(db, 'SELECT * FROM people WHERE id = ?', [personId]);
        if (!existing) return res.status(404).json({ error: 'Person not found' });

        const accountCount = queryOne(db, 'SELECT COUNT(*) as count FROM accounts WHERE person_id = ?', [personId]);
        const txnCount = queryOne(db, 'SELECT COUNT(*) as count FROM transactions WHERE person_id = ?', [personId]);

        if (accountCount.count > 0 || txnCount.count > 0) {
            return res.status(409).json({
                error: 'Cannot delete person with financial history',
                details: `This person has ${accountCount.count} account(s) and ${txnCount.count} transaction(s). Financial records must be preserved.`
            });
        }

        db.run('DELETE FROM people WHERE id = ?', [personId]);
        db.run(
            `INSERT INTO audit_logs (entity_type, entity_id, action, old_value) VALUES ('PERSON', ?, 'DELETE', ?)`,
            [personId, JSON.stringify(existing)]
        );

        saveDatabase();
        res.json({ message: 'Person deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── List accounts for a person ──────────────────────────────
router.get('/people/:id/accounts', async (req, res) => {
    try {
        const db = await getDatabase();
        const personId = Number(req.params.id);

        const person = queryOne(db, 'SELECT * FROM people WHERE id = ?', [personId]);
        if (!person) return res.status(404).json({ error: 'Person not found' });

        const accounts = queryAll(db, `SELECT * FROM accounts WHERE person_id = ? ORDER BY start_date ASC`, [personId]);

        res.json({ person, accounts, count: accounts.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// ACCOUNT ENDPOINTS
// ═══════════════════════════════════════════════════════════════

const VALID_DIRECTIONS = ['MONEY_GIVEN', 'MONEY_TAKEN'];
const VALID_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
const VALID_METHODS = ['SIMPLE_INTEREST'];
const VALID_STATUSES = ['ACTIVE', 'PARTIALLY_PAID', 'OVERDUE', 'CLOSED', 'WRITTEN_OFF'];

// ─── List all accounts (with optional filters) ───────────────
router.get('/accounts', async (req, res) => {
    try {
        const db = await getDatabase();
        const { person_id, direction, status, search, sort_by, sort_order } = req.query;

        let sql = `
            SELECT a.*, p.name as person_name, p.phone as person_phone
            FROM accounts a
            JOIN people p ON a.person_id = p.id
            WHERE 1=1
        `;
        const params = [];

        if (person_id) {
            sql += ' AND a.person_id = ?';
            params.push(Number(person_id));
        }
        if (direction && VALID_DIRECTIONS.includes(direction)) {
            sql += ' AND a.direction = ?';
            params.push(direction);
        }
        if (status && VALID_STATUSES.includes(status)) {
            sql += ' AND a.status = ?';
            params.push(status);
        }
        if (search && search.trim()) {
            const term = search.trim();
            sql += ' AND (p.name LIKE ? OR CAST(a.id AS TEXT) LIKE ?)';
            params.push(`%${term}%`, `%${term}%`);
        }

        // Sorting
        const validSorts = { due_date: 'a.due_date', principal: 'a.principal', person_name: 'p.name', created_at: 'a.created_at' };
        const sortCol = validSorts[sort_by] || 'a.created_at';
        const order = sort_order === 'ASC' ? 'ASC' : 'DESC';
        sql += ` ORDER BY ${sortCol} ${order}`;

        const accounts = queryAll(db, sql, params);
        res.json({ data: accounts });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Get single account ──────────────────────────────────────
router.get('/accounts/:id', async (req, res) => {
    try {
        const db = await getDatabase();
        const accountId = Number(req.params.id);

        const account = queryOne(db, `
            SELECT a.*, p.name as person_name, p.phone as person_phone
            FROM accounts a
            JOIN people p ON a.person_id = p.id
            WHERE a.id = ?
        `, [accountId]);

        if (!account) return res.status(404).json({ error: 'Account not found' });

        res.json({ data: account });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Create account ──────────────────────────────────────────
router.post('/accounts', async (req, res) => {
    try {
        const db = await getDatabase();
        const { person_id, direction, principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, notes } = req.body;

        // Validation
        const errors = [];

        if (!person_id) errors.push('Person is required');
        else {
            const person = queryOne(db, 'SELECT id FROM people WHERE id = ?', [Number(person_id)]);
            if (!person) errors.push('Selected person does not exist');
        }

        if (!direction || !VALID_DIRECTIONS.includes(direction)) errors.push('Direction must be MONEY_GIVEN or MONEY_TAKEN');

        const principalPaisa = Math.round(Number(principal) * 100);
        if (!principal || isNaN(Number(principal)) || Number(principal) <= 0) errors.push('Principal must be greater than zero');

        const rate = Number(interest_rate);
        if (interest_rate === undefined || interest_rate === null || interest_rate === '' || isNaN(rate) || rate < 0) errors.push('Interest rate must be zero or greater');

        if (!interest_frequency || !VALID_FREQUENCIES.includes(interest_frequency)) errors.push('Interest frequency is invalid');

        const method = calculation_method || 'SIMPLE_INTEREST';
        if (!VALID_METHODS.includes(method)) errors.push('Calculation method is invalid');

        if (!start_date) errors.push('Start date is required');
        if (!due_date) errors.push('Due date is required');
        if (start_date && due_date && due_date < start_date) errors.push('Due date cannot be before start date');

        if (errors.length > 0) {
            return res.status(400).json({ error: errors.join('. '), errors });
        }

        db.run(
            `INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
            [Number(person_id), direction, principalPaisa, principalPaisa, rate, interest_frequency, method, start_date, due_date, notes ? notes.trim() : null]
        );

        const result = queryOne(db, 'SELECT last_insert_rowid() as id');
        const newAccount = queryOne(db, `
            SELECT a.*, p.name as person_name
            FROM accounts a JOIN people p ON a.person_id = p.id
            WHERE a.id = ?
        `, [result.id]);

        // Audit log
        db.run(
            `INSERT INTO audit_logs (entity_type, entity_id, action, new_value)
             VALUES ('ACCOUNT', ?, 'CREATE', ?)`,
            [result.id, JSON.stringify(newAccount)]
        );

        saveDatabase();

        res.status(201).json({
            message: 'Account created successfully',
            data: newAccount
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Update account ──────────────────────────────────────────
router.put('/accounts/:id', async (req, res) => {
    try {
        const db = await getDatabase();
        const accountId = Number(req.params.id);

        const existing = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accountId]);
        if (!existing) return res.status(404).json({ error: 'Account not found' });

        const { interest_rate, interest_frequency, calculation_method, due_date, notes, status, outstanding_principal } = req.body;

        // Validation
        const errors = [];

        const rate = Number(interest_rate);
        if (interest_rate !== undefined && (isNaN(rate) || rate < 0)) errors.push('Interest rate must be zero or greater');

        const outAmt = Number(outstanding_principal);
        if (outstanding_principal !== undefined && (isNaN(outAmt) || outAmt < 0)) errors.push('Outstanding principal must be zero or greater');

        if (interest_frequency && !VALID_FREQUENCIES.includes(interest_frequency)) errors.push('Interest frequency is invalid');

        if (calculation_method && !VALID_METHODS.includes(calculation_method)) errors.push('Calculation method is invalid');

        if (status && !VALID_STATUSES.includes(status)) errors.push('Status is invalid');

        const newDueDate = due_date || existing.due_date;
        if (newDueDate < existing.start_date) errors.push('Due date cannot be before start date');

        if (errors.length > 0) {
            return res.status(400).json({ error: errors.join('. '), errors });
        }

        // Audit log before change
        db.run(
            `INSERT INTO audit_logs (entity_type, entity_id, action, old_value, new_value)
             VALUES ('ACCOUNT', ?, 'UPDATE', ?, ?)`,
            [accountId, JSON.stringify(existing), JSON.stringify(req.body)]
        );

        db.run(`
            UPDATE accounts SET
                interest_rate = ?,
                interest_frequency = ?,
                calculation_method = ?,
                due_date = ?,
                notes = ?,
                status = ?,
                outstanding_principal = ?
            WHERE id = ?
        `, [
            interest_rate !== undefined ? rate : existing.interest_rate,
            interest_frequency || existing.interest_frequency,
            calculation_method || existing.calculation_method,
            due_date || existing.due_date,
            notes !== undefined ? (notes ? notes.trim() : null) : existing.notes,
            status || existing.status,
            outstanding_principal !== undefined ? Math.round(outAmt) : existing.outstanding_principal,
            accountId
        ]);

        const updated = queryOne(db, `
            SELECT a.*, p.name as person_name
            FROM accounts a JOIN people p ON a.person_id = p.id
            WHERE a.id = ?
        `, [accountId]);

        saveDatabase();

        res.json({ message: 'Account updated successfully', data: updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── List transactions with filters ──────────────────────────
router.get('/transactions', async (req, res) => {
    try {
        const db = await getDatabase();
        const {
            account_id, person_id, transaction_type,
            payment_method, start_date, end_date,
            payment_id, search, sort
        } = req.query;

        let sql = `
            SELECT t.*, p.name as person_name,
                   a.direction as account_direction,
                   a.principal as account_principal,
                   a.outstanding_principal as account_outstanding_principal
            FROM transactions t
            JOIN people p ON t.person_id = p.id
            LEFT JOIN accounts a ON t.account_id = a.id
            WHERE 1=1
        `;
        const params = [];

        if (account_id) {
            sql += ' AND t.account_id = ?';
            params.push(Number(account_id));
        }
        if (person_id) {
            sql += ' AND t.person_id = ?';
            params.push(Number(person_id));
        }
        if (transaction_type && transaction_type !== 'ALL') {
            sql += ' AND t.transaction_type = ?';
            params.push(transaction_type);
        }
        if (payment_method && payment_method !== 'ALL') {
            sql += ' AND t.payment_method = ?';
            params.push(payment_method);
        }
        if (payment_id) {
            sql += ' AND t.payment_id = ?';
            params.push(payment_id);
        }
        if (start_date) {
            sql += ' AND t.transaction_date >= ?';
            params.push(start_date);
        }
        if (end_date) {
            sql += ' AND t.transaction_date <= ?';
            params.push(end_date);
        }
        if (search && search.trim()) {
            const q = search.trim();
            const cleanId = q.replace('#', '');
            const numId = !isNaN(Number(cleanId)) ? Number(cleanId) : null;
            if (numId !== null) {
                sql += ' AND (t.id = ? OR t.account_id = ? OR p.name LIKE ? OR t.reference LIKE ? OR t.payment_id LIKE ?)';
                params.push(numId, numId, `%${q}%`, `%${q}%`, `%${q}%`);
            } else {
                sql += ' AND (p.name LIKE ? OR t.reference LIKE ? OR t.payment_id LIKE ? OR t.notes LIKE ?)';
                params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
            }
        }

        // Sorting
        if (sort === 'oldest') {
            sql += ' ORDER BY t.transaction_date ASC, t.id ASC';
        } else if (sort === 'amount_desc') {
            sql += ' ORDER BY t.amount DESC, t.id DESC';
        } else if (sort === 'amount_asc') {
            sql += ' ORDER BY t.amount ASC, t.id ASC';
        } else {
            // Default: newest first
            sql += ' ORDER BY t.transaction_date DESC, t.id DESC';
        }

        const transactions = queryAll(db, sql, params);
        res.json({ data: transactions });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Get single transaction ──────────────────────────────────
router.get('/transactions/:id', async (req, res) => {
    try {
        const db = await getDatabase();
        const txId = Number(req.params.id);

        const tx = queryOne(db, `
            SELECT t.*, p.name as person_name
            FROM transactions t
            JOIN people p ON t.person_id = p.id
            WHERE t.id = ?
        `, [txId]);

        if (!tx) return res.status(404).json({ error: 'Transaction not found' });

        res.json({ data: tx });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Create transaction (Step 4A Foundation) ────────────────
router.post('/transactions', async (req, res) => {
    try {
        const db = await getDatabase();
        const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotency_key;

        const { transaction, isDuplicate } = await createTransaction(db, req.body, idempotencyKey);

        res.status(isDuplicate ? 200 : 201).json({
            message: isDuplicate ? 'Duplicate transaction detected; returning existing record' : 'Transaction created successfully',
            data: transaction,
            isDuplicate
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message, errors: err.errors });
    }
});

// ─── Payment Allocation (Step 4E) ───────────────────────────
const handlePaymentAllocation = async (req, res) => {
    try {
        const db = await getDatabase();
        const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotency_key;

        const result = await allocatePayment(db, req.body, idempotencyKey);

        res.status(result.isDuplicate ? 200 : 201).json({
            message: result.isDuplicate ? 'Duplicate payment detected; returning existing records' : 'Payment allocated successfully',
            data: result,
            isDuplicate: result.isDuplicate
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message, errors: err.errors });
    }
};

router.post('/payments/allocate', handlePaymentAllocation);
router.post('/transactions/allocate', handlePaymentAllocation);

// ─── Interest Foundation (Step 5A) ──────────────────────────
const {
    SUPPORTED_CALCULATION_METHODS,
    SUPPORTED_FREQUENCIES,
    SUPPORTED_PRINCIPAL_BASIS,
    SUPPORTED_DAY_COUNT_CONVENTIONS,
    RATE_REPRESENTATION,
    PRECISION_POLICY,
    DATE_BOUNDARY_CONVENTION,
    validateCalculationInput,
    prepareInterestCalculation,
    calculateInterest,
    calculateSimpleInterest,
    calculateElapsedDays,
    calculateTimeFraction,
    calculateTimeBetweenDates,
    calculateSimpleInterestByDates,
    calculateAccountInterest,
    buildPrincipalTimeline,
    calculateTimelineInterest,
    recordInterest,
    getAccountInterestBalance,
    accrueInterest
} = require('../services/interestService');

router.get('/interest/foundation', (req, res) => {
    res.json({
        data: {
            status: 'FOUNDATION_READY',
            supported_calculation_methods: SUPPORTED_CALCULATION_METHODS,
            supported_frequencies: SUPPORTED_FREQUENCIES,
            supported_principal_basis: SUPPORTED_PRINCIPAL_BASIS,
            supported_day_count_conventions: SUPPORTED_DAY_COUNT_CONVENTIONS,
            rate_representation: RATE_REPRESENTATION,
            precision_policy: PRECISION_POLICY,
            date_boundary_convention: DATE_BOUNDARY_CONVENTION,
            message: 'Interest calculation foundation configured. Calculations and accrual deferred to Step 5B+.'
        }
    });
});

router.post('/interest/validate', async (req, res) => {
    try {
        const db = await getDatabase();
        const { account_id, period, principal_basis, calculation_method } = req.body;

        if (!account_id) {
            return res.status(400).json({ error: 'account_id is required' });
        }

        const account = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [Number(account_id)]);
        if (!account) {
            return res.status(404).json({ error: `Account #${account_id} not found` });
        }

        const prepared = prepareInterestCalculation(account, period, {
            principalBasis: principal_basis,
            calculationMethod: calculation_method
        });

        res.json({
            message: 'Interest calculation parameters validated successfully',
            data: prepared
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message, errors: err.errors });
    }
});

// ─── Calculate Simple Interest (Step 5B) ────────────────────
router.post('/interest/calculate', (req, res) => {
    try {
        const { principal, rate, time, is_paisa } = req.body;
        const result = calculateSimpleInterest(principal, rate, time, { isPaisa: is_paisa === true });
        res.json({
            message: 'Simple interest calculated successfully',
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// ─── Date-to-Time & Date-based Interest (Step 5C) ────────────
router.post('/interest/calculate-time', (req, res) => {
    try {
        const { start_date, end_date, basis } = req.body;
        const result = calculateTimeBetweenDates(start_date, end_date, basis);
        res.json({
            message: 'Time calculated successfully',
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

router.post('/interest/calculate-by-dates', (req, res) => {
    try {
        const { principal, rate, start_date, end_date, basis, is_paisa } = req.body;
        const result = calculateSimpleInterestByDates(principal, rate, start_date, end_date, {
            dayCountConvention: basis,
            isPaisa: is_paisa === true
        });
        res.json({
            message: 'Interest calculated by date range successfully',
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// ─── Account-Level Interest Calculation (Step 5D) ───────────
router.post('/accounts/:id/calculate-interest', async (req, res) => {
    try {
        const db = await getDatabase();
        const accountId = req.params.id;
        const { start_date, end_date, basis } = req.body;
        const result = calculateAccountInterest(db, accountId, start_date, end_date, {
            dayCountConvention: basis
        });
        res.json({
            message: 'Account interest calculated successfully',
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

router.post('/interest/calculate-account', async (req, res) => {
    try {
        const db = await getDatabase();
        const { account_id, start_date, end_date, basis } = req.body;
        const result = calculateAccountInterest(db, account_id, start_date, end_date, {
            dayCountConvention: basis
        });
        res.json({
            message: 'Account interest calculated successfully',
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// ─── Principal Timeline (Step 5E) ───────────────────────────
router.post('/accounts/:id/principal-timeline', async (req, res) => {
    try {
        const db = await getDatabase();
        const accountId = req.params.id;
        const { start_date, end_date } = req.body;
        const result = buildPrincipalTimeline(db, accountId, start_date, end_date);
        res.json({
            message: 'Principal timeline generated successfully',
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

router.post('/interest/principal-timeline', async (req, res) => {
    try {
        const db = await getDatabase();
        const { account_id, start_date, end_date } = req.body;
        const result = buildPrincipalTimeline(db, account_id, start_date, end_date);
        res.json({
            message: 'Principal timeline generated successfully',
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// ─── Timeline-Based Interest Calculation (Step 5F) ──────────
router.post('/accounts/:id/timeline-interest', async (req, res) => {
    try {
        const db = await getDatabase();
        const accountId = req.params.id;
        const { start_date, end_date, basis } = req.body;
        const result = calculateTimelineInterest(db, accountId, start_date, end_date, {
            dayCountConvention: basis
        });
        res.json({
            message: 'Timeline interest calculated successfully',
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

router.post('/interest/timeline-interest', async (req, res) => {
    try {
        const db = await getDatabase();
        const { account_id, start_date, end_date, basis } = req.body;
        const result = calculateTimelineInterest(db, account_id, start_date, end_date, {
            dayCountConvention: basis
        });
        res.json({
            message: 'Timeline interest calculated successfully',
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// ─── Step 5I: Interest Outstanding & Payment Allocation ──────
router.get('/accounts/:id/interest-balance', async (req, res) => {
    try {
        const db = await getDatabase();
        const accountId = req.params.id;
        const result = getAccountInterestBalance(db, accountId);
        res.json({
            message: 'Interest balance retrieved successfully',
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

router.get('/accounts/:id/interest-records', async (req, res) => {
    try {
        const db = await getDatabase();
        const accountId = req.params.id;
        const balance = getAccountInterestBalance(db, accountId);
        res.json({
            message: 'Interest records retrieved successfully',
            data: balance.records
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

router.post('/accounts/:id/interest-records', async (req, res) => {
    try {
        const db = await getDatabase();
        const accountId = req.params.id;
        const result = recordInterest(db, { ...req.body, account_id: accountId });
        saveDatabase();
        res.status(201).json({
            message: 'Interest recorded successfully',
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

router.post('/interest/record', async (req, res) => {
    try {
        const db = await getDatabase();
        const result = recordInterest(db, req.body);
        saveDatabase();
        res.status(201).json({
            message: 'Interest recorded successfully',
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// ─── Step 5J: Automatic Interest Accrual Service ──────
router.post('/accounts/:id/accrue-interest', async (req, res) => {
    try {
        const db = await getDatabase();
        const accountId = req.params.id;
        const startDate = req.body.start_date || req.body.startDate;
        const endDate = req.body.end_date || req.body.endDate;
        const result = accrueInterest(db, accountId, startDate, endDate, req.body.options || {});
        res.json({
            message: result.status === 'ALREADY_RECORDED'
                ? 'Interest already recorded for this period'
                : (result.status === 'ZERO_INTEREST' ? 'Zero interest for this period' : 'Interest accrued successfully'),
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

router.post('/interest/accrue', async (req, res) => {
    try {
        const db = await getDatabase();
        const accountId = req.body.account_id || req.body.accountId;
        const startDate = req.body.start_date || req.body.startDate;
        const endDate = req.body.end_date || req.body.endDate;
        const result = accrueInterest(db, accountId, startDate, endDate, req.body.options || {});
        res.json({
            message: result.status === 'ALREADY_RECORDED'
                ? 'Interest already recorded for this period'
                : (result.status === 'ZERO_INTEREST' ? 'Zero interest for this period' : 'Interest accrued successfully'),
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

router.post('/test/reset-state', async (req, res) => {
    try {
        const db = await getDatabase();
        db.run('DELETE FROM interest_allocations');
        db.run('DELETE FROM interest_records');
        db.run('DELETE FROM transactions');
        db.run('DELETE FROM accounts WHERE id > 4');
        db.run("UPDATE accounts SET principal = 200000, outstanding_principal = 200000, interest_rate = 15.0, status = 'ACTIVE' WHERE id IN (1, 2)");
        db.run("UPDATE accounts SET principal = 500000, outstanding_principal = 500000, interest_rate = 18.0, status = 'ACTIVE' WHERE id = 3");
        db.run("UPDATE accounts SET principal = 10000000, outstanding_principal = 10000000, interest_rate = 10.0, status = 'ACTIVE' WHERE id = 4");
        saveDatabase();
        res.json({ message: 'State reset successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Prohibit transaction editing & deletion (Historical Immutability) ──
const immutableTxHandler = (req, res) => {
    res.status(405).json({
        error: 'Method Not Allowed: Financial transactions are immutable historical records. Editing and deletion are prohibited.'
    });
};
router.put('/transactions/:id', immutableTxHandler);
router.patch('/transactions/:id', immutableTxHandler);
router.delete('/transactions/:id', immutableTxHandler);

module.exports = router;
