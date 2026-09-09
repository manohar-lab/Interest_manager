const express = require('express');
const { getDatabase, saveDatabase } = require('../db/connection');
const { queryAll, queryOne } = require('../db/helpers');
const { createTransaction, allocatePayment } = require('../services/transactionService');

const {
    login,
    logout,
    changePassword,
    setupPin,
    verifyUserPin,
    changePin,
    resetPin,
    requestPasswordReset,
    completePasswordReset,
    createUser,
    setUserStatus,
    listUsers,
    ROLES
} = require('../services/authService');

const {
    getNotifications,
    getUnreadCount,
    markAsRead,
    markAllAsRead,
    checkDueAndOverdueNotifications
} = require('../services/notificationService');

const {
    authenticate,
    requireRole,
    requireAdmin,
    requireStaffOrAdmin
} = require('../middleware/authMiddleware');

const {
    loginLimiter,
    pinLimiter,
    resetLimiter
} = require('../middleware/rateLimiter');

const router = express.Router();

// ─── Health Check (Public) ───────────────────────────────────
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

// ─── Public Authentication Routes (12B, 12G, 12L) ──────────────
router.post('/auth/login', loginLimiter, async (req, res) => {
    try {
        const db = await getDatabase();
        const { username, password } = req.body;
        const clientInfo = {
            ip: req.ip || req.connection?.remoteAddress,
            userAgent: req.headers['user-agent']
        };
        const authResult = login(db, username, password, clientInfo);
        res.json({ success: true, ...authResult });
    } catch (err) {
        res.status(err.statusCode || 401).json({ success: false, error: err.message });
    }
});

router.post('/auth/request-reset', resetLimiter, async (req, res) => {
    try {
        const db = await getDatabase();
        const { username } = req.body;
        const result = requestPasswordReset(db, username);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 400).json({ success: false, error: err.message });
    }
});

router.post('/auth/reset-password', resetLimiter, async (req, res) => {
    try {
        const db = await getDatabase();
        const { reset_token, new_password } = req.body;
        const result = completePasswordReset(db, reset_token, new_password);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 400).json({ success: false, error: err.message });
    }
});

// ─── Global Authentication Barrier (12A, 12E) ──────────────────
router.use(authenticate);

// ─── Viewer Write Guard (12E.2: Prevent Mutating Operations by VIEWER) ──
router.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        if (req.user && req.user.role === ROLES.VIEWER) {
            const allowedViewerRoutes = [
                '/auth/logout',
                '/auth/change-password',
                '/auth/pin/setup',
                '/auth/pin/verify',
                '/auth/pin/change',
                '/auth/pin/reset',
                '/notifications/mark-all-read'
            ];
            const isReadPatch = req.path.startsWith('/notifications/') && req.path.endsWith('/read');
            if (!allowedViewerRoutes.includes(req.path) && !isReadPatch) {
                return res.status(403).json({
                    success: false,
                    error: `Permission denied. Role (${req.user.role}) is not authorized to perform write operations.`
                });
            }
        }
    }
    next();
});

// ─── Authenticated Session & Security Routes (12B, 12D, 12J) ───
router.post('/auth/logout', async (req, res) => {
    try {
        const db = await getDatabase();
        const result = logout(db, req.token);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/auth/me', (req, res) => {
    res.json({ success: true, user: req.user });
});

router.post('/auth/change-password', async (req, res) => {
    try {
        const db = await getDatabase();
        const { current_password, new_password } = req.body;
        const result = changePassword(db, req.user.id, current_password, new_password);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 400).json({ success: false, error: err.message });
    }
});

router.post('/auth/pin/setup', async (req, res) => {
    try {
        const db = await getDatabase();
        const { pin, confirm_pin } = req.body;
        const result = setupPin(db, req.user.id, pin, confirm_pin);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 400).json({ success: false, error: err.message });
    }
});

router.post('/auth/pin/verify', pinLimiter, async (req, res) => {
    try {
        const db = await getDatabase();
        const { pin } = req.body;
        const result = verifyUserPin(db, req.user.id, pin);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 401).json({ success: false, error: err.message });
    }
});

router.post('/auth/pin/change', async (req, res) => {
    try {
        const db = await getDatabase();
        const { current_credential, new_pin, confirm_pin } = req.body;
        const result = changePin(db, req.user.id, current_credential, new_pin, confirm_pin);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 400).json({ success: false, error: err.message });
    }
});

router.post('/auth/pin/reset', async (req, res) => {
    try {
        const db = await getDatabase();
        const { password, new_pin, confirm_pin } = req.body;
        const result = resetPin(db, req.user.id, password, new_pin, confirm_pin);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 400).json({ success: false, error: err.message });
    }
});

// ─── User Administration (ADMIN only) ──────────────────────────
router.get('/auth/users', requireAdmin, async (req, res) => {
    try {
        const db = await getDatabase();
        const users = listUsers(db);
        res.json({ success: true, items: users });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/auth/users', requireAdmin, async (req, res) => {
    try {
        const db = await getDatabase();
        const { username, password, role } = req.body;
        const user = createUser(db, { username, password, role });
        res.status(201).json({ success: true, user });
    } catch (err) {
        res.status(err.statusCode || 400).json({ success: false, error: err.message });
    }
});

router.patch('/auth/users/:id/status', requireAdmin, async (req, res) => {
    try {
        const db = await getDatabase();
        const userId = parseInt(req.params.id, 10);
        const { status } = req.body;
        const result = setUserStatus(db, userId, status);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 400).json({ success: false, error: err.message });
    }
});

// ─── Notifications Routes (12H, 12I) ───────────────────────────
router.get('/notifications', async (req, res) => {
    try {
        const db = await getDatabase();
        const result = getNotifications(db, req.user.id, req.query);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/notifications/unread-count', async (req, res) => {
    try {
        const db = await getDatabase();
        const count = getUnreadCount(db, req.user.id);
        res.json({ success: true, unread_count: count });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.patch('/notifications/:id/read', async (req, res) => {
    try {
        const db = await getDatabase();
        const id = parseInt(req.params.id, 10);
        const result = markAsRead(db, id, req.user.id);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/notifications/mark-all-read', async (req, res) => {
    try {
        const db = await getDatabase();
        const result = markAllAsRead(db, req.user.id);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/notifications/check-due', requireStaffOrAdmin, async (req, res) => {
    try {
        const db = await getDatabase();
        const result = checkDueAndOverdueNotifications(db, req.query.as_of_date || req.body.as_of_date);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
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

        // Step 6A: Initialize interest configuration
        try {
            db.run(`
                INSERT INTO account_interest_configs (account_id, calculation_method, interest_rate, effective_from, effective_to)
                VALUES (?, ?, ?, ?, NULL)
            `, [result.id, method, rate, start_date]);
        } catch (_) {}

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
    accrueInterest,
    getInterestRecordAudit,
    getAccountInterestAuditHistory,
    reverseInterest,
    getInterestCorrectionChain
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
        const result = recordInterest(db, {
            ...req.body,
            account_id: accountId,
            source: 'MANUAL',
            scheduler_run_id: null
        }, { source: 'MANUAL', actorId: req.body.actor_id || req.body.actorId || 'API_USER' });
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
        const result = recordInterest(db, {
            ...req.body,
            source: 'MANUAL',
            scheduler_run_id: null
        }, { source: 'MANUAL', actorId: req.body.actor_id || req.body.actorId || 'API_USER' });
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

const { accrueAndRecord } = require('../services/interestRecordingService');

router.post('/interest/accrue-and-record', async (req, res) => {
    try {
        const db = await getDatabase();
        const accountId = req.body.account_id || req.body.accountId;
        const result = accrueAndRecord(db, accountId, req.body);
        saveDatabase();
        res.status(201).json({
            message: 'Interest accrued and recorded successfully',
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
        db.run('DELETE FROM accrual_run_details');
        db.run('DELETE FROM accrual_runs');
        db.run('DELETE FROM interest_allocations');
        db.run('DELETE FROM interest_records');
        db.run("DELETE FROM audit_logs WHERE entity_type = 'INTEREST_RECORD'");
        db.run('DELETE FROM transactions');
        db.run('DELETE FROM accounts WHERE id > 4');
        db.run("UPDATE accounts SET principal = 200000, outstanding_principal = 200000, interest_rate = 15.0, interest_frequency = 'MONTHLY', calculation_method = 'SIMPLE_INTEREST', start_date = '2026-08-01', due_date = '2026-09-01', status = 'ACTIVE' WHERE id = 1");
        db.run("UPDATE accounts SET principal = 200000, outstanding_principal = 200000, interest_rate = 15.0, interest_frequency = 'MONTHLY', calculation_method = 'SIMPLE_INTEREST', start_date = '2026-09-01', due_date = '2026-10-01', status = 'ACTIVE' WHERE id = 2");
        db.run("UPDATE accounts SET principal = 500000, outstanding_principal = 500000, interest_rate = 18.0, interest_frequency = 'MONTHLY', calculation_method = 'SIMPLE_INTEREST', start_date = '2026-09-10', due_date = '2026-10-10', status = 'ACTIVE' WHERE id = 3");
        db.run("UPDATE accounts SET principal = 10000000, outstanding_principal = 10000000, interest_rate = 10.0, interest_frequency = 'MONTHLY', calculation_method = 'SIMPLE_INTEREST', start_date = '2026-08-01', due_date = '2026-09-01', status = 'ACTIVE' WHERE id = 4");
        db.run('DELETE FROM account_interest_configs WHERE account_id > 4');
        db.run('DELETE FROM account_interest_configs WHERE account_id <= 4');
        db.run(`
            INSERT INTO account_interest_configs (account_id, calculation_method, interest_rate, effective_from, effective_to) VALUES
            (1, 'SIMPLE_INTEREST', 15.0, '2026-08-01', NULL),
            (2, 'SIMPLE_INTEREST', 15.0, '2026-09-01', NULL),
            (3, 'SIMPLE_INTEREST', 18.0, '2026-09-10', NULL),
            (4, 'SIMPLE_INTEREST', 10.0, '2026-08-01', NULL);
        `);
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

// ─── Step 5K / 5L: Accrual Scheduler & Monitoring API ──────
const {
    runScheduler,
    getAccrualRuns,
    getAccrualRunById,
    getFailedAccruals,
    retryFailedAccrual
} = require('../services/schedulerService');

router.post('/scheduler/run', async (req, res) => {
    try {
        const db = await getDatabase();
        const options = { ...req.body };

        if (req.body.currentDate || req.body.current_date || req.body.as_of_date || req.body.asOfDate) {
            options.currentDate = req.body.currentDate || req.body.current_date || req.body.as_of_date || req.body.asOfDate;
        }

        if (req.body.dryRun || req.body.dry_run) {
            options.dryRun = true;
        }

        const result = runScheduler(db, options);
        res.json({
            message: 'Scheduler run completed',
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// ─── Step 5L: List recent accrual runs (§16, §17) ───────────
router.get('/scheduler/runs', async (req, res) => {
    try {
        const db = await getDatabase();
        const runs = getAccrualRuns(db, req.query);
        res.json({
            message: 'Accrual runs retrieved successfully',
            data: runs
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Step 5L: Get specific run details (§18) ─────────────────
router.get('/scheduler/runs/:id', async (req, res) => {
    try {
        const db = await getDatabase();
        const runData = getAccrualRunById(db, req.params.id);
        if (!runData) {
            return res.status(404).json({ error: `Accrual run #${req.params.id} not found` });
        }
        res.json({
            message: 'Accrual run details retrieved successfully',
            data: runData
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Step 5L: Get failed accrual attempts (§19) ──────────────
router.get('/scheduler/failures', async (req, res) => {
    try {
        const db = await getDatabase();
        const failures = getFailedAccruals(db, req.query);
        res.json({
            message: 'Failed accruals retrieved successfully',
            data: failures
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Step 5L: Controlled Manual Retry (§20, §21, §22) ────────
router.post('/scheduler/retry/:detailId', async (req, res) => {
    try {
        const db = await getDatabase();
        const result = retryFailedAccrual(db, req.params.detailId);
        res.json({
            message: result.message,
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// Step 5M: Interest Accrual Audit & Financial Traceability
// ═══════════════════════════════════════════════════════════════

// ─── Get audit history for an account (§21) ──────────────────
router.get('/accounts/:id/interest-audit', async (req, res) => {
    try {
        const db = await getDatabase();
        const accountId = req.params.id;
        const auditHistory = getAccountInterestAuditHistory(db, accountId);
        res.json({
            message: 'Interest audit history retrieved successfully',
            data: auditHistory
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// ─── Get audit detail for a specific interest record (§22, §23, §26) ──
router.get('/accounts/:id/interest-records/:recordId/audit', async (req, res) => {
    try {
        const db = await getDatabase();
        const auditDetail = getInterestRecordAudit(db, req.params.recordId);
        res.json({
            message: 'Interest record audit retrieved successfully',
            data: auditDetail
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

router.get('/interest-records/:id/audit', async (req, res) => {
    try {
        const db = await getDatabase();
        const auditDetail = getInterestRecordAudit(db, req.params.id);
        res.json({
            message: 'Interest record audit retrieved successfully',
            data: auditDetail
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// Step 5N: Interest Correction & Reversal
// ═══════════════════════════════════════════════════════════════

// ─── Reverse an interest record (§19, §20) ────────────────────
const handleInterestReversal = async (req, res) => {
    try {
        const db = await getDatabase();
        const recordId = req.params.recordId || req.params.id;
        const result = reverseInterest(db, recordId, req.body);
        saveDatabase();
        res.json({
            message: 'Interest record reversed successfully',
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
};

router.post('/accounts/:id/interest-records/:recordId/reverse', handleInterestReversal);
router.post('/interest-records/:id/reverse', handleInterestReversal);

// ─── Get correction history / chain for an interest record (§21, §22) ─
const handleCorrectionHistory = async (req, res) => {
    try {
        const db = await getDatabase();
        const recordId = req.params.recordId || req.params.id;
        const result = getInterestCorrectionChain(db, recordId);
        res.json({
            message: 'Interest correction history retrieved successfully',
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
};

router.get('/accounts/:id/interest-records/:recordId/correction-history', handleCorrectionHistory);
router.get('/interest-records/:id/correction-history', handleCorrectionHistory);

// ─── Prohibit audit log editing & deletion (Historical Immutability §11, §43, §49) ──
const immutableAuditHandler = (req, res) => {
    res.status(405).json({
        error: 'Method Not Allowed: Audit log entries are immutable historical records. Editing and deletion are strictly prohibited.'
    });
};

router.put('/audit-logs/:id', immutableAuditHandler);
router.patch('/audit-logs/:id', immutableAuditHandler);
router.delete('/audit-logs/:id', immutableAuditHandler);
router.put('/accounts/:id/interest-records/:recordId/audit', immutableAuditHandler);
router.patch('/accounts/:id/interest-records/:recordId/audit', immutableAuditHandler);
router.delete('/accounts/:id/interest-records/:recordId/audit', immutableAuditHandler);
router.put('/interest-records/:id/audit', immutableAuditHandler);
router.patch('/interest-records/:id/audit', immutableAuditHandler);
router.delete('/interest-records/:id/audit', immutableAuditHandler);

// ─── Prohibit editing & deletion of reversals and correction chains ──
const immutableReversalHandler = (req, res) => {
    res.status(405).json({
        error: 'Method Not Allowed: Reversal and correction records are immutable. Direct modification or deletion is prohibited.'
    });
};

router.put('/accounts/:id/interest-records/:recordId/reverse', immutableReversalHandler);
router.patch('/accounts/:id/interest-records/:recordId/reverse', immutableReversalHandler);
router.delete('/accounts/:id/interest-records/:recordId/reverse', immutableReversalHandler);
router.put('/interest-records/:id/reverse', immutableReversalHandler);
router.patch('/interest-records/:id/reverse', immutableReversalHandler);
router.delete('/interest-records/:id/reverse', immutableReversalHandler);

router.put('/accounts/:id/interest-records/:recordId/correction-history', immutableReversalHandler);
router.patch('/accounts/:id/interest-records/:recordId/correction-history', immutableReversalHandler);
router.delete('/accounts/:id/interest-records/:recordId/correction-history', immutableReversalHandler);
router.put('/interest-records/:id/correction-history', immutableReversalHandler);
router.patch('/interest-records/:id/correction-history', immutableReversalHandler);
router.delete('/interest-records/:id/correction-history', immutableReversalHandler);

// ═══════════════════════════════════════════════════════════════
// Step 6A: Loan Interest Configurations API
// ═══════════════════════════════════════════════════════════════
const {
    createInterestConfig,
    getAccountInterestConfigs,
    getInterestConfigById,
    updateInterestConfig,
    getActiveInterestConfig
} = require('../services/interestConfigService');

// ─── List interest configurations for an account ─────────────
router.get('/accounts/:id/interest-configs', async (req, res) => {
    try {
        const db = await getDatabase();
        const configs = getAccountInterestConfigs(db, req.params.id);
        res.json({
            message: 'Account interest configurations retrieved successfully',
            data: configs,
            count: configs.length
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// ─── Create a new interest configuration for an account ──────
router.post('/accounts/:id/interest-configs', async (req, res) => {
    try {
        const db = await getDatabase();
        const newConfig = createInterestConfig(db, req.params.id, req.body);
        res.status(201).json({
            message: 'Interest configuration created successfully',
            data: newConfig
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message, errors: err.errors });
    }
});

// ─── Get active interest configuration for an account ────────
router.get('/accounts/:id/interest-configs/active', async (req, res) => {
    try {
        const db = await getDatabase();
        const activeConfig = getActiveInterestConfig(db, req.params.id, req.query.date);
        res.json({
            message: activeConfig ? 'Active interest configuration retrieved' : 'No active configuration found for date',
            data: activeConfig
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// ─── Get single configuration by ID ──────────────────────────
router.get('/interest-configs/:id', async (req, res) => {
    try {
        const db = await getDatabase();
        const config = getInterestConfigById(db, req.params.id);
        if (!config) {
            return res.status(404).json({ error: `Interest configuration #${req.params.id} not found` });
        }
        res.json({
            message: 'Interest configuration retrieved successfully',
            data: config
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// ─── Update configuration by ID (e.g. set effective_to) ───────
router.put('/interest-configs/:id', async (req, res) => {
    try {
        const db = await getDatabase();
        const updated = updateInterestConfig(db, req.params.id, req.body);
        res.json({
            message: 'Interest configuration updated successfully',
            data: updated
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message, errors: err.errors });
    }
});

// ═══════════════════════════════════════════════════════════════
// STEP 6H: INTEREST HISTORY ENDPOINTS (READ-ONLY)
// ═══════════════════════════════════════════════════════════════
const {
    getAccountInterestHistory,
    getPersonInterestHistory,
    getInterestHistory,
    getInterestRecordDetails
} = require('../services/interestHistoryService');

// ─── Account/Loan-Level Interest History ───────────────────────
const handleAccountInterestHistory = async (req, res) => {
    try {
        const db = await getDatabase();
        const history = getAccountInterestHistory(db, req.params.id, req.query);
        res.json({
            message: 'Account interest history retrieved successfully',
            ...history,
            data: history
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
};

router.get('/accounts/:id/interest-history', handleAccountInterestHistory);
router.get('/loans/:id/interest-history', handleAccountInterestHistory);
router.get('/loans/:id/interest', handleAccountInterestHistory);

// ─── Person-Level Interest History ────────────────────────────
router.get('/people/:id/interest-history', async (req, res) => {
    try {
        const db = await getDatabase();
        const history = getPersonInterestHistory(db, req.params.id, req.query);
        res.json({
            message: 'Person interest history retrieved successfully',
            ...history,
            data: history
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// ─── General Interest History Query ───────────────────────────
router.get('/interest-history', async (req, res) => {
    try {
        const db = await getDatabase();
        const history = getInterestHistory(db, req.query, req.query);
        res.json({
            message: 'Interest history retrieved successfully',
            ...history,
            data: history
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// ─── Single Interest Record History Detail ────────────────────
router.get('/interest-records/:id/history-detail', async (req, res) => {
    try {
        const db = await getDatabase();
        const detail = getInterestRecordDetails(db, req.params.id);
        res.json({
            message: 'Interest record details retrieved successfully',
            data: detail
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// STEP 6I: INTEREST RECALCULATION & CORRECTION ENDPOINTS
// ═══════════════════════════════════════════════════════════════
const {
    recalculateInterestForRecord,
    correctInterestRecord
} = require('../services/interestCorrectionService');

// ─── Recalculate interest for a record (read-only preview) ────
const handleRecalculate = async (req, res) => {
    try {
        const db = await getDatabase();
        const recordId = req.params.recordId || req.params.id;
        const result = recalculateInterestForRecord(db, recordId, req.body);
        res.json({
            message: 'Interest recalculation computed successfully',
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
};

router.post('/interest-records/:id/recalculate', handleRecalculate);
router.post('/accounts/:id/interest-records/:recordId/recalculate', handleRecalculate);

// ─── Correct an interest record (atomic replacement) ──────────
const handleCorrection = async (req, res) => {
    try {
        const db = await getDatabase();
        const recordId = req.params.recordId || req.params.id;
        const result = correctInterestRecord(db, recordId, req.body);
        res.json({
            message: result.message || 'Interest record corrected successfully',
            data: result
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message, code: err.code });
    }
};

router.post('/interest-records/:id/correct', handleCorrection);
router.post('/accounts/:id/interest-records/:recordId/correct', handleCorrection);

// ═══════════════════════════════════════════════════════════════
// STEP 7A/7B/7C/7D/7E/7F/7G/7H: DASHBOARD ENDPOINTS
// ═══════════════════════════════════════════════════════════════
const {
    getDashboardSummary,
    getLoanSummaries,
    getPeopleSummaries,
    getInterestPaymentSummary,
    getDueCollectionSummary,
    getCollectionItems,
    getRecentActivity,
    getIntegratedDashboard
} = require('../services/dashboardService');

router.get('/dashboard/summary', async (req, res) => {
    try {
        const db = await getDatabase();
        const options = {};
        if (req.query.person_id) {
            options.person_id = req.query.person_id;
        }
        const summary = getDashboardSummary(db, options);
        res.json({
            message: 'Dashboard summary retrieved successfully',
            data: summary,
            ...summary
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// Step 7C: Loan / Account Summaries
const handleLoanSummaries = async (req, res) => {
    try {
        const db = await getDatabase();
        const options = {
            person_id: req.query.person_id,
            status: req.query.status || req.query.loan_status,
            direction: req.query.direction
        };
        const items = getLoanSummaries(db, options);
        res.json({
            message: 'Loan summaries retrieved successfully',
            items: items,
            data: items,
            count: items.length
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
};

router.get('/dashboard/loans', handleLoanSummaries);
router.get('/dashboard/accounts', handleLoanSummaries);

// Step 7D: People / Customer Summaries
const handlePeopleSummaries = async (req, res) => {
    try {
        const db = await getDatabase();
        const options = {
            person_id: req.query.person_id
        };
        const items = getPeopleSummaries(db, options);
        res.json({
            message: 'People summaries retrieved successfully',
            items: items,
            data: items,
            count: items.length
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
};

router.get('/dashboard/people', handlePeopleSummaries);
router.get('/dashboard/customers', handlePeopleSummaries);

// Step 7E: Interest & Payment Financial Summary
const handleFinancialSummary = async (req, res) => {
    try {
        const db = await getDatabase();
        const options = {
            person_id: req.query.person_id,
            account_id: req.query.account_id || req.query.loan_id
        };
        const summary = getInterestPaymentSummary(db, options);
        res.json({
            message: 'Financial summary retrieved successfully',
            interest: summary.interest,
            payments: summary.payments,
            data: summary,
            ...summary
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
};

router.get('/dashboard/financial-summary', handleFinancialSummary);
router.get('/dashboard/interest-payments', handleFinancialSummary);

// Step 7F: Due & Collection Summary
const handleDueSummary = async (req, res) => {
    try {
        const db = await getDatabase();
        const options = {
            person_id: req.query.person_id,
            as_of_date: req.query.as_of_date || req.query.current_date || req.query.date
        };
        const summary = getDueCollectionSummary(db, options);
        res.json({
            message: 'Due and collection summary retrieved successfully',
            data: summary,
            ...summary
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
};

router.get('/dashboard/due-summary', handleDueSummary);
router.get('/dashboard/collections/summary', handleDueSummary);

// Step 7F: Collection Items (Due / Overdue Loan List)
const handleCollections = async (req, res) => {
    try {
        const db = await getDatabase();
        const options = {
            person_id: req.query.person_id,
            as_of_date: req.query.as_of_date || req.query.current_date || req.query.date
        };
        const items = getCollectionItems(db, options);
        res.json({
            message: 'Collection items retrieved successfully',
            items: items,
            data: items,
            count: items.length
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
};

router.get('/dashboard/collections', handleCollections);
router.get('/dashboard/collection-items', handleCollections);

// Step 7G: Recent Activity Summary
const handleRecentActivity = async (req, res) => {
    try {
        const db = await getDatabase();
        const options = {
            person_id: req.query.person_id,
            account_id: req.query.account_id || req.query.loan_id,
            limit: req.query.limit
        };
        const items = getRecentActivity(db, options);
        res.json({
            message: 'Recent activity retrieved successfully',
            items: items,
            data: items,
            count: items.length
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
};

router.get('/dashboard/recent-activity', handleRecentActivity);
router.get('/dashboard/activity', handleRecentActivity);

// Step 7H: Integrated Dashboard Endpoint
const handleIntegratedDashboard = async (req, res) => {
    try {
        const db = await getDatabase();
        const options = {
            person_id: req.query.person_id,
            as_of_date: req.query.as_of_date || req.query.current_date || req.query.date,
            limit: req.query.limit,
            status: req.query.status || req.query.loan_status,
            direction: req.query.direction
        };
        const dashboard = getIntegratedDashboard(db, options);
        res.json({
            message: 'Dashboard data retrieved successfully',
            data: dashboard,
            ...dashboard
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
};

router.get('/dashboard', handleIntegratedDashboard);
router.get('/dashboard/all', handleIntegratedDashboard);

// ═══════════════════════════════════════════════════════════════
// PART 8: DUE / OVERDUE TRACKING ENDPOINTS
// ═══════════════════════════════════════════════════════════════
const {
    getDueOverdueSummary,
    getDueLoans,
    getOverdueLoans,
    getCollectionItems: getPart8CollectionItems
} = require('../services/dueTrackingService');

// 8F.1: Due / Overdue Summary
const handleDueOverdueSummary = async (req, res) => {
    try {
        const db = await getDatabase();
        const options = {
            person_id: req.query.person_id,
            account_id: req.query.account_id || req.query.loan_id,
            as_of_date: req.query.as_of_date || req.query.current_date || req.query.date,
            grace_period: req.query.grace_period
        };
        const summary = getDueOverdueSummary(db, options);
        res.json({
            message: 'Due and overdue summary retrieved successfully',
            data: summary,
            ...summary
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
};

router.get('/due-overdue/summary', handleDueOverdueSummary);
router.get('/due/summary', handleDueOverdueSummary);
router.get('/overdue/summary', handleDueOverdueSummary);

// 8F.2: Due Loans
const handleDueLoans = async (req, res) => {
    try {
        const db = await getDatabase();
        const options = {
            person_id: req.query.person_id,
            account_id: req.query.account_id || req.query.loan_id,
            as_of_date: req.query.as_of_date || req.query.current_date || req.query.date,
            grace_period: req.query.grace_period,
            limit: req.query.limit
        };
        const items = getDueLoans(db, options);
        res.json({
            message: 'Due loans retrieved successfully',
            items: items,
            data: items,
            count: items.length
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
};

router.get('/due', handleDueLoans);
router.get('/due/loans', handleDueLoans);

// 8F.3: Overdue Loans
const handleOverdueLoans = async (req, res) => {
    try {
        const db = await getDatabase();
        const options = {
            person_id: req.query.person_id,
            account_id: req.query.account_id || req.query.loan_id,
            as_of_date: req.query.as_of_date || req.query.current_date || req.query.date,
            grace_period: req.query.grace_period,
            limit: req.query.limit
        };
        const items = getOverdueLoans(db, options);
        res.json({
            message: 'Overdue loans retrieved successfully',
            items: items,
            data: items,
            count: items.length
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
};

router.get('/overdue', handleOverdueLoans);
router.get('/overdue/loans', handleOverdueLoans);

// 8G: Collection Attention List
const handleCollectionList = async (req, res) => {
    try {
        const db = await getDatabase();
        const options = {
            person_id: req.query.person_id,
            account_id: req.query.account_id || req.query.loan_id,
            as_of_date: req.query.as_of_date || req.query.current_date || req.query.date,
            grace_period: req.query.grace_period,
            include_due: req.query.include_due === 'true' || req.query.include_due === '1',
            limit: req.query.limit
        };
        const items = getPart8CollectionItems(db, options);
        res.json({
            message: 'Collection items retrieved successfully',
            items: items,
            data: items,
            count: items.length
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ error: err.message });
    }
};

router.get('/collections', handleCollectionList);
router.get('/collections/items', handleCollectionList);

// ═══════════════════════════════════════════════════════════════
// PART 9 — REPORTS API (9I)
// ═══════════════════════════════════════════════════════════════
const {
    REPORT_TYPES,
    generateReport,
    generateLoanPortfolioReport,
    generatePeopleReport,
    generatePaymentReport,
    generateInterestReport,
    generateDueOverdueReport,
    generateCollectionReport
} = require('../services/reportService');

const extractReportOptions = (req, explicitType = null) => ({
    report_type: explicitType || req.params.report_type || req.query.report_type || req.query.type,
    start_date: req.query.start_date || req.query.from || req.query.startDate,
    end_date: req.query.end_date || req.query.to || req.query.endDate,
    as_of_date: req.query.as_of_date || req.query.current_date || req.query.date,
    person_id: req.query.person_id || req.query.personId,
    loan_id: req.query.loan_id || req.query.loanId || req.query.account_id || req.query.accountId,
    status: req.query.status,
    transaction_type: req.query.transaction_type || req.query.tx_type,
    grace_period: req.query.grace_period,
    page: req.query.page,
    page_size: req.query.page_size || req.query.pageSize || req.query.limit
});

// Specific report endpoints
router.get('/reports/loans', async (req, res) => {
    try {
        const db = await getDatabase();
        const report = generateLoanPortfolioReport(db, extractReportOptions(req, REPORT_TYPES.LOAN_PORTFOLIO));
        res.json({ message: 'Loan portfolio report generated successfully', data: report, ...report });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

router.get('/reports/portfolio', async (req, res) => {
    try {
        const db = await getDatabase();
        const report = generateLoanPortfolioReport(db, extractReportOptions(req, REPORT_TYPES.LOAN_PORTFOLIO));
        res.json({ message: 'Loan portfolio report generated successfully', data: report, ...report });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

router.get('/reports/people', async (req, res) => {
    try {
        const db = await getDatabase();
        const report = generatePeopleReport(db, extractReportOptions(req, REPORT_TYPES.PEOPLE));
        res.json({ message: 'People report generated successfully', data: report, ...report });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

router.get('/reports/payments', async (req, res) => {
    try {
        const db = await getDatabase();
        const report = generatePaymentReport(db, extractReportOptions(req, REPORT_TYPES.PAYMENTS));
        res.json({ message: 'Payment report generated successfully', data: report, ...report });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

router.get('/reports/transactions', async (req, res) => {
    try {
        const db = await getDatabase();
        const report = generatePaymentReport(db, extractReportOptions(req, REPORT_TYPES.PAYMENTS));
        res.json({ message: 'Payment report generated successfully', data: report, ...report });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

router.get('/reports/interest', async (req, res) => {
    try {
        const db = await getDatabase();
        const report = generateInterestReport(db, extractReportOptions(req, REPORT_TYPES.INTEREST));
        res.json({ message: 'Interest report generated successfully', data: report, ...report });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

router.get('/reports/due-overdue', async (req, res) => {
    try {
        const db = await getDatabase();
        const report = generateDueOverdueReport(db, extractReportOptions(req, REPORT_TYPES.DUE_OVERDUE));
        res.json({ message: 'Due/overdue report generated successfully', data: report, ...report });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

router.get('/reports/collections', async (req, res) => {
    try {
        const db = await getDatabase();
        const report = generateCollectionReport(db, extractReportOptions(req, REPORT_TYPES.COLLECTION));
        res.json({ message: 'Collection report generated successfully', data: report, ...report });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

// Parameterized & unified report endpoints
router.get('/reports/:report_type', async (req, res) => {
    try {
        const db = await getDatabase();
        const report = generateReport(db, extractReportOptions(req));
        res.json({ message: `${report.report_type} report generated successfully`, data: report, ...report });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

router.get('/reports', async (req, res) => {
    try {
        const db = await getDatabase();
        const options = extractReportOptions(req);
        if (!options.report_type) {
            return res.status(400).json({
                error: `Report type parameter required (?type=... or ?report_type=...). Must be one of: ${Object.values(REPORT_TYPES).join(', ')}`
            });
        }
        const report = generateReport(db, options);
        res.json({ message: `${report.report_type} report generated successfully`, data: report, ...report });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// PART 10 — PERSON STATEMENTS & PDF API (10F, 10H)
// ═══════════════════════════════════════════════════════════════
const { generatePersonStatement } = require('../services/statementService');
const { generateStatementPdf, generateStatementFilename } = require('../services/pdfService');

const handleStatementJson = async (req, res) => {
    try {
        const db = await getDatabase();
        let personId = req.params.person_id;
        let loanId = req.query.loan_id || req.query.account_id;

        // If called via /statements/loan/:loan_id, look up person_id
        if (!personId && req.params.loan_id) {
            loanId = req.params.loan_id;
            const acc = queryOne(db, 'SELECT person_id FROM accounts WHERE id = ?', [loanId]);
            if (!acc) {
                return res.status(404).json({ error: `Loan #${loanId} not found` });
            }
            personId = acc.person_id;
        }

        const options = {
            loan_id: loanId,
            start_date: req.query.start_date || req.query.from,
            end_date: req.query.end_date || req.query.to,
            as_of_date: req.query.as_of_date || req.query.current_date || req.query.date,
            grace_period: req.query.grace_period
        };

        const statement = generatePersonStatement(db, personId, options);
        res.json({
            message: 'Person statement generated successfully',
            success: true,
            statement: statement,
            data: statement,
            ...statement
        });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
};

const handleStatementPdf = async (req, res) => {
    try {
        const db = await getDatabase();
        let personId = req.params.person_id;
        let loanId = req.query.loan_id || req.query.account_id;

        if (!personId && req.params.loan_id) {
            loanId = req.params.loan_id;
            const acc = queryOne(db, 'SELECT person_id FROM accounts WHERE id = ?', [loanId]);
            if (!acc) {
                return res.status(404).json({ error: `Loan #${loanId} not found` });
            }
            personId = acc.person_id;
        }

        const options = {
            loan_id: loanId,
            start_date: req.query.start_date || req.query.from,
            end_date: req.query.end_date || req.query.to,
            as_of_date: req.query.as_of_date || req.query.current_date || req.query.date,
            grace_period: req.query.grace_period
        };

        const statement = generatePersonStatement(db, personId, options);
        const pdfBuffer = await generateStatementPdf(statement);
        const filename = generateStatementFilename(statement);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.end(pdfBuffer);
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
};

router.get('/people/:person_id/statement', handleStatementJson);
router.get('/people/:person_id/statement/pdf', handleStatementPdf);
router.get('/statements/person/:person_id', handleStatementJson);
router.get('/statements/person/:person_id/pdf', handleStatementPdf);
router.get('/statements/loan/:loan_id', handleStatementJson);
router.get('/statements/loan/:loan_id/pdf', handleStatementPdf);

// ═══════════════════════════════════════════════════════════════
// PART 11 — EXCEL EXPORT & BACKUP/RESTORE API (11B, 11G, 11H, 11J)
// ═══════════════════════════════════════════════════════════════
const {
    exportPeople,
    exportLoans,
    exportTransactions,
    exportInterest,
    exportDueOverdue,
    exportCollection,
    exportReport,
    exportPersonStatement
} = require('../services/excelExportService');

const {
    createBackup,
    validateBackup,
    restoreBackup,
    getBackupStatus,
    generateBackupFilename
} = require('../services/backupService');

// Statement Excel Handler
const handleStatementExcel = async (req, res) => {
    try {
        const db = await getDatabase();
        let personId = req.params.person_id;
        let loanId = req.query.loan_id || req.query.account_id;

        if (!personId && req.params.loan_id) {
            loanId = req.params.loan_id;
            const acc = queryOne(db, 'SELECT person_id FROM accounts WHERE id = ?', [loanId]);
            if (!acc) {
                return res.status(404).json({ error: `Loan #${loanId} not found` });
            }
            personId = acc.person_id;
        }

        const options = {
            loan_id: loanId,
            start_date: req.query.start_date || req.query.from,
            end_date: req.query.end_date || req.query.to,
            as_of_date: req.query.as_of_date || req.query.current_date || req.query.date,
            grace_period: req.query.grace_period
        };

        const excelResult = await exportPersonStatement(db, personId, options);
        res.setHeader('Content-Type', excelResult.contentType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${excelResult.filename}"`);
        res.setHeader('Content-Length', excelResult.length);
        res.end(excelResult);
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
};

router.get('/people/:person_id/statement/excel', handleStatementExcel);
router.get('/statements/person/:person_id/excel', handleStatementExcel);
router.get('/statements/loan/:loan_id/excel', handleStatementExcel);

// Report Excel Endpoints
router.get('/reports/:report_type/excel', async (req, res) => {
    try {
        const db = await getDatabase();
        const options = extractReportOptions(req);
        const excelResult = await exportReport(db, options);
        res.setHeader('Content-Type', excelResult.contentType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${excelResult.filename}"`);
        res.setHeader('Content-Length', excelResult.length);
        res.end(excelResult);
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

router.get('/reports/excel', async (req, res) => {
    try {
        const db = await getDatabase();
        const options = extractReportOptions(req);
        if (!options.report_type) {
            return res.status(400).json({ error: 'Report type parameter required (?type=... or ?report_type=...)' });
        }
        const excelResult = await exportReport(db, options);
        res.setHeader('Content-Type', excelResult.contentType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${excelResult.filename}"`);
        res.setHeader('Content-Length', excelResult.length);
        res.end(excelResult);
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

// Domain Convenience Excel Endpoints
router.get('/people/export/excel', async (req, res) => {
    try {
        const db = await getDatabase();
        const excelResult = await exportPeople(db, req.query);
        res.setHeader('Content-Type', excelResult.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${excelResult.filename}"`);
        res.setHeader('Content-Length', excelResult.length);
        res.end(excelResult);
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

router.get(['/accounts/export/excel', '/loans/export/excel'], async (req, res) => {
    try {
        const db = await getDatabase();
        const excelResult = await exportLoans(db, req.query);
        res.setHeader('Content-Type', excelResult.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${excelResult.filename}"`);
        res.setHeader('Content-Length', excelResult.length);
        res.end(excelResult);
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

router.get('/transactions/export/excel', async (req, res) => {
    try {
        const db = await getDatabase();
        const excelResult = await exportTransactions(db, req.query);
        res.setHeader('Content-Type', excelResult.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${excelResult.filename}"`);
        res.setHeader('Content-Length', excelResult.length);
        res.end(excelResult);
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

// ─── Backup & Restore Endpoints (12M, 12E.3) ─────────────────
router.get('/backup/export', requireStaffOrAdmin, async (req, res) => {
    try {
        const db = await getDatabase();
        const backupPackage = createBackup(db);
        const filename = generateBackupFilename(backupPackage.metadata.created_at);
        const jsonStr = JSON.stringify(backupPackage, null, 2);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(jsonStr);
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

router.get('/backup/status', async (req, res) => {
    try {
        const db = await getDatabase();
        const status = getBackupStatus(db);
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/backup/validate', requireStaffOrAdmin, (req, res) => {
    try {
        const backupData = req.body.backup || req.body;
        const validationResult = validateBackup(backupData);
        res.json({ success: true, message: 'Backup validation passed', ...validationResult });
    } catch (err) {
        res.status(err.statusCode || 400).json({ success: false, error: err.message });
    }
});

router.post('/backup/restore', requireAdmin, async (req, res) => {
    try {
        const db = await getDatabase();
        const backupData = req.body.backup || req.body.data || req.body;
        const confirm = req.body.confirm || req.body.confirmation;
        const result = restoreBackup(db, backupData, { confirm });
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ success: false, error: err.message });
    }
});

module.exports = router;







