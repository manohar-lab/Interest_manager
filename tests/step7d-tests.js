/**
 * Interest Manager — Step 7D Test Suite
 * Implementation: People / Customer Summary Layer
 *
 * Verifies all 13 specifications from Step 7D:
 *   Test 1: Empty system — returns empty collection [] (§26.1)
 *   Test 2: Person with no loans — person appears with 0 for all counts & monetary totals (§26.2)
 *   Test 3: One person, one loan — verifies all summary fields accurately match the loan (§26.3)
 *   Test 4: One person, multiple loans — combined loan values aggregated across 3 loans (§26.4)
 *   Test 5: Active/closed mix — 2 active + 1 closed -> total=3, active=2, closed=1 (§26.5)
 *   Test 6: Multiple people — Person A (2 loans) and Person B (1 loan) isolated (§26.6)
 *   Test 7: Principal aggregation — total_principal correctly sums all loans (§26.7)
 *   Test 8: Outstanding aggregation — outstanding_principal correctly sums all loans (§26.8)
 *   Test 9: Payment aggregation — total_paid aggregates Part 5 payments across loans (§26.9)
 *   Test 10: Interest aggregation — total_interest and outstanding_interest aggregate Part 6 records (§26.10)
 *   Test 11: Interest payment — allocating interest payment reduces outstanding_interest (§26.11)
 *   Test 12: Authorization — user isolation, no data leakage, 404/400 handling (§26.12)
 *   Test 13: Read-only — getPeopleSummaries causes zero database mutations (§26.13)
 *   Test 14: Live API endpoints — GET /api/dashboard/people & /dashboard/customers (§18, §19)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const initSqlJs = require('sql.js');

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
    console.log('   INTEREST MANAGER — STEP 7D: PEOPLE / CUSTOMER SUMMARY');
    console.log('================================================================\n');

    const SQL = await initSqlJs();

    // ─── Test 1: Empty system (§26.1) ────────────────────────────
    console.log('--- Test 1: Empty System ---');
    await runTest('Test 1 — Empty system returns empty collection []', async () => {
        const db = await createFreshInMemoryDb(SQL);
        const summaries = getPeopleSummaries(db);

        assert.ok(Array.isArray(summaries), 'Expected array');
        assert.strictEqual(summaries.length, 0, 'Expected 0 people');
    });

    // ─── Test 2: Person with no loans (§26.2) ────────────────────
    console.log('\n--- Test 2: Person With No Loans ---');
    let db;
    let personNoLoansId;
    await runTest('Test 2 — Person with no loans appears with all 0s', async () => {
        db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Suresh Raina', '9812345678')");
        personNoLoansId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const summaries = getPeopleSummaries(db);

        assert.strictEqual(summaries.length, 1);
        const p = summaries[0];
        assert.strictEqual(p.person_id, personNoLoansId);
        assert.strictEqual(p.person_name, 'Suresh Raina');
        assert.strictEqual(p.total_loans, 0);
        assert.strictEqual(p.active_loans, 0);
        assert.strictEqual(p.closed_loans, 0);
        assert.strictEqual(p.total_principal, 0);
        assert.strictEqual(p.total_principal_paisa, 0);
        assert.strictEqual(p.outstanding_principal, 0);
        assert.strictEqual(p.outstanding_principal_paisa, 0);
        assert.strictEqual(p.total_paid, 0);
        assert.strictEqual(p.total_paid_paisa, 0);
        assert.strictEqual(p.total_interest, 0);
        assert.strictEqual(p.total_interest_paisa, 0);
        assert.strictEqual(p.outstanding_interest, 0);
        assert.strictEqual(p.outstanding_interest_paisa, 0);
    });

    // ─── Test 3: One person, one loan (§26.3) ────────────────────
    console.log('\n--- Test 3: One Person, One Loan ---');
    let personAId, loanA1Id;
    await runTest('Test 3 — One person with one loan displays accurate summary fields', async () => {
        // Create Person A
        db.run("INSERT INTO people (name, phone) VALUES ('Amit Shah', '9811100001')");
        personAId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Create Loan A1 (₹100,000 = 10,000,000 paisa)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 10000000, 10000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-07-01', 'ACTIVE')
        `, [personAId]);
        loanA1Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const summaries = getPeopleSummaries(db, { person_id: personAId });
        assert.strictEqual(summaries.length, 1);
        const p = summaries[0];

        assert.strictEqual(p.person_id, personAId);
        assert.strictEqual(p.person_name, 'Amit Shah');
        assert.strictEqual(p.total_loans, 1);
        assert.strictEqual(p.active_loans, 1);
        assert.strictEqual(p.closed_loans, 0);
        assert.strictEqual(p.total_principal, 100000);
        assert.strictEqual(p.total_principal_paisa, 10000000);
        assert.strictEqual(p.outstanding_principal, 100000);
        assert.strictEqual(p.outstanding_principal_paisa, 10000000);
        assert.strictEqual(p.total_paid, 0);
        assert.strictEqual(p.total_interest, 0);
    });

    // ─── Test 4: One person, multiple loans (§26.4) ──────────────
    console.log('\n--- Test 4: One Person, Multiple Loans ---');
    let loanA2Id, loanA3Id;
    await runTest('Test 4 — Person A with 3 loans aggregates all values', async () => {
        // Loan A2 (₹50,000 = 5,000,000 paisa)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 5000000, 5000000, 15.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-02-01', '2026-08-01', 'ACTIVE')
        `, [personAId]);
        loanA2Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Loan A3 (₹25,000 = 2,500,000 paisa)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 2500000, 2500000, 10.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-03-01', '2026-09-01', 'ACTIVE')
        `, [personAId]);
        loanA3Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const summaries = getPeopleSummaries(db, { person_id: personAId });
        assert.strictEqual(summaries.length, 1);
        const p = summaries[0];

        assert.strictEqual(p.total_loans, 3);
        assert.strictEqual(p.active_loans, 3);
        assert.strictEqual(p.closed_loans, 0);

        // Combined principal: 100,000 + 50,000 + 25,000 = 175,000 (17,500,000 paisa)
        assert.strictEqual(p.total_principal, 175000);
        assert.strictEqual(p.total_principal_paisa, 17500000);
        assert.strictEqual(p.outstanding_principal, 175000);
        assert.strictEqual(p.outstanding_principal_paisa, 17500000);
    });

    // ─── Test 5: Active/closed mix (§26.5) ───────────────────────
    console.log('\n--- Test 5: Active/Closed Mix ---');
    await runTest('Test 5 — 2 ACTIVE + 1 CLOSED -> total=3, active=2, closed=1', async () => {
        // Mark Loan A3 as CLOSED with 0 outstanding
        db.run("UPDATE accounts SET status = 'CLOSED', outstanding_principal = 0 WHERE id = ?", [loanA3Id]);

        const summaries = getPeopleSummaries(db, { person_id: personAId });
        const p = summaries[0];

        assert.strictEqual(p.total_loans, 3);
        assert.strictEqual(p.active_loans, 2);
        assert.strictEqual(p.closed_loans, 1);

        // Total principal still includes the closed loan: ₹175,000
        assert.strictEqual(p.total_principal, 175000);
        assert.strictEqual(p.total_principal_paisa, 17500000);

        // Outstanding principal excludes the closed loan: 100,000 + 50,000 + 0 = 150,000
        assert.strictEqual(p.outstanding_principal, 150000);
        assert.strictEqual(p.outstanding_principal_paisa, 15000000);
    });

    // ─── Test 6: Multiple people (§26.6) ─────────────────────────
    console.log('\n--- Test 6: Multiple People ---');
    let personBId, loanB1Id;
    await runTest('Test 6 — Person A (3 loans) and Person B (1 loan) summaries are strictly isolated', async () => {
        // Create Person B
        db.run("INSERT INTO people (name, phone) VALUES ('Deepika P', '9811100002')");
        personBId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Loan B1 (₹60,000 = 6,000,000 paisa)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 6000000, 6000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-04-01', '2026-10-01', 'ACTIVE')
        `, [personBId]);
        loanB1Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const all = getPeopleSummaries(db);
        // Total people: Suresh (0 loans), Amit (3 loans), Deepika (1 loan) = 3 people
        assert.strictEqual(all.length, 3);

        const pA = all.find(p => p.person_id === personAId);
        assert.strictEqual(pA.total_loans, 3);
        assert.strictEqual(pA.total_principal, 175000);

        const pB = all.find(p => p.person_id === personBId);
        assert.strictEqual(pB.total_loans, 1);
        assert.strictEqual(pB.total_principal, 60000);
        assert.strictEqual(pB.outstanding_principal, 60000);

        const pNoLoans = all.find(p => p.person_id === personNoLoansId);
        assert.strictEqual(pNoLoans.total_loans, 0);
    });

    // ─── Test 7: Principal aggregation (§26.7) ───────────────────
    console.log('\n--- Test 7: Principal Aggregation ---');
    await runTest('Test 7 — Principal aggregation matches SUM(accounts.principal) for each person', async () => {
        const all = getPeopleSummaries(db);

        for (const p of all) {
            const row = queryOne(db, 'SELECT COALESCE(SUM(principal), 0) as total FROM accounts WHERE person_id = ?', [p.person_id]);
            assert.strictEqual(p.total_principal_paisa, Number(row.total));
            assert.strictEqual(p.total_principal, Number(row.total) / 100);
        }
    });

    // ─── Test 8: Outstanding aggregation (§26.8) ─────────────────
    console.log('\n--- Test 8: Outstanding Aggregation ---');
    await runTest('Test 8 — Outstanding principal matches SUM(accounts.outstanding_principal)', async () => {
        const all = getPeopleSummaries(db);

        for (const p of all) {
            const row = queryOne(db, 'SELECT COALESCE(SUM(outstanding_principal), 0) as total FROM accounts WHERE person_id = ?', [p.person_id]);
            assert.strictEqual(p.outstanding_principal_paisa, Number(row.total));
            assert.strictEqual(p.outstanding_principal, Number(row.total) / 100);
        }
    });

    // ─── Test 9: Payment aggregation (§26.9) ─────────────────────
    console.log('\n--- Test 9: Payment Aggregation ---');
    await runTest('Test 9 — Payments through Part 5 workflow aggregate accurately to total_paid', async () => {
        // Pay ₹20,000 on Loan A1
        db.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference
            ) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 2000000, 'CASH', '2026-03-01', 'PAY-A1')
        `, [loanA1Id, personAId]);
        db.run('UPDATE accounts SET outstanding_principal = 8000000 WHERE id = ?', [loanA1Id]);

        // Pay ₹10,000 on Loan A2
        db.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference
            ) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 1000000, 'UPI', '2026-03-05', 'PAY-A2')
        `, [loanA2Id, personAId]);
        db.run('UPDATE accounts SET outstanding_principal = 4000000 WHERE id = ?', [loanA2Id]);

        // Person A summary check
        const summariesA = getPeopleSummaries(db, { person_id: personAId });
        const pA = summariesA[0];

        // Total paid on Person A: 20,000 + 10,000 = 30,000 (3,000,000 paisa)
        assert.strictEqual(pA.total_paid, 30000);
        assert.strictEqual(pA.total_paid_paisa, 3000000);

        // Person A outstanding: 80,000 + 40,000 + 0 = 120,000
        assert.strictEqual(pA.outstanding_principal, 120000);
        assert.strictEqual(pA.outstanding_principal_paisa, 12000000);

        // Person B total_paid must still be 0
        const summariesB = getPeopleSummaries(db, { person_id: personBId });
        assert.strictEqual(summariesB[0].total_paid, 0);
    });

    // ─── Test 10: Interest aggregation (§26.10) ──────────────────
    console.log('\n--- Test 10: Interest Aggregation ---');
    let intRecA1Id;
    await runTest('Test 10 — Recorded interest from Part 6 aggregates across loans for that person', async () => {
        // Record ₹1,000 (100,000 paisa) interest on Loan A1
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis, interest_rate,
                interest_amount, paid_amount, calculation_method, status
            ) VALUES (?, '2026-01-01', '2026-01-31', 10000000, 12.0, 100000, 0, 'SIMPLE_INTEREST', 'PENDING')
        `, [loanA1Id]);
        intRecA1Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Record ₹500 (50,000 paisa) interest on Loan A2
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis, interest_rate,
                interest_amount, paid_amount, calculation_method, status
            ) VALUES (?, '2026-02-01', '2026-02-28', 5000000, 15.0, 50000, 0, 'SIMPLE_INTEREST', 'PENDING')
        `, [loanA2Id]);

        // Record a REVERSED record (₹300) on Loan A1 — should NOT be included
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis, interest_rate,
                interest_amount, paid_amount, calculation_method, status, reversal_reason
            ) VALUES (?, '2026-01-01', '2026-01-15', 10000000, 12.0, 30000, 0, 'SIMPLE_INTEREST', 'REVERSED', 'Erroneous')
        `, [loanA1Id]);

        const summariesA = getPeopleSummaries(db, { person_id: personAId });
        const pA = summariesA[0];

        // Total interest: 1,000 + 500 = 1,500 (150,000 paisa)
        assert.strictEqual(pA.total_interest, 1500);
        assert.strictEqual(pA.total_interest_paisa, 150000);
        assert.strictEqual(pA.outstanding_interest, 1500);
        assert.strictEqual(pA.outstanding_interest_paisa, 150000);

        // Person B has zero interest
        const summariesB = getPeopleSummaries(db, { person_id: personBId });
        assert.strictEqual(summariesB[0].total_interest, 0);
    });

    // ─── Test 11: Interest payment (§26.11) ──────────────────────
    console.log('\n--- Test 11: Interest Payment ---');
    await runTest('Test 11 — Paying interest reduces outstanding_interest while preserving total_interest', async () => {
        // Pay ₹400 (40,000 paisa) on Loan A1's interest
        db.run(`
            UPDATE interest_records
            SET paid_amount = 40000, status = 'PARTIALLY_PAID'
            WHERE id = ?
        `, [intRecA1Id]);

        db.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference
            ) VALUES (?, ?, 'INTEREST_RECEIVED', 40000, 'UPI', '2026-02-15', 'PAY-INT-A1')
        `, [loanA1Id, personAId]);

        const summariesA = getPeopleSummaries(db, { person_id: personAId });
        const pA = summariesA[0];

        // Total interest remains 1,500
        assert.strictEqual(pA.total_interest, 1500);
        assert.strictEqual(pA.total_interest_paisa, 150000);

        // Outstanding interest reduces: 1,500 - 400 = 1,100 (110,000 paisa)
        assert.strictEqual(pA.outstanding_interest, 1100);
        assert.strictEqual(pA.outstanding_interest_paisa, 110000);

        // Total paid increases: 30,000 + 400 = 30,400 (3,040,000 paisa)
        assert.strictEqual(pA.total_paid, 30400);
        assert.strictEqual(pA.total_paid_paisa, 3040000);
    });

    // ─── Test 12: Authorization (§26.12) ─────────────────────────
    console.log('\n--- Test 12: Authorization ---');
    await runTest('Test 12a — Authorization scope via person_id isolates people and prevents leakage', async () => {
        const scopedB = getPeopleSummaries(db, { person_id: personBId });
        assert.strictEqual(scopedB.length, 1);
        assert.strictEqual(scopedB[0].person_id, personBId);
        assert.strictEqual(scopedB[0].person_name, 'Deepika P');

        // Verify Person A does not appear in Person B's result
        const personIds = scopedB.map(p => p.person_id);
        assert.ok(!personIds.includes(personAId));
    });

    await runTest('Test 12b — Non-existent person_id throws 404', async () => {
        let threw = false;
        try {
            getPeopleSummaries(db, { person_id: 99999 });
        } catch (err) {
            threw = true;
            assert.strictEqual(err.statusCode, 404);
        }
        assert.ok(threw);
    });

    await runTest('Test 12c — Invalid person_id format throws 400', async () => {
        let threw = false;
        try {
            getPeopleSummaries(db, { person_id: 'abc' });
        } catch (err) {
            threw = true;
            assert.strictEqual(err.statusCode, 400);
        }
        assert.ok(threw);
    });

    // ─── Test 13: Read-only verification (§26.13) ────────────────
    console.log('\n--- Test 13: Read-Only Verification ---');
    await runTest('Test 13 — getPeopleSummaries causes zero mutations to database tables', async () => {
        const getSnapshot = () => ({
            people: queryOne(db, 'SELECT COUNT(*) as c FROM people').c,
            accounts: queryOne(db, 'SELECT COUNT(*) as c, SUM(outstanding_principal) as bal FROM accounts'),
            transactions: queryOne(db, 'SELECT COUNT(*) as c, SUM(amount) as amt FROM transactions'),
            interest: queryOne(db, 'SELECT COUNT(*) as c, SUM(interest_amount) as amt FROM interest_records')
        });

        const before = getSnapshot();

        // Multiple calls with and without scoping
        getPeopleSummaries(db);
        getPeopleSummaries(db, { person_id: personAId });
        getPeopleSummaries(db, { person_id: personBId });

        const after = getSnapshot();
        assert.deepStrictEqual(before, after, 'Database state must be completely unchanged');
    });

    // ─── Test 14: Live API Endpoints (§18, §19) ──────────────────
    console.log('\n--- Test 14: Live API Endpoints ---');
    await runTest('Test 14a — HTTP GET /api/dashboard/people returns 200 with items collection', async () => {
        const res = await httpRequest('GET', '/dashboard/people');
        assert.strictEqual(res.statusCode, 200);

        const body = res.body;
        assert.ok(Array.isArray(body.items), 'body.items must be an array');
        assert.ok(Array.isArray(body.data), 'body.data must be an array');
        assert.strictEqual(typeof body.count, 'number');

        if (body.items.length > 0) {
            const item = body.items[0];
            assert.ok('person_id' in item);
            assert.ok('person_name' in item);
            assert.ok('total_loans' in item);
            assert.ok('active_loans' in item);
            assert.ok('closed_loans' in item);
            assert.ok('total_principal' in item);
            assert.ok('outstanding_principal' in item);
            assert.ok('total_paid' in item);
            assert.ok('total_interest' in item);
            assert.ok('outstanding_interest' in item);
        }
    });

    await runTest('Test 14b — HTTP GET /api/dashboard/customers works as an alias', async () => {
        const res = await httpRequest('GET', '/dashboard/customers');
        assert.strictEqual(res.statusCode, 200);
        assert.ok(Array.isArray(res.body.items));
    });

    await runTest('Test 14c — Live HTTP scoping via ?person_id=1', async () => {
        const res = await httpRequest('GET', '/dashboard/people?person_id=1');
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.items.length, 1);
        assert.strictEqual(res.body.items[0].person_id, 1);
    });

    await runTest('Test 14d — Live HTTP 404 for non-existent person', async () => {
        const res = await httpRequest('GET', '/dashboard/people?person_id=99999');
        assert.strictEqual(res.statusCode, 404);
        assert.ok(res.body.error);
    });

    await runTest('Test 14e — Live HTTP 400 for invalid person_id', async () => {
        const res = await httpRequest('GET', '/dashboard/people?person_id=not-valid');
        assert.strictEqual(res.statusCode, 400);
        assert.ok(res.body.error);
    });

    // ─── Final Summary ──────────────────────────────────────────
    console.log('\n================================================================');
    console.log(`Step 7D Test Results: ${passed} passed, ${failed} failed`);
    console.log('================================================================\n');

    if (failed > 0) process.exit(1);
    process.exit(0);
}

runAll().catch((err) => {
    console.error('Fatal error running Step 7D tests:', err);
    process.exit(1);
});
