/**
 * Interest Manager — Step 7C Test Suite
 * Implementation: Loan / Account Summary Layer
 *
 * Verifies all 11 specifications from Step 7C:
 *   Test 1: No loans — returns empty collection [] (§23.1)
 *   Test 2: One loan — exactly one summary, correct loan_id, person, principal, status (§23.2)
 *   Test 3: Multiple loans — three independent summaries returned (§23.3)
 *   Test 4: Multiple loans for one person — Person A has Loan 1 & Loan 2 independently (§23.4)
 *   Test 5: Different people — Person A -> Loan A, Person B -> Loan B correct association (§23.5)
 *   Test 6: Outstanding principal — matches authoritative balance service after payment (§23.6)
 *   Test 7: Interest — total_interest and outstanding_interest match Part 6 records (§23.7)
 *   Test 8: Interest payment — paying part of interest updates outstanding_interest (§23.8)
 *   Test 9: Loan status — loan status workflow reflected accurately (ACTIVE -> CLOSED) (§23.9)
 *   Test 10: Authorization — scoping by person_id isolates loans, no leakage, 404/400 (§23.10)
 *   Test 11: Read-only — loan summary calls cause zero mutations to DB tables (§23.11)
 *   Test 12: API endpoints — live GET /api/dashboard/loans & /dashboard/accounts (§21, §22)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const initSqlJs = require('sql.js');

const { getLoanSummaries } = require('../services/dashboardService');
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
    console.log('   INTEREST MANAGER — STEP 7C: LOAN / ACCOUNT SUMMARY');
    console.log('================================================================\n');

    const SQL = await initSqlJs();

    // ─── Test 1: No loans (§23.1) ────────────────────────────────
    console.log('--- Test 1: No Loans ---');
    await runTest('Test 1 — Empty database returns an empty collection []', async () => {
        const db = await createFreshInMemoryDb(SQL);
        const summaries = getLoanSummaries(db);

        assert.ok(Array.isArray(summaries), 'Result must be an array');
        assert.strictEqual(summaries.length, 0, 'Array must be empty');
    });

    // ─── Test 2: One loan (§23.2) ────────────────────────────────
    console.log('\n--- Test 2: One Loan ---');
    let db;
    let personAId, loan1Id;
    await runTest('Test 2 — One loan returns exactly 1 summary with correct fields', async () => {
        db = await createFreshInMemoryDb(SQL);

        // Create Person A
        db.run("INSERT INTO people (name, phone) VALUES ('Anil Kapoor', '9810011111')");
        personAId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Create Loan 1 (₹20,000 = 2,000,000 paisa)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 2000000, 2000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-07-01', 'ACTIVE')
        `, [personAId]);
        loan1Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const summaries = getLoanSummaries(db);

        assert.strictEqual(summaries.length, 1, 'Exactly one summary expected');
        const s = summaries[0];

        assert.strictEqual(s.loan_id, loan1Id);
        assert.strictEqual(s.account_id, loan1Id);
        assert.strictEqual(s.person_id, personAId);
        assert.strictEqual(s.person_name, 'Anil Kapoor');
        assert.strictEqual(s.loan_status, 'ACTIVE');
        assert.strictEqual(s.status, 'ACTIVE');
        assert.strictEqual(s.original_principal, 20000);
        assert.strictEqual(s.original_principal_paisa, 2000000);
        assert.strictEqual(s.outstanding_principal, 20000);
        assert.strictEqual(s.outstanding_principal_paisa, 2000000);
        assert.strictEqual(s.total_paid, 0);
        assert.strictEqual(s.total_paid_paisa, 0);
        assert.strictEqual(s.total_interest, 0);
        assert.strictEqual(s.total_interest_paisa, 0);
        assert.strictEqual(s.outstanding_interest, 0);
        assert.strictEqual(s.outstanding_interest_paisa, 0);
        assert.strictEqual(s.relevant_date, '2026-01-01');
    });

    // ─── Test 3: Multiple loans (§23.3) ──────────────────────────
    console.log('\n--- Test 3: Multiple Loans ---');
    let loan2Id, loan3Id;
    await runTest('Test 3 — Create 3 loans -> Three independent summaries returned', async () => {
        // Loan 2 (₹10,000 = 1,000,000 paisa)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 1000000, 1000000, 15.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-02-01', '2026-08-01', 'ACTIVE')
        `, [personAId]);
        loan2Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Loan 3 (₹5,000 = 500,000 paisa, CLOSED)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 500000, 0, 10.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-03-01', '2026-09-01', 'CLOSED')
        `, [personAId]);
        loan3Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const summaries = getLoanSummaries(db);

        assert.strictEqual(summaries.length, 3, 'Expected three independent summaries');

        const ids = summaries.map(s => s.loan_id);
        assert.ok(ids.includes(loan1Id));
        assert.ok(ids.includes(loan2Id));
        assert.ok(ids.includes(loan3Id));
    });

    // ─── Test 4: Multiple loans for one person (§23.4) ───────────
    console.log('\n--- Test 4: Multiple Loans for One Person ---');
    await runTest('Test 4 — Person A has Loan 1, Loan 2, Loan 3 independently without combining', async () => {
        const summaries = getLoanSummaries(db, { person_id: personAId });

        assert.strictEqual(summaries.length, 3);
        summaries.forEach(s => {
            assert.strictEqual(s.person_id, personAId);
            assert.strictEqual(s.person_name, 'Anil Kapoor');
        });

        // Verify independent principals
        const principals = summaries.map(s => s.original_principal_paisa).sort((a, b) => a - b);
        assert.deepStrictEqual(principals, [500000, 1000000, 2000000]);
    });

    // ─── Test 5: Different people (§23.5) ────────────────────────
    console.log('\n--- Test 5: Different People ---');
    let personBId, loanBId;
    await runTest('Test 5 — Person A -> Loan A, Person B -> Loan B mapped to correct persons', async () => {
        // Create Person B
        db.run("INSERT INTO people (name, phone) VALUES ('Bhavna Patel', '9820022222')");
        personBId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Loan for Person B (₹50,000 = 5,000,000 paisa)
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 5000000, 5000000, 14.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-04-01', '2026-10-01', 'ACTIVE')
        `, [personBId]);
        loanBId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const allSummaries = getLoanSummaries(db);
        assert.strictEqual(allSummaries.length, 4);

        const bLoan = allSummaries.find(s => s.loan_id === loanBId);
        assert.ok(bLoan, 'Person B loan must exist');
        assert.strictEqual(bLoan.person_id, personBId);
        assert.strictEqual(bLoan.person_name, 'Bhavna Patel');
        assert.strictEqual(bLoan.original_principal, 50000);

        const aLoans = allSummaries.filter(s => s.person_id === personAId);
        assert.strictEqual(aLoans.length, 3);
        aLoans.forEach(l => assert.strictEqual(l.person_name, 'Anil Kapoor'));
    });

    // ─── Test 6: Outstanding principal (§23.6) ───────────────────
    console.log('\n--- Test 6: Outstanding Principal ---');
    await runTest('Test 6 — Loan summary outstanding_principal reflects payments correctly', async () => {
        // Make a partial payment of ₹5,000 (500,000 paisa) on Loan 1
        db.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference
            ) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 500000, 'UPI', '2026-02-15', 'PAY-TEST-6A')
        `, [loan1Id, personAId]);

        // Update authoritative balance
        db.run('UPDATE accounts SET outstanding_principal = 1500000 WHERE id = ?', [loan1Id]);

        const summaries = getLoanSummaries(db);
        const l1 = summaries.find(s => s.loan_id === loan1Id);

        assert.strictEqual(l1.original_principal, 20000);
        assert.strictEqual(l1.original_principal_paisa, 2000000);
        assert.strictEqual(l1.outstanding_principal, 15000);
        assert.strictEqual(l1.outstanding_principal_paisa, 1500000);
        assert.strictEqual(l1.total_paid, 5000);
        assert.strictEqual(l1.total_paid_paisa, 500000);
    });

    // ─── Test 7: Interest (§23.7) ────────────────────────────────
    console.log('\n--- Test 7: Interest ---');
    let intRecId;
    await runTest('Test 7 — total_interest and outstanding_interest match Part 6 interest records', async () => {
        // Record interest for Loan 1: ₹197.26 (19726 paisa)
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis, interest_rate,
                interest_amount, paid_amount, calculation_method, status
            ) VALUES (?, '2026-01-01', '2026-01-31', 2000000, 12.0, 19726, 0, 'SIMPLE_INTEREST', 'PENDING')
        `, [loan1Id]);
        intRecId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const summaries = getLoanSummaries(db);
        const l1 = summaries.find(s => s.loan_id === loan1Id);

        assert.strictEqual(l1.total_interest, 197.26);
        assert.strictEqual(l1.total_interest_paisa, 19726);
        assert.strictEqual(l1.outstanding_interest, 197.26);
        assert.strictEqual(l1.outstanding_interest_paisa, 19726);

        // Other loans should have 0 interest
        const l2 = summaries.find(s => s.loan_id === loan2Id);
        assert.strictEqual(l2.total_interest, 0);
        assert.strictEqual(l2.outstanding_interest, 0);
    });

    // ─── Test 8: Interest payment (§23.8) ────────────────────────
    console.log('\n--- Test 8: Interest Payment ---');
    await runTest('Test 8 — Paying part of interest updates outstanding_interest correctly', async () => {
        // Pay ₹100.00 (10000 paisa) against the interest record
        db.run(`
            UPDATE interest_records
            SET paid_amount = 10000, status = 'PARTIALLY_PAID'
            WHERE id = ?
        `, [intRecId]);

        // Record interest payment transaction
        db.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference
            ) VALUES (?, ?, 'INTEREST_RECEIVED', 10000, 'CASH', '2026-02-20', 'INT-PAY-8A')
        `, [loan1Id, personAId]);

        const summaries = getLoanSummaries(db);
        const l1 = summaries.find(s => s.loan_id === loan1Id);

        // Total interest stays 197.26
        assert.strictEqual(l1.total_interest, 197.26);
        assert.strictEqual(l1.total_interest_paisa, 19726);

        // Outstanding interest drops to: 197.26 - 100.00 = 97.26 (9726 paisa)
        assert.strictEqual(l1.outstanding_interest, 97.26);
        assert.strictEqual(l1.outstanding_interest_paisa, 9726);

        // Total paid on loan 1 is now 500,000 (principal) + 10,000 (interest) = 510,000 paisa (₹5,100)
        assert.strictEqual(l1.total_paid_paisa, 510000);
        assert.strictEqual(l1.total_paid, 5100);
    });

    // ─── Test 9: Loan status (§23.9) ────────────────────────────
    console.log('\n--- Test 9: Loan Status ---');
    await runTest('Test 9 — Status transitions are reflected accurately (ACTIVE -> CLOSED)', async () => {
        // Verify loan 3 is CLOSED
        const summariesBefore = getLoanSummaries(db);
        const l3 = summariesBefore.find(s => s.loan_id === loan3Id);
        assert.strictEqual(l3.loan_status, 'CLOSED');

        // Close loan 2
        db.run("UPDATE accounts SET status = 'CLOSED', outstanding_principal = 0 WHERE id = ?", [loan2Id]);

        const summariesAfter = getLoanSummaries(db);
        const l2 = summariesAfter.find(s => s.loan_id === loan2Id);
        assert.strictEqual(l2.loan_status, 'CLOSED');
        assert.strictEqual(l2.outstanding_principal, 0);

        // Status filter testing
        const activeOnly = getLoanSummaries(db, { status: 'ACTIVE' });
        activeOnly.forEach(s => assert.strictEqual(s.loan_status, 'ACTIVE'));

        const closedOnly = getLoanSummaries(db, { status: 'CLOSED' });
        closedOnly.forEach(s => assert.strictEqual(s.loan_status, 'CLOSED'));
    });

    // ─── Test 10: Authorization (§23.10) ────────────────────────
    console.log('\n--- Test 10: Authorization ---');
    await runTest('Test 10a — Authorization scoping via person_id prevents data leakage', async () => {
        // Scoped to Person B
        const bSummaries = getLoanSummaries(db, { person_id: personBId });
        assert.strictEqual(bSummaries.length, 1);
        assert.strictEqual(bSummaries[0].loan_id, loanBId);
        assert.strictEqual(bSummaries[0].person_id, personBId);

        // Person A loans must NOT be present in Person B's result
        const personAIds = bSummaries.map(s => s.person_id);
        assert.ok(!personAIds.includes(personAId), "Person A loans must not leak to Person B");
    });

    await runTest('Test 10b — Non-existent person_id returns 404', async () => {
        let threw = false;
        try {
            getLoanSummaries(db, { person_id: 99999 });
        } catch (err) {
            threw = true;
            assert.strictEqual(err.statusCode, 404);
        }
        assert.ok(threw);
    });

    await runTest('Test 10c — Invalid person_id format returns 400', async () => {
        let threw = false;
        try {
            getLoanSummaries(db, { person_id: 'invalid-id' });
        } catch (err) {
            threw = true;
            assert.strictEqual(err.statusCode, 400);
        }
        assert.ok(threw);
    });

    // ─── Test 11: Read-only verification (§23.11) ───────────────
    console.log('\n--- Test 11: Read-Only Verification ---');
    await runTest('Test 11 — getLoanSummaries causes zero mutations to database tables', async () => {
        const getSnapshot = () => ({
            people: queryOne(db, 'SELECT COUNT(*) as c FROM people').c,
            accounts: queryOne(db, 'SELECT COUNT(*) as c, SUM(outstanding_principal) as bal FROM accounts'),
            transactions: queryOne(db, 'SELECT COUNT(*) as c, SUM(amount) as amt FROM transactions'),
            interest: queryOne(db, 'SELECT COUNT(*) as c, SUM(interest_amount) as amt FROM interest_records')
        });

        const before = getSnapshot();

        // Repeated calls with various filter combinations
        getLoanSummaries(db);
        getLoanSummaries(db, { person_id: personAId });
        getLoanSummaries(db, { person_id: personBId });
        getLoanSummaries(db, { status: 'ACTIVE' });
        getLoanSummaries(db, { status: 'CLOSED' });

        const after = getSnapshot();
        assert.deepStrictEqual(before, after, 'Database state must be perfectly unaltered');
    });

    // ─── Test 12: Live API Endpoints (§21, §22) ──────────────────
    console.log('\n--- Test 12: Live API Endpoints ---');
    await runTest('Test 12a — HTTP GET /api/dashboard/loans returns 200 with items collection', async () => {
        const res = await httpRequest('GET', '/dashboard/loans');
        assert.strictEqual(res.statusCode, 200);

        const body = res.body;
        assert.ok(Array.isArray(body.items), 'body.items must be an array');
        assert.ok(Array.isArray(body.data), 'body.data must be an array');
        assert.strictEqual(typeof body.count, 'number');

        if (body.items.length > 0) {
            const item = body.items[0];
            assert.ok('loan_id' in item);
            assert.ok('person_id' in item);
            assert.ok('person_name' in item);
            assert.ok('loan_status' in item);
            assert.ok('original_principal' in item);
            assert.ok('outstanding_principal' in item);
            assert.ok('total_paid' in item);
            assert.ok('total_interest' in item);
            assert.ok('outstanding_interest' in item);
            assert.ok('relevant_date' in item);
        }
    });

    await runTest('Test 12b — HTTP GET /api/dashboard/accounts works as an alias', async () => {
        const res = await httpRequest('GET', '/dashboard/accounts');
        assert.strictEqual(res.statusCode, 200);
        assert.ok(Array.isArray(res.body.items));
    });

    await runTest('Test 12c — Live HTTP scoping via ?person_id=1', async () => {
        const res = await httpRequest('GET', '/dashboard/loans?person_id=1');
        assert.strictEqual(res.statusCode, 200);
        res.body.items.forEach(item => {
            assert.strictEqual(item.person_id, 1);
        });
    });

    await runTest('Test 12d — Live HTTP 404 for non-existent person', async () => {
        const res = await httpRequest('GET', '/dashboard/loans?person_id=99999');
        assert.strictEqual(res.statusCode, 404);
        assert.ok(res.body.error);
    });

    await runTest('Test 12e — Live HTTP 400 for invalid person_id format', async () => {
        const res = await httpRequest('GET', '/dashboard/loans?person_id=not-a-number');
        assert.strictEqual(res.statusCode, 400);
        assert.ok(res.body.error);
    });

    // ─── Final Summary ──────────────────────────────────────────
    console.log('\n================================================================');
    console.log(`Step 7C Test Results: ${passed} passed, ${failed} failed`);
    console.log('================================================================\n');

    if (failed > 0) process.exit(1);
    process.exit(0);
}

runAll().catch((err) => {
    console.error('Fatal error running Step 7C tests:', err);
    process.exit(1);
});
