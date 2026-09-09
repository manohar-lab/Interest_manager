/**
 * Interest Manager — Step 7A Test Suite
 * Dashboard Architecture + KPI Data Contract
 *
 * Verifies:
 *   Test 1: Empty system — all counts = 0, all monetary totals = 0
 *   Test 2: One person, one loan — total_people = 1, total_loans = 1, values from actual loan
 *   Test 3: Multiple loans — total_loans, active_loans, closed_loans correct
 *   Test 4: Payments — total_paid reflects actual payment data
 *   Test 5: Interest — total_interest, outstanding_interest use actual interest records
 *   Test 6: Principal — matches authoritative account balance service
 *   Test 7: Authorization — person_id scoping enforces isolation; 400/404 on invalid
 *   Test 8: Read-only verification — dashboard never modifies database
 *   Test 9: DTO Contract verification — all required fields present
 *   Test 10: HTTP API integration — live GET /api/dashboard/summary endpoint
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const initSqlJs = require('sql.js');

const { getDashboardSummary } = require('../services/dashboardService');
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

    // Load project schema
    const schemaSql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf-8');
    db.run(schemaSql);

    return db;
}

async function runAll() {
    console.log('\n================================================================');
    console.log('   INTEREST MANAGER — STEP 7A: DASHBOARD ARCHITECTURE & KPIs');
    console.log('================================================================\n');

    const SQL = await initSqlJs();

    // ─── Test 1: Empty system ─────────────────────────────────
    console.log('--- Test 1: Empty System ---');
    await runTest('Test 1 — Empty system returns all counts = 0 and all monetary totals = 0', async () => {
        const db = await createFreshInMemoryDb(SQL);
        const d = getDashboardSummary(db);

        // Counts must be 0
        assert.strictEqual(d.total_people, 0, 'total_people must be 0');
        assert.strictEqual(d.total_loans, 0, 'total_loans must be 0');
        assert.strictEqual(d.total_accounts, 0, 'total_accounts must be 0');
        assert.strictEqual(d.active_loans, 0, 'active_loans must be 0');
        assert.strictEqual(d.active_accounts, 0, 'active_accounts must be 0');
        assert.strictEqual(d.closed_loans, 0, 'closed_loans must be 0');
        assert.strictEqual(d.closed_accounts, 0, 'closed_accounts must be 0');

        // Monetary values must be 0 (not null, not undefined)
        assert.strictEqual(d.total_principal, 0, 'total_principal must be 0');
        assert.strictEqual(d.total_principal_paisa, 0, 'total_principal_paisa must be 0');
        assert.strictEqual(d.outstanding_principal, 0, 'outstanding_principal must be 0');
        assert.strictEqual(d.outstanding_principal_paisa, 0, 'outstanding_principal_paisa must be 0');
        assert.strictEqual(d.total_interest, 0, 'total_interest must be 0');
        assert.strictEqual(d.total_interest_paisa, 0, 'total_interest_paisa must be 0');
        assert.strictEqual(d.outstanding_interest, 0, 'outstanding_interest must be 0');
        assert.strictEqual(d.outstanding_interest_paisa, 0, 'outstanding_interest_paisa must be 0');
        assert.strictEqual(d.total_paid, 0, 'total_paid must be 0');
        assert.strictEqual(d.total_paid_paisa, 0, 'total_paid_paisa must be 0');

        // Metadata
        assert.ok(d.generated_at, 'generated_at timestamp must be present');
    });

    // ─── Test 2: One person, one loan ─────────────────────────
    console.log('\n--- Test 2: One Person, One Loan ---');
    let db2;
    let person1Id, account1Id;
    await runTest('Test 2 — One person, one loan reflects exact counts and loan values', async () => {
        db2 = await createFreshInMemoryDb(SQL);

        // Insert 1 person
        db2.run("INSERT INTO people (name, phone) VALUES ('Alice Sharma', '9876543210')");
        person1Id = queryOne(db2, 'SELECT last_insert_rowid() as id').id;

        // Insert 1 loan (principal = ₹5,000 = 500000 paisa)
        db2.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 500000, 500000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-07-01', 'ACTIVE')
        `, [person1Id]);
        account1Id = queryOne(db2, 'SELECT last_insert_rowid() as id').id;

        const d = getDashboardSummary(db2);

        assert.strictEqual(d.total_people, 1, 'total_people must be 1');
        assert.strictEqual(d.total_loans, 1, 'total_loans must be 1');
        assert.strictEqual(d.total_accounts, 1, 'total_accounts must be 1');
        assert.strictEqual(d.active_loans, 1, 'active_loans must be 1');
        assert.strictEqual(d.closed_loans, 0, 'closed_loans must be 0');
        assert.strictEqual(d.total_principal, 5000, 'total_principal must be ₹5,000');
        assert.strictEqual(d.total_principal_paisa, 500000, 'total_principal_paisa must be 500000');
        assert.strictEqual(d.outstanding_principal, 5000, 'outstanding_principal must be ₹5,000');
        assert.strictEqual(d.outstanding_principal_paisa, 500000, 'outstanding_principal_paisa must be 500000');
        assert.strictEqual(d.total_interest, 0, 'total_interest must be 0 initially');
        assert.strictEqual(d.total_paid, 0, 'total_paid must be 0 initially');
    });

    // ─── Test 3: Multiple loans ───────────────────────────────
    console.log('\n--- Test 3: Multiple Loans ---');
    let person2Id, account2Id, account3Id;
    await runTest('Test 3 — Multiple loans correctly compute total_loans, active_loans, and closed_loans', async () => {
        // Insert person 2
        db2.run("INSERT INTO people (name, phone) VALUES ('Bob Verma', '9876543211')");
        person2Id = queryOne(db2, 'SELECT last_insert_rowid() as id').id;

        // Insert loan 2 for Bob (Active, ₹10,000 = 1000000 paisa)
        db2.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 1000000, 1000000, 15.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-02-01', '2026-08-01', 'ACTIVE')
        `, [person2Id]);
        account2Id = queryOne(db2, 'SELECT last_insert_rowid() as id').id;

        // Insert loan 3 for Bob (Closed, ₹2,000 = 200000 paisa, outstanding = 0)
        db2.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 200000, 0, 10.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-03-01', '2026-09-01', 'CLOSED')
        `, [person2Id]);
        account3Id = queryOne(db2, 'SELECT last_insert_rowid() as id').id;

        const d = getDashboardSummary(db2);

        assert.strictEqual(d.total_people, 2, 'total_people must be 2');
        assert.strictEqual(d.total_loans, 3, 'total_loans must be 3');
        assert.strictEqual(d.active_loans, 2, 'active_loans must be 2 (1 Alice + 1 Bob)');
        assert.strictEqual(d.closed_loans, 1, 'closed_loans must be 1 (Bob closed loan)');
    });

    // ─── Test 4: Payments ─────────────────────────────────────
    console.log('\n--- Test 4: Payments ---');
    await runTest('Test 4 — Dashboard total_paid reflects actual payment transactions', async () => {
        // Record payment transactions for account 3 (principal paid = 200000)
        db2.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference
            ) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 200000, 'CASH', '2026-03-15', 'TX-PAY-1')
        `, [account3Id, person2Id]);

        // Record a partial payment for Alice's loan 1 (principal paid = 100000, ₹1,000)
        db2.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference
            ) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 100000, 'UPI', '2026-01-20', 'TX-PAY-2')
        `, [account1Id, person1Id]);

        // Reduce Alice's outstanding principal in accounts table (authoritative balance)
        db2.run('UPDATE accounts SET outstanding_principal = 400000 WHERE id = ?', [account1Id]);

        const d = getDashboardSummary(db2);

        // total_paid should be 200000 + 100000 = 300000 paisa (₹3,000)
        assert.strictEqual(d.total_paid_paisa, 300000, 'total_paid_paisa must be 300000');
        assert.strictEqual(d.total_paid, 3000, 'total_paid must be ₹3,000');
    });

    // ─── Test 5: Interest ─────────────────────────────────────
    console.log('\n--- Test 5: Interest ---');
    await runTest('Test 5 — Dashboard total_interest and outstanding_interest use actual interest records', async () => {
        // Record interest on Alice's account: ₹50.00 (5000 paisa), paid: ₹20.00 (2000 paisa)
        db2.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis, interest_rate,
                interest_amount, paid_amount, calculation_method, status
            ) VALUES (?, '2026-01-01', '2026-01-31', 500000, 12.0, 5000, 2000, 'SIMPLE_INTEREST', 'PARTIALLY_PAID')
        `, [account1Id]);

        // Record interest on Bob's account 2: ₹125.00 (12500 paisa), paid: ₹0
        db2.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis, interest_rate,
                interest_amount, paid_amount, calculation_method, status
            ) VALUES (?, '2026-02-01', '2026-02-28', 1000000, 15.0, 12500, 0, 'SIMPLE_INTEREST', 'PENDING')
        `, [account2Id]);

        // Record a REVERSED interest record: ₹30.00 (3000 paisa) — must NOT be included
        db2.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis, interest_rate,
                interest_amount, paid_amount, calculation_method, status, reversal_reason
            ) VALUES (?, '2026-01-01', '2026-01-15', 500000, 12.0, 3000, 0, 'SIMPLE_INTEREST', 'REVERSED', 'Calculated incorrectly')
        `, [account1Id]);

        const d = getDashboardSummary(db2);

        // Expected active interest: 5000 + 12500 = 17500 paisa (₹175.00)
        assert.strictEqual(d.total_interest_paisa, 17500, 'total_interest_paisa must exclude REVERSED records');
        assert.strictEqual(d.total_interest, 175, 'total_interest rupees must be ₹175.00');

        // Expected outstanding interest: 17500 - 2000 = 15500 paisa (₹155.00)
        assert.strictEqual(d.outstanding_interest_paisa, 15500, 'outstanding_interest_paisa must be 15500');
        assert.strictEqual(d.outstanding_interest, 155, 'outstanding_interest rupees must be ₹155.00');
    });

    // ─── Test 6: Principal matches authoritative balance ──────
    console.log('\n--- Test 6: Principal ---');
    await runTest('Test 6 — Dashboard principal values match authoritative accounts table', async () => {
        const d = getDashboardSummary(db2);

        // Authoritative query from existing balance service / accounts table
        const expectedPrincipalRow = queryOne(db2, `
            SELECT
                COALESCE(SUM(principal), 0) as total_principal,
                COALESCE(SUM(outstanding_principal), 0) as outstanding_principal
            FROM accounts
        `);

        assert.strictEqual(d.total_principal_paisa, Number(expectedPrincipalRow.total_principal),
            'total_principal_paisa must match SUM(accounts.principal)');
        assert.strictEqual(d.outstanding_principal_paisa, Number(expectedPrincipalRow.outstanding_principal),
            'outstanding_principal_paisa must match SUM(accounts.outstanding_principal)');

        // Rupee representations
        assert.strictEqual(d.total_principal, Number(expectedPrincipalRow.total_principal) / 100);
        assert.strictEqual(d.outstanding_principal, Number(expectedPrincipalRow.outstanding_principal) / 100);
    });

    // ─── Test 7: Authorization (person_id scoping) ────────────
    console.log('\n--- Test 7: Authorization ---');
    await runTest('Test 7a — person_id scoping isolates Alice from Bob', async () => {
        const p1 = getDashboardSummary(db2, { person_id: person1Id });

        assert.strictEqual(p1.total_people, 1, 'Alice scoped: total_people must be 1');
        assert.strictEqual(p1.person_id, person1Id, 'Alice scoped: person_id must match');
        assert.strictEqual(p1.total_loans, 1, 'Alice has 1 loan');
        assert.strictEqual(p1.total_principal_paisa, 500000, 'Alice total_principal is 500000');
        assert.strictEqual(p1.outstanding_principal_paisa, 400000, 'Alice outstanding_principal is 400000');
        assert.strictEqual(p1.total_interest_paisa, 5000, 'Alice total_interest is 5000');
        assert.strictEqual(p1.outstanding_interest_paisa, 3000, 'Alice outstanding_interest is 3000 (5000 - 2000)');
        assert.strictEqual(p1.total_paid_paisa, 100000, 'Alice total_paid is 100000');

        const p2 = getDashboardSummary(db2, { person_id: person2Id });

        assert.strictEqual(p2.total_people, 1, 'Bob scoped: total_people must be 1');
        assert.strictEqual(p2.person_id, person2Id, 'Bob scoped: person_id must match');
        assert.strictEqual(p2.total_loans, 2, 'Bob has 2 loans (1 active + 1 closed)');
        assert.strictEqual(p2.active_loans, 1, 'Bob has 1 active loan');
        assert.strictEqual(p2.closed_loans, 1, 'Bob has 1 closed loan');
        assert.strictEqual(p2.total_principal_paisa, 1200000, 'Bob total_principal is 1200000 (1000000 + 200000)');
        assert.strictEqual(p2.outstanding_principal_paisa, 1000000, 'Bob outstanding_principal is 1000000');
        assert.strictEqual(p2.total_interest_paisa, 12500, 'Bob total_interest is 12500');
        assert.strictEqual(p2.total_paid_paisa, 200000, 'Bob total_paid is 200000');

        // Isolation: Alice\'s totals != Bob\'s totals
        assert.notStrictEqual(p1.total_principal_paisa, p2.total_principal_paisa);
        assert.notStrictEqual(p1.total_paid_paisa, p2.total_paid_paisa);
    });

    await runTest('Test 7b — Non-existent person_id throws 404', async () => {
        let threw = false;
        try {
            getDashboardSummary(db2, { person_id: 99999 });
        } catch (err) {
            threw = true;
            assert.strictEqual(err.statusCode, 404);
        }
        assert.ok(threw, 'Should throw for non-existent person');
    });

    await runTest('Test 7c — Invalid person_id format throws 400', async () => {
        let threw = false;
        try {
            getDashboardSummary(db2, { person_id: 'not-a-number' });
        } catch (err) {
            threw = true;
            assert.strictEqual(err.statusCode, 400);
        }
        assert.ok(threw, 'Should throw 400 for invalid person_id');
    });

    // ─── Test 8: Read-only verification ───────────────────────
    console.log('\n--- Test 8: Read-Only Verification ---');
    await runTest('Test 8 — Dashboard service performs zero database writes', async () => {
        const countQuery = (table) => queryOne(db2, `SELECT COUNT(*) as c FROM ${table}`).c;

        const peopleBefore = countQuery('people');
        const accountsBefore = countQuery('accounts');
        const txBefore = countQuery('transactions');
        const intBefore = countQuery('interest_records');

        // Perform multiple dashboard summary queries
        getDashboardSummary(db2);
        getDashboardSummary(db2, { person_id: person1Id });
        getDashboardSummary(db2, { person_id: person2Id });

        assert.strictEqual(countQuery('people'), peopleBefore, 'people count must remain unchanged');
        assert.strictEqual(countQuery('accounts'), accountsBefore, 'accounts count must remain unchanged');
        assert.strictEqual(countQuery('transactions'), txBefore, 'transactions count must remain unchanged');
        assert.strictEqual(countQuery('interest_records'), intBefore, 'interest_records count must remain unchanged');
    });

    // ─── Test 9: DTO Contract Structure ───────────────────────
    console.log('\n--- Test 9: DTO Contract Structure ---');
    await runTest('Test 9 — DashboardSummary DTO contains all specified fields and correct types', async () => {
        const d = getDashboardSummary(db2);

        const requiredNumericFields = [
            'total_people', 'total_loans', 'active_loans', 'closed_loans',
            'total_principal', 'total_principal_paisa',
            'outstanding_principal', 'outstanding_principal_paisa',
            'total_interest', 'total_interest_paisa',
            'outstanding_interest', 'outstanding_interest_paisa',
            'total_paid', 'total_paid_paisa'
        ];

        for (const field of requiredNumericFields) {
            assert.ok(field in d, `Field '${field}' must exist in DTO`);
            assert.strictEqual(typeof d[field], 'number', `Field '${field}' must be a number`);
            assert.ok(!isNaN(d[field]), `Field '${field}' must not be NaN`);
        }

        assert.ok('generated_at' in d, "Field 'generated_at' must exist in DTO");
        assert.strictEqual(typeof d.generated_at, 'string');
    });

    // ─── Test 10: HTTP API Integration ────────────────────────
    console.log('\n--- Test 10: HTTP API Integration ---');
    await runTest('Test 10a — Live GET /api/dashboard/summary endpoint returns 200 with DTO', async () => {
        const res = await httpRequest('GET', '/dashboard/summary');
        assert.strictEqual(res.statusCode, 200, `Expected 200, got ${res.statusCode}`);
        assert.ok(res.body.data, 'Response must have data object');

        const d = res.body.data;
        assert.ok(typeof d.total_people === 'number');
        assert.ok(typeof d.total_loans === 'number');
        assert.ok(typeof d.total_principal_paisa === 'number');
        assert.ok(typeof d.outstanding_principal_paisa === 'number');
        assert.ok(typeof d.total_paid_paisa === 'number');
        assert.ok(typeof d.generated_at === 'string');
    });

    await runTest('Test 10b — Live GET /api/dashboard/summary?person_id=1 returns 200 scoped data', async () => {
        const res = await httpRequest('GET', '/dashboard/summary?person_id=1');
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.person_id, 1);
        assert.strictEqual(res.body.data.total_people, 1);
    });

    await runTest('Test 10c — Live GET /api/dashboard/summary?person_id=99999 returns 404', async () => {
        const res = await httpRequest('GET', '/dashboard/summary?person_id=99999');
        assert.strictEqual(res.statusCode, 404);
        assert.ok(res.body.error);
    });

    await runTest('Test 10d — Live GET /api/dashboard/summary?person_id=invalid returns 400', async () => {
        const res = await httpRequest('GET', '/dashboard/summary?person_id=invalid');
        assert.strictEqual(res.statusCode, 400);
        assert.ok(res.body.error);
    });

    // ─── Final Summary ────────────────────────────────────────
    console.log('\n================================================================');
    console.log(`Step 7A Test Results: ${passed} passed, ${failed} failed`);
    console.log('================================================================\n');

    if (failed > 0) process.exit(1);
    process.exit(0);
}

runAll().catch((err) => {
    console.error('Fatal error running Step 7A tests:', err);
    process.exit(1);
});
