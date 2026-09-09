/**
 * Interest Manager — Step 7F Test Suite
 * Implementation: Due / Collection Summary Layer
 *
 * Verifies all specifications of Step 7F:
 *   Test 1: Nothing due — Active loans with future due dates -> due_count = 0, overdue_count = 0 (§26.1)
 *   Test 2: One due loan — due_date = as_of_date -> due_count = 1, due_amount = expected (§26.2)
 *   Test 3: One overdue loan — due_date < as_of_date -> overdue_count = 1, overdue_amount = expected (§26.3)
 *   Test 4: Fully paid past-due loan — due_date < as_of_date, balance = 0 -> Not overdue (§26.4)
 *   Test 5: Partial payment — Required ₹10,000, Paid ₹4,000, Outstanding ₹6,000 (§26.5)
 *   Test 6: Multiple loans — Loan A current, Loan B due, Loan C overdue -> due=1, overdue=1 (§26.6)
 *   Test 7: Multiple loans for one person — independently classified (§26.7)
 *   Test 8: Interest contribution — Part 6 interest integrated correctly (§26.8)
 *   Test 9: Closed loan — Closed loan with old due date excluded from active collection (§26.9)
 *   Test 10: Collection list — detailed collection list contains required contract fields (§26.10)
 *   Test 11: Authorization — person_id scoping, non-existent person 404, invalid input 400 (§26.11)
 *   Test 12: Read-only — zero database mutations during aggregation queries (§26.12)
 *   Test 13: Deterministic testing with clock abstraction (options.as_of_date) (§27)
 *   Test 14: Live API endpoints — GET /dashboard/due-summary & GET /dashboard/collections (§19)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const initSqlJs = require('sql.js');

const {
    getDueCollectionSummary,
    getCollectionItems
} = require('../services/dashboardService');
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
    console.log('   INTEREST MANAGER — STEP 7F: DUE / COLLECTION SUMMARY');
    console.log('================================================================\n');

    const SQL = await initSqlJs();
    const TEST_TODAY = '2026-09-09';

    // ─── Test 1: Nothing due (§26.1) ─────────────────────────────
    console.log('--- Test 1: Nothing Due ---');
    await runTest('Test 1 — Active loans with future due dates -> due_loan_count = 0, overdue_loan_count = 0', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Amit Sharma', '9876543210')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Create active loan with future due date (2026-12-31 > 2026-09-09)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 1000000, 1000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')
        `, [personId]);

        const summary = getDueCollectionSummary(db, { as_of_date: TEST_TODAY });

        assert.strictEqual(summary.due_loan_count, 0);
        assert.strictEqual(summary.overdue_loan_count, 0);
        assert.strictEqual(summary.due_amount, 0);
        assert.strictEqual(summary.due_amount_paisa, 0);
        assert.strictEqual(summary.overdue_amount, 0);
        assert.strictEqual(summary.overdue_amount_paisa, 0);
        assert.strictEqual(summary.collection_amount, 0);
        assert.strictEqual(summary.collection_amount_paisa, 0);

        const items = getCollectionItems(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(items.length, 0);
    });

    // ─── Test 2: One due loan (§26.2) ────────────────────────────
    console.log('\n--- Test 2: One Due Loan ---');
    await runTest('Test 2 — Loan with due_date = as_of_date -> due_loan_count = 1, due_amount = outstanding', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Priya Patel', '9876543211')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Create active loan with due_date = TEST_TODAY ('2026-09-09')
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 500000, 500000, 10.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-03-09', '2026-09-09', 'ACTIVE')
        `, [personId]);

        const summary = getDueCollectionSummary(db, { as_of_date: TEST_TODAY });

        assert.strictEqual(summary.due_loan_count, 1);
        assert.strictEqual(summary.overdue_loan_count, 0);
        assert.strictEqual(summary.due_amount, 5000);
        assert.strictEqual(summary.due_amount_paisa, 500000);
        assert.strictEqual(summary.overdue_amount, 0);
        assert.strictEqual(summary.collection_amount, 5000);
        assert.strictEqual(summary.collection_amount_paisa, 500000);

        const items = getCollectionItems(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].is_due, true);
        assert.strictEqual(items[0].is_overdue, false);
        assert.strictEqual(items[0].amount_due, 5000);
        assert.strictEqual(items[0].amount_overdue, 0);
        assert.strictEqual(items[0].outstanding_amount, 5000);
    });

    // ─── Test 3: One overdue loan (§26.3) ────────────────────────
    console.log('\n--- Test 3: One Overdue Loan ---');
    await runTest('Test 3 — Loan with due_date < as_of_date -> overdue_loan_count = 1, overdue_amount = outstanding', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Ramesh Rao', '9876543212')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Due date: 2026-08-01 (< 2026-09-09)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 800000, 800000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-02-01', '2026-08-01', 'ACTIVE')
        `, [personId]);

        const summary = getDueCollectionSummary(db, { as_of_date: TEST_TODAY });

        assert.strictEqual(summary.due_loan_count, 0);
        assert.strictEqual(summary.overdue_loan_count, 1);
        assert.strictEqual(summary.due_amount, 0);
        assert.strictEqual(summary.overdue_amount, 8000);
        assert.strictEqual(summary.overdue_amount_paisa, 800000);
        assert.strictEqual(summary.collection_amount, 8000);

        const items = getCollectionItems(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].is_due, false);
        assert.strictEqual(items[0].is_overdue, true);
        assert.strictEqual(items[0].amount_due, 0);
        assert.strictEqual(items[0].amount_overdue, 8000);
        assert.strictEqual(items[0].days_overdue > 0, true);
    });

    // ─── Test 4: Fully paid past-due loan (§26.4) ────────────────
    console.log('\n--- Test 4: Fully Paid Past-Due Loan ---');
    await runTest('Test 4 — Fully paid loan with historical due date is NOT overdue', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Sneha Verma', '9876543213')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Loan with past due date ('2026-08-01'), but outstanding_principal = 0 and no interest
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 1000000, 0, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-08-01', 'ACTIVE')
        `, [personId]);

        const summary = getDueCollectionSummary(db, { as_of_date: TEST_TODAY });

        assert.strictEqual(summary.due_loan_count, 0);
        assert.strictEqual(summary.overdue_loan_count, 0);
        assert.strictEqual(summary.due_amount, 0);
        assert.strictEqual(summary.overdue_amount, 0);
        assert.strictEqual(summary.collection_amount, 0);

        const items = getCollectionItems(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(items.length, 0);
    });

    // ─── Test 5: Partial payment (§26.5) ─────────────────────────
    console.log('\n--- Test 5: Partial Payment ---');
    await runTest('Test 5 — Required ₹10,000, Paid ₹4,000, Outstanding ₹6,000 -> overdue_amount = ₹6,000', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Vijay Kumar', '9876543214')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Principal: ₹10,000 (1,000,000 paisa), Outstanding: ₹6,000 (600,000 paisa)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 1000000, 600000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-08-01', 'ACTIVE')
        `, [personId]);

        const summary = getDueCollectionSummary(db, { as_of_date: TEST_TODAY });

        assert.strictEqual(summary.overdue_loan_count, 1);
        assert.strictEqual(summary.overdue_amount, 6000);
        assert.strictEqual(summary.overdue_amount_paisa, 600000);
        assert.strictEqual(summary.collection_amount, 6000);

        const items = getCollectionItems(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].outstanding_amount, 6000);
        assert.strictEqual(items[0].amount_overdue, 6000);
    });

    // ─── Test 6: Multiple loans (§26.6) ──────────────────────────
    console.log('\n--- Test 6: Multiple Loans ---');
    await runTest('Test 6 — Loan A (current), Loan B (due), Loan C (overdue) -> due=1, overdue=1', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Person 1', '9000000001')");
        const p1 = queryOne(db, 'SELECT last_insert_rowid() as id').id;
        db.run("INSERT INTO people (name, phone) VALUES ('Person 2', '9000000002')");
        const p2 = queryOne(db, 'SELECT last_insert_rowid() as id').id;
        db.run("INSERT INTO people (name, phone) VALUES ('Person 3', '9000000003')");
        const p3 = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Loan A: Current (due in future 2026-12-01)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 100000, 100000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-01', 'ACTIVE')
        `, [p1]);

        // Loan B: Due today (2026-09-09)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 200000, 200000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-03-09', '2026-09-09', 'ACTIVE')
        `, [p2]);

        // Loan C: Overdue (2026-08-01)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 300000, 300000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-02-01', '2026-08-01', 'ACTIVE')
        `, [p3]);

        const summary = getDueCollectionSummary(db, { as_of_date: TEST_TODAY });

        assert.strictEqual(summary.due_loan_count, 1);
        assert.strictEqual(summary.overdue_loan_count, 1);
        assert.strictEqual(summary.due_amount, 2000);
        assert.strictEqual(summary.overdue_amount, 3000);
        assert.strictEqual(summary.collection_amount, 5000);

        const items = getCollectionItems(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(items.length, 2);
    });

    // ─── Test 7: Multiple loans for one person (§26.7) ───────────
    console.log('\n--- Test 7: Multiple Loans For One Person ---');
    await runTest('Test 7 — One person with multiple loans classified independently', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Sunil Gavaskar', '9876543220')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Loan 1: Current (due 2026-11-01)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 100000, 100000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-11-01', 'ACTIVE')
        `, [personId]);

        // Loan 2: Due today (2026-09-09)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 250000, 250000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-03-09', '2026-09-09', 'ACTIVE')
        `, [personId]);

        // Loan 3: Overdue (due 2026-07-01)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 400000, 400000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-07-01', 'ACTIVE')
        `, [personId]);

        const summary = getDueCollectionSummary(db, { person_id: personId, as_of_date: TEST_TODAY });

        assert.strictEqual(summary.due_loan_count, 1);
        assert.strictEqual(summary.overdue_loan_count, 1);
        assert.strictEqual(summary.due_amount, 2500);
        assert.strictEqual(summary.overdue_amount, 4000);
        assert.strictEqual(summary.collection_amount, 6500);

        const items = getCollectionItems(db, { person_id: personId, as_of_date: TEST_TODAY });
        assert.strictEqual(items.length, 2);
        // Overdue sorted first
        assert.strictEqual(items[0].is_overdue, true);
        assert.strictEqual(items[0].amount_overdue, 4000);
        assert.strictEqual(items[1].is_due, true);
        assert.strictEqual(items[1].amount_due, 2500);
    });

    // ─── Test 8: Interest contribution (§26.8) ───────────────────
    console.log('\n--- Test 8: Interest Contribution ---');
    await runTest('Test 8 — Outstanding interest from Part 6 contributes to due/overdue amounts', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Manoj Bajpayee', '9876543221')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Loan overdue: Principal = ₹10,000 (1,000,000 paisa)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 1000000, 1000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-08-01', 'ACTIVE')
        `, [personId]);
        const loanId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Add Part 6 interest record: ₹500 interest, ₹100 paid -> ₹400 outstanding interest (40,000 paisa)
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis, interest_rate,
                interest_amount, paid_amount, calculation_method, status
            ) VALUES (?, '2026-01-01', '2026-01-31', 1000000, 12.0, 50000, 10000, 'SIMPLE_INTEREST', 'PARTIALLY_PAID')
        `, [loanId]);

        // Add reversed interest record (should NOT be counted)
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis, interest_rate,
                interest_amount, paid_amount, calculation_method, status
            ) VALUES (?, '2026-02-01', '2026-02-28', 1000000, 12.0, 50000, 0, 'SIMPLE_INTEREST', 'REVERSED')
        `, [loanId]);

        const summary = getDueCollectionSummary(db, { as_of_date: TEST_TODAY });

        // Overdue = Principal (₹10,000) + Outstanding Interest (₹400) = ₹10,400 (1,040,000 paisa)
        assert.strictEqual(summary.overdue_loan_count, 1);
        assert.strictEqual(summary.overdue_amount, 10400);
        assert.strictEqual(summary.overdue_amount_paisa, 1040000);
        assert.strictEqual(summary.collection_amount, 10400);

        const items = getCollectionItems(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].outstanding_principal, 10000);
        assert.strictEqual(items[0].outstanding_interest, 400);
        assert.strictEqual(items[0].outstanding_amount, 10400);
        assert.strictEqual(items[0].amount_overdue, 10400);
    });

    // ─── Test 9: Closed loan (§26.9) ─────────────────────────────
    console.log('\n--- Test 9: Closed Loan ---');
    await runTest('Test 9 — Closed loan with old due date is excluded from active collection targets', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Kiran Bedi', '9876543222')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Closed loan with past due date ('2026-05-01')
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 500000, 0, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-05-01', 'CLOSED')
        `, [personId]);

        // Written-off loan
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 300000, 300000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-05-01', 'WRITTEN_OFF')
        `, [personId]);

        const summary = getDueCollectionSummary(db, { as_of_date: TEST_TODAY });

        assert.strictEqual(summary.due_loan_count, 0);
        assert.strictEqual(summary.overdue_loan_count, 0);
        assert.strictEqual(summary.due_amount, 0);
        assert.strictEqual(summary.overdue_amount, 0);
        assert.strictEqual(summary.collection_amount, 0);

        const items = getCollectionItems(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(items.length, 0);
    });

    // ─── Test 10: Collection list (§26.10) ───────────────────────
    console.log('\n--- Test 10: Collection List ---');
    await runTest('Test 10 — Detailed collection list contains required contract fields and excludes unrelated loans', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Anil Kumble', '9876543223')");
        const p1 = queryOne(db, 'SELECT last_insert_rowid() as id').id;
        db.run("INSERT INTO people (name, phone) VALUES ('Javagal Srinath', '9876543224')");
        const p2 = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // P1: Overdue loan (due 2026-07-15)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 1500000, 1500000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-15', '2026-07-15', 'ACTIVE')
        `, [p1]);

        // P2: Due loan (due 2026-09-09)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 800000, 800000, 10.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-03-09', '2026-09-09', 'ACTIVE')
        `, [p2]);

        // P2: Current loan (due 2026-12-15) -> should NOT appear in collection list
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 500000, 500000, 10.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-03-09', '2026-12-15', 'ACTIVE')
        `, [p2]);

        const items = getCollectionItems(db, { as_of_date: TEST_TODAY });

        assert.strictEqual(items.length, 2);

        // First item: Overdue
        const overdueItem = items[0];
        assert.strictEqual(overdueItem.person_name, 'Anil Kumble');
        assert.strictEqual(overdueItem.is_overdue, true);
        assert.strictEqual(overdueItem.is_due, false);
        assert.strictEqual(overdueItem.amount_overdue, 15000);
        assert.strictEqual(overdueItem.amount_due, 0);
        assert.strictEqual(overdueItem.outstanding_amount, 15000);
        assert.strictEqual(overdueItem.due_date, '2026-07-15');
        assert.strictEqual(overdueItem.days_overdue > 0, true);

        // Second item: Due
        const dueItem = items[1];
        assert.strictEqual(dueItem.person_name, 'Javagal Srinath');
        assert.strictEqual(dueItem.is_due, true);
        assert.strictEqual(dueItem.is_overdue, false);
        assert.strictEqual(dueItem.amount_due, 8000);
        assert.strictEqual(dueItem.amount_overdue, 0);
        assert.strictEqual(dueItem.outstanding_amount, 8000);
        assert.strictEqual(dueItem.due_date, '2026-09-09');
    });

    // ─── Test 11: Authorization (§26.11) ─────────────────────────
    console.log('\n--- Test 11: Authorization ---');
    await runTest('Test 11 — Authorization: person_id scoping isolates collection data, 404/400 for invalid inputs', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('User Alpha', '9111111111')");
        const p1 = queryOne(db, 'SELECT last_insert_rowid() as id').id;
        db.run("INSERT INTO people (name, phone) VALUES ('User Beta', '9222222222')");
        const p2 = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // P1 overdue loan: ₹5,000
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 500000, 500000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-07-01', 'ACTIVE')
        `, [p1]);

        // P2 overdue loan: ₹9,000
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 900000, 900000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-07-01', 'ACTIVE')
        `, [p2]);

        // Scoped to P1
        const s1 = getDueCollectionSummary(db, { person_id: p1, as_of_date: TEST_TODAY });
        assert.strictEqual(s1.overdue_loan_count, 1);
        assert.strictEqual(s1.overdue_amount, 5000);

        const items1 = getCollectionItems(db, { person_id: p1, as_of_date: TEST_TODAY });
        assert.strictEqual(items1.length, 1);
        assert.strictEqual(items1[0].person_id, p1);

        // Scoped to P2
        const s2 = getDueCollectionSummary(db, { person_id: p2, as_of_date: TEST_TODAY });
        assert.strictEqual(s2.overdue_loan_count, 1);
        assert.strictEqual(s2.overdue_amount, 9000);

        // Non-existent person -> 404
        assert.throws(() => {
            getDueCollectionSummary(db, { person_id: 99999 });
        }, (err) => err.statusCode === 404);

        // Invalid person_id -> 400
        assert.throws(() => {
            getDueCollectionSummary(db, { person_id: 'bad-input' });
        }, (err) => err.statusCode === 400);
    });

    // ─── Test 12: Read-only (§26.12) ─────────────────────────────
    console.log('\n--- Test 12: Read-Only Verification ---');
    await runTest('Test 12 — Service execution causes zero database modifications', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Rahul Dravid', '9876543225')");
        const pId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 1000000, 1000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-08-01', 'ACTIVE')
        `, [pId]);

        const getCounts = () => ({
            people: queryOne(db, 'SELECT COUNT(*) as c FROM people').c,
            accounts: queryOne(db, 'SELECT COUNT(*) as c FROM accounts').c,
            transactions: queryOne(db, 'SELECT COUNT(*) as c FROM transactions').c,
            interest_records: queryOne(db, 'SELECT COUNT(*) as c FROM interest_records').c
        });

        const before = getCounts();

        // Perform multiple queries
        getDueCollectionSummary(db, { as_of_date: TEST_TODAY });
        getDueCollectionSummary(db, { person_id: pId, as_of_date: TEST_TODAY });
        getCollectionItems(db, { as_of_date: TEST_TODAY });
        getCollectionItems(db, { person_id: pId, as_of_date: TEST_TODAY });

        const after = getCounts();

        assert.deepStrictEqual(before, after);
    });

    // ─── Test 13: Deterministic Clock Abstraction (§27) ──────────
    console.log('\n--- Test 13: Deterministic Clock Abstraction ---');
    await runTest('Test 13 — Shifting as_of_date moves loan from current -> due -> overdue', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Sourav Ganguly', '9876543226')");
        const pId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Loan due on 2026-10-15
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 700000, 700000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-15', '2026-10-15', 'ACTIVE')
        `, [pId]);

        // 1. Before due date (2026-10-10): Current
        const sBefore = getDueCollectionSummary(db, { as_of_date: '2026-10-10' });
        assert.strictEqual(sBefore.due_loan_count, 0);
        assert.strictEqual(sBefore.overdue_loan_count, 0);

        // 2. Exactly on due date (2026-10-15): Due
        const sOn = getDueCollectionSummary(db, { as_of_date: '2026-10-15' });
        assert.strictEqual(sOn.due_loan_count, 1);
        assert.strictEqual(sOn.overdue_loan_count, 0);
        assert.strictEqual(sOn.due_amount, 7000);

        // 3. After due date (2026-10-20): Overdue
        const sAfter = getDueCollectionSummary(db, { as_of_date: '2026-10-20' });
        assert.strictEqual(sAfter.due_loan_count, 0);
        assert.strictEqual(sAfter.overdue_loan_count, 1);
        assert.strictEqual(sAfter.overdue_amount, 7000);
    });

    // ─── Test 14: Live API Endpoints (§19) ───────────────────────
    console.log('\n--- Test 14: Live API Endpoints ---');
    await runTest('Test 14 — Live API: GET /api/dashboard/due-summary and GET /api/dashboard/collections', async () => {
        const res1 = await httpRequest('GET', `/dashboard/due-summary?as_of_date=${TEST_TODAY}`);
        assert.strictEqual(res1.statusCode, 200, `Expected 200, got ${res1.statusCode}`);
        assert.strictEqual(typeof res1.body.due_loan_count, 'number');
        assert.strictEqual(typeof res1.body.overdue_loan_count, 'number');
        assert.strictEqual(typeof res1.body.due_amount, 'number');
        assert.strictEqual(typeof res1.body.overdue_amount, 'number');
        assert.strictEqual(typeof res1.body.collection_amount, 'number');

        const res2 = await httpRequest('GET', `/dashboard/collections?as_of_date=${TEST_TODAY}`);
        assert.strictEqual(res2.statusCode, 200, `Expected 200, got ${res2.statusCode}`);
        assert.strictEqual(Array.isArray(res2.body.items), true);
        assert.strictEqual(typeof res2.body.count, 'number');

        // Test alias endpoints
        const res3 = await httpRequest('GET', `/dashboard/collections/summary?as_of_date=${TEST_TODAY}`);
        assert.strictEqual(res3.statusCode, 200);

        const res4 = await httpRequest('GET', `/dashboard/collection-items?as_of_date=${TEST_TODAY}`);
        assert.strictEqual(res4.statusCode, 200);
    });

    console.log('\n================================================================');
    console.log(`Step 7F Tests: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runAll().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
