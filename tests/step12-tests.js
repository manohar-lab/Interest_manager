/**
 * Interest Manager — Part 12 Test Suite: Authentication, PIN, Security & Notifications
 *
 * Verifies all specifications of Part 12 (12O.1 to 12O.28):
 *   12O.1:  Unauthenticated access -> 401
 *   12O.2:  Invalid credentials -> 401 (generic failure)
 *   12O.3:  Disabled user -> rejected
 *   12O.4:  Session expiration -> 401
 *   12O.5:  Role enforcement (Viewer cannot perform write operations) -> 403
 *   12O.6:  IDOR testing (resource scoping & 404s)
 *   12O.7:  Report authorization (401 without auth)
 *   12O.8:  Dashboard authorization (401 without auth)
 *   12O.9:  Excel export authorization (401 without auth)
 *   12O.10: PDF statement authorization (401 without auth)
 *   12O.11: Backup creation authorization (Viewer rejected with 403)
 *   12O.12: Restore authorization (Non-admin rejected with 403)
 *   12O.13: PIN test (setup, correct, incorrect, lockout after 5, change, reset)
 *   12O.14: PIN storage test (no raw PIN in DB)
 *   12O.15: Password storage test (no raw password in DB)
 *   12O.16: Credential logging test (no secrets in audit_logs)
 *   12O.17: Rate limit test (throttling triggers 429)
 *   12O.18: Notification test (due/overdue condition generates notification)
 *   12O.19: Duplicate notification prevention (re-run generates 0 duplicates)
 *   12O.20: Notification authorization (authenticated user only)
 *   12O.21: Notification financial integrity (zero balance mutations)
 *   12O.22: Backup round-trip with auth enabled
 *   12O.23: Restore security (users/roles/credentials preserved after restore)
 *   12O.24: XSS defense (HTML/script tags stored & handled as text)
 *   12O.25: SQL injection defense (malicious SQL inputs safely handled)
 *   12O.26: Sensitive URL test (no credentials in query strings)
 *   12O.27: Session fixation defense (fresh token generated per login)
 *   12O.28: Logout test (invalidated token rejected on subsequent calls)
 */

const assert = require('assert');
const http = require('http');
const express = require('express');
const initSqlJs = require('sql.js');

const {
    ROLES,
    STATUSES,
    hashPassword,
    verifyPassword,
    hashPin,
    verifyPin,
    login,
    logout,
    getUserFromSession,
    changePassword,
    setupPin,
    verifyUserPin,
    changePin,
    resetPin,
    requestPasswordReset,
    completePasswordReset,
    createUser,
    setUserStatus,
    listUsers
} = require('../services/authService');

const {
    NOTIFICATION_TYPES,
    createNotification,
    getNotifications,
    getUnreadCount,
    markAsRead,
    markAllAsRead,
    checkDueAndOverdueNotifications
} = require('../services/notificationService');

const { createRateLimiter, resetRateLimiters } = require('../middleware/rateLimiter');
const { queryOne, queryAll } = require('../db/helpers');
const apiRoutes = require('../routes/api');
const { getDatabase } = require('../db/connection');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    Error: ${err.message}\n`);
        failed++;
    }
}

async function createFreshInMemoryDb(SQL) {
    const db = new SQL.Database();
    db.run('PRAGMA foreign_keys = ON;');

    // Schema definition
    db.run(`
        CREATE TABLE people (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT,
            address TEXT,
            notes TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            person_id INTEGER NOT NULL,
            direction TEXT NOT NULL,
            principal INTEGER NOT NULL,
            outstanding_principal INTEGER NOT NULL,
            interest_rate REAL NOT NULL,
            interest_frequency TEXT NOT NULL,
            calculation_method TEXT NOT NULL,
            start_date TEXT NOT NULL,
            due_date TEXT NOT NULL,
            grace_period INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'ACTIVE',
            notes TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (person_id) REFERENCES people(id)
        );

        CREATE TABLE interest_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            period_start TEXT NOT NULL,
            period_end TEXT NOT NULL,
            principal_basis INTEGER NOT NULL,
            interest_rate REAL NOT NULL,
            interest_amount INTEGER NOT NULL,
            paid_amount INTEGER NOT NULL DEFAULT 0,
            calculation_method TEXT NOT NULL DEFAULT 'SIMPLE_INTEREST',
            status TEXT NOT NULL DEFAULT 'PENDING',
            reversal_reason TEXT,
            reversed_at TEXT,
            reversal_actor_id TEXT,
            reversal_source TEXT,
            corrects_record_id INTEGER,
            corrected_by_record_id INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (account_id) REFERENCES accounts(id)
        );

        CREATE TABLE audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL,
            entity_id INTEGER NOT NULL,
            action TEXT NOT NULL,
            old_value TEXT,
            new_value TEXT,
            timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'VIEWER',
            status TEXT NOT NULL DEFAULT 'ACTIVE',
            pin_hash TEXT,
            pin_salt TEXT,
            pin_failed_attempts INTEGER NOT NULL DEFAULT 0,
            pin_locked_until TEXT,
            reset_token TEXT,
            reset_token_expires_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_login_at TEXT
        );

        CREATE TABLE user_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT NOT NULL UNIQUE,
            user_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            ip_address TEXT,
            user_agent TEXT,
            expires_at TEXT NOT NULL,
            revoked_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            reference_type TEXT,
            reference_id INTEGER,
            event_key TEXT UNIQUE,
            status TEXT NOT NULL DEFAULT 'UNREAD',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            read_at TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `);

    // Seed default test users
    const adminPass = hashPassword('AdminPassword@123');
    const staffPass = hashPassword('StaffPassword@123');
    const viewerPass = hashPassword('ViewerPassword@123');

    db.run(`
        INSERT INTO users (username, password_hash, password_salt, role, status)
        VALUES 
            ('admin', ?, ?, 'ADMIN', 'ACTIVE'),
            ('staff', ?, ?, 'STAFF', 'ACTIVE'),
            ('viewer', ?, ?, 'VIEWER', 'ACTIVE');
    `, [
        adminPass.hash, adminPass.salt,
        staffPass.hash, staffPass.salt,
        viewerPass.hash, viewerPass.salt
    ]);

    return db;
}

// ─── HTTP Test Server Helper ──────────────────────────────────────────
function createTestHttpServer(db) {
    const testApp = express();
    testApp.use(express.json({ limit: '50mb' }));
    testApp.use('/api', apiRoutes);

    return new Promise((resolve) => {
        const server = testApp.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            function request(method, path, body = null, token = null) {
                return new Promise((res, rej) => {
                    const headers = { 'Content-Type': 'application/json' };
                    if (token) headers['Authorization'] = `Bearer ${token}`;

                    const req = http.request({
                        hostname: '127.0.0.1',
                        port,
                        path: `/api${path}`,
                        method,
                        headers
                    }, response => {
                        const chunks = [];
                        response.on('data', c => chunks.push(c));
                        response.on('end', () => {
                            const raw = Buffer.concat(chunks).toString('utf-8');
                            let parsed;
                            try { parsed = JSON.parse(raw); } catch { parsed = raw; }
                            res({ statusCode: response.statusCode, headers: response.headers, body: parsed });
                        });
                    });
                    req.on('error', rej);
                    if (body) req.write(JSON.stringify(body));
                    req.end();
                });
            }
            resolve({ server, port, request, close: () => new Promise(r => server.close(r)) });
        });
    });
}

async function runAll() {
    console.log('\n================================================================');
    console.log('   INTEREST MANAGER — PART 12: SECURITY & NOTIFICATIONS TESTS');
    console.log('================================================================\n');

    const SQL = await initSqlJs();
    const liveDb = await getDatabase();
    const httpTester = await createTestHttpServer(liveDb);

    try {
        // Acquire test tokens for admin, staff, and viewer
        const adminLogin = await httpTester.request('POST', '/auth/login', { username: 'admin', password: 'AdminPassword@123' });
        assert.strictEqual(adminLogin.statusCode, 200);
        const adminToken = adminLogin.body.token;

        const staffLogin = await httpTester.request('POST', '/auth/login', { username: 'staff', password: 'StaffPassword@123' });
        assert.strictEqual(staffLogin.statusCode, 200);
        const staffToken = staffLogin.body.token;

        const viewerLogin = await httpTester.request('POST', '/auth/login', { username: 'viewer', password: 'ViewerPassword@123' });
        assert.strictEqual(viewerLogin.statusCode, 200);
        const viewerToken = viewerLogin.body.token;

        // ─── 12O.1: Unauthenticated Access ─────────────────────────
        await runTest('12O.1 Unauthenticated access -> 401', async () => {
            const res = await httpTester.request('GET', '/people', null, null);
            assert.strictEqual(res.statusCode, 401);
            assert.strictEqual(res.body.success, false);
        });

        // ─── 12O.2: Invalid Credentials ────────────────────────────
        await runTest('12O.2 Invalid credentials -> 401 generic failure', async () => {
            const res = await httpTester.request('POST', '/auth/login', { username: 'admin', password: 'WrongPassword999!' });
            assert.strictEqual(res.statusCode, 401);
            assert.strictEqual(res.body.success, false);
            assert.match(res.body.error, /invalid username or password/i);
        });

        // ─── 12O.3: Disabled User ──────────────────────────────────
        await runTest('12O.3 Disabled user rejection', async () => {
            const db = await createFreshInMemoryDb(SQL);
            const user = createUser(db, { username: 'inactive_user', password: 'Password@123', role: ROLES.STAFF });
            setUserStatus(db, user.id, STATUSES.DISABLED);

            assert.throws(() => {
                login(db, 'inactive_user', 'Password@123');
            }, /account is disabled/i);
        });

        // ─── 12O.4: Session Expiration ─────────────────────────────
        await runTest('12O.4 Session expiration -> 401', async () => {
            const db = await createFreshInMemoryDb(SQL);
            const { token } = login(db, 'admin', 'AdminPassword@123');

            // Fast forward expiration to the past
            db.run("UPDATE user_sessions SET expires_at = datetime('now', '-1 hour') WHERE token = ?", [token]);

            const user = getUserFromSession(db, token);
            assert.strictEqual(user, null);
        });

        // ─── 12O.5: Role Enforcement ───────────────────────────────
        await runTest('12O.5 Role enforcement (Viewer cannot perform write operations -> 403)', async () => {
            const writeAttempt = await httpTester.request('POST', '/people', { name: 'Unauthorized Entry' }, viewerToken);
            assert.strictEqual(writeAttempt.statusCode, 403);
            assert.match(writeAttempt.body.error, /permission denied/i);
        });

        // ─── 12O.6: IDOR Testing ───────────────────────────────────
        await runTest('12O.6 IDOR testing (non-existent entity returns 404)', async () => {
            const res = await httpTester.request('GET', '/people/99999', null, viewerToken);
            assert.strictEqual(res.statusCode, 404);
        });

        // ─── 12O.7: Report Authorization ───────────────────────────
        await runTest('12O.7 Report authorization (401 without auth)', async () => {
            const res = await httpTester.request('GET', '/reports/loans', null, null);
            assert.strictEqual(res.statusCode, 401);
        });

        // ─── 12O.8: Dashboard Authorization ────────────────────────
        await runTest('12O.8 Dashboard authorization (401 without auth)', async () => {
            const res = await httpTester.request('GET', '/dashboard/summary', null, null);
            assert.strictEqual(res.statusCode, 401);
        });

        // ─── 12O.9: Excel Authorization ────────────────────────────
        await runTest('12O.9 Excel export authorization (401 without auth)', async () => {
            const res = await httpTester.request('GET', '/reports/loans/excel', null, null);
            assert.strictEqual(res.statusCode, 401);
        });

        // ─── 12O.10: PDF Authorization ─────────────────────────────
        await runTest('12O.10 PDF statement authorization (401 without auth)', async () => {
            const res = await httpTester.request('GET', '/people/1/statement/pdf', null, null);
            assert.strictEqual(res.statusCode, 401);
        });

        // ─── 12O.11: Backup Authorization ──────────────────────────
        await runTest('12O.11 Backup authorization (Viewer rejected with 403)', async () => {
            const res = await httpTester.request('GET', '/backup/export', null, viewerToken);
            assert.strictEqual(res.statusCode, 403);
        });

        // ─── 12O.12: Restore Authorization ─────────────────────────
        await runTest('12O.12 Restore authorization (Staff rejected with 403)', async () => {
            const res = await httpTester.request('POST', '/backup/restore', { confirm: true }, staffToken);
            assert.strictEqual(res.statusCode, 403);
        });

        // ─── 12O.13: PIN Test ──────────────────────────────────────
        await runTest('12O.13 PIN test (setup, verify, fail limit, lockout, change, reset)', async () => {
            const db = await createFreshInMemoryDb(SQL);
            const user = queryOne(db, "SELECT id FROM users WHERE username = 'staff'");

            // 1. Setup PIN
            const setupRes = setupPin(db, user.id, '4321', '4321');
            assert.strictEqual(setupRes.success, true);

            // 2. Correct PIN verification
            const verifySuccess = verifyUserPin(db, user.id, '4321');
            assert.strictEqual(verifySuccess.success, true);

            // 3. Incorrect PIN attempts
            assert.throws(() => verifyUserPin(db, user.id, '9999'), /incorrect pin/i);

            // 4. Repeat 4 more failures to trigger lockout (total 5)
            for (let i = 0; i < 3; i++) {
                assert.throws(() => verifyUserPin(db, user.id, '0000'), /incorrect pin/i);
            }
            // 5th failure triggers lockout
            assert.throws(() => verifyUserPin(db, user.id, '0000'), /pin locked/i);

            // 5. Subsequent call rejected due to active lock
            assert.throws(() => verifyUserPin(db, user.id, '4321'), /pin verification locked/i);

            // 6. Reset PIN with strong password authentication clears lock
            const resetRes = resetPin(db, user.id, 'StaffPassword@123', '7890', '7890');
            assert.strictEqual(resetRes.success, true);

            // Verify with new PIN
            const newPinOk = verifyUserPin(db, user.id, '7890');
            assert.strictEqual(newPinOk.success, true);

            // 7. Change PIN with existing PIN
            const changeRes = changePin(db, user.id, '7890', '5678', '5678');
            assert.strictEqual(changeRes.success, true);
            assert.strictEqual(verifyUserPin(db, user.id, '5678').success, true);
        });

        // ─── 12O.14: PIN Storage Test ──────────────────────────────
        await runTest('12O.14 PIN storage test (no raw PIN in database)', async () => {
            const db = await createFreshInMemoryDb(SQL);
            const user = queryOne(db, "SELECT id FROM users WHERE username = 'staff'");
            setupPin(db, user.id, '9876', '9876');

            const row = queryOne(db, 'SELECT pin_hash, pin_salt FROM users WHERE id = ?', [user.id]);
            assert.notStrictEqual(row.pin_hash, '9876');
            assert(row.pin_hash.length >= 32);
            assert(row.pin_salt.length >= 16);

            // Verify raw '9876' does not appear anywhere in user table row
            const allCols = queryOne(db, 'SELECT * FROM users WHERE id = ?', [user.id]);
            for (const [col, val] of Object.entries(allCols)) {
                assert.notStrictEqual(val, '9876', `Column ${col} contains raw PIN`);
            }
        });

        // ─── 12O.15: Password Storage Test ─────────────────────────
        await runTest('12O.15 Password storage test (no raw password in database)', async () => {
            const db = await createFreshInMemoryDb(SQL);
            const row = queryOne(db, "SELECT password_hash, password_salt FROM users WHERE username = 'admin'");
            assert.notStrictEqual(row.password_hash, 'AdminPassword@123');
            assert(row.password_hash.length >= 64);
            assert(row.password_salt.length >= 32);
        });

        // ─── 12O.16: Credential Logging Test ───────────────────────
        await runTest('12O.16 Credential logging test (zero secrets logged in audit_logs)', async () => {
            const db = await createFreshInMemoryDb(SQL);
            const user = queryOne(db, "SELECT id FROM users WHERE username = 'admin'");

            // Run login and PIN failure to generate security audit entries
            try { login(db, 'admin', 'WrongPassSecret123'); } catch (_) {}
            setupPin(db, user.id, '1122', '1122');
            try { verifyUserPin(db, user.id, '9999'); } catch (_) {}

            const logs = queryAll(db, 'SELECT * FROM audit_logs');
            for (const l of logs) {
                const combined = JSON.stringify(l);
                assert(!combined.includes('AdminPassword@123'), 'Raw password logged in audit');
                assert(!combined.includes('WrongPassSecret123'), 'Failed attempt password logged in audit');
                assert(!combined.includes('1122'), 'Raw PIN logged in audit');
            }
        });

        // ─── 12O.17: Rate Limit Test ───────────────────────────────
        await runTest('12O.17 Rate limit test (throttling triggers 429)', async () => {
            const app = express();
            const limiter = createRateLimiter({ keyPrefix: 'test_limit', maxAttempts: 3, windowMs: 60000 });
            app.use(limiter);
            app.get('/test', (req, res) => res.json({ ok: true }));

            const s = await new Promise(r => { const inst = app.listen(0, '127.0.0.1', () => r(inst)); });
            const p = s.address().port;

            async function hit() {
                return new Promise(resolve => {
                    http.get(`http://127.0.0.1:${p}/test`, res => {
                        res.resume();
                        res.on('end', () => resolve(res.statusCode));
                    });
                });
            }

            assert.strictEqual(await hit(), 200);
            assert.strictEqual(await hit(), 200);
            assert.strictEqual(await hit(), 200);
            const fourth = await hit();
            assert.strictEqual(fourth, 429, 'Expected 429 after exceeding maxAttempts');

            await new Promise(r => s.close(r));
        });

        // ─── 12O.18: Notification Test ─────────────────────────────
        await runTest('12O.18 Notification test (due/overdue condition creates notification)', async () => {
            const db = await createFreshInMemoryDb(SQL);
            db.run("INSERT INTO people (id, name) VALUES (1, 'Ramesh');");
            db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                    VALUES (1, 1, 'MONEY_GIVEN', 500000, 500000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'OVERDUE');`);

            const scanResult = checkDueAndOverdueNotifications(db, '2026-09-09');
            assert(scanResult.created.overdue >= 1);

            const notifs = getNotifications(db);
            assert(notifs.total >= 1);
            assert.strictEqual(notifs.items[0].type, NOTIFICATION_TYPES.OVERDUE);
            assert.strictEqual(notifs.items[0].status, 'UNREAD');
        });

        // ─── 12O.19: Duplicate Notification Test ───────────────────
        await runTest('12O.19 Duplicate notification prevention (re-run generates 0 duplicates)', async () => {
            const db = await createFreshInMemoryDb(SQL);
            db.run("INSERT INTO people (id, name) VALUES (1, 'Suresh');");
            db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                    VALUES (1, 1, 'MONEY_GIVEN', 500000, 500000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'OVERDUE');`);

            // First run: creates 1 notification
            const firstRun = checkDueAndOverdueNotifications(db, '2026-09-09');
            assert.strictEqual(firstRun.created.total, 1);

            // Second run: 0 new notifications
            const secondRun = checkDueAndOverdueNotifications(db, '2026-09-09');
            assert.strictEqual(secondRun.created.total, 0);

            // Notification count is still 1
            const notifs = getNotifications(db);
            assert.strictEqual(notifs.total, 1);
        });

        // ─── 12O.20: Notification Authorization ────────────────────
        await runTest('12O.20 Notification authorization (authenticated user only)', async () => {
            const unauth = await httpTester.request('GET', '/notifications', null, null);
            assert.strictEqual(unauth.statusCode, 401);

            const auth = await httpTester.request('GET', '/notifications', null, viewerToken);
            assert.strictEqual(auth.statusCode, 200);
            assert(Array.isArray(auth.body.items));
        });

        // ─── 12O.21: Notification Financial Integrity ──────────────
        await runTest('12O.21 Notification financial integrity (zero balance mutations)', async () => {
            const db = await createFreshInMemoryDb(SQL);
            db.run("INSERT INTO people (id, name) VALUES (1, 'Kavita');");
            db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                    VALUES (1, 1, 'MONEY_GIVEN', 1000000, 750000, 15.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-08-01', 'OVERDUE');`);

            const beforeAccount = queryOne(db, 'SELECT * FROM accounts WHERE id = 1');
            checkDueAndOverdueNotifications(db, '2026-09-09');
            const afterAccount = queryOne(db, 'SELECT * FROM accounts WHERE id = 1');

            assert.strictEqual(beforeAccount.principal, afterAccount.principal);
            assert.strictEqual(beforeAccount.outstanding_principal, afterAccount.outstanding_principal);
            assert.strictEqual(beforeAccount.due_date, afterAccount.due_date);
            assert.strictEqual(beforeAccount.interest_rate, afterAccount.interest_rate);
        });

        // ─── 12O.22: Backup Round-Trip with Auth Enabled ───────────
        await runTest('12O.22 Backup round-trip with auth enabled', async () => {
            const exportRes = await httpTester.request('GET', '/backup/export', null, adminToken);
            assert.strictEqual(exportRes.statusCode, 200);
            assert(exportRes.body.checksum);

            const restoreRes = await httpTester.request('POST', '/backup/restore', {
                backup: exportRes.body,
                confirm: true
            }, adminToken);
            assert.strictEqual(restoreRes.statusCode, 200);
            assert.strictEqual(restoreRes.body.success, true);
        });

        // ─── 12O.23: Restore Security ──────────────────────────────
        await runTest('12O.23 Restore security (users, roles, credentials intact after restore)', async () => {
            const users = listUsers(liveDb);
            const usernames = users.map(u => u.username);
            assert(usernames.includes('admin'));
            assert(usernames.includes('staff'));
            assert(usernames.includes('viewer'));

            // Verify admin can still log in
            const loginRes = login(liveDb, 'admin', 'AdminPassword@123');
            assert(loginRes.token);
            assert.strictEqual(loginRes.user.role, 'ADMIN');
        });

        // ─── 12O.24: XSS Test ──────────────────────────────────────
        await runTest('12O.24 XSS defense (script tags stored & returned as safe string)', async () => {
            const xssPayload = "<script>alert('xss')</script>";
            const createRes = await httpTester.request('POST', '/people', {
                name: `Malicious ${xssPayload}`,
                notes: `Notes with ${xssPayload}`
            }, adminToken);

            assert.strictEqual(createRes.statusCode, 201);
            const personId = createRes.body.data.id;

            const fetchRes = await httpTester.request('GET', `/people/${personId}`, null, adminToken);
            assert.strictEqual(fetchRes.statusCode, 200);
            assert.strictEqual(fetchRes.body.data.name, `Malicious ${xssPayload}`);
        });

        // ─── 12O.25: SQL Injection Test ────────────────────────────
        await runTest('12O.25 SQL injection defense (safe parameterized execution)', async () => {
            const sqlPayload = "' OR 1=1 --";
            const searchRes = await httpTester.request('GET', `/people?search=${encodeURIComponent(sqlPayload)}`, null, adminToken);
            assert.strictEqual(searchRes.statusCode, 200);
            assert(Array.isArray(searchRes.body.data));
        });

        // ─── 12O.26: Sensitive URL Test ────────────────────────────
        await runTest('12O.26 Sensitive URL test (no credentials accepted via query params)', async () => {
            const res = await httpTester.request('GET', '/auth/me?token=some_token', null, null);
            assert.strictEqual(res.statusCode, 401, 'Token must come from Authorization header, not query params');
        });

        // ─── 12O.27: Session Fixation Defense ──────────────────────
        await runTest('12O.27 Session fixation defense (distinct tokens per login)', async () => {
            const login1 = await httpTester.request('POST', '/auth/login', { username: 'admin', password: 'AdminPassword@123' });
            const login2 = await httpTester.request('POST', '/auth/login', { username: 'admin', password: 'AdminPassword@123' });

            assert.strictEqual(login1.statusCode, 200);
            assert.strictEqual(login2.statusCode, 200);
            assert.notStrictEqual(login1.body.token, login2.body.token, 'Tokens must be unique per session');
        });

        // ─── 12O.28: Logout Test ───────────────────────────────────
        await runTest('12O.28 Logout test (token invalidated after logout)', async () => {
            const tempLogin = await httpTester.request('POST', '/auth/login', { username: 'viewer', password: 'ViewerPassword@123' });
            const tempToken = tempLogin.body.token;

            // Verify token works
            const beforeLogout = await httpTester.request('GET', '/auth/me', null, tempToken);
            assert.strictEqual(beforeLogout.statusCode, 200);

            // Log out
            const logoutRes = await httpTester.request('POST', '/auth/logout', null, tempToken);
            assert.strictEqual(logoutRes.statusCode, 200);

            // Subsequent request with same token fails with 401
            const afterLogout = await httpTester.request('GET', '/auth/me', null, tempToken);
            assert.strictEqual(afterLogout.statusCode, 401);
        });

    } finally {
        await httpTester.close();
    }

    console.log('\n================================================================');
    console.log(`   TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runAll().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
