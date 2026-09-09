/**
 * Interest Manager — Step 7H Test Suite
 * Implementation: Dashboard Data Integration
 *
 * Verifies all specifications of Step 7H:
 *   Test 1: Empty dashboard — zero values, empty collections (§22.1)
 *   Test 2: One person — summary.total_people = 1, people.items consistent (§22.2)
 *   Test 3: One loan — summary.total_loans = 1, loans.items contains loan (§22.3)
 *   Test 4: Multiple loans — total_loans, active_loans, closed_loans match loan data (§22.4)
 *   Test 5: Multiple loans for one person — people.items, loans.items, summary consistency (§22.5)
 *   Test 6: Payments — summary.total_paid, financial.payments.total_paid, recent_activity (§22.6)
 *   Test 7: Interest — summary.total_interest, summary.outstanding_interest, financial.interest (§22.7)
 *   Test 8: Due/overdue — due_collection agreements with established 7F logic (§22.8)
 *   Test 9: Recent activity — integrated recent activity in correct newest-first order (§22.9)
 *   Test 10: Authorization — scoping isolates all 6 dashboard sections (§22.10)
 *   Test 11: Read-only — zero database mutations during aggregation (§22.11)
 *   Test 12: Service failure — failures propagate genuine errors, never faked zeros (§22.12)
 *   Test 13: Cross-section reconciliation test (§23)
 *   Test 14: Live API endpoints — GET /api/dashboard and GET /api/dashboard/all (§14)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const initSqlJs = require('sql.js');

const { getIntegratedDashboard } = require('../services/dashboardService');
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
    console.log('   INTEREST MANAGER — STEP 7H: DASHBOARD DATA INTEGRATION');
    console.log('================================================================\n');

    const SQL = await initSqlJs();
    const TEST_DATE = '2026-09-09';

    // ─── Test 1: Empty dashboard (§22.1) ─────────────────────────
    console.log('--- Test 1: Empty Dashboard ---');
    await runTest('Test 1 — Empty database returns valid structure with zero totals and empty arrays', async () => {
        const db = await createFreshInMemoryDb(SQL);
        const d = getIntegratedDashboard(db, { as_of_date: TEST_DATE });

        assert.strictEqual(d.summary.total_people, 0);
        assert.strictEqual(d.summary.total_loans, 0);
        assert.strictEqual(d.summary.active_loans, 0);
        assert.strictEqual(d.summary.closed_loans, 0);
        assert.strictEqual(d.summary.total_principal, 0);
        assert.strictEqual(d.summary.outstanding_principal, 0);
        assert.strictEqual(d.summary.total_interest, 0);
        assert.strictEqual(d.summary.outstanding_interest, 0);
        assert.strictEqual(d.summary.total_paid, 0);

        assert.strictEqual(Array.isArray(d.loans.items), true);
        assert.strictEqual(d.loans.items.length, 0);
        assert.strictEqual(d.loans.count, 0);

        assert.strictEqual(Array.isArray(d.people.items), true);
        assert.strictEqual(d.people.items.length, 0);
        assert.strictEqual(d.people.count, 0);

        assert.strictEqual(d.financial.interest.total_interest, 0);
        assert.strictEqual(d.financial.payments.total_paid, 0);

        assert.strictEqual(d.due_collection.due_loan_count, 0);
        assert.strictEqual(d.due_collection.overdue_loan_count, 0);
        assert.strictEqual(d.due_collection.due_amount, 0);
        assert.strictEqual(d.due_collection.overdue_amount, 0);
        assert.strictEqual(Array.isArray(d.due_collection.items), true);
        assert.strictEqual(d.due_collection.items.length, 0);

        assert.strictEqual(Array.isArray(d.recent_activity.items), true);
        assert.strictEqual(d.recent_activity.items.length, 0);
        assert.strictEqual(d.recent_activity.count, 0);
    });

    // ─── Test 2: One person (§22.2) ──────────────────────────────
    console.log('\n--- Test 2: One Person ---');
    await runTest('Test 2 — One person record reflected in summary and people.items', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (name, phone) VALUES ('Amit Sharma', '9876543210')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const d = getIntegratedDashboard(db, { as_of_date: TEST_DATE });

        assert.strictEqual(d.summary.total_people, 1);
        assert.strictEqual(d.people.items.length, 1);
        assert.strictEqual(d.people.items[0].person_id, personId);
        assert.strictEqual(d.people.items[0].person_name, 'Amit Sharma');
        assert.strictEqual(d.people.items[0].total_loans, 0);
    });

    // ─── Test 3: One loan (§22.3) ────────────────────────────────
    console.log('\n--- Test 3: One Loan ---');
    await runTest('Test 3 — One loan reflected in summary.total_loans and loans.items', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (name, phone) VALUES ('Priya Patel', '9876543211')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 1000000, 1000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')
        `, [personId]);
        const loanId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const d = getIntegratedDashboard(db, { as_of_date: TEST_DATE });

        assert.strictEqual(d.summary.total_loans, 1);
        assert.strictEqual(d.summary.active_loans, 1);
        assert.strictEqual(d.summary.closed_loans, 0);
        assert.strictEqual(d.summary.total_principal, 10000);
        assert.strictEqual(d.summary.outstanding_principal, 10000);

        assert.strictEqual(d.loans.items.length, 1);
        assert.strictEqual(d.loans.items[0].loan_id, loanId);
        assert.strictEqual(d.loans.items[0].person_name, 'Priya Patel');
    });

    // ─── Test 4: Multiple loans (§22.4) ──────────────────────────
    console.log('\n--- Test 4: Multiple Loans ---');
    await runTest('Test 4 — Multiple loans (2 active, 1 closed) match loan summary data', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (name, phone) VALUES ('Rajesh Kumar', '9876543212')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Active Loan 1
        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 100000, 100000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')`, [personId]);

        // Active Loan 2
        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 200000, 200000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')`, [personId]);

        // Closed Loan 3
        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 300000, 0, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-06-01', 'CLOSED')`, [personId]);

        const d = getIntegratedDashboard(db, { as_of_date: TEST_DATE });

        assert.strictEqual(d.summary.total_loans, 3);
        assert.strictEqual(d.summary.active_loans, 2);
        assert.strictEqual(d.summary.closed_loans, 1);
        assert.strictEqual(d.loans.items.length, 3);
        assert.strictEqual(d.summary.total_principal, 6000);
        assert.strictEqual(d.summary.outstanding_principal, 3000);
    });

    // ─── Test 5: Multiple loans for one person (§22.5) ───────────
    console.log('\n--- Test 5: Multiple Loans For One Person ---');
    await runTest('Test 5 — Person with 2 loans reflects loan_count=2 in people, 2 in loans, 2 in summary', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (name, phone) VALUES ('Sunita Rao', '9876543213')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 150000, 150000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')`, [personId]);
        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 250000, 250000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')`, [personId]);

        const d = getIntegratedDashboard(db, { as_of_date: TEST_DATE });

        assert.strictEqual(d.summary.total_people, 1);
        assert.strictEqual(d.summary.total_loans, 2);
        assert.strictEqual(d.people.items[0].total_loans, 2);
        assert.strictEqual(d.people.items[0].total_principal, 4000);
        assert.strictEqual(d.loans.items.length, 2);
    });

    // ─── Test 6: Payments consistency (§22.6) ────────────────────
    console.log('\n--- Test 6: Payments Consistency ---');
    await runTest('Test 6 — summary.total_paid == financial.payments.total_paid and recent_activity matches', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (name, phone) VALUES ('Manoj Tiwari', '9876543214')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 1000000, 800000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')`, [personId]);
        const loanId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Payment 1: ₹1,500 principal
        db.run(`INSERT INTO transactions (account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference)
                VALUES (?, ?, 'PRINCIPAL_RECEIVED', 150000, 'UPI', '2026-02-01', 'PAY-1')`, [loanId, personId]);

        // Payment 2: ₹500 interest
        db.run(`INSERT INTO transactions (account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference)
                VALUES (?, ?, 'INTEREST_RECEIVED', 50000, 'CASH', '2026-02-15', 'PAY-2')`, [loanId, personId]);

        const d = getIntegratedDashboard(db, { as_of_date: TEST_DATE });

        assert.strictEqual(d.summary.total_paid, 2000);
        assert.strictEqual(d.financial.payments.total_paid, 2000);
        assert.strictEqual(d.financial.payments.payment_count, 2);

        assert.strictEqual(d.recent_activity.items.length, 2);
        assert.strictEqual(d.recent_activity.items[0].date_time, '2026-02-15');
        assert.strictEqual(d.recent_activity.items[1].date_time, '2026-02-01');
    });

    // ─── Test 7: Interest consistency (§22.7) ────────────────────
    console.log('\n--- Test 7: Interest Consistency ---');
    await runTest('Test 7 — summary.total_interest and outstanding_interest match financial.interest and Part 6', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (name, phone) VALUES ('Vikramaditya', '9876543215')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 1000000, 1000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')`, [personId]);
        const loanId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Interest record: ₹800 interest, ₹200 paid -> ₹600 outstanding
        db.run(`INSERT INTO interest_records (account_id, period_start, period_end, principal_basis, interest_rate, interest_amount, paid_amount, calculation_method, status)
                VALUES (?, '2026-01-01', '2026-01-31', 1000000, 12.0, 80000, 20000, 'SIMPLE_INTEREST', 'PARTIALLY_PAID')`, [loanId]);

        const d = getIntegratedDashboard(db, { as_of_date: TEST_DATE });

        assert.strictEqual(d.summary.total_interest, 800);
        assert.strictEqual(d.summary.outstanding_interest, 600);
        assert.strictEqual(d.financial.interest.total_interest, 800);
        assert.strictEqual(d.financial.interest.paid_interest, 200);
        assert.strictEqual(d.financial.interest.outstanding_interest, 600);
    });

    // ─── Test 8: Due / overdue consistency (§22.8) ───────────────
    console.log('\n--- Test 8: Due / Overdue Consistency ---');
    await runTest('Test 8 — due_collection agrees with 7F logic and summary', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (name, phone) VALUES ('Anand Kumar', '9876543216')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Loan 1: Due today (2026-09-09)
        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 300000, 300000, 10.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-03-09', '2026-09-09', 'ACTIVE')`, [personId]);

        // Loan 2: Overdue (2026-08-01)
        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 500000, 500000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-08-01', 'ACTIVE')`, [personId]);

        const d = getIntegratedDashboard(db, { as_of_date: TEST_DATE });

        assert.strictEqual(d.due_collection.due_loan_count, 1);
        assert.strictEqual(d.due_collection.overdue_loan_count, 1);
        assert.strictEqual(d.due_collection.due_amount, 3000);
        assert.strictEqual(d.due_collection.overdue_amount, 5000);
        assert.strictEqual(d.due_collection.collection_amount, 8000);
        assert.strictEqual(d.due_collection.items.length, 2);
    });

    // ─── Test 9: Recent activity (§22.9) ─────────────────────────
    console.log('\n--- Test 9: Recent Activity In Integrated Dashboard ---');
    await runTest('Test 9 — recent_activity contained in integrated response in newest-first order', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (name, phone) VALUES ('Gautam Gambhir', '9876543217')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 500000, 500000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')`, [personId]);
        const loanId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (?, ?, 'PRINCIPAL_RECEIVED', 10000, '2026-04-01')`, [loanId, personId]);
        db.run(`INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (?, ?, 'PRINCIPAL_RECEIVED', 20000, '2026-04-15')`, [loanId, personId]);

        const d = getIntegratedDashboard(db, { as_of_date: TEST_DATE });

        assert.strictEqual(d.recent_activity.items.length, 2);
        assert.strictEqual(d.recent_activity.items[0].date_time, '2026-04-15');
        assert.strictEqual(d.recent_activity.items[1].date_time, '2026-04-01');
    });

    // ─── Test 10: Authorization scoping (§22.10) ─────────────────
    console.log('\n--- Test 10: Authorization Scoping ---');
    await runTest('Test 10 — Authorization scoping via person_id cleanly isolates all 6 sections', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (name, phone) VALUES ('User Alpha', '9111111111')");
        const p1 = queryOne(db, 'SELECT last_insert_rowid() as id').id;
        db.run("INSERT INTO people (name, phone) VALUES ('User Beta', '9222222222')");
        const p2 = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // P1 Loan: ₹1,000, overdue
        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 100000, 100000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-08-01', 'ACTIVE')`, [p1]);
        const l1 = queryOne(db, 'SELECT last_insert_rowid() as id').id;
        db.run(`INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (?, ?, 'PRINCIPAL_RECEIVED', 20000, '2026-02-01')`, [l1, p1]);

        // P2 Loan: ₹4,000, current
        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 400000, 400000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-01', 'ACTIVE')`, [p2]);
        const l2 = queryOne(db, 'SELECT last_insert_rowid() as id').id;
        db.run(`INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (?, ?, 'PRINCIPAL_RECEIVED', 50000, '2026-03-01')`, [l2, p2]);

        // Query scoped to User Alpha
        const dAlpha = getIntegratedDashboard(db, { person_id: p1, as_of_date: TEST_DATE });

        assert.strictEqual(dAlpha.summary.total_people, 1);
        assert.strictEqual(dAlpha.summary.total_loans, 1);
        assert.strictEqual(dAlpha.summary.total_principal, 1000);
        assert.strictEqual(dAlpha.summary.total_paid, 200);

        assert.strictEqual(dAlpha.loans.items.length, 1);
        assert.strictEqual(dAlpha.loans.items[0].person_id, p1);

        assert.strictEqual(dAlpha.people.items.length, 1);
        assert.strictEqual(dAlpha.people.items[0].person_id, p1);

        assert.strictEqual(dAlpha.due_collection.overdue_loan_count, 1);
        assert.strictEqual(dAlpha.due_collection.overdue_amount, 1000);

        assert.strictEqual(dAlpha.recent_activity.items.length, 1);
        assert.strictEqual(dAlpha.recent_activity.items[0].person_id, p1);
    });

    // ─── Test 11: Read-only (§22.11) ─────────────────────────────
    console.log('\n--- Test 11: Read-Only Verification ---');
    await runTest('Test 11 — Calling getIntegratedDashboard performs zero database writes', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (name, phone) VALUES ('Kapil Dev', '9876543218')");
        const pId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 1000000, 1000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')`, [pId]);

        const getCounts = () => ({
            people: queryOne(db, 'SELECT COUNT(*) as c FROM people').c,
            accounts: queryOne(db, 'SELECT COUNT(*) as c FROM accounts').c,
            transactions: queryOne(db, 'SELECT COUNT(*) as c FROM transactions').c,
            interest_records: queryOne(db, 'SELECT COUNT(*) as c FROM interest_records').c
        });

        const before = getCounts();

        getIntegratedDashboard(db, { as_of_date: TEST_DATE });
        getIntegratedDashboard(db, { person_id: pId, as_of_date: TEST_DATE });

        const after = getCounts();
        assert.deepStrictEqual(before, after);
    });

    // ─── Test 12: Service failure handling (§22.12) ──────────────
    console.log('\n--- Test 12: Service Failure Handling ---');
    await runTest('Test 12 — Failures propagate genuine error codes (400, 404, 500), never fake zeros', async () => {
        const db = await createFreshInMemoryDb(SQL);

        // Missing DB -> 500
        assert.throws(() => {
            getIntegratedDashboard(null);
        }, (err) => err.statusCode === 500);

        // Non-existent person -> 404
        assert.throws(() => {
            getIntegratedDashboard(db, { person_id: 88888 });
        }, (err) => err.statusCode === 404);

        // Invalid person_id format -> 400
        assert.throws(() => {
            getIntegratedDashboard(db, { person_id: 'bad-input' });
        }, (err) => err.statusCode === 400);
    });

    // ─── Test 13: Cross-section reconciliation test (§23) ────────
    console.log('\n--- Test 13: Cross-Section Reconciliation ---');
    await runTest('Test 13 — Section values reconcile across summary, loans, people, financial, due_collection', async () => {
        const db = await createFreshInMemoryDb(SQL);

        // Insert 2 people
        db.run("INSERT INTO people (name, phone) VALUES ('P1', '9000000001')");
        const p1 = queryOne(db, 'SELECT last_insert_rowid() as id').id;
        db.run("INSERT INTO people (name, phone) VALUES ('P2', '9000000002')");
        const p2 = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // P1 Loan A (active, due today): ₹1,000
        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 100000, 100000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-03-09', '2026-09-09', 'ACTIVE')`, [p1]);
        const l1 = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // P2 Loan B (active, overdue): ₹2,000
        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 200000, 200000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-08-01', 'ACTIVE')`, [p2]);
        const l2 = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // P2 Loan C (closed): ₹3,000
        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 300000, 0, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-06-01', 'CLOSED')`, [p2]);
        const l3 = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Interest on L1: ₹50, Paid ₹10 -> ₹40 outstanding
        db.run(`INSERT INTO interest_records (account_id, period_start, period_end, principal_basis, interest_rate, interest_amount, paid_amount, calculation_method, status)
                VALUES (?, '2026-08-01', '2026-08-31', 100000, 12.0, 5000, 1000, 'SIMPLE_INTEREST', 'PARTIALLY_PAID')`, [l1]);

        // Payment on L1: ₹10
        db.run(`INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (?, ?, 'INTEREST_RECEIVED', 1000, '2026-08-15')`, [l1, p1]);

        // Payment on L3: ₹3,000
        db.run(`INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (?, ?, 'PRINCIPAL_RECEIVED', 300000, '2026-06-01')`, [l3, p2]);

        const d = getIntegratedDashboard(db, { as_of_date: TEST_DATE });

        // 1. People count reconciliation
        assert.strictEqual(d.summary.total_people, d.people.items.length);
        assert.strictEqual(d.summary.total_people, 2);

        // 2. Loan count reconciliation
        assert.strictEqual(d.summary.total_loans, d.loans.items.length);
        assert.strictEqual(d.summary.total_loans, 3);
        assert.strictEqual(d.summary.active_loans, 2);
        assert.strictEqual(d.summary.closed_loans, 1);

        // 3. Principal reconciliation
        const sumLoanPrincipal = d.loans.items.reduce((acc, l) => acc + l.original_principal, 0);
        assert.strictEqual(d.summary.total_principal, sumLoanPrincipal);
        assert.strictEqual(d.summary.total_principal, 6000);

        // 4. Financial interest reconciliation
        assert.strictEqual(d.summary.total_interest, d.financial.interest.total_interest);
        assert.strictEqual(d.summary.outstanding_interest, d.financial.interest.outstanding_interest);

        // 5. Payment reconciliation
        assert.strictEqual(d.summary.total_paid, d.financial.payments.total_paid);
        assert.strictEqual(d.summary.total_paid, 3010);

        // 6. Due & collection reconciliation
        assert.strictEqual(d.due_collection.due_loan_count, 1);
        assert.strictEqual(d.due_collection.overdue_loan_count, 1);
    });

    // ─── Test 14: Live API Endpoints (§14) ───────────────────────
    console.log('\n--- Test 14: Live API Endpoints ---');
    await runTest('Test 14 — Live HTTP GET /api/dashboard and GET /api/dashboard/all return 200 with integrated contract', async () => {
        const res1 = await httpRequest('GET', `/dashboard?as_of_date=${TEST_DATE}`);
        assert.strictEqual(res1.statusCode, 200, `Expected 200, got ${res1.statusCode}`);

        // Check top-level contract sections
        assert.strictEqual(typeof res1.body.summary, 'object');
        assert.strictEqual(typeof res1.body.loans, 'object');
        assert.strictEqual(Array.isArray(res1.body.loans.items), true);
        assert.strictEqual(typeof res1.body.people, 'object');
        assert.strictEqual(Array.isArray(res1.body.people.items), true);
        assert.strictEqual(typeof res1.body.financial, 'object');
        assert.strictEqual(typeof res1.body.due_collection, 'object');
        assert.strictEqual(typeof res1.body.recent_activity, 'object');
        assert.strictEqual(Array.isArray(res1.body.recent_activity.items), true);

        // Test alias endpoint
        const res2 = await httpRequest('GET', `/dashboard/all?as_of_date=${TEST_DATE}`);
        assert.strictEqual(res2.statusCode, 200);

        // Test 404 for non-existent person
        const res3 = await httpRequest('GET', '/dashboard?person_id=99999');
        assert.strictEqual(res3.statusCode, 404);

        // Test 400 for invalid person
        const res4 = await httpRequest('GET', '/dashboard?person_id=bad');
        assert.strictEqual(res4.statusCode, 400);
    });

    console.log('\n================================================================');
    console.log(`Step 7H Tests: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runAll().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
