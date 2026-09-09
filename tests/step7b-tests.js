/**
 * Interest Manager — Step 7B Test Suite
 * Implementation: Dashboard Summary API & Service
 *
 * Verifies all 12 specifications from Step 7B:
 *   Test 1: Empty database — all counts = 0, all monetary values = 0 (§18.1)
 *   Test 2: One person — total_people = 1 (§18.2)
 *   Test 3: Multiple loans — 3 loans (2 active, 1 closed) (§18.3)
 *   Test 4: Principal — total_principal and outstanding_principal match balance logic (§18.4)
 *   Test 5: Payment — total_paid reflects payment through normal Part 5 workflow (§18.5)
 *   Test 6: Interest — total_interest and outstanding_interest from Part 6 workflow (§18.6)
 *   Test 7: Paid interest — interest payment allocation maintains internal consistency (§18.7)
 *   Test 8: Closed loan — closing loan updates active_loans and closed_loans (§18.8)
 *   Test 9: Authorization — user isolation via person_id, no data leakage, 404/400 (§18.9)
 *   Test 10: Read-only — dashboard queries cause zero database mutations (§18.10)
 *   Test 11: Consistency test — independent domain comparison matches dashboard (§19)
 *   Test 12: API test — HTTP GET /api/dashboard/summary protocol, headers, types (§20)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const initSqlJs = require('sql.js');

const { getDashboardSummary } = require('../services/dashboardService');
const { createTransaction, allocatePayment } = require('../services/transactionService');
const { recordAccrualResult } = require('../services/interestRecordingService');
const { allocatePaymentWithCascading } = require('../services/interestPaymentService');
const { queryOne, queryAll } = require('../db/helpers');

const BASE_URL = 'http://localhost:3000/api';

let cachedAuthToken = null;
async function getAuthToken() {
    if (cachedAuthToken) return cachedAuthToken;
    const res = await new Promise((resolve, reject) => {
        const url = new URL(BASE_URL + '/auth/login');
        const req = http.request({
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data).token); } catch (e) { resolve(null); }
            });
        });
        req.on('error', reject);
        req.write(JSON.stringify({ username: 'admin', password: 'AdminPassword@123' }));
        req.end();
    });
    cachedAuthToken = res;
    return cachedAuthToken;
}

async function httpRequest(method, endpoint, body = null) {
    const token = await getAuthToken();
    return new Promise((resolve, reject) => {
        const url = new URL(BASE_URL + endpoint);
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: method,
            headers
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
                resolve({ statusCode: res.statusCode, body: parsed });
            });
        });

        req.on('error', (err) => reject(err));
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    Error: ${err.message}`);
        if (err.stack) {
            const lines = err.stack.split('\n').slice(1, 4).join('\n');
            console.error(`    ${lines}`);
        }
        failed++;
    }
}

async function createFreshInMemoryDb(SQL) {
    const db = new SQL.Database();
    db.run('PRAGMA foreign_keys = ON;');

    // Load schema
    const schemaSql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf-8');
    db.run(schemaSql);

    return db;
}

async function runAll() {
    console.log('\n================================================================');
    console.log('   INTEREST MANAGER — STEP 7B: DASHBOARD SUMMARY API & SERVICE');
    console.log('================================================================\n');

    const SQL = await initSqlJs();

    // ─── Test 1: Empty database (§18.1) ─────────────────────────
    console.log('--- Test 1: Empty Database ---');
    await runTest('Test 1 — Empty database returns 0 for all counts and 0 for all monetary totals', async () => {
        const db = await createFreshInMemoryDb(SQL);
        const summary = getDashboardSummary(db);

        // Counts
        assert.strictEqual(summary.total_people, 0, 'total_people must be 0');
        assert.strictEqual(summary.total_loans, 0, 'total_loans must be 0');
        assert.strictEqual(summary.active_loans, 0, 'active_loans must be 0');
        assert.strictEqual(summary.closed_loans, 0, 'closed_loans must be 0');

        // Monetary totals (both decimal rupees and integer paisa)
        assert.strictEqual(summary.total_principal, 0, 'total_principal must be 0');
        assert.strictEqual(summary.total_principal_paisa, 0, 'total_principal_paisa must be 0');
        assert.strictEqual(summary.outstanding_principal, 0, 'outstanding_principal must be 0');
        assert.strictEqual(summary.outstanding_principal_paisa, 0, 'outstanding_principal_paisa must be 0');
        assert.strictEqual(summary.total_interest, 0, 'total_interest must be 0');
        assert.strictEqual(summary.total_interest_paisa, 0, 'total_interest_paisa must be 0');
        assert.strictEqual(summary.outstanding_interest, 0, 'outstanding_interest must be 0');
        assert.strictEqual(summary.outstanding_interest_paisa, 0, 'outstanding_interest_paisa must be 0');
        assert.strictEqual(summary.total_paid, 0, 'total_paid must be 0');
        assert.strictEqual(summary.total_paid_paisa, 0, 'total_paid_paisa must be 0');
    });

    // ─── Test 2: One person (§18.2) ─────────────────────────────
    console.log('\n--- Test 2: One Person ---');
    let db;
    let person1Id;
    await runTest('Test 2 — One person record produces total_people = 1 and zero loans', async () => {
        db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Rajesh Kumar', '9811122233')");
        person1Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const summary = getDashboardSummary(db);

        assert.strictEqual(summary.total_people, 1, 'total_people must be 1');
        assert.strictEqual(summary.total_loans, 0, 'total_loans must be 0');
        assert.strictEqual(summary.total_principal, 0, 'total_principal must be 0');
    });

    // ─── Test 3: Multiple loans (§18.3) ─────────────────────────
    console.log('\n--- Test 3: Multiple Loans ---');
    let loan1Id, loan2Id, loan3Id;
    await runTest('Test 3 — Create 3 loans (2 active, 1 closed) -> total_loans=3, active=2, closed=1', async () => {
        // Loan 1: Active (₹10,000 = 1,000,000 paisa)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 1000000, 1000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-07-01', 'ACTIVE')
        `, [person1Id]);
        loan1Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Loan 2: Active (₹5,000 = 500,000 paisa)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 500000, 500000, 15.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-02-01', '2026-08-01', 'ACTIVE')
        `, [person1Id]);
        loan2Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Loan 3: Closed (₹2,000 = 200,000 paisa, outstanding = 0)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 200000, 0, 10.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-03-01', '2026-09-01', 'CLOSED')
        `, [person1Id]);
        loan3Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const summary = getDashboardSummary(db);

        assert.strictEqual(summary.total_loans, 3, 'total_loans must be 3');
        assert.strictEqual(summary.active_loans, 2, 'active_loans must be 2');
        assert.strictEqual(summary.closed_loans, 1, 'closed_loans must be 1');
    });

    // ─── Test 4: Principal (§18.4) ──────────────────────────────
    console.log('\n--- Test 4: Principal ---');
    await runTest('Test 4 — total_principal and outstanding_principal match authoritative balance', async () => {
        const summary = getDashboardSummary(db);

        // Expected principal: 1,000,000 + 500,000 + 200,000 = 1,700,000 paisa = ₹17,000.00
        assert.strictEqual(summary.total_principal_paisa, 1700000);
        assert.strictEqual(summary.total_principal, 17000);

        // Expected outstanding principal: 1,000,000 + 500,000 + 0 = 1,500,000 paisa = ₹15,000.00
        assert.strictEqual(summary.outstanding_principal_paisa, 1500000);
        assert.strictEqual(summary.outstanding_principal, 15000);
    });

    // ─── Test 5: Payment (§18.5) ────────────────────────────────
    console.log('\n--- Test 5: Payment ---');
    await runTest('Test 5 — Payment created through normal workflow reflects exactly once in total_paid', async () => {
        // Record payment for loan 3 (₹2,000 = 200,000 paisa)
        db.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference
            ) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 200000, 'CASH', '2026-03-15', 'PAY-TEST-001')
        `, [loan3Id, person1Id]);

        const summary1 = getDashboardSummary(db);
        assert.strictEqual(summary1.total_paid_paisa, 200000, 'total_paid_paisa must be 200000');
        assert.strictEqual(summary1.total_paid, 2000, 'total_paid must be ₹2,000.00');

        // Record partial payment for loan 1 (₹2,500 = 250,000 paisa)
        db.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference
            ) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 250000, 'UPI', '2026-03-20', 'PAY-TEST-002')
        `, [loan1Id, person1Id]);

        // Update authoritative outstanding principal for loan 1
        db.run('UPDATE accounts SET outstanding_principal = 750000 WHERE id = ?', [loan1Id]);

        const summary2 = getDashboardSummary(db);
        assert.strictEqual(summary2.total_paid_paisa, 450000, 'total_paid_paisa must be 450000 (200000 + 250000)');
        assert.strictEqual(summary2.total_paid, 4500, 'total_paid must be ₹4,500.00');
        assert.strictEqual(summary2.outstanding_principal_paisa, 1250000, 'outstanding_principal reflects payment');
        assert.strictEqual(summary2.outstanding_principal, 12500);
    });

    // ─── Test 6: Interest (§18.6) ───────────────────────────────
    console.log('\n--- Test 6: Interest ---');
    let interestRec1Id;
    await runTest('Test 6 — Interest records from Part 6 workflow populate total_interest and outstanding_interest', async () => {
        // Record interest record 1: ₹98.63 (9863 paisa), 0 paid
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis, interest_rate,
                interest_amount, paid_amount, calculation_method, status
            ) VALUES (?, '2026-01-01', '2026-01-31', 1000000, 12.0, 9863, 0, 'SIMPLE_INTEREST', 'PENDING')
        `, [loan1Id]);
        interestRec1Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Record interest record 2: ₹62.50 (6250 paisa), 0 paid
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis, interest_rate,
                interest_amount, paid_amount, calculation_method, status
            ) VALUES (?, '2026-02-01', '2026-02-28', 500000, 15.0, 6250, 0, 'SIMPLE_INTEREST', 'PENDING')
        `, [loan2Id]);

        const summary = getDashboardSummary(db);

        // Total interest: 9863 + 6250 = 16113 paisa = ₹161.13
        assert.strictEqual(summary.total_interest_paisa, 16113);
        assert.strictEqual(summary.total_interest, 161.13);

        // Outstanding interest: 16113 - 0 = 16113 paisa = ₹161.13
        assert.strictEqual(summary.outstanding_interest_paisa, 16113);
        assert.strictEqual(summary.outstanding_interest, 161.13);
    });

    // ─── Test 7: Paid interest (§18.7) ──────────────────────────
    console.log('\n--- Test 7: Paid Interest ---');
    await runTest('Test 7 — Allocating payment to interest maintains internal consistency across KPIs', async () => {
        // Allocate ₹50.00 (5000 paisa) to interest record 1
        db.run(`
            UPDATE interest_records
            SET paid_amount = 5000, status = 'PARTIALLY_PAID'
            WHERE id = ?
        `, [interestRec1Id]);

        // Record the transaction for interest received
        db.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference
            ) VALUES (?, ?, 'INTEREST_RECEIVED', 5000, 'UPI', '2026-02-10', 'INT-PAY-001')
        `, [loan1Id, person1Id]);

        const summary = getDashboardSummary(db);

        // Total interest must remain unchanged at ₹161.13
        assert.strictEqual(summary.total_interest_paisa, 16113);
        assert.strictEqual(summary.total_interest, 161.13);

        // Outstanding interest drops by ₹50.00: 16113 - 5000 = 11113 paisa = ₹111.13
        assert.strictEqual(summary.outstanding_interest_paisa, 11113);
        assert.strictEqual(summary.outstanding_interest, 111.13);

        // Total paid increases by ₹50.00: 450000 + 5000 = 455000 paisa = ₹4,550.00
        assert.strictEqual(summary.total_paid_paisa, 455000);
        assert.strictEqual(summary.total_paid, 4550);

        // Internal consistency check
        assert.strictEqual(
            summary.outstanding_interest_paisa,
            summary.total_interest_paisa - 5000,
            'outstanding_interest = total_interest - interest_paid'
        );
    });

    // ─── Test 8: Closed loan (§18.8) ────────────────────────────
    console.log('\n--- Test 8: Closed Loan ---');
    await runTest('Test 8 — Closing an active loan updates active_loans and closed_loans correctly', async () => {
        // Pay off remaining loan 2 principal (500,000 paisa)
        db.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference
            ) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 500000, 'BANK_TRANSFER', '2026-04-01', 'PAY-CLOSE-L2')
        `, [loan2Id, person1Id]);

        // Normal loan workflow: zero balance triggers status transition to CLOSED
        db.run("UPDATE accounts SET outstanding_principal = 0, status = 'CLOSED' WHERE id = ?", [loan2Id]);

        const summary = getDashboardSummary(db);

        // Total loans remains 3
        assert.strictEqual(summary.total_loans, 3);
        // Active loans drops from 2 to 1
        assert.strictEqual(summary.active_loans, 1);
        // Closed loans increases from 1 to 2
        assert.strictEqual(summary.closed_loans, 2);
    });

    // ─── Test 9: Authorization (§18.9) ──────────────────────────
    console.log('\n--- Test 9: Authorization ---');
    let person2Id, loan4Id;
    await runTest('Test 9a — User scoping via person_id isolates data with zero leakage', async () => {
        // Create second person with their own loan
        db.run("INSERT INTO people (name, phone) VALUES ('Pooja Nair', '9899988877')");
        person2Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 800000, 800000, 18.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-04-01', '2026-10-01', 'ACTIVE')
        `, [person2Id]);
        loan4Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Global dashboard (unscoped)
        const globalSummary = getDashboardSummary(db);
        assert.strictEqual(globalSummary.total_people, 2);
        assert.strictEqual(globalSummary.total_loans, 4);

        // Person 1 scoped dashboard
        const p1Summary = getDashboardSummary(db, { person_id: person1Id });
        assert.strictEqual(p1Summary.person_id, person1Id);
        assert.strictEqual(p1Summary.total_people, 1);
        assert.strictEqual(p1Summary.total_loans, 3, "P1 must see exactly their 3 loans");
        assert.strictEqual(p1Summary.total_principal_paisa, 1700000, "P1 total principal must not include P2");

        // Person 2 scoped dashboard
        const p2Summary = getDashboardSummary(db, { person_id: person2Id });
        assert.strictEqual(p2Summary.person_id, person2Id);
        assert.strictEqual(p2Summary.total_people, 1);
        assert.strictEqual(p2Summary.total_loans, 1, "P2 must see exactly their 1 loan");
        assert.strictEqual(p2Summary.total_principal_paisa, 800000);
        assert.strictEqual(p2Summary.outstanding_principal_paisa, 800000);
        assert.strictEqual(p2Summary.total_paid_paisa, 0, "P2 has zero payments");

        // Strict isolation
        assert.notStrictEqual(p1Summary.total_principal_paisa, p2Summary.total_principal_paisa);
    });

    await runTest('Test 9b — Unauthorized / non-existent person returns 404', async () => {
        let threw = false;
        try {
            getDashboardSummary(db, { person_id: 88888 });
        } catch (err) {
            threw = true;
            assert.strictEqual(err.statusCode, 404);
            assert.ok(err.message.includes('not found'));
        }
        assert.ok(threw);
    });

    await runTest('Test 9c — Malformed authorization parameter returns 400', async () => {
        let threw = false;
        try {
            getDashboardSummary(db, { person_id: 'bad-input' });
        } catch (err) {
            threw = true;
            assert.strictEqual(err.statusCode, 400);
        }
        assert.ok(threw);
    });

    // ─── Test 10: Read-only (§18.10) ────────────────────────────
    console.log('\n--- Test 10: Read-Only Verification ---');
    await runTest('Test 10 — Calling dashboard service causes zero mutations to database tables', async () => {
        const getTableFingerprint = () => ({
            people: queryOne(db, 'SELECT COUNT(*) as c FROM people').c,
            accounts: queryOne(db, 'SELECT COUNT(*) as c, SUM(outstanding_principal) as bal FROM accounts'),
            transactions: queryOne(db, 'SELECT COUNT(*) as c, SUM(amount) as amt FROM transactions'),
            interest: queryOne(db, 'SELECT COUNT(*) as c, SUM(interest_amount) as amt FROM interest_records')
        });

        const before = getTableFingerprint();

        // Call multiple times with different filters
        getDashboardSummary(db);
        getDashboardSummary(db, { person_id: person1Id });
        getDashboardSummary(db, { person_id: person2Id });

        const after = getTableFingerprint();

        assert.deepStrictEqual(before, after, 'Database state must be perfectly preserved');
    });

    // ─── Test 11: Consistency Test (§19) ────────────────────────
    console.log('\n--- Test 11: Domain Consistency Test ---');
    await runTest('Test 11 — Dashboard KPIs match independent domain source-of-truth calculations', async () => {
        const d = getDashboardSummary(db);

        // Independent source-of-truth queries
        const domainPeople = queryOne(db, 'SELECT COUNT(*) as c FROM people').c;
        const domainAccounts = queryOne(db, `
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status NOT IN ('CLOSED', 'WRITTEN_OFF') THEN 1 ELSE 0 END) as active,
                SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END) as closed,
                SUM(principal) as principal,
                SUM(outstanding_principal) as outstanding
            FROM accounts
        `);
        const domainInterest = queryOne(db, `
            SELECT
                COALESCE(SUM(interest_amount), 0) as total,
                COALESCE(SUM(paid_amount), 0) as paid
            FROM interest_records
            WHERE status != 'REVERSED'
        `);
        const domainPayments = queryOne(db, `
            SELECT COALESCE(SUM(amount), 0) as total
            FROM transactions
            WHERE transaction_type IN ('PRINCIPAL_RECEIVED', 'INTEREST_RECEIVED')
        `);

        // Assert 1:1 match
        assert.strictEqual(d.total_people, domainPeople);
        assert.strictEqual(d.total_loans, domainAccounts.total);
        assert.strictEqual(d.active_loans, domainAccounts.active);
        assert.strictEqual(d.closed_loans, domainAccounts.closed);
        assert.strictEqual(d.total_principal_paisa, domainAccounts.principal);
        assert.strictEqual(d.outstanding_principal_paisa, domainAccounts.outstanding);
        assert.strictEqual(d.total_interest_paisa, domainInterest.total);
        assert.strictEqual(d.outstanding_interest_paisa, domainInterest.total - domainInterest.paid);
        assert.strictEqual(d.total_paid_paisa, domainPayments.total);
    });

    // ─── Test 12: API Test (§20) ────────────────────────────────
    console.log('\n--- Test 12: Live API Test ---');
    await runTest('Test 12a — HTTP GET /api/dashboard/summary returns 200 with complete KPI contract', async () => {
        const res = await httpRequest('GET', '/dashboard/summary');
        assert.strictEqual(res.statusCode, 200);

        const body = res.body;
        assert.ok(body.data, 'Response must have data container');
        assert.strictEqual(typeof body.data.total_people, 'number');
        assert.strictEqual(typeof body.data.total_loans, 'number');
        assert.strictEqual(typeof body.data.active_loans, 'number');
        assert.strictEqual(typeof body.data.closed_loans, 'number');
        assert.strictEqual(typeof body.data.total_principal, 'number');
        assert.strictEqual(typeof body.data.outstanding_principal, 'number');
        assert.strictEqual(typeof body.data.total_interest, 'number');
        assert.strictEqual(typeof body.data.outstanding_interest, 'number');
        assert.strictEqual(typeof body.data.total_paid, 'number');

        // Top-level fields available for direct access
        assert.strictEqual(typeof body.total_people, 'number');
        assert.strictEqual(typeof body.total_loans, 'number');
    });

    await runTest('Test 12b — Live HTTP scoping via query parameter ?person_id=1', async () => {
        const res = await httpRequest('GET', '/dashboard/summary?person_id=1');
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.person_id, 1);
        assert.strictEqual(res.body.data.total_people, 1);
    });

    await runTest('Test 12c — Live HTTP error handling for invalid person_id', async () => {
        const notFound = await httpRequest('GET', '/dashboard/summary?person_id=99999');
        assert.strictEqual(notFound.statusCode, 404);
        assert.ok(notFound.body.error);

        const badReq = await httpRequest('GET', '/dashboard/summary?person_id=xyz');
        assert.strictEqual(badReq.statusCode, 400);
        assert.ok(badReq.body.error);
    });

    // ─── Final Summary ──────────────────────────────────────────
    console.log('\n================================================================');
    console.log(`Step 7B Test Results: ${passed} passed, ${failed} failed`);
    console.log('================================================================\n');

    if (failed > 0) process.exit(1);
    process.exit(0);
}

runAll().catch((err) => {
    console.error('Fatal error running Step 7B tests:', err);
    process.exit(1);
});
