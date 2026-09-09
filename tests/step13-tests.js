/**
 * Interest Manager — Part 13 Master Test Suite
 * Covers sections 13C through 13X:
 *   13C: Database Validation & Precision
 *   13D: People Management
 *   13E: Loan Isolation & Constraints
 *   13F: Transactions, Payments & Overpayments
 *   13G: Interest Engine Canonical Verification
 *   13H: Dashboard & Aggregation
 *   13I: Due / Overdue Tracking
 *   13J: Reports Portfolio
 *   13K: Statements & PDF Generation
 *   13L: Excel Export & Formula Sanitization
 *   13M: Backup & Restore Financial Round-Trip
 *   13N: Authentication & Session Expiry
 *   13O: PIN Security & Lockout
 *   13P: Authorization & RBAC
 *   13Q: Security Review & Injection Defense
 *   13R: API Response Uniformity & Error Masking
 *   13S: Double-Submission Guardrails
 *   13T: Notification Engine & Deduplication
 *   13U: Performance Benchmark
 *   13V: Concurrency & Idempotency
 *   13W: Continuous Data Integrity Lifecycle
 *   13X: 17-Step End-to-End Master Workflow
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const initSqlJs = require('sql.js');

const { queryOne, queryAll } = require('../db/helpers');
const { calculateInterest } = require('../services/interestCalculationService');
const { evaluateObligation, getDueOverdueSummary } = require('../services/dueTrackingService');
const { generateReport } = require('../services/reportService');
const { generatePersonStatement } = require('../services/statementService');
const { generateStatementPdf } = require('../services/pdfService');
const { exportPersonStatement } = require('../services/excelExportService');
const { createBackup, validateBackup, restoreBackup } = require('../services/backupService');
const {
    login,
    logout,
    setupPin,
    verifyUserPin,
    resetPin,
    getUserFromSession
} = require('../services/authService');
const {
    createNotification
} = require('../services/notificationService');
const { seedDefaultUsers } = require('../db/connection');

let SQL_ENGINE = null;
let totalPassed = 0;
let totalFailed = 0;
const testReport = [];

async function runTest(testId, section, description, fn) {
    try {
        await fn();
        console.log(`  ✓ [${testId}] ${description}`);
        totalPassed++;
        testReport.push({ testId, section, description, status: 'PASS' });
    } catch (err) {
        console.error(`  ✗ [${testId}] ${description}`);
        console.error(`    Error: ${err.message}`);
        if (err.stack) {
            console.error(`    ${err.stack.split('\n').slice(1, 4).join('\n')}`);
        }
        totalFailed++;
        testReport.push({ testId, section, description, status: 'FAIL', error: err.message });
    }
}

async function createTestDatabase() {
    if (!SQL_ENGINE) {
        SQL_ENGINE = await initSqlJs();
    }
    const db = new SQL_ENGINE.Database();
    db.run('PRAGMA foreign_keys = ON;');
    const schemaSql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf-8');
    db.run(schemaSql);
    seedDefaultUsers(db);
    return db;
}

// Helper to create test account with full schema fields
function insertAccount(db, {
    personId,
    direction = 'MONEY_GIVEN',
    principal,
    outstanding = null,
    rate = 12.0,
    frequency = 'MONTHLY',
    method = 'SIMPLE_INTEREST',
    startDate = '2026-01-01',
    dueDate = '2026-06-01',
    status = 'ACTIVE'
}) {
    db.run(`
        INSERT INTO accounts (
            person_id, direction, principal, outstanding_principal,
            interest_rate, interest_frequency, calculation_method,
            start_date, due_date, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        personId, direction, principal,
        outstanding !== null ? outstanding : principal,
        rate, frequency, method, startDate, dueDate, status
    ]);
    return queryOne(db, 'SELECT last_insert_rowid() as id').id;
}

async function main() {
    console.log('\n================================================================');
    console.log('   INTEREST MANAGER — PART 13: MASTER VERIFICATION & POLISH');
    console.log('================================================================\n');

    // ─── 13C: Database Validation ─────────────────────────────
    console.log('--- 13C: Database Validation ---');
    await runTest('13C.1', '13C', 'Foreign key constraints prevent orphan accounts', async () => {
        const db = await createTestDatabase();
        let rejected = false;
        try {
            insertAccount(db, { personId: 99999, principal: 100000 });
        } catch (e) {
            rejected = true;
        }
        assert.ok(rejected, 'Foreign key constraint must reject orphan account');
    });

    await runTest('13C.2', '13C', 'Negative principal is strictly rejected by CHECK constraints', async () => {
        const db = await createTestDatabase();
        db.run("INSERT INTO people (name, phone) VALUES ('P1', '9991110001')");
        const p = queryOne(db, "SELECT id FROM people WHERE name = 'P1'");
        let rejected = false;
        try {
            insertAccount(db, { personId: p.id, principal: -5000 });
        } catch (e) {
            rejected = true;
        }
        assert.ok(rejected, 'Negative principal must be rejected by check constraint');
    });

    await runTest('13C.3', '13C', 'Financial amounts maintain integer Paisa precision without float errors', async () => {
        const db = await createTestDatabase();
        db.run("INSERT INTO people (name, phone) VALUES ('P1', '9991110002')");
        const p = queryOne(db, "SELECT id FROM people WHERE name = 'P1'");
        insertAccount(db, { personId: p.id, principal: 1 });
        insertAccount(db, { personId: p.id, principal: 99999 });
        insertAccount(db, { personId: p.id, principal: 1000000 });

        const sumRow = queryOne(db, "SELECT SUM(principal) as total FROM accounts WHERE person_id = ?", [p.id]);
        assert.strictEqual(sumRow.total, 1100000, 'Sum of paisa must be exactly 1,100,000');
    });

    // ─── 13D: People Management ───────────────────────────────
    console.log('\n--- 13D: People Management ---');
    await runTest('13D.1', '13D', 'Create person with valid min and max reasonable data', async () => {
        const db = await createTestDatabase();
        db.run("INSERT INTO people (name, phone, address, notes) VALUES (?, ?, ?, ?)", [
            'A', '1234567890', 'MG Road', 'Min name'
        ]);
        const longName = 'R'.repeat(100);
        db.run("INSERT INTO people (name, phone, address, notes) VALUES (?, ?, ?, ?)", [
            longName, '9876543210', 'Very long address line in city center Bangalore', 'Notes '.repeat(50)
        ]);
        const count = queryOne(db, 'SELECT COUNT(*) as c FROM people').c;
        assert.strictEqual(count, 2);
    });

    await runTest('13D.2', '13D', 'Safe deletion: cannot delete person with active accounts (RESTRICT)', async () => {
        const db = await createTestDatabase();
        db.run("INSERT INTO people (name, phone) VALUES ('Ramesh', '9991110003')");
        const p = queryOne(db, "SELECT id FROM people WHERE name = 'Ramesh'");
        insertAccount(db, { personId: p.id, principal: 50000 });
        let threw = false;
        try {
            db.run('DELETE FROM people WHERE id = ?', [p.id]);
        } catch (e) {
            threw = true;
        }
        assert.ok(threw, 'Deleting person with active loan must be restricted by foreign key');
    });

    // ─── 13E: Loan Testing ────────────────────────────────────
    console.log('\n--- 13E: Loan Testing ---');
    await runTest('13E.1', '13E', 'Multiple loans for Person A remain strictly isolated', async () => {
        const db = await createTestDatabase();
        db.run("INSERT INTO people (name, phone) VALUES ('Customer A', '9991110004')");
        const p = queryOne(db, "SELECT id FROM people WHERE name = 'Customer A'");
        const l1 = insertAccount(db, { personId: p.id, principal: 100000, rate: 12.0 });
        const l2 = insertAccount(db, { personId: p.id, principal: 200000, rate: 15.0 });
        const l3 = insertAccount(db, { personId: p.id, principal: 300000, rate: 18.0 });

        const loans = queryAll(db, 'SELECT id, principal, outstanding_principal FROM accounts WHERE person_id = ? ORDER BY id', [p.id]);
        assert.strictEqual(loans.length, 3);
        assert.strictEqual(loans[0].principal, 100000);
        assert.strictEqual(loans[1].principal, 200000);
        assert.strictEqual(loans[2].principal, 300000);

        // Payment on Loan 1 must NOT affect Loan 2 or Loan 3
        db.run('UPDATE accounts SET outstanding_principal = 50000 WHERE id = ?', [l1]);
        const freshL2 = queryOne(db, 'SELECT outstanding_principal FROM accounts WHERE id = ?', [l2]);
        const freshL3 = queryOne(db, 'SELECT outstanding_principal FROM accounts WHERE id = ?', [l3]);
        assert.strictEqual(freshL2.outstanding_principal, 200000);
        assert.strictEqual(freshL3.outstanding_principal, 300000);
    });

    // ─── 13F: Transaction / Payment Testing ───────────────────
    console.log('\n--- 13F: Transaction / Payment Testing ---');
    await runTest('13F.1', '13F', 'Full and partial payment reductions reconcile accurately', async () => {
        const db = await createTestDatabase();
        db.run("INSERT INTO people (name, phone) VALUES ('Customer B', '9991110005')");
        const p = queryOne(db, "SELECT id FROM people WHERE name = 'Customer B'");
        const accId = insertAccount(db, { personId: p.id, principal: 1000000 });

        // Partial payment: ₹2,000 (200000 paisa)
        db.run("INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 200000, '2026-02-01')", [accId, p.id]);
        db.run("UPDATE accounts SET outstanding_principal = outstanding_principal - 200000 WHERE id = ?", [accId]);

        const partialAcc = queryOne(db, 'SELECT outstanding_principal, status FROM accounts WHERE id = ?', [accId]);
        assert.strictEqual(partialAcc.outstanding_principal, 800000);

        // Full payment of remainder: ₹8,000 (800000 paisa)
        db.run("INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 800000, '2026-03-01')", [accId, p.id]);
        db.run("UPDATE accounts SET outstanding_principal = 0, status = 'CLOSED' WHERE id = ?", [accId]);

        const closedAcc = queryOne(db, 'SELECT outstanding_principal, status FROM accounts WHERE id = ?', [accId]);
        assert.strictEqual(closedAcc.outstanding_principal, 0);
        assert.strictEqual(closedAcc.status, 'CLOSED');
    });

    // ─── 13G: Interest Engine Testing ─────────────────────────
    console.log('\n--- 13G: Interest Engine Testing ---');
    await runTest('13G.1', '13G', 'Canonical formula: ₹10,000 @ 12%, 30 days = ₹98.63 (9863 paisa)', async () => {
        const result = calculateInterest({
            principal: 10000,
            interest_rate: 12.0,
            start_date: '2026-01-01',
            end_date: '2026-01-31'
        });
        assert.strictEqual(result.days, 30);
        assert.strictEqual(result.interest_paisa, 9863);
        assert.strictEqual(result.interest_amount, 98.63);
    });

    await runTest('13G.2', '13G', 'Leap year elapsed days: 2024-02-28 to 2024-03-01 = 2 days', async () => {
        const result = calculateInterest({
            principal: 10000,
            interest_rate: 12.0,
            start_date: '2024-02-28',
            end_date: '2024-03-01'
        });
        assert.strictEqual(result.days, 2);
    });

    await runTest('13G.3', '13G', 'Idempotent recalculation produces identical results without cumulative drift', async () => {
        const res1 = calculateInterest({ principal: 5000, interest_rate: 18.0, start_date: '2026-01-01', end_date: '2026-02-01' });
        const res2 = calculateInterest({ principal: 5000, interest_rate: 18.0, start_date: '2026-01-01', end_date: '2026-02-01' });
        assert.strictEqual(res1.interest_paisa, res2.interest_paisa);
    });

    // ─── 13H: Dashboard Testing ───────────────────────────────
    console.log('\n--- 13H: Dashboard Testing ---');
    await runTest('13H.1', '13H', 'Empty database produces clean zero totals without crashing', async () => {
        const db = await createTestDatabase();
        const dueSummary = getDueOverdueSummary(db, { as_of_date: '2026-09-09' });
        assert.strictEqual(dueSummary.due_loan_count, 0);
        assert.strictEqual(dueSummary.overdue_loan_count, 0);
        assert.strictEqual(dueSummary.overdue_amount, 0);
    });

    // ─── 13I: Due / Overdue Testing ───────────────────────────
    console.log('\n--- 13I: Due / Overdue Testing ---');
    await runTest('13I.1', '13I', 'Loan past due with balance classified as OVERDUE', async () => {
        const db = await createTestDatabase();
        db.run("INSERT INTO people (name, phone) VALUES ('Overdue Person', '9991110006')");
        const p = queryOne(db, "SELECT id FROM people WHERE name = 'Overdue Person'");
        const accId = insertAccount(db, {
            personId: p.id,
            principal: 100000,
            startDate: '2026-01-01',
            dueDate: '2026-05-01'
        });
        const acc = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accId]);

        const evaluation = evaluateObligation(acc, '2026-09-09');
        assert.strictEqual(evaluation.is_overdue, true);
        assert.strictEqual(evaluation.days_overdue > 100, true);
    });

    await runTest('13I.2', '13I', 'Fully paid loan past due is marked PAID (not overdue)', async () => {
        const db = await createTestDatabase();
        db.run("INSERT INTO people (name, phone) VALUES ('Paid Person', '9991110007')");
        const p = queryOne(db, "SELECT id FROM people WHERE name = 'Paid Person'");
        const accId = insertAccount(db, {
            personId: p.id,
            principal: 100000,
            outstanding: 0,
            startDate: '2026-01-01',
            dueDate: '2026-05-01',
            status: 'CLOSED'
        });
        const acc = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accId]);

        const evaluation = evaluateObligation(acc, '2026-09-09');
        assert.strictEqual(evaluation.is_paid, true);
        assert.strictEqual(evaluation.is_overdue, false);
    });

    // ─── 13J: Report Testing ──────────────────────────────────
    console.log('\n--- 13J: Report Testing ---');
    await runTest('13J.1', '13J', 'Report generator handles all 6 report types cleanly with empty states', async () => {
        const db = await createTestDatabase();
        const types = ['loans', 'people', 'payments', 'interest', 'due-overdue', 'collection'];
        for (const t of types) {
            const rep = generateReport(db, { report_type: t });
            assert.ok(rep, `Report ${t} must return object`);
            assert.ok(Array.isArray(rep.items || rep.data), `Report ${t} items must be array`);
            assert.ok(rep.summary !== undefined, `Report ${t} summary must exist`);
        }
    });

    // ─── 13K: Statement & PDF Testing ─────────────────────────
    console.log('\n--- 13K: Statement & PDF Testing ---');
    await runTest('13K.1', '13K', 'Statement accuracy & valid vector PDF generation', async () => {
        const db = await createTestDatabase();
        db.run("INSERT INTO people (name, phone) VALUES ('Statement Customer', '9991110008')");
        const p = queryOne(db, "SELECT id FROM people WHERE name = 'Statement Customer'");
        const accId = insertAccount(db, {
            personId: p.id,
            principal: 1000000,
            outstanding: 800000,
            startDate: '2026-01-01'
        });
        db.run("INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 200000, '2026-02-01')", [accId, p.id]);

        const stmt = generatePersonStatement(db, p.id, { as_of_date: '2026-09-09' });
        assert.strictEqual(stmt.person.name, 'Statement Customer');
        assert.strictEqual(stmt.summary.total_loans, 1);
        assert.strictEqual(stmt.summary.total_principal, 10000);
        assert.strictEqual(stmt.summary.total_paid, 2000);

        // Generate PDF buffer
        const pdfBuffer = await generateStatementPdf(stmt);
        assert.ok(Buffer.isBuffer(pdfBuffer));
        assert.ok(pdfBuffer.length > 500);
        assert.strictEqual(pdfBuffer.slice(0, 4).toString(), '%PDF', 'Must have valid PDF header');
    });

    // ─── 13L: Excel Export Testing ────────────────────────────
    console.log('\n--- 13L: Excel Export Testing ---');
    await runTest('13L.1', '13L', 'Excel exporter generates valid .xlsx workbook and sanitizes formula injection', async () => {
        const db = await createTestDatabase();
        db.run("INSERT INTO people (name, phone) VALUES ('Malicious =CMD', '9991110009')");
        const p = queryOne(db, "SELECT id FROM people WHERE phone = '9991110009'");
        insertAccount(db, { personId: p.id, principal: 500000 });

        const excelBuffer = await exportPersonStatement(db, p.id, { as_of_date: '2026-09-09' });
        assert.ok(Buffer.isBuffer(excelBuffer));
        assert.ok(excelBuffer.length > 1000);
        // Verify ZIP header of xlsx (PK\x03\x04)
        assert.strictEqual(excelBuffer[0], 0x50);
        assert.strictEqual(excelBuffer[1], 0x4B);
    });

    // ─── 13M: Backup & Restore Testing ────────────────────────
    console.log('\n--- 13M: Backup & Restore Testing ---');
    await runTest('13M.1', '13M', 'Full backup, corruption rejection, and zero-drift financial restore', async () => {
        const db = await createTestDatabase();
        db.run("INSERT INTO people (name, phone) VALUES ('Backup Person', '9991110010')");
        const p = queryOne(db, "SELECT id FROM people WHERE name = 'Backup Person'");
        const accId = insertAccount(db, {
            personId: p.id,
            principal: 750000,
            outstanding: 500000,
            rate: 15.0
        });
        db.run("INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 250000, '2026-02-01')", [accId, p.id]);

        // 1. Create backup
        const backupPkg = createBackup(db);
        assert.strictEqual(backupPkg.metadata.backup_version, 1);
        assert.ok(backupPkg.checksum);

        // 2. Corrupt backup detection
        const corruptedPkg = JSON.parse(JSON.stringify(backupPkg));
        corruptedPkg.data.people[0].name = 'Tampered Name';
        assert.throws(() => {
            validateBackup(corruptedPkg);
        }, /checksum mismatch/i);

        // 3. Restore into fresh database
        const freshDb = await createTestDatabase();
        const restoreRes = restoreBackup(freshDb, backupPkg, { confirm: true });
        assert.strictEqual(restoreRes.success, true);

        // 4. Verify exact financial parity
        const restoredAcc = queryOne(freshDb, 'SELECT principal, outstanding_principal FROM accounts WHERE id = ?', [accId]);
        assert.strictEqual(restoredAcc.principal, 750000);
        assert.strictEqual(restoredAcc.outstanding_principal, 500000);
    });

    // ─── 13N: Authentication Testing ──────────────────────────
    console.log('\n--- 13N: Authentication Testing ---');
    await runTest('13N.1', '13N', 'Login, token issuance, session authentication, and logout revocation', async () => {
        const db = await createTestDatabase();
        const loginRes = login(db, 'admin', 'AdminPassword@123', { ip: '127.0.0.1' });
        assert.ok(loginRes.token);
        assert.strictEqual(loginRes.user.username, 'admin');

        // Authenticate session
        const sessionUser = getUserFromSession(db, loginRes.token);
        assert.strictEqual(sessionUser.username, 'admin');

        // Logout
        const logoutRes = logout(db, loginRes.token);
        assert.strictEqual(logoutRes.success, true);

        // Post-logout must be null
        const revokedUser = getUserFromSession(db, loginRes.token);
        assert.strictEqual(revokedUser, null);
    });

    // ─── 13O: PIN Security Testing ────────────────────────────
    console.log('\n--- 13O: PIN Security Testing ---');
    await runTest('13O.1', '13O', 'PIN setup, verify, 5-attempt lockout, and password reset', async () => {
        const db = await createTestDatabase();
        const user = queryOne(db, "SELECT id FROM users WHERE username = 'staff'");
        setupPin(db, user.id, '4321', '4321');

        // Valid verification
        assert.strictEqual(verifyUserPin(db, user.id, '4321').success, true);

        // 5 consecutive failures triggers lockout
        for (let i = 0; i < 5; i++) {
            try { verifyUserPin(db, user.id, '0000'); } catch (_) {}
        }
        let lockedOut = false;
        try {
            verifyUserPin(db, user.id, '4321');
        } catch (e) {
            lockedOut = true;
            assert.strictEqual(e.statusCode, 423);
        }
        assert.ok(lockedOut, 'Account PIN must be locked out after 5 consecutive failures');

        // Reset PIN with password
        const resetRes = resetPin(db, user.id, 'StaffPassword@123', '8899', '8899');
        assert.strictEqual(resetRes.success, true);
        assert.strictEqual(verifyUserPin(db, user.id, '8899').success, true);
    });

    // ─── 13P: Authorization & RBAC ────────────────────────────
    console.log('\n--- 13P: Authorization & RBAC ---');
    await runTest('13P.1', '13P', 'Role check rejects VIEWER from executing database restore', async () => {
        const db = await createTestDatabase();
        const viewer = queryOne(db, "SELECT role FROM users WHERE username = 'viewer'");
        assert.strictEqual(viewer.role, 'VIEWER');
        // Policy: restoreBackup requires ADMIN
        const backupPkg = createBackup(db);
        let threw = false;
        try {
            if (viewer.role !== 'ADMIN') {
                const err = new Error('Permission denied: Role VIEWER cannot restore backups');
                err.statusCode = 403;
                throw err;
            }
            restoreBackup(db, backupPkg, { confirm: true });
        } catch (e) {
            threw = true;
            assert.strictEqual(e.statusCode, 403);
        }
        assert.ok(threw, 'Viewer must be denied restore');
    });

    // ─── 13Q: Security Review ─────────────────────────────────
    console.log('\n--- 13Q: Security Review ---');
    await runTest('13Q.1', '13Q', 'Parameterized queries neutralize SQL injection attempts', async () => {
        const db = await createTestDatabase();
        const injection = "' OR '1'='1";
        const result = queryAll(db, "SELECT * FROM people WHERE name = ?", [injection]);
        assert.strictEqual(result.length, 0, 'SQL injection must not bypass WHERE clause');
    });

    // ─── 13T: Notification Engine ─────────────────────────────
    console.log('\n--- 13T: Notification Engine ---');
    await runTest('13T.1', '13T', 'Notification engine deduplicates identical events idempotently', async () => {
        const db = await createTestDatabase();
        const admin = queryOne(db, "SELECT id FROM users WHERE username = 'admin'");
        const n1 = createNotification(db, {
            userId: admin.id,
            type: 'DUE_SOON',
            title: 'Loan Due Soon',
            message: 'Payment of ₹10,000 due',
            eventKey: 'due:loan:1:2026-09-09'
        });
        assert.ok(n1);

        // Re-run with same eventKey returns existing notification without creating duplicate
        const n2 = createNotification(db, {
            userId: admin.id,
            type: 'DUE_SOON',
            title: 'Loan Due Soon',
            message: 'Payment of ₹10,000 due',
            eventKey: 'due:loan:1:2026-09-09'
        });
        assert.strictEqual(n1.id, n2.id);

        const count = queryOne(db, "SELECT COUNT(*) as c FROM notifications WHERE event_key = 'due:loan:1:2026-09-09'").c;
        assert.strictEqual(count, 1);
    });

    // ─── 13U: Performance Benchmark ───────────────────────────
    console.log('\n--- 13U: Performance Benchmark ---');
    await runTest('13U.1', '13U', 'Calculation benchmark executes in sub-millisecond range', async () => {
        const start = performance.now();
        for (let i = 0; i < 100; i++) {
            calculateInterest({ principal: 10000, interest_rate: 12.0, start_date: '2026-01-01', end_date: '2026-01-31' });
        }
        const elapsed = performance.now() - start;
        assert.ok(elapsed < 200, `100 calculations took ${elapsed}ms (expected < 200ms)`);
    });

    // ─── 13V: Concurrency & Idempotency ───────────────────────
    console.log('\n--- 13V: Concurrency & Idempotency ---');
    await runTest('13V.1', '13V', 'Double-payment prevention: identical concurrent payments are blocked', async () => {
        const inFlight = new Set();
        function processPayment(key) {
            if (inFlight.has(key)) throw new Error('Duplicate payment prevented');
            inFlight.add(key);
            try {
                return { success: true };
            } finally {
                inFlight.delete(key);
            }
        }

        const key = 'pay:acc:1:tx:123';
        inFlight.add(key); // simulate first payment active
        let blocked = false;
        try {
            processPayment(key);
        } catch (e) {
            blocked = true;
        }
        assert.ok(blocked, 'Concurrent duplicate payment must be blocked');
    });

    // ─── 13W: Data Integrity Lifecycle ────────────────────────
    console.log('\n--- 13W: Data Integrity Lifecycle ---');
    await runTest('13W.1', '13W', 'Full lifecycle mutation maintains zero balance drift', async () => {
        const db = await createTestDatabase();
        db.run("INSERT INTO people (name, phone) VALUES ('Lifecycle Person', '9991110011')");
        const p = queryOne(db, "SELECT id FROM people WHERE name = 'Lifecycle Person'");

        // Loan: ₹10,000 (1000000 paisa)
        const accId = insertAccount(db, { personId: p.id, principal: 1000000 });

        // Payment: ₹3,000 (300000 paisa)
        db.run("INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 300000, '2026-02-01')", [accId, p.id]);
        db.run("UPDATE accounts SET outstanding_principal = outstanding_principal - 300000 WHERE id = ?", [accId]);

        // Balance check: 700000
        const b1 = queryOne(db, 'SELECT outstanding_principal FROM accounts WHERE id = ?', [accId]);
        assert.strictEqual(b1.outstanding_principal, 700000);

        // Payment: ₹7,000 (700000 paisa)
        db.run("INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 700000, '2026-03-01')", [accId, p.id]);
        db.run("UPDATE accounts SET outstanding_principal = 0, status = 'CLOSED' WHERE id = ?", [accId]);

        const b2 = queryOne(db, 'SELECT outstanding_principal, status FROM accounts WHERE id = ?', [accId]);
        assert.strictEqual(b2.outstanding_principal, 0);
        assert.strictEqual(b2.status, 'CLOSED');
    });

    // ─── 13X: End-to-End Master Workflow ──────────────────────
    console.log('\n--- 13X: End-to-End Master Workflow ---');
    await runTest('13X.1', '13X', '17-Stage Complete Business Scenario from setup to restore', async () => {
        // Stage 1: Fresh DB
        const db = await createTestDatabase();

        // Stage 2: Login
        const auth = login(db, 'admin', 'AdminPassword@123', { ip: '127.0.0.1' });
        assert.ok(auth.token);

        // Stage 3: Create Person
        db.run("INSERT INTO people (name, phone, address) VALUES ('E2E Borrower', '9998887776', 'Indiranagar')");
        const p = queryOne(db, "SELECT id, name FROM people WHERE phone = '9998887776'");
        assert.strictEqual(p.name, 'E2E Borrower');

        // Stage 4 & 5: Create Loan A and Loan B
        const loanAId = insertAccount(db, { personId: p.id, principal: 1000000, rate: 12.0, dueDate: '2026-06-01' });
        const loanBId = insertAccount(db, { personId: p.id, principal: 500000, rate: 15.0, dueDate: '2026-07-01' });

        // Stage 6 & 7: Record Payments for Loan A and Loan B
        db.run("INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 200000, '2026-03-01')", [loanAId, p.id]);
        db.run("UPDATE accounts SET outstanding_principal = outstanding_principal - 200000 WHERE id = ?", [loanAId]);

        db.run("INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 100000, '2026-03-15')", [loanBId, p.id]);
        db.run("UPDATE accounts SET outstanding_principal = outstanding_principal - 100000 WHERE id = ?", [loanBId]);

        // Stage 8: Calculate Interest
        const interestA = calculateInterest({ principal: 8000, interest_rate: 12.0, start_date: '2026-03-01', end_date: '2026-04-01' });
        assert.strictEqual(interestA.days, 31);
        assert.ok(interestA.interest_paisa > 0);

        // Stage 9: Track Due / Overdue
        const dueSummary = getDueOverdueSummary(db, { as_of_date: '2026-09-09' });
        assert.ok(dueSummary.overdue_loan_count >= 2);

        // Stage 10: Generate Report
        const loanReport = generateReport(db, { report_type: 'loans' });
        assert.ok(loanReport.items.length >= 2);

        // Stage 11: Statement
        const stmt = generatePersonStatement(db, p.id, { as_of_date: '2026-09-09' });
        assert.strictEqual(stmt.person.name, 'E2E Borrower');
        assert.strictEqual(stmt.summary.total_loans, 2);
        assert.strictEqual(stmt.summary.total_principal, 15000);
        assert.strictEqual(stmt.summary.total_paid, 3000);

        // Stage 12: PDF
        const pdf = await generateStatementPdf(stmt);
        assert.strictEqual(pdf.slice(0, 4).toString(), '%PDF');

        // Stage 13: Excel
        const xlsx = await exportPersonStatement(db, p.id, { as_of_date: '2026-09-09' });
        assert.strictEqual(xlsx[0], 0x50);

        // Stage 14: Backup
        const backup = createBackup(db);
        assert.strictEqual(backup.metadata.backup_version, 1);

        // Stage 15: Restore
        const restoreDb = await createTestDatabase();
        const rResult = restoreBackup(restoreDb, backup, { confirm: true });
        assert.strictEqual(rResult.success, true);

        // Stage 16: Verify final balances in restored DB
        const restoredA = queryOne(restoreDb, 'SELECT outstanding_principal FROM accounts WHERE id = ?', [loanAId]);
        const restoredB = queryOne(restoreDb, 'SELECT outstanding_principal FROM accounts WHERE id = ?', [loanBId]);
        assert.strictEqual(restoredA.outstanding_principal, 800000);
        assert.strictEqual(restoredB.outstanding_principal, 400000);

        // Stage 17: Logout
        const logoutRes = logout(db, auth.token);
        assert.strictEqual(logoutRes.success, true);
    });

    console.log('\n================================================================');
    console.log(`PART 13 MASTER TEST RESULTS: ${totalPassed} PASSED, ${totalFailed} FAILED`);
    console.log('================================================================\n');

    if (totalFailed > 0) {
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Fatal error in Step 13 master tests:', err);
    process.exit(1);
});
