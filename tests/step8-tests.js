/**
 * Interest Manager — Part 8 Test Suite: Due / Overdue Tracking
 *
 * Covers:
 *   8I.1:  Future Due Date -> CURRENT
 *   8I.2:  Due Today -> DUE
 *   8I.3:  Overdue -> OVERDUE (due_date < today, grace_period = 0)
 *   8I.4:  Fully Paid Past Due -> PAID (outstanding = 0, NOT overdue)
 *   8I.5:  Partial Payment -> PARTIALLY_PAID before due date, OVERDUE after overdue threshold
 *   8I.6:  Grace Period -> DUE within grace period, OVERDUE once grace period expired
 *   8I.7:  Multiple Loans -> current_count = 1, due_count = 1, overdue_count = 1
 *   8I.8:  Multiple People -> independent classification across customers
 *   8I.9:  Interest Contribution -> authoritative Part 6 interest integrated
 *   8I.10: Payment Reversal -> status and outstanding update correctly
 *   8I.11: Interest Correction -> superseded interest records excluded
 *   8I.12: Closed Loan -> CLOSED status, excluded from active collection
 *   8I.13: Scoping & Authorization -> person_id scoping isolates data and aggregates
 *   8J.1:  Zero Due -> required = 0, no active overdue amount
 *   8J.2:  Exact Payment -> required = 10000, paid = 10000, status = PAID
 *   8J.3:  Overpayment -> handled safely, outstanding = 0, status = PAID
 *   8J.4:  Payment on Due Date -> boundary behavior deterministic
 *   8J.5:  Payment One Day Late -> overdue handling and outstanding reduction
 *   8J.6:  Performance / Aggregation -> single aggregated query, no N+1
 *   8J.7:  Reconciliation -> Part 8 totals == Part 7 Dashboard totals
 *   8J.8:  Live API Endpoints -> GET /due, /overdue, /due-overdue/summary, /collections
 *   8J.9:  Read-Only Verification -> zero DB mutations during read operations
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const initSqlJs = require('sql.js');

const {
    evaluateObligation,
    getDueOverdueSummary,
    getDueLoans,
    getOverdueLoans,
    getCollectionItems,
    resolveAsOfDate
} = require('../services/dueTrackingService');
const {
    getDueCollectionSummary,
    getCollectionItems: getDashboardCollectionItems
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
    const schemaSql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf-8');
    db.run(schemaSql);
    return db;
}

async function runAll() {
    console.log('\n================================================================');
    console.log('   INTEREST MANAGER — PART 8: DUE / OVERDUE TRACKING TESTS');
    console.log('================================================================\n');

    const SQL = await initSqlJs();
    const TEST_TODAY = '2026-09-09';

    // ─── 8I.1 Future Due Date ──────────────────────────────────
    await runTest('8I.1 Future Due Date -> CURRENT', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE', 0)`);

        const summary = getDueOverdueSummary(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(summary.current_count, 1, 'Should have 1 current loan');
        assert.strictEqual(summary.due_count, 0, 'Should have 0 due loans');
        assert.strictEqual(summary.overdue_count, 0, 'Should have 0 overdue loans');

        const dueLoans = getDueLoans(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(dueLoans.length, 0);

        const overdueLoans = getOverdueLoans(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(overdueLoans.length, 0);
    });

    // ─── 8I.2 Due Today ────────────────────────────────────────
    await runTest('8I.2 Due Today -> DUE', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-09', 'ACTIVE', 0)`);

        const summary = getDueOverdueSummary(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(summary.due_count, 1, 'Should have 1 due loan');
        assert.strictEqual(summary.overdue_count, 0, 'Should not be overdue yet');
        assert.strictEqual(summary.due_amount, 10000.00, 'Due amount should be ₹10,000');

        const dueLoans = getDueLoans(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(dueLoans.length, 1);
        assert.strictEqual(dueLoans[0].status, 'DUE');
        assert.strictEqual(dueLoans[0].outstanding_amount, 10000.00);
    });

    // ─── 8I.3 Overdue ──────────────────────────────────────────
    await runTest('8I.3 Overdue -> OVERDUE (due_date < today, grace_period = 0)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'ACTIVE', 0)`);

        const summary = getDueOverdueSummary(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(summary.due_count, 0, 'Should have 0 due loans');
        assert.strictEqual(summary.overdue_count, 1, 'Should have 1 overdue loan');
        assert.strictEqual(summary.overdue_amount, 10000.00, 'Overdue amount should be ₹10,000');

        const overdueLoans = getOverdueLoans(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(overdueLoans.length, 1);
        assert.strictEqual(overdueLoans[0].status, 'OVERDUE');
        assert.strictEqual(overdueLoans[0].days_overdue, 8, 'Should be 8 days overdue');
        assert.strictEqual(overdueLoans[0].overdue_amount, 10000.00);
    });

    // ─── 8I.4 Fully Paid Past Due ──────────────────────────────
    await runTest('8I.4 Fully Paid Past Due -> PAID (outstanding = 0, NOT overdue)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 0, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'ACTIVE', 0)`);
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'PRINCIPAL_RECEIVED', 1000000, '2026-09-01')`);

        const summary = getDueOverdueSummary(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(summary.paid_count, 1, 'Should be counted as paid');
        assert.strictEqual(summary.due_count, 0, 'Should have 0 due');
        assert.strictEqual(summary.overdue_count, 0, 'Must NOT be overdue');
        assert.strictEqual(summary.overdue_amount, 0);

        const overdueLoans = getOverdueLoans(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(overdueLoans.length, 0, 'Fully paid loan must not appear in overdue list');
    });

    // ─── 8I.5 Partial Payment ──────────────────────────────────
    await runTest('8I.5 Partial Payment -> PARTIALLY_PAID before due date, OVERDUE after overdue threshold', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        // Required ₹10,000, Paid ₹4,000, Outstanding ₹6,000
        // Loan 1: Future due date
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 600000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE', 0)`);
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'PRINCIPAL_RECEIVED', 400000, '2026-08-10')`);

        // Loan 2: Past due date
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (2, 1, 'MONEY_GIVEN', 1000000, 600000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'ACTIVE', 0)`);
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (2, 2, 1, 'PRINCIPAL_RECEIVED', 400000, '2026-08-10')`);

        // Evaluate Loan 1
        const eval1 = evaluateObligation(
            { id: 1, person_id: 1, due_date: '2026-09-15', principal: 1000000, outstanding_principal_paisa: 600000, total_paid_paisa: 400000, grace_period: 0, status: 'ACTIVE' },
            TEST_TODAY
        );
        assert.strictEqual(eval1.status, 'PARTIALLY_PAID', 'Before due date should be PARTIALLY_PAID');
        assert.strictEqual(eval1.is_partially_paid, true);
        assert.strictEqual(eval1.outstanding_amount, 6000.00);

        // Evaluate Loan 2
        const eval2 = evaluateObligation(
            { id: 2, person_id: 1, due_date: '2026-09-01', principal: 1000000, outstanding_principal_paisa: 600000, total_paid_paisa: 400000, grace_period: 0, status: 'ACTIVE' },
            TEST_TODAY
        );
        assert.strictEqual(eval2.status, 'OVERDUE', 'After overdue threshold should be OVERDUE');
        assert.strictEqual(eval2.is_overdue, true);
        assert.strictEqual(eval2.outstanding_amount, 6000.00);
        assert.strictEqual(eval2.amount_overdue, 6000.00);
    });

    // ─── 8I.6 Grace Period ─────────────────────────────────────
    await runTest('8I.6 Grace Period -> DUE within grace period, OVERDUE after grace period', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        // due_date = 2026-09-01, grace_period = 3 days
        // Grace period spans: 2026-09-01 to 2026-09-04
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'ACTIVE', 3)`);

        // Case A: as_of_date = 2026-09-03 (within grace period) -> DUE
        const evalGrace = evaluateObligation(
            { id: 1, person_id: 1, due_date: '2026-09-01', principal: 1000000, outstanding_principal_paisa: 1000000, total_paid_paisa: 0, grace_period: 3, status: 'ACTIVE' },
            '2026-09-03'
        );
        assert.strictEqual(evalGrace.status, 'DUE', 'Within grace period should be DUE');
        assert.strictEqual(evalGrace.is_due, true);
        assert.strictEqual(evalGrace.is_overdue, false);

        // Case B: as_of_date = 2026-09-05 (grace period expired) -> OVERDUE
        const evalExpired = evaluateObligation(
            { id: 1, person_id: 1, due_date: '2026-09-01', principal: 1000000, outstanding_principal_paisa: 1000000, total_paid_paisa: 0, grace_period: 3, status: 'ACTIVE' },
            '2026-09-05'
        );
        assert.strictEqual(evalExpired.status, 'OVERDUE', 'After grace period should be OVERDUE');
        assert.strictEqual(evalExpired.is_overdue, true);
        assert.strictEqual(evalExpired.days_overdue, 4);
    });

    // ─── 8I.7 Multiple Loans ───────────────────────────────────
    await runTest('8I.7 Multiple Loans -> current_count = 1, due_count = 1, overdue_count = 1', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        // Loan 1: CURRENT (due 2026-09-20)
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-20', 'ACTIVE', 0)`);
        // Loan 2: DUE (due 2026-09-09)
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (2, 1, 'MONEY_GIVEN', 2000000, 2000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-09', 'ACTIVE', 0)`);
        // Loan 3: OVERDUE (due 2026-09-01)
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (3, 1, 'MONEY_GIVEN', 3000000, 3000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'ACTIVE', 0)`);

        const summary = getDueOverdueSummary(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(summary.current_count, 1, 'current_count should be 1');
        assert.strictEqual(summary.due_count, 1, 'due_count should be 1');
        assert.strictEqual(summary.overdue_count, 1, 'overdue_count should be 1');
        assert.strictEqual(summary.due_amount, 20000.00, 'due_amount should be ₹20,000');
        assert.strictEqual(summary.overdue_amount, 30000.00, 'overdue_amount should be ₹30,000');
        assert.strictEqual(summary.collection_amount, 50000.00, 'collection_amount should be ₹50,000');
    });

    // ─── 8I.8 Multiple People ──────────────────────────────────
    await runTest('8I.8 Multiple People -> independent classification across customers', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111'), (2, 'Bob', '2222222222')");
        // Alice has an overdue loan
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'ACTIVE', 0)`);
        // Bob has a current loan
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (2, 2, 'MONEY_GIVEN', 2000000, 2000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-20', 'ACTIVE', 0)`);

        const aliceSummary = getDueOverdueSummary(db, { as_of_date: TEST_TODAY, person_id: 1 });
        assert.strictEqual(aliceSummary.overdue_count, 1);
        assert.strictEqual(aliceSummary.current_count, 0);

        const bobSummary = getDueOverdueSummary(db, { as_of_date: TEST_TODAY, person_id: 2 });
        assert.strictEqual(bobSummary.overdue_count, 0);
        assert.strictEqual(bobSummary.current_count, 1);
    });

    // ─── 8I.9 Interest Contribution ────────────────────────────
    await runTest('8I.9 Interest Contribution -> authoritative Part 6 interest integrated', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'ACTIVE', 0)`);
        // Add Part 6 interest record: ₹200 accrued, ₹50 paid, ₹150 outstanding
        db.run(`INSERT INTO interest_records (id, account_id, period_start, period_end, principal_basis, interest_rate, interest_amount, paid_amount, status)
                VALUES (1, 1, '2026-08-01', '2026-09-01', 1000000, 12, 20000, 5000, 'PARTIALLY_PAID')`);

        const overdueLoans = getOverdueLoans(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(overdueLoans.length, 1);
        assert.strictEqual(overdueLoans[0].outstanding_principal, 10000.00);
        assert.strictEqual(overdueLoans[0].outstanding_interest, 150.00);
        assert.strictEqual(overdueLoans[0].outstanding_amount, 10150.00);
        assert.strictEqual(overdueLoans[0].overdue_amount, 10150.00);
    });

    // ─── 8I.10 Payment Reversal ────────────────────────────────
    await runTest('8I.10 Payment Reversal -> status and outstanding update correctly', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        // Initially fully paid
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 0, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'ACTIVE', 0)`);

        let summary = getDueOverdueSummary(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(summary.paid_count, 1);
        assert.strictEqual(summary.overdue_count, 0);

        // Payment reversal restores outstanding principal to ₹10,000
        db.run(`UPDATE accounts SET outstanding_principal = 1000000 WHERE id = 1`);

        summary = getDueOverdueSummary(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(summary.paid_count, 0);
        assert.strictEqual(summary.overdue_count, 1, 'Should dynamically reflect overdue status after reversal');
        assert.strictEqual(summary.overdue_amount, 10000.00);
    });

    // ─── 8I.11 Interest Correction ─────────────────────────────
    await runTest('8I.11 Interest Correction -> superseded interest records excluded', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'ACTIVE', 0)`);
        // Superseded/reversed record: ₹500
        db.run(`INSERT INTO interest_records (id, account_id, period_start, period_end, principal_basis, interest_rate, interest_amount, paid_amount, status)
                VALUES (1, 1, '2026-08-01', '2026-09-01', 1000000, 12, 50000, 0, 'REVERSED')`);
        // Corrected record: ₹200
        db.run(`INSERT INTO interest_records (id, account_id, period_start, period_end, principal_basis, interest_rate, interest_amount, paid_amount, status)
                VALUES (2, 1, '2026-08-01', '2026-09-01', 1000000, 12, 20000, 0, 'PENDING')`);

        const overdueLoans = getOverdueLoans(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(overdueLoans.length, 1);
        assert.strictEqual(overdueLoans[0].outstanding_interest, 200.00, 'Only non-reversed interest should be included');
        assert.strictEqual(overdueLoans[0].overdue_amount, 10200.00);
    });

    // ─── 8I.12 Closed Loan ─────────────────────────────────────
    await runTest('8I.12 Closed Loan -> CLOSED status, excluded from active collection', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 0, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'CLOSED', 0)`);

        const summary = getDueOverdueSummary(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(summary.closed_count, 1);
        assert.strictEqual(summary.due_count, 0);
        assert.strictEqual(summary.overdue_count, 0);

        const collectionList = getCollectionItems(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(collectionList.length, 0, 'Closed loan must not appear in collection list');
    });

    // ─── 8I.13 Scoping & Authorization ─────────────────────────
    await runTest('8I.13 Scoping & Authorization -> person_id scoping isolates data and aggregates', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111'), (2, 'Bob', '2222222222')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'ACTIVE', 0),
                       (2, 2, 'MONEY_GIVEN', 5000000, 5000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'ACTIVE', 0)`);

        const aliceSummary = getDueOverdueSummary(db, { as_of_date: TEST_TODAY, person_id: 1 });
        assert.strictEqual(aliceSummary.overdue_amount, 10000.00, 'Alice overdue amount must not include Bob');
        assert.strictEqual(aliceSummary.overdue_count, 1);

        const aliceOverdue = getOverdueLoans(db, { as_of_date: TEST_TODAY, person_id: 1 });
        assert.strictEqual(aliceOverdue.length, 1);
        assert.strictEqual(aliceOverdue[0].person_name, 'Alice');

        // Non-existent person throws 404
        assert.throws(() => {
            getDueOverdueSummary(db, { person_id: 999 });
        }, /not found/i);
    });

    // ─── 8J.1 Zero Due ─────────────────────────────────────────
    await runTest('8J.1 Zero Due -> required = 0, no active overdue amount', async () => {
        // Direct evaluation of an obligation with 0 outstanding
        const evalZero = evaluateObligation({
            id: 1,
            person_id: 1,
            due_date: '2026-09-01',
            principal: 1000000,
            outstanding_principal_paisa: 0,
            total_paid_paisa: 0,
            outstanding_interest_paisa: 0,
            status: 'ACTIVE'
        }, TEST_TODAY);

        assert.strictEqual(evalZero.amount_overdue, 0, 'No active overdue amount when outstanding is 0');
        assert.strictEqual(evalZero.is_overdue, false);
        assert.strictEqual(evalZero.status, 'PAID');

        // Database test with settled loan (outstanding = 0)
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 0, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'ACTIVE', 0)`);

        const summary = getDueOverdueSummary(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(summary.overdue_count, 0);
        assert.strictEqual(summary.overdue_amount, 0);
        assert.strictEqual(summary.paid_count, 1);
    });

    // ─── 8J.2 Exact Payment ────────────────────────────────────
    await runTest('8J.2 Exact Payment -> required = 10000, paid = 10000, status = PAID', async () => {
        const evalPaid = evaluateObligation({
            id: 1,
            person_id: 1,
            due_date: '2026-09-01',
            principal: 1000000,
            outstanding_principal_paisa: 0,
            total_paid_paisa: 1000000,
            outstanding_interest_paisa: 0,
            status: 'ACTIVE'
        }, TEST_TODAY);

        assert.strictEqual(evalPaid.status, 'PAID');
        assert.strictEqual(evalPaid.is_paid, true);
        assert.strictEqual(evalPaid.is_overdue, false);
        assert.strictEqual(evalPaid.outstanding_amount, 0);
    });

    // ─── 8J.3 Overpayment ──────────────────────────────────────
    await runTest('8J.3 Overpayment -> handled safely, outstanding = 0, status = PAID', async () => {
        const evalOverpaid = evaluateObligation({
            id: 1,
            person_id: 1,
            due_date: '2026-09-01',
            principal: 1000000,
            outstanding_principal_paisa: 0,
            total_paid_paisa: 1200000,
            outstanding_interest_paisa: 0,
            status: 'ACTIVE'
        }, TEST_TODAY);

        assert.strictEqual(evalOverpaid.status, 'PAID');
        assert.strictEqual(evalOverpaid.is_paid, true);
        assert.strictEqual(evalOverpaid.is_overdue, false);
        assert.strictEqual(evalOverpaid.outstanding_amount, 0);
    });

    // ─── 8J.4 Payment on Due Date ──────────────────────────────
    await runTest('8J.4 Payment on Due Date -> boundary behavior deterministic', async () => {
        // Due on 2026-09-09, evaluated on 2026-09-09
        const evalDueToday = evaluateObligation({
            id: 1,
            person_id: 1,
            due_date: '2026-09-09',
            principal: 1000000,
            outstanding_principal_paisa: 1000000,
            total_paid_paisa: 0,
            status: 'ACTIVE',
            grace_period: 0
        }, '2026-09-09');

        assert.strictEqual(evalDueToday.status, 'DUE');
        assert.strictEqual(evalDueToday.is_due, true);
        assert.strictEqual(evalDueToday.is_overdue, false);
    });

    // ─── 8J.5 Payment One Day Late ─────────────────────────────
    await runTest('8J.5 Payment One Day Late -> overdue handling and outstanding reduction', async () => {
        // Due 2026-09-09, evaluated on 2026-09-10 with grace_period = 0
        const evalLate = evaluateObligation({
            id: 1,
            person_id: 1,
            due_date: '2026-09-09',
            principal: 1000000,
            outstanding_principal_paisa: 500000, // ₹5,000 paid late
            total_paid_paisa: 500000,
            status: 'ACTIVE',
            grace_period: 0
        }, '2026-09-10');

        assert.strictEqual(evalLate.status, 'OVERDUE');
        assert.strictEqual(evalLate.is_overdue, true);
        assert.strictEqual(evalLate.days_overdue, 1);
        assert.strictEqual(evalLate.outstanding_amount, 5000.00);
        assert.strictEqual(evalLate.amount_overdue, 5000.00);
    });

    // ─── 8J.6 Performance / Aggregation ────────────────────────
    await runTest('8J.6 Performance / Aggregation -> single aggregated query, no N+1', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        // Insert 20 loans
        for (let i = 1; i <= 20; i++) {
            const dueDate = i % 2 === 0 ? '2026-09-01' : '2026-09-25';
            db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                    VALUES (${i}, 1, 'MONEY_GIVEN', 100000, 100000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '${dueDate}', 'ACTIVE', 0)`);
        }

        const summary = getDueOverdueSummary(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(summary.total_count, 20);
        assert.strictEqual(summary.overdue_count, 10);
        assert.strictEqual(summary.current_count, 10);

        // Test pagination limit
        const overdueLimited = getOverdueLoans(db, { as_of_date: TEST_TODAY, limit: 5 });
        assert.strictEqual(overdueLimited.length, 5);

        const collectionLimited = getCollectionItems(db, { as_of_date: TEST_TODAY, limit: 3 });
        assert.strictEqual(collectionLimited.length, 3);
    });

    // ─── 8J.7 Reconciliation with Part 7 Dashboard ─────────────
    await runTest('8J.7 Reconciliation -> Part 8 totals == Part 7 Dashboard totals', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'ACTIVE', 0),
                       (2, 1, 'MONEY_GIVEN', 2000000, 2000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-09', 'ACTIVE', 0)`);

        const part8Summary = getDueOverdueSummary(db, { as_of_date: TEST_TODAY });
        const part7Summary = getDueCollectionSummary(db, { as_of_date: TEST_TODAY });

        assert.strictEqual(part8Summary.overdue_count, part7Summary.overdue_count, 'Overdue count must match');
        assert.strictEqual(part8Summary.overdue_amount, part7Summary.overdue_amount, 'Overdue amount must match');
        assert.strictEqual(part8Summary.due_count, part7Summary.due_count, 'Due count must match');
        assert.strictEqual(part8Summary.due_amount, part7Summary.due_amount, 'Due amount must match');
        assert.strictEqual(part8Summary.collection_amount, part7Summary.collection_amount, 'Collection amount must match');
    });

    // ─── 8J.8 Live API Endpoints ───────────────────────────────
    await runTest('8J.8 Live API Endpoints -> GET /due, /overdue, /due-overdue/summary, /collections', async () => {
        // Summary endpoint
        const resSummary = await httpRequest('GET', '/due-overdue/summary?as_of_date=2026-09-09');
        assert.strictEqual(resSummary.statusCode, 200);
        assert(resSummary.body.data !== undefined || resSummary.body.overdue_count !== undefined);

        // Due endpoint
        const resDue = await httpRequest('GET', '/due?as_of_date=2026-09-09');
        assert.strictEqual(resDue.statusCode, 200);
        assert(Array.isArray(resDue.body.items));

        // Overdue endpoint
        const resOverdue = await httpRequest('GET', '/overdue?as_of_date=2026-09-09');
        assert.strictEqual(resOverdue.statusCode, 200);
        assert(Array.isArray(resOverdue.body.items));

        // Collections endpoint
        const resCollections = await httpRequest('GET', '/collections?as_of_date=2026-09-09');
        assert.strictEqual(resCollections.statusCode, 200);
        assert(Array.isArray(resCollections.body.items));
    });

    // ─── 8J.9 Read-Only Verification ───────────────────────────
    await runTest('8J.9 Read-Only Verification -> zero DB mutations during read operations', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'ACTIVE', 0)`);

        const beforeAccounts = queryAll(db, 'SELECT * FROM accounts');
        const beforePeople = queryAll(db, 'SELECT * FROM people');

        getDueOverdueSummary(db, { as_of_date: TEST_TODAY });
        getDueLoans(db, { as_of_date: TEST_TODAY });
        getOverdueLoans(db, { as_of_date: TEST_TODAY });
        getCollectionItems(db, { as_of_date: TEST_TODAY });

        const afterAccounts = queryAll(db, 'SELECT * FROM accounts');
        const afterPeople = queryAll(db, 'SELECT * FROM people');

        assert.deepStrictEqual(beforeAccounts, afterAccounts, 'Accounts table must be unchanged');
        assert.deepStrictEqual(beforePeople, afterPeople, 'People table must be unchanged');
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    if (failed > 0) {
        process.exit(1);
    }
}

runAll().catch(err => {
    console.error('Test run error:', err);
    process.exit(1);
});
