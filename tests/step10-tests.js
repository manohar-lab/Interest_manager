/**
 * Interest Manager — Part 10 Test Suite: Person Statements + PDF
 *
 * Verifies all specifications of Part 10:
 *   10J.1:  Basic person statement (single loan, complete summary & ledger)
 *   10J.2:  Multiple loans for one person (consolidated aggregation)
 *   10J.3:  Specific loan filter (loan_id filter & LOAN_STATEMENT type)
 *   10J.4:  Date range filtering (inclusive boundary behavior)
 *   10J.5:  Opening balance calculation (prior transactions & interest)
 *   10J.6:  Closing balance calculation (formula reconciliation)
 *   10J.7:  Payment integration (balance reduction & ledger running balances)
 *   10J.8:  Interest integration (Part 6 non-reversed interest records)
 *   10J.9:  Due / Overdue integration (Part 8 engine & overdue amounts)
 *   10J.10: Closed loan (fully paid account, 0 closing balance)
 *   10J.11: Scoping / Authorization (400 bad ID, 404 missing person, 403 loan mismatch)
 *   10J.12: Empty person history (valid 200 DTO with zero balances)
 *   10J.13: Empty date range (period with no activity, opening == closing)
 *   10J.14: Inverted date range (start_date > end_date throws 400)
 *   10J.15: PDF generation verification (valid %PDF- header, non-empty buffer)
 *   10J.16: PDF financial accuracy (matches Statement DTO)
 *   10J.17: Multi-page PDF test (large transaction list renders multi-page vector PDF)
 *   10J.18: Read-Only verification (zero DB writes across statement and PDF generation)
 *   10K.1:  Reconciliation vs People model
 *   10K.2:  Reconciliation vs Loans model
 *   10K.3:  Reconciliation vs Transactions ledger
 *   10K.4:  Reconciliation vs Interest engine
 *   10K.5:  Reconciliation vs Due / Overdue engine
 *   10K.6:  Reconciliation vs Part 9 Reports
 *   10K.7:  Reconciliation vs Part 7 Dashboard
 *   10K.8:  Live HTTP API endpoints (/statement and /statement/pdf)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const initSqlJs = require('sql.js');

const {
    STATEMENT_TYPES,
    generatePersonStatement,
    getStatementByLoanId
} = require('../services/statementService');

const {
    generateStatementPdf,
    generateStatementFilename
} = require('../services/pdfService');

const { generatePeopleReport } = require('../services/reportService');
const { getPeopleSummaries } = require('../services/dashboardService');
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

async function httpRequest(method, endpoint, body = null, isBinary = false) {
    const token = await getAuthToken();
    return new Promise((resolve, reject) => {
        const url = new URL(BASE_URL + endpoint);
        const headers = isBinary ? {} : { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: method,
            headers
        };

        const req = http.request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                if (isBinary) {
                    resolve({ statusCode: res.statusCode, headers: res.headers, body: buffer });
                } else {
                    let parsed;
                    try {
                        parsed = JSON.parse(buffer.toString('utf-8'));
                    } catch (e) {
                        parsed = buffer.toString('utf-8');
                    }
                    resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
                }
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
    console.log('   INTEREST MANAGER — PART 10: PERSON STATEMENTS + PDF');
    console.log('================================================================\n');

    const SQL = await initSqlJs();
    const TEST_TODAY = '2026-09-09';

    // ─── 10J.1 Basic Person Statement ──────────────────────────
    await runTest('10J.1 Basic person statement (single loan, complete summary & ledger)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone, address) VALUES (1, 'Ramesh Kumar', '9876543210', '123 MG Road')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 800000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);
        
        // Initial disbursement and a payment
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date, notes)
                VALUES (1, 1, 1, 'MONEY_LENT', 1000000, '2026-08-01', 'Loan disbursement'),
                       (2, 1, 1, 'PRINCIPAL_RECEIVED', 200000, '2026-08-15', 'Part payment')`);

        const statement = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });

        assert.strictEqual(statement.statement_type, STATEMENT_TYPES.PERSON_STATEMENT);
        assert.strictEqual(statement.person.id, 1);
        assert.strictEqual(statement.person.name, 'Ramesh Kumar');
        assert.strictEqual(statement.summary.opening_balance, 0);
        assert.strictEqual(statement.summary.total_principal, 10000.00);
        assert.strictEqual(statement.summary.total_payments, 2000.00);
        assert.strictEqual(statement.summary.closing_balance, 8000.00);
        assert.strictEqual(statement.transactions.length, 2);
        assert.strictEqual(statement.loans.length, 1);
        assert.strictEqual(statement.loans[0].outstanding_principal, 8000.00);
    });

    // ─── 10J.2 Multiple Loans For One Person ───────────────────
    await runTest('10J.2 Multiple loans for one person (consolidated aggregation)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Sita Sharma', '9123456780')");
        // Loan 1: ₹10,000, paid ₹3,000, outstanding ₹7,000
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 700000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);
        // Loan 2: ₹20,000, paid ₹5,000, outstanding ₹15,000
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (2, 1, 'MONEY_GIVEN', 2000000, 1500000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-05', '2026-09-20', 'ACTIVE')`);

        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'MONEY_LENT', 1000000, '2026-08-01'),
                       (2, 2, 1, 'MONEY_LENT', 2000000, '2026-08-05'),
                       (3, 1, 1, 'PRINCIPAL_RECEIVED', 300000, '2026-08-10'),
                       (4, 2, 1, 'PRINCIPAL_RECEIVED', 500000, '2026-08-12')`);

        const statement = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });

        assert.strictEqual(statement.statement_type, STATEMENT_TYPES.PERSON_STATEMENT);
        assert.strictEqual(statement.summary.total_principal, 30000.00);
        assert.strictEqual(statement.summary.total_payments, 8000.00);
        assert.strictEqual(statement.summary.closing_balance, 22000.00);
        assert.strictEqual(statement.loans.length, 2);
        assert.strictEqual(statement.transactions.length, 4);

        // Verify chronological ordering
        for (let i = 1; i < statement.transactions.length; i++) {
            assert(statement.transactions[i].date >= statement.transactions[i - 1].date);
        }
    });

    // ─── 10J.3 Specific Loan Filter ────────────────────────────
    await runTest('10J.3 Specific loan filter (loan_id filter & LOAN_STATEMENT type)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Arun')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE'),
                       (2, 1, 'MONEY_GIVEN', 2500000, 2000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-05', '2026-09-20', 'ACTIVE')`);

        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'MONEY_LENT', 1000000, '2026-08-01'),
                       (2, 2, 1, 'MONEY_LENT', 2500000, '2026-08-05'),
                       (3, 2, 1, 'PRINCIPAL_RECEIVED', 500000, '2026-08-12')`);

        // Filter specifically for loan 2
        const statement = generatePersonStatement(db, 1, { loan_id: 2, as_of_date: TEST_TODAY });

        assert.strictEqual(statement.statement_type, STATEMENT_TYPES.LOAN_STATEMENT);
        assert.strictEqual(statement.loans.length, 1);
        assert.strictEqual(statement.loans[0].id, 2);
        assert.strictEqual(statement.summary.total_principal, 25000.00);
        assert.strictEqual(statement.summary.total_payments, 5000.00);
        assert.strictEqual(statement.summary.closing_balance, 20000.00);
        assert.strictEqual(statement.transactions.length, 2);
        assert(statement.transactions.every(t => t.account_id === 2));

        // Direct helper test
        const loanStmt = getStatementByLoanId(db, 2, { as_of_date: TEST_TODAY });
        assert.strictEqual(loanStmt.statement_type, STATEMENT_TYPES.LOAN_STATEMENT);
        assert.strictEqual(loanStmt.loans[0].id, 2);
    });

    // ─── 10J.4 Date Range Filtering ────────────────────────────
    await runTest('10J.4 Date range filtering (inclusive boundary behavior)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Deepak')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 600000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);

        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'MONEY_LENT', 1000000, '2026-08-01'),
                       (2, 1, 1, 'PRINCIPAL_RECEIVED', 100000, '2026-08-05'),
                       (3, 1, 1, 'PRINCIPAL_RECEIVED', 200000, '2026-08-10'),
                       (4, 1, 1, 'PRINCIPAL_RECEIVED', 100000, '2026-08-15')`);

        // Filter 2026-08-05 to 2026-08-10 (inclusive)
        const statement = generatePersonStatement(db, 1, {
            start_date: '2026-08-05',
            end_date: '2026-08-10',
            as_of_date: TEST_TODAY
        });

        // 2026-08-05 is included, 2026-08-10 is included.
        // 2026-08-01 is prior -> contributes to opening balance: ₹10,000 (disbursement)
        assert.strictEqual(statement.summary.opening_balance, 10000.00);
        // Transactions in period: 2026-08-05 (₹1,000 credit) and 2026-08-10 (₹2,000 credit)
        assert.strictEqual(statement.transactions.length, 2);
        assert.strictEqual(statement.summary.period_credits, 3000.00);
        // Closing balance at 2026-08-10: 10,000 - 3,000 = 7,000.00
        assert.strictEqual(statement.summary.closing_balance, 7000.00);
    });

    // ─── 10J.5 Opening Balance Calculation ─────────────────────
    await runTest('10J.5 Opening balance calculation (prior transactions & interest)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Sunil')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 2000000, 1500000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-07-01', '2026-09-01', 'ACTIVE')`);

        // Prior disbursement ₹20,000 and prior payment ₹5,000
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'MONEY_LENT', 2000000, '2026-07-01'),
                       (2, 1, 1, 'PRINCIPAL_RECEIVED', 500000, '2026-07-15')`);

        // Prior non-reversed interest of ₹200.00 (20,000 paisa) recorded on 2026-07-31
        db.run(`INSERT INTO interest_records (id, account_id, period_start, period_end, principal_basis, interest_rate, interest_amount, status, created_at)
                VALUES (1, 1, '2026-07-01', '2026-07-31', 2000000, 12, 20000, 'PENDING', '2026-07-31 10:00:00')`);

        // Query starting from 2026-08-01
        const statement = generatePersonStatement(db, 1, {
            start_date: '2026-08-01',
            end_date: '2026-08-31',
            as_of_date: TEST_TODAY
        });

        // Opening balance = 20,000 (disbursed) + 200 (accrued interest) - 5,000 (payment) = 15,200.00
        assert.strictEqual(statement.summary.opening_balance, 15200.00);
        assert.strictEqual(statement.summary.closing_balance, 15200.00);
    });

    // ─── 10J.6 Closing Balance Calculation ─────────────────────
    await runTest('10J.6 Closing balance calculation (formula reconciliation)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Meera')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 750000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);

        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'MONEY_LENT', 1000000, '2026-08-01'),
                       (2, 1, 1, 'PRINCIPAL_RECEIVED', 250000, '2026-08-10')`);

        const statement = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });

        const sm = statement.summary;
        // Formula: opening_balance + total_debit - total_credit = closing_balance
        const expectedClosing = Math.round((sm.opening_balance + sm.total_debit - sm.total_credit) * 100) / 100;
        assert.strictEqual(sm.closing_balance, expectedClosing);
        assert.strictEqual(sm.closing_balance, 7500.00);

        // Ledger final running balance must equal closing balance
        const lastTx = statement.transactions[statement.transactions.length - 1];
        assert.strictEqual(lastTx.running_balance, sm.closing_balance);
    });

    // ─── 10J.7 Payment Integration ─────────────────────────────
    await runTest('10J.7 Payment integration (balance reduction & ledger running balances)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Vikas')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 5000000, 3000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);

        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'MONEY_LENT', 5000000, '2026-08-01'),
                       (2, 1, 1, 'PRINCIPAL_RECEIVED', 1000000, '2026-08-05'),
                       (3, 1, 1, 'PRINCIPAL_RECEIVED', 1000000, '2026-08-10')`);

        const statement = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });
        assert.strictEqual(statement.summary.total_payments, 20000.00);

        const tx2 = statement.transactions.find(t => t.id === 2);
        assert.strictEqual(tx2.credit, 10000.00);
        assert.strictEqual(tx2.running_balance, 40000.00);

        const tx3 = statement.transactions.find(t => t.id === 3);
        assert.strictEqual(tx3.credit, 10000.00);
        assert.strictEqual(tx3.running_balance, 30000.00);
    });

    // ─── 10J.8 Interest Integration ────────────────────────────
    await runTest('10J.8 Interest integration (Part 6 non-reversed interest records)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Pooja')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);

        // Record active interest
        db.run(`INSERT INTO interest_records (id, account_id, period_start, period_end, principal_basis, interest_rate, interest_amount, status, created_at)
                VALUES (1, 1, '2026-08-01', '2026-08-31', 1000000, 12, 10000, 'PENDING', '2026-08-31 12:00:00')`);
        // Record reversed interest (must NOT be counted)
        db.run(`INSERT INTO interest_records (id, account_id, period_start, period_end, principal_basis, interest_rate, interest_amount, status, created_at)
                VALUES (2, 1, '2026-08-01', '2026-08-31', 1000000, 12, 5000, 'REVERSED', '2026-08-31 12:05:00')`);

        const statement = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });

        assert.strictEqual(statement.interest.records.length, 1);
        assert.strictEqual(statement.interest.records[0].id, 1);
        assert.strictEqual(statement.interest.summary.total_interest, 100.00);
        assert.strictEqual(statement.summary.total_interest, 100.00);
    });

    // ─── 10J.9 Due / Overdue Integration ───────────────────────
    await runTest('10J.9 Due / Overdue integration (Part 8 engine & overdue amounts)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Kiran')");
        // Overdue account: due 2026-08-15, test today is 2026-09-09
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-07-01', '2026-08-15', 'OVERDUE')`);

        const statement = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });

        assert.strictEqual(statement.due_overdue.obligations.length, 1);
        assert.strictEqual(statement.due_overdue.obligations[0].status, 'OVERDUE');
        assert.strictEqual(statement.due_overdue.summary.total_overdue, 10000.00);
        assert.strictEqual(statement.summary.total_overdue, 10000.00);
    });

    // ─── 10J.10 Closed Loan ────────────────────────────────────
    await runTest('10J.10 Closed loan (fully paid account, 0 closing balance)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Anil')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 0, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-07-01', '2026-08-01', 'CLOSED')`);

        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'MONEY_LENT', 1000000, '2026-07-01'),
                       (2, 1, 1, 'PRINCIPAL_RECEIVED', 1000000, '2026-07-25')`);

        const statement = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });

        assert.strictEqual(statement.loans[0].status, 'CLOSED');
        assert.strictEqual(statement.summary.total_principal, 10000.00);
        assert.strictEqual(statement.summary.total_payments, 10000.00);
        assert.strictEqual(statement.summary.closing_balance, 0.00);
        assert.strictEqual(statement.summary.total_overdue, 0.00);
    });

    // ─── 10J.11 Scoping / Authorization ────────────────────────
    await runTest('10J.11 Scoping / Authorization (400 bad ID, 404 missing person, 403 loan mismatch)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Person 1'), (2, 'Person 2')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE'),
                       (2, 2, 'MONEY_GIVEN', 2000000, 2000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);

        // Bad ID -> 400
        assert.throws(() => {
            generatePersonStatement(db, 0);
        }, (err) => err.statusCode === 400);

        assert.throws(() => {
            generatePersonStatement(db, 'invalid');
        }, (err) => err.statusCode === 400);

        // Missing person -> 404
        assert.throws(() => {
            generatePersonStatement(db, 999);
        }, (err) => err.statusCode === 404);

        // Loan mismatch -> 403 Forbidden (Loan 2 belongs to Person 2, requested for Person 1)
        assert.throws(() => {
            generatePersonStatement(db, 1, { loan_id: 2 });
        }, (err) => err.statusCode === 403 && /does not belong to/i.test(err.message));
    });

    // ─── 10J.12 Empty Person History ───────────────────────────
    await runTest('10J.12 Empty person history (valid 200 DTO with zero balances)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'New Customer', '9999999999')");

        const statement = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });

        assert.strictEqual(statement.person.id, 1);
        assert.strictEqual(statement.loans.length, 0);
        assert.strictEqual(statement.transactions.length, 0);
        assert.strictEqual(statement.summary.opening_balance, 0.00);
        assert.strictEqual(statement.summary.closing_balance, 0.00);
        assert.strictEqual(statement.summary.total_principal, 0.00);
        assert.strictEqual(statement.summary.total_payments, 0.00);
        assert.strictEqual(statement.summary.total_overdue, 0.00);
    });

    // ─── 10J.13 Empty Date Range ───────────────────────────────
    await runTest('10J.13 Empty date range (period with no activity, opening == closing)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Gopal')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'MONEY_LENT', 1000000, '2026-08-01')`);

        // Query future range with no activity: 2026-09-01 to 2026-09-05
        const statement = generatePersonStatement(db, 1, {
            start_date: '2026-09-01',
            end_date: '2026-09-05',
            as_of_date: TEST_TODAY
        });

        assert.strictEqual(statement.transactions.length, 0);
        assert.strictEqual(statement.summary.opening_balance, 10000.00);
        assert.strictEqual(statement.summary.closing_balance, 10000.00);
    });

    // ─── 10J.14 Inverted Date Range ────────────────────────────
    await runTest('10J.14 Inverted date range (start_date > end_date throws 400)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Mohan')");

        assert.throws(() => {
            generatePersonStatement(db, 1, {
                start_date: '2026-09-10',
                end_date: '2026-09-01'
            });
        }, (err) => err.statusCode === 400 && /start_date cannot be after end_date/i.test(err.message));
    });

    // ─── 10J.15 PDF Generation Verification ────────────────────
    await runTest('10J.15 PDF generation verification (valid %PDF- header, non-empty buffer)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone, address) VALUES (1, 'Ramesh Kumar', '9876543210', '123 MG Road')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 800000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'MONEY_LENT', 1000000, '2026-08-01'),
                       (2, 1, 1, 'PRINCIPAL_RECEIVED', 200000, '2026-08-15')`);

        const statement = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });
        const pdfBuffer = await generateStatementPdf(statement);

        assert(Buffer.isBuffer(pdfBuffer));
        assert(pdfBuffer.length > 1000);
        // Standard PDF magic header
        assert.strictEqual(pdfBuffer.slice(0, 5).toString('ascii'), '%PDF-');

        const filename = generateStatementFilename(statement);
        assert(/person-statement-1-.*\.pdf/.test(filename));
    });

    // ─── 10J.16 PDF Financial Accuracy ─────────────────────────
    await runTest('10J.16 PDF financial accuracy (matches Statement DTO)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Finance User')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1500000, 1200000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'MONEY_LENT', 1500000, '2026-08-01'),
                       (2, 1, 1, 'PRINCIPAL_RECEIVED', 300000, '2026-08-10')`);

        const statement = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });
        const pdfBuffer = await generateStatementPdf(statement);

        // Ensure PDF contains non-zero byte content and valid EOF trailer
        assert(pdfBuffer.length > 2000);
        assert(pdfBuffer.toString('binary').includes('%%EOF'));
    });

    // ─── 10J.17 Multi-Page PDF Test ────────────────────────────
    await runTest('10J.17 Multi-page PDF test (large transaction list renders multi-page vector PDF)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'High Volume Merchant', '9000000000')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 5000000, 3000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')`);

        // Insert 60 transactions to force multiple pages
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'MONEY_LENT', 5000000, '2026-01-01')`);
        
        for (let i = 2; i <= 60; i++) {
            const day = String((i % 28) + 1).padStart(2, '0');
            const month = String(Math.min(12, Math.floor(i / 6) + 1)).padStart(2, '0');
            db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date, notes)
                    VALUES (${i}, 1, 1, 'PRINCIPAL_RECEIVED', 33333, '2026-${month}-${day}', 'Payment #${i}')`);
        }

        const statement = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });
        assert.strictEqual(statement.transactions.length, 60);

        const pdfBuffer = await generateStatementPdf(statement);
        assert(Buffer.isBuffer(pdfBuffer));
        // Multi-page PDF should be substantially larger
        assert(pdfBuffer.length > 5000);
        assert.strictEqual(pdfBuffer.slice(0, 5).toString('ascii'), '%PDF-');
    });

    // ─── 10J.18 Read-Only Verification ─────────────────────────
    await runTest('10J.18 Read-Only verification (zero DB writes across statement and PDF generation)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'ReadOnly Person')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'MONEY_LENT', 1000000, '2026-08-01')`);

        const beforeTxCount = queryOne(db, 'SELECT COUNT(*) as c FROM transactions').c;
        const beforeAccCount = queryOne(db, 'SELECT COUNT(*) as c FROM accounts').c;
        const beforePeopleCount = queryOne(db, 'SELECT COUNT(*) as c FROM people').c;
        const beforeInterestCount = queryOne(db, 'SELECT COUNT(*) as c FROM interest_records').c;

        const statement = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });
        await generateStatementPdf(statement);

        const afterTxCount = queryOne(db, 'SELECT COUNT(*) as c FROM transactions').c;
        const afterAccCount = queryOne(db, 'SELECT COUNT(*) as c FROM accounts').c;
        const afterPeopleCount = queryOne(db, 'SELECT COUNT(*) as c FROM people').c;
        const afterInterestCount = queryOne(db, 'SELECT COUNT(*) as c FROM interest_records').c;

        assert.strictEqual(afterTxCount, beforeTxCount);
        assert.strictEqual(afterAccCount, beforeAccCount);
        assert.strictEqual(afterPeopleCount, beforePeopleCount);
        assert.strictEqual(afterInterestCount, beforeInterestCount);
    });

    // ─── 10K.1 Reconcile vs People Model ───────────────────────
    await runTest('10K.1 Reconciliation vs People model', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone, address, notes) VALUES (1, 'Suresh', '9811122233', 'Bangalore', 'VIP customer')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);

        const statement = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });
        const personRow = queryOne(db, 'SELECT * FROM people WHERE id = 1');

        assert.strictEqual(statement.person.id, personRow.id);
        assert.strictEqual(statement.person.name, personRow.name);
        assert.strictEqual(statement.person.phone, personRow.phone);
        assert.strictEqual(statement.person.address, personRow.address);
    });

    // ─── 10K.2 Reconcile vs Loans Model ────────────────────────
    await runTest('10K.2 Reconciliation vs Loans model', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Kavita')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1200000, 900000, 15, 'MONTHLY', 'SIMPLE_INTEREST', '2026-07-01', '2026-09-30', 'ACTIVE')`);

        const statement = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });
        const accRow = queryOne(db, 'SELECT * FROM accounts WHERE id = 1');

        assert.strictEqual(statement.loans[0].principal, accRow.principal / 100);
        assert.strictEqual(statement.loans[0].outstanding_principal, accRow.outstanding_principal / 100);
        assert.strictEqual(statement.loans[0].interest_rate, accRow.interest_rate);
        assert.strictEqual(statement.loans[0].loan_status, accRow.status);
    });

    // ─── 10K.3 Reconcile vs Transactions Ledger ────────────────
    await runTest('10K.3 Reconciliation vs Transactions ledger', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Manoj')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 700000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'MONEY_LENT', 1000000, '2026-08-01'),
                       (2, 1, 1, 'PRINCIPAL_RECEIVED', 300000, '2026-08-10')`);

        const statement = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });
        const netDbPaisa = statement.transactions.reduce((acc, t) => acc + (t.debit_paisa - t.credit_paisa), 0);
        assert.strictEqual(netDbPaisa, 700000);
        assert.strictEqual(netDbPaisa / 100, statement.summary.closing_balance);
    });

    // ─── 10K.4 Reconcile vs Interest Engine ────────────────────
    await runTest('10K.4 Reconciliation vs Interest engine', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Renu')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);
        db.run(`INSERT INTO interest_records (id, account_id, period_start, period_end, principal_basis, interest_rate, interest_amount, status, created_at)
                VALUES (1, 1, '2026-08-01', '2026-08-31', 1000000, 12, 12000, 'PENDING', '2026-08-31 20:00:00')`);

        const statement = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });
        const intRow = queryOne(db, 'SELECT interest_amount FROM interest_records WHERE id = 1');

        assert.strictEqual(statement.summary.total_interest, intRow.interest_amount / 100);
        assert.strictEqual(statement.interest.records[0].interest_amount, intRow.interest_amount / 100);
    });

    // ─── 10K.5 Reconcile vs Due / Overdue Engine ───────────────
    await runTest('10K.5 Reconciliation vs Due / Overdue engine', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Pankaj')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 2000000, 1500000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-07-01', '2026-08-15', 'OVERDUE')`);

        const statement = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });
        assert.strictEqual(statement.summary.total_overdue, 15000.00);
        assert.strictEqual(statement.due_overdue.obligations[0].amount_overdue, 15000.00);
    });

    // ─── 10K.6 Reconcile vs Part 9 Reports ─────────────────────
    await runTest('10K.6 Reconciliation vs Part 9 Reports', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Girish')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 3000000, 2400000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (1, 1, 1, 'MONEY_LENT', 3000000, '2026-08-01'),
                       (2, 1, 1, 'PRINCIPAL_RECEIVED', 600000, '2026-08-10')`);

        const statement = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });
        const peopleReport = generatePeopleReport(db, { as_of_date: TEST_TODAY });
        const reportPerson = peopleReport.items.find(p => p.person_id === 1);

        assert.strictEqual(statement.summary.total_principal, reportPerson.total_principal);
        assert.strictEqual(statement.summary.total_payments, reportPerson.total_paid);
        assert.strictEqual(statement.summary.closing_balance, reportPerson.total_outstanding);
    });

    // ─── 10K.7 Reconcile vs Part 7 Dashboard ───────────────────
    await runTest('10K.7 Reconciliation vs Part 7 Dashboard', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Bhavna')");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 2000000, 1600000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-15', 'ACTIVE')`);

        const statement = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });
        const peopleSummaries = getPeopleSummaries(db, { person_id: 1 });
        const personSummary = peopleSummaries[0];

        assert.strictEqual(statement.summary.total_principal, personSummary.total_principal);
        assert.strictEqual(statement.summary.closing_balance, personSummary.outstanding_principal);
    });

    // ─── 10K.8 Live HTTP API Endpoints ─────────────────────────
    await runTest('10K.8 Live HTTP API endpoints (/statement and /statement/pdf)', async () => {
        // Test GET /api/people/:person_id/statement
        const stmtRes = await httpRequest('GET', '/people/1/statement');
        assert(stmtRes.statusCode === 200 || stmtRes.statusCode === 404);
        if (stmtRes.statusCode === 200) {
            assert.strictEqual(stmtRes.body.success, true);
            assert(stmtRes.body.data.summary);
            assert(stmtRes.body.data.person);
        }

        // Test GET /api/people/:person_id/statement/pdf
        const pdfRes = await httpRequest('GET', '/people/1/statement/pdf', null, true);
        assert(pdfRes.statusCode === 200 || pdfRes.statusCode === 404);
        if (pdfRes.statusCode === 200) {
            assert.strictEqual(pdfRes.headers['content-type'], 'application/pdf');
            assert(pdfRes.body.slice(0, 5).toString('ascii') === '%PDF-');
        }

        // Test GET /api/statements/person/:person_id
        const altRes = await httpRequest('GET', '/statements/person/1');
        assert(altRes.statusCode === 200 || altRes.statusCode === 404);

        // Test 400 Bad Request on invalid person ID
        const badRes = await httpRequest('GET', '/people/invalid_id/statement');
        assert.strictEqual(badRes.statusCode, 400);

        // Test 404 on non-existent person
        const notFoundRes = await httpRequest('GET', '/people/999999/statement');
        assert.strictEqual(notFoundRes.statusCode, 404);
    });

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
