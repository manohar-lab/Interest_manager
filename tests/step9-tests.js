/**
 * Interest Manager — Part 9 Test Suite: Reports
 *
 * Verifies all specifications of Part 9:
 *   9J.1:  Common report validation (valid/invalid types, 400 on bad type)
 *   9J.2:  Loan portfolio report (loan count, principal, paid, balance reconciliation)
 *   9J.3:  People report (multi-loan customer aggregation)
 *   9J.4:  Payment report (transaction count, payment amounts)
 *   9J.5:  Payment date-range filtering (inclusive boundary behavior)
 *   9J.6:  Interest report (Part 6 integration, no recalculation)
 *   9J.7:  Due / Overdue report (Part 8 integration)
 *   9J.8:  Collection priority report (overdue inclusion, ordering)
 *   9J.9:  Multiple loans per person (concurrent active, overdue, paid states)
 *   9J.10: Authorization scoping (customer isolation across counts, totals, items)
 *   9J.11: Pagination test (page_size, total_pages, no duplicates)
 *   9J.12: Monetary precision (integer paisa exactness)
 *   9J.13: Empty report handling (valid DTO, empty arrays, zero totals)
 *   9J.14: Read-Only verification (zero DB writes across all report services)
 *   9K.1:  Loan reconciliation vs account balance services
 *   9K.2:  People reconciliation vs authorized loans
 *   9K.3:  Payment reconciliation vs transactions
 *   9K.4:  Interest reconciliation vs Part 6 records
 *   9K.5:  Due / Overdue reconciliation vs Part 8 due tracking
 *   9K.6:  Dashboard reconciliation vs Part 7 Dashboard
 *   9K.7:  Cross-report consistency
 *   9K.8:  Live HTTP API endpoints
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const initSqlJs = require('sql.js');

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

const { getDueOverdueSummary } = require('../services/dueTrackingService');
const { getDashboardSummary, getDueCollectionSummary } = require('../services/dashboardService');
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
    console.log('   INTEREST MANAGER — PART 9: REPORTS TEST SUITE');
    console.log('================================================================\n');

    const SQL = await initSqlJs();
    const TEST_TODAY = '2026-09-09';

    // ─── 9J.1 Common Report Validation ─────────────────────────
    await runTest('9J.1 Common report validation (valid/invalid types, 400 on bad type)', async () => {
        const db = await createFreshInMemoryDb(SQL);

        // Invalid report type throws 400
        assert.throws(() => {
            generateReport(db, { report_type: 'INVALID_TYPE' });
        }, (err) => err.statusCode === 400 && /invalid report type/i.test(err.message));

        // Invalid date range (start > end) throws 400
        assert.throws(() => {
            generateReport(db, {
                report_type: 'PAYMENTS',
                start_date: '2026-09-10',
                end_date: '2026-09-01'
            });
        }, (err) => err.statusCode === 400 && /start_date cannot be after end_date/i.test(err.message));
    });

    // ─── 9J.2 Loan Portfolio Report ────────────────────────────
    await runTest('9J.2 Loan portfolio report (loan count, principal, paid, balance reconciliation)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        // Loan A: ₹10,000
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);
        // Loan B: ₹20,000, Paid ₹5,000, Outstanding ₹15,000
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (2, 1, 'MONEY_GIVEN', 2000000, 1500000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 2, 1, 'PRINCIPAL_RECEIVED', 500000, '2026-08-10')`);
        // Loan C: ₹30,000
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (3, 1, 'MONEY_GIVEN', 3000000, 3000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);

        const report = generateLoanPortfolioReport(db);
        assert.strictEqual(report.report_type, REPORT_TYPES.LOAN_PORTFOLIO);
        assert.strictEqual(report.summary.total_loans, 3);
        assert.strictEqual(report.summary.total_principal, 60000.00);
        assert.strictEqual(report.summary.total_paid, 5000.00);
        assert.strictEqual(report.summary.outstanding_principal, 55000.00);
        assert.strictEqual(report.items.length, 3);
    });

    // ─── 9J.3 People Report ────────────────────────────────────
    await runTest('9J.3 People report (multi-loan customer aggregation)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111'), (2, 'Bob', '2222222222')");
        // Alice has 2 loans
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE'),
                       (2, 1, 'MONEY_GIVEN', 2000000, 2000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);
        // Bob has 1 loan
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (3, 2, 'MONEY_GIVEN', 5000000, 5000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);

        const report = generatePeopleReport(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(report.summary.total_people, 2);
        assert.strictEqual(report.summary.total_loans, 3);
        assert.strictEqual(report.summary.total_principal, 80000.00);

        const alice = report.items.find(p => p.person_id === 1);
        assert.strictEqual(alice.loan_count, 2);
        assert.strictEqual(alice.total_principal, 30000.00);

        const bob = report.items.find(p => p.person_id === 2);
        assert.strictEqual(bob.loan_count, 1);
        assert.strictEqual(bob.total_principal, 50000.00);
    });

    // ─── 9J.4 Payment Report ───────────────────────────────────
    await runTest('9J.4 Payment report (transaction count, payment amounts)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 5000000, 4000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);

        // 3 Payments: ₹5,000, ₹3,000, ₹2,000
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'PRINCIPAL_RECEIVED', 500000, '2026-08-05'),
                       (2, 1, 1, 'PRINCIPAL_RECEIVED', 300000, '2026-08-10'),
                       (3, 1, 1, 'INTEREST_RECEIVED', 200000, '2026-08-15')`);

        const report = generatePaymentReport(db);
        assert.strictEqual(report.summary.transaction_count, 3);
        assert.strictEqual(report.summary.total_amount, 10000.00);
        assert.strictEqual(report.summary.total_payment_amount, 10000.00);
        assert.strictEqual(report.items.length, 3);
    });

    // ─── 9J.5 Payment Date-Range Filtering ─────────────────────
    await runTest('9J.5 Payment date-range filtering (inclusive boundary behavior)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 5000000, 4000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);

        // Transactions: 2026-09-01, 2026-09-05, 2026-09-10
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'PRINCIPAL_RECEIVED', 100000, '2026-09-01'),
                       (2, 1, 1, 'PRINCIPAL_RECEIVED', 200000, '2026-09-05'),
                       (3, 1, 1, 'PRINCIPAL_RECEIVED', 300000, '2026-09-10')`);

        const report = generatePaymentReport(db, {
            start_date: '2026-09-01',
            end_date: '2026-09-05'
        });

        assert.strictEqual(report.summary.transaction_count, 2, 'Should only include 2 transactions');
        assert.strictEqual(report.summary.total_amount, 3000.00);
        const dates = report.items.map(t => t.transaction_date);
        assert(dates.includes('2026-09-01'));
        assert(dates.includes('2026-09-05'));
        assert(!dates.includes('2026-09-10'));
    });

    // ─── 9J.6 Interest Report ──────────────────────────────────
    await runTest('9J.6 Interest report (Part 6 integration, no recalculation)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);
        // Record 1: ₹98.63 accrued, ₹30.00 paid, ₹68.63 outstanding
        db.run(`INSERT INTO interest_records (id, account_id, period_start, period_end, principal_basis, interest_rate, interest_amount, paid_amount, status)
                VALUES (1, 1, '2026-08-01', '2026-08-31', 1000000, 12, 9863, 3000, 'PARTIALLY_PAID')`);
        // Record 2: Reversed (should be excluded by default)
        db.run(`INSERT INTO interest_records (id, account_id, period_start, period_end, principal_basis, interest_rate, interest_amount, paid_amount, status)
                VALUES (2, 1, '2026-08-01', '2026-08-31', 1000000, 12, 9863, 0, 'REVERSED')`);

        const report = generateInterestReport(db);
        assert.strictEqual(report.summary.interest_record_count, 1, 'Reversed records excluded');
        assert.strictEqual(report.summary.total_interest, 98.63);
        assert.strictEqual(report.summary.paid_interest, 30.00);
        assert.strictEqual(report.summary.outstanding_interest, 68.63);
    });

    // ─── 9J.7 Due / Overdue Report ─────────────────────────────
    await runTest('9J.7 Due / Overdue report (Part 8 integration)', async () => {
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

        const report = generateDueOverdueReport(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(report.summary.current_count, 1);
        assert.strictEqual(report.summary.due_count, 1);
        assert.strictEqual(report.summary.overdue_count, 1);
        assert.strictEqual(report.summary.due_amount, 20000.00);
        assert.strictEqual(report.summary.overdue_amount, 30000.00);
        assert.strictEqual(report.summary.collection_amount, 50000.00);
    });

    // ─── 9J.8 Collection Report ────────────────────────────────
    await runTest('9J.8 Collection priority report (overdue inclusion, ordering)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        // Loan A: Overdue ₹5,000 (due 2026-09-01)
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 500000, 500000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'ACTIVE', 0)`);
        // Loan B: Overdue ₹3,000 (due 2026-08-15, older)
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (2, 1, 'MONEY_GIVEN', 300000, 300000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-08-15', 'ACTIVE', 0)`);
        // Loan C: Current ₹10,000 (due 2026-09-25)
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (3, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-25', 'ACTIVE', 0)`);

        const report = generateCollectionReport(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(report.summary.collection_count, 2);
        assert.strictEqual(report.summary.total_collection_amount, 8000.00);

        // Verify oldest overdue appears first
        assert.strictEqual(report.items[0].loan_id, 2, 'Oldest due date (2026-08-15) must be first');
        assert.strictEqual(report.items[1].loan_id, 1);
    });

    // ─── 9J.9 Multiple Loans Per Person ────────────────────────
    await runTest('9J.9 Multiple loans per person (concurrent active, overdue, paid states)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        // Loan 1: Overdue
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'ACTIVE', 0)`);
        // Loan 2: Current
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (2, 1, 'MONEY_GIVEN', 2000000, 2000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-25', 'ACTIVE', 0)`);
        // Loan 3: Fully paid
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (3, 1, 'MONEY_GIVEN', 3000000, 0, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'ACTIVE', 0)`);

        const report = generateDueOverdueReport(db, { as_of_date: TEST_TODAY });
        assert.strictEqual(report.summary.overdue_count, 1);
        assert.strictEqual(report.summary.current_count, 1);
        assert.strictEqual(report.summary.paid_count, 1);
    });

    // ─── 9J.10 Authorization Scoping ───────────────────────────
    await runTest('9J.10 Authorization scoping (customer isolation across counts, totals, items)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111'), (2, 'Bob', '2222222222')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE'),
                       (2, 2, 'MONEY_GIVEN', 5000000, 5000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);

        const aliceReport = generateLoanPortfolioReport(db, { person_id: 1 });
        assert.strictEqual(aliceReport.summary.total_loans, 1);
        assert.strictEqual(aliceReport.summary.total_principal, 10000.00, 'Alice report must exclude Bob');
        assert.strictEqual(aliceReport.items.length, 1);
        assert.strictEqual(aliceReport.items[0].person_name, 'Alice');

        // Invalid person ID throws 404
        assert.throws(() => {
            generateLoanPortfolioReport(db, { person_id: 999 });
        }, /not found/i);
    });

    // ─── 9J.11 Pagination Test ─────────────────────────────────
    await runTest('9J.11 Pagination test (page_size, total_pages, no duplicates)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        // Create 25 loans
        for (let i = 1; i <= 25; i++) {
            db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                    VALUES (${i}, 1, 'MONEY_GIVEN', 100000, 100000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);
        }

        const page1 = generateLoanPortfolioReport(db, { page: 1, page_size: 10 });
        assert.strictEqual(page1.items.length, 10);
        assert.strictEqual(page1.pagination.total_records, 25);
        assert.strictEqual(page1.pagination.total_pages, 3);

        const page2 = generateLoanPortfolioReport(db, { page: 2, page_size: 10 });
        assert.strictEqual(page2.items.length, 10);

        const page3 = generateLoanPortfolioReport(db, { page: 3, page_size: 10 });
        assert.strictEqual(page3.items.length, 5);

        // Check for no duplicates across pages
        const page1Ids = page1.items.map(i => i.loan_id);
        const page2Ids = page2.items.map(i => i.loan_id);
        const overlap = page1Ids.filter(id => page2Ids.includes(id));
        assert.strictEqual(overlap.length, 0, 'Pages must not have overlapping records');
    });

    // ─── 9J.12 Monetary Precision ──────────────────────────────
    await runTest('9J.12 Monetary precision (integer paisa exactness)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        // ₹10.33 + ₹20.67 = ₹31.00 exactly without floating point artifacts
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1033, 1033, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE'),
                       (2, 1, 'MONEY_GIVEN', 2067, 2067, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);

        const report = generateLoanPortfolioReport(db);
        assert.strictEqual(report.summary.total_principal, 31.00);
        assert.strictEqual(report.summary.total_principal_paisa, 3100);
    });

    // ─── 9J.13 Empty Report ────────────────────────────────────
    await runTest('9J.13 Empty report handling (valid DTO, empty arrays, zero totals)', async () => {
        const db = await createFreshInMemoryDb(SQL);

        const report = generateLoanPortfolioReport(db);
        assert.strictEqual(report.items.length, 0);
        assert.strictEqual(report.summary.total_loans, 0);
        assert.strictEqual(report.summary.total_principal, 0);
        assert.strictEqual(report.pagination.total_records, 0);
        assert.strictEqual(report.pagination.total_pages, 0);
    });

    // ─── 9J.14 Read-Only Verification ──────────────────────────
    await runTest('9J.14 Read-Only verification (zero DB writes across all report services)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);

        const beforeAccounts = queryAll(db, 'SELECT * FROM accounts');
        const beforePeople = queryAll(db, 'SELECT * FROM people');

        generateLoanPortfolioReport(db);
        generatePeopleReport(db, { as_of_date: TEST_TODAY });
        generatePaymentReport(db);
        generateInterestReport(db);
        generateDueOverdueReport(db, { as_of_date: TEST_TODAY });
        generateCollectionReport(db, { as_of_date: TEST_TODAY });

        const afterAccounts = queryAll(db, 'SELECT * FROM accounts');
        const afterPeople = queryAll(db, 'SELECT * FROM people');

        assert.deepStrictEqual(beforeAccounts, afterAccounts, 'Accounts table must remain untouched');
        assert.deepStrictEqual(beforePeople, afterPeople, 'People table must remain untouched');
    });

    // ─── 9K.1 Loan Reconciliation ──────────────────────────────
    await runTest('9K.1 Loan reconciliation vs account balance services', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 700000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'PRINCIPAL_RECEIVED', 300000, '2026-08-10')`);
        db.run(`INSERT INTO interest_records (id, account_id, period_start, period_end, principal_basis, interest_rate, interest_amount, paid_amount, status)
                VALUES (1, 1, '2026-08-01', '2026-08-31', 1000000, 12, 10000, 2000, 'PARTIALLY_PAID')`);

        const report = generateLoanPortfolioReport(db);
        const item = report.items[0];

        assert.strictEqual(item.principal_amount, 10000.00);
        assert.strictEqual(item.paid_amount, 3000.00);
        assert.strictEqual(item.outstanding_principal, 7000.00);
        assert.strictEqual(item.interest_amount, 100.00);
        assert.strictEqual(item.outstanding_interest, 80.00);
        assert.strictEqual(item.total_outstanding, 7080.00);
    });

    // ─── 9K.5 & 9K.6 Dashboard & Due/Overdue Reconciliation ────
    await runTest('9K.5 & 9K.6 Dashboard & Due/Overdue reconciliation with Part 7 & Part 8', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        // Overdue loan
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'ACTIVE', 0)`);
        // Due loan
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (2, 1, 'MONEY_GIVEN', 2000000, 2000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-09', 'ACTIVE', 0)`);

        const part9Report = generateDueOverdueReport(db, { as_of_date: TEST_TODAY });
        const part8Summary = getDueOverdueSummary(db, { as_of_date: TEST_TODAY });
        const part7DueSummary = getDueCollectionSummary(db, { as_of_date: TEST_TODAY });
        const part7Dashboard = getDashboardSummary(db, { as_of_date: TEST_TODAY });

        assert.strictEqual(part9Report.summary.overdue_count, part8Summary.overdue_count, 'Overdue count must reconcile with Part 8');
        assert.strictEqual(part9Report.summary.overdue_amount, part8Summary.overdue_amount, 'Overdue amount must reconcile with Part 8');
        assert.strictEqual(part9Report.summary.due_count, part8Summary.due_count, 'Due count must reconcile with Part 8');
        assert.strictEqual(part9Report.summary.due_amount, part8Summary.due_amount, 'Due amount must reconcile with Part 8');

        assert.strictEqual(part9Report.summary.overdue_count, part7DueSummary.overdue_count, 'Overdue count must reconcile with Part 7 Due Summary');
        assert.strictEqual(part9Report.summary.total_count, part7Dashboard.total_accounts, 'Total accounts must reconcile with Part 7 Dashboard');
    });

    // ─── 9K.2 People Reconciliation ───────────────────────────
    await runTest('9K.2 People reconciliation vs authorized loans', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 800000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE'),
                       (2, 1, 'MONEY_GIVEN', 2000000, 1500000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);

        const peopleReport = generatePeopleReport(db, { as_of_date: TEST_TODAY });
        const alice = peopleReport.items.find(p => p.person_id === 1);

        const loans = queryAll(db, 'SELECT * FROM accounts WHERE person_id = 1');
        const expectedPrincipal = loans.reduce((sum, l) => sum + l.principal, 0) / 100;
        const expectedOutstanding = loans.reduce((sum, l) => sum + l.outstanding_principal, 0) / 100;

        assert.strictEqual(alice.loan_count, loans.length);
        assert.strictEqual(alice.total_principal, expectedPrincipal);
        assert.strictEqual(alice.total_outstanding, expectedOutstanding);
    });

    // ─── 9K.3 Payment Reconciliation ───────────────────────────
    await runTest('9K.3 Payment reconciliation vs Part 5 transactions', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 5000000, 3000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'PRINCIPAL_RECEIVED', 1000000, '2026-08-05'),
                       (2, 1, 1, 'PRINCIPAL_RECEIVED', 1000000, '2026-08-10')`);

        const paymentReport = generatePaymentReport(db);
        const txRows = queryAll(db, 'SELECT * FROM transactions WHERE transaction_type IN (\'PRINCIPAL_RECEIVED\', \'INTEREST_RECEIVED\', \'MONEY_RECEIVED\')');
        const expectedTotal = txRows.reduce((sum, t) => sum + t.amount, 0) / 100;

        assert.strictEqual(paymentReport.summary.transaction_count, txRows.length);
        assert.strictEqual(paymentReport.summary.total_payment_amount, expectedTotal);
    });

    // ─── 9K.4 Interest Reconciliation ──────────────────────────
    await runTest('9K.4 Interest reconciliation vs Part 6 interest records', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);
        db.run(`INSERT INTO interest_records (id, account_id, period_start, period_end, principal_basis, interest_rate, interest_amount, paid_amount, status)
                VALUES (1, 1, '2026-08-01', '2026-08-31', 1000000, 12, 12000, 4000, 'PARTIALLY_PAID'),
                       (2, 1, '2026-08-01', '2026-08-31', 1000000, 12, 5000, 0, 'REVERSED')`);

        const interestReport = generateInterestReport(db);
        const activeRecords = queryAll(db, 'SELECT * FROM interest_records WHERE status != \'REVERSED\'');
        const expectedTotal = activeRecords.reduce((sum, r) => sum + r.interest_amount, 0) / 100;
        const expectedPaid = activeRecords.reduce((sum, r) => sum + r.paid_amount, 0) / 100;

        assert.strictEqual(interestReport.summary.interest_record_count, activeRecords.length);
        assert.strictEqual(interestReport.summary.total_interest, expectedTotal);
        assert.strictEqual(interestReport.summary.paid_interest, expectedPaid);
        assert.strictEqual(interestReport.summary.outstanding_interest, expectedTotal - expectedPaid);
    });

    // ─── 9K.7 Cross-Report Consistency ─────────────────────────
    await runTest('9K.7 Cross-Report Consistency across all 6 reports and Dashboard', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '1111111111'), (2, 'Bob', '2222222222')");

        // Loan 1 (Alice): Overdue ₹10,000, Paid ₹2,000, Outstanding Principal ₹8,000, Interest ₹200 (Paid ₹50, Out ₹150)
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 800000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'ACTIVE', 0)`);
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'PRINCIPAL_RECEIVED', 200000, '2026-08-10'),
                       (2, 1, 1, 'INTEREST_RECEIVED', 5000, '2026-08-15')`);
        db.run(`INSERT INTO interest_records (id, account_id, period_start, period_end, principal_basis, interest_rate, interest_amount, paid_amount, status)
                VALUES (1, 1, '2026-08-01', '2026-09-01', 1000000, 12, 20000, 5000, 'PARTIALLY_PAID')`);

        // Loan 2 (Bob): Current ₹20,000 (due 2026-09-25)
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status, grace_period)
                VALUES (2, 2, 'MONEY_GIVEN', 2000000, 2000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-25', 'ACTIVE', 0)`);

        const loanReport = generateLoanPortfolioReport(db);
        const peopleReport = generatePeopleReport(db, { as_of_date: TEST_TODAY });
        const paymentReport = generatePaymentReport(db);
        const interestReport = generateInterestReport(db);
        const dueReport = generateDueOverdueReport(db, { as_of_date: TEST_TODAY });
        const collectionReport = generateCollectionReport(db, { as_of_date: TEST_TODAY });
        const dashboard = getDashboardSummary(db, { as_of_date: TEST_TODAY });

        // 1. Principal consistency
        assert.strictEqual(loanReport.summary.total_principal, peopleReport.summary.total_principal);
        assert.strictEqual(loanReport.summary.total_principal, dashboard.total_principal);

        // 2. Paid amount consistency
        assert.strictEqual(loanReport.summary.total_paid, peopleReport.summary.total_paid);
        assert.strictEqual(loanReport.summary.total_paid, paymentReport.summary.total_payment_amount);
        assert.strictEqual(loanReport.summary.total_paid, dashboard.total_paid);

        // 3. Outstanding principal consistency
        assert.strictEqual(loanReport.summary.outstanding_principal, dashboard.outstanding_principal);

        // 4. Interest consistency
        assert.strictEqual(loanReport.summary.total_interest, interestReport.summary.total_interest);
        assert.strictEqual(loanReport.summary.total_interest, dashboard.total_interest);
        assert.strictEqual(loanReport.summary.outstanding_interest, interestReport.summary.outstanding_interest);
        assert.strictEqual(loanReport.summary.outstanding_interest, dashboard.outstanding_interest);

        // 5. Due & Overdue consistency
        assert.strictEqual(dueReport.summary.overdue_amount, collectionReport.summary.total_collection_amount);
        assert.strictEqual(dueReport.summary.overdue_count, collectionReport.summary.collection_count);
        assert.strictEqual(dueReport.summary.overdue_count, 1);
        assert.strictEqual(dueReport.summary.overdue_amount, 8150.00); // ₹8,000 principal + ₹150 interest
    });

    // ─── 9K.8 Live HTTP API Endpoints ──────────────────────────
    await runTest('9K.8 Live HTTP API Endpoints (/reports/loans, /reports/people, /reports/payments, /reports/interest, /reports/due-overdue, /reports/collections, /reports/:type)', async () => {
        // GET /reports/loans
        const resLoans = await httpRequest('GET', '/reports/loans');
        assert.strictEqual(resLoans.statusCode, 200);
        assert(Array.isArray(resLoans.body.items));
        assert.strictEqual(resLoans.body.report_type, 'LOAN_PORTFOLIO');

        // GET /reports/people
        const resPeople = await httpRequest('GET', '/reports/people');
        assert.strictEqual(resPeople.statusCode, 200);
        assert(Array.isArray(resPeople.body.items));
        assert.strictEqual(resPeople.body.report_type, 'PEOPLE');

        // GET /reports/payments
        const resPayments = await httpRequest('GET', '/reports/payments');
        assert.strictEqual(resPayments.statusCode, 200);
        assert(Array.isArray(resPayments.body.items));
        assert.strictEqual(resPayments.body.report_type, 'PAYMENTS');

        // GET /reports/interest
        const resInterest = await httpRequest('GET', '/reports/interest');
        assert.strictEqual(resInterest.statusCode, 200);
        assert(Array.isArray(resInterest.body.items));
        assert.strictEqual(resInterest.body.report_type, 'INTEREST');

        // GET /reports/due-overdue
        const resDue = await httpRequest('GET', '/reports/due-overdue?as_of_date=2026-09-09');
        assert.strictEqual(resDue.statusCode, 200);
        assert(Array.isArray(resDue.body.items));
        assert.strictEqual(resDue.body.report_type, 'DUE_OVERDUE');

        // GET /reports/collections
        const resColl = await httpRequest('GET', '/reports/collections?as_of_date=2026-09-09');
        assert.strictEqual(resColl.statusCode, 200);
        assert(Array.isArray(resColl.body.items));
        assert.strictEqual(resColl.body.report_type, 'COLLECTION');

        // Parameterized endpoint GET /reports/LOAN_PORTFOLIO
        const resParam = await httpRequest('GET', '/reports/LOAN_PORTFOLIO');
        assert.strictEqual(resParam.statusCode, 200);
        assert.strictEqual(resParam.body.report_type, 'LOAN_PORTFOLIO');

        // Unified endpoint GET /reports?type=payments
        const resUnified = await httpRequest('GET', '/reports?type=payments');
        assert.strictEqual(resUnified.statusCode, 200);
        assert.strictEqual(resUnified.body.report_type, 'PAYMENTS');
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
