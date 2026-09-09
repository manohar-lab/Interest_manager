/**
 * Interest Manager — Step 7G Test Suite
 * Implementation: Recent Activity Summary Layer
 *
 * Verifies all specifications of Step 7G:
 *   Test 1: Empty activity — No transactions -> items = [] (§23.1)
 *   Test 2: One transaction — items.length = 1, verify contract fields (§23.2)
 *   Test 3: Multiple transactions — Chronological newest-first ordering C, B, A (§23.3)
 *   Test 4: Limit — Configurable limit bounds returned items (e.g. 15 txs with limit=10 -> 10 items) (§23.4)
 *   Test 5: Multiple loans for one person — Each activity points to correct loan_id (§23.5)
 *   Test 6: Multiple people — Correct person is associated with each activity (§23.6)
 *   Test 7: Same timestamp — Deterministic secondary ordering (t.id DESC) (§23.7)
 *   Test 8: Reversed transaction — Follows status convention (§23.8)
 *   Test 9: Unauthorized activity — Scoping via person_id isolates data, 404/400 for bad input (§23.9)
 *   Test 10: Read-only verification — Zero database mutations during execution (§23.10)
 *   Test 11: Cross-check — Dashboard activity matches Part 5 transaction records (§24)
 *   Test 12: Live API endpoints — GET /dashboard/recent-activity (§12)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const initSqlJs = require('sql.js');

const { getRecentActivity } = require('../services/dashboardService');
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
    console.log('   INTEREST MANAGER — STEP 7G: RECENT ACTIVITY SUMMARY');
    console.log('================================================================\n');

    const SQL = await initSqlJs();

    // ─── Test 1: Empty activity (§23.1) ──────────────────────────
    console.log('--- Test 1: Empty Activity ---');
    await runTest('Test 1 — Empty database returns empty array []', async () => {
        const db = await createFreshInMemoryDb(SQL);
        const items = getRecentActivity(db);
        assert.strictEqual(Array.isArray(items), true);
        assert.strictEqual(items.length, 0);
    });

    // ─── Test 2: One transaction (§23.2) ─────────────────────────
    console.log('\n--- Test 2: One Transaction ---');
    await runTest('Test 2 — One transaction returns exactly 1 item with all contract fields', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Amit Sharma', '9876543210')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 1000000, 1000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')
        `, [personId]);
        const loanId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference, notes
            ) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 500000, 'UPI', '2026-02-15', 'REF-001', 'First installment')
        `, [loanId, personId]);
        const txId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const items = getRecentActivity(db);

        assert.strictEqual(items.length, 1);
        const item = items[0];

        assert.strictEqual(item.activity_id, txId);
        assert.strictEqual(item.activity_type, 'PRINCIPAL_RECEIVED');
        assert.strictEqual(item.person_id, personId);
        assert.strictEqual(item.person_name, 'Amit Sharma');
        assert.strictEqual(item.loan_id, loanId);
        assert.strictEqual(item.amount, 5000.00);
        assert.strictEqual(item.amount_paisa, 500000);
        assert.strictEqual(item.date_time, '2026-02-15');
        assert.strictEqual(item.payment_method, 'UPI');
        assert.strictEqual(item.reference, 'REF-001');
        assert.strictEqual(item.notes, 'First installment');
        assert.strictEqual(item.status, 'COMPLETED');
    });

    // ─── Test 3: Multiple transactions (§23.3) ───────────────────
    console.log('\n--- Test 3: Multiple Transactions Ordering ---');
    await runTest('Test 3 — Transactions ordered newest first (C, B, A)', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Bhavna Shah', '9876543211')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 2000000, 2000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')
        `, [personId]);
        const loanId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Tx A: older ('2026-01-10')
        db.run(`
            INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date)
            VALUES (?, ?, 'PRINCIPAL_RECEIVED', 100000, '2026-01-10')
        `, [loanId, personId]);
        const txAId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Tx B: newer ('2026-02-10')
        db.run(`
            INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date)
            VALUES (?, ?, 'PRINCIPAL_RECEIVED', 200000, '2026-02-10')
        `, [loanId, personId]);
        const txBId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Tx C: newest ('2026-03-10')
        db.run(`
            INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date)
            VALUES (?, ?, 'PRINCIPAL_RECEIVED', 300000, '2026-03-10')
        `, [loanId, personId]);
        const txCId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const items = getRecentActivity(db);

        assert.strictEqual(items.length, 3);
        assert.strictEqual(items[0].activity_id, txCId);
        assert.strictEqual(items[0].date_time, '2026-03-10');

        assert.strictEqual(items[1].activity_id, txBId);
        assert.strictEqual(items[1].date_time, '2026-02-10');

        assert.strictEqual(items[2].activity_id, txAId);
        assert.strictEqual(items[2].date_time, '2026-01-10');
    });

    // ─── Test 4: Limit (§23.4) ───────────────────────────────────
    console.log('\n--- Test 4: Limit Handling ---');
    await runTest('Test 4 — 15 transactions with default limit 10 returns 10 most recent', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Chetan Bhagat', '9876543212')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 5000000, 5000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')
        `, [personId]);
        const loanId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Create 15 transactions on sequential dates 2026-01-01 -> 2026-01-15
        for (let i = 1; i <= 15; i++) {
            const day = String(i).padStart(2, '0');
            db.run(`
                INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (?, ?, 'PRINCIPAL_RECEIVED', ?, '2026-01-${day}')
            `, [loanId, personId, i * 10000]);
        }

        // Default limit (10)
        const itemsDefault = getRecentActivity(db);
        assert.strictEqual(itemsDefault.length, 10);
        // Most recent should be day 15, oldest in result should be day 06
        assert.strictEqual(itemsDefault[0].date_time, '2026-01-15');
        assert.strictEqual(itemsDefault[9].date_time, '2026-01-06');

        // Custom limit (5)
        const itemsCustom = getRecentActivity(db, { limit: 5 });
        assert.strictEqual(itemsCustom.length, 5);
        assert.strictEqual(itemsCustom[0].date_time, '2026-01-15');
        assert.strictEqual(itemsCustom[4].date_time, '2026-01-11');
    });

    // ─── Test 5: Multiple loans for one person (§23.5) ───────────
    console.log('\n--- Test 5: Multiple Loans For One Person ---');
    await runTest('Test 5 — Transactions point to correct loan_id for person with multiple loans', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Deepak Chopra', '9876543213')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Loan 1
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 100000, 100000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-06-01', 'ACTIVE')
        `, [personId]);
        const loan1Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Loan 2
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 200000, 200000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-06-01', 'ACTIVE')
        `, [personId]);
        const loan2Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Tx on Loan 1
        db.run(`
            INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date)
            VALUES (?, ?, 'PRINCIPAL_RECEIVED', 50000, '2026-02-01')
        `, [loan1Id, personId]);

        // Tx on Loan 2
        db.run(`
            INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date)
            VALUES (?, ?, 'PRINCIPAL_RECEIVED', 75000, '2026-02-05')
        `, [loan2Id, personId]);

        const items = getRecentActivity(db);
        assert.strictEqual(items.length, 2);

        // Newest tx (Loan 2)
        assert.strictEqual(items[0].loan_id, loan2Id);
        assert.strictEqual(items[0].amount, 750.00);

        // Older tx (Loan 1)
        assert.strictEqual(items[1].loan_id, loan1Id);
        assert.strictEqual(items[1].amount, 500.00);
    });

    // ─── Test 6: Multiple people (§23.6) ─────────────────────────
    console.log('\n--- Test 6: Multiple People ---');
    await runTest('Test 6 — Correct person is associated with each activity', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Person A', '9000000001')");
        const p1Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;
        db.run("INSERT INTO people (name, phone) VALUES ('Person B', '9000000002')");
        const p2Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 100000, 100000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-06-01', 'ACTIVE')`, [p1Id]);
        const l1Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 100000, 100000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-06-01', 'ACTIVE')`, [p2Id]);
        const l2Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (?, ?, 'PRINCIPAL_RECEIVED', 20000, '2026-03-01')`, [l1Id, p1Id]);
        db.run(`INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (?, ?, 'INTEREST_RECEIVED', 30000, '2026-03-02')`, [l2Id, p2Id]);

        const items = getRecentActivity(db);
        assert.strictEqual(items.length, 2);

        assert.strictEqual(items[0].person_name, 'Person B');
        assert.strictEqual(items[0].person_id, p2Id);
        assert.strictEqual(items[0].activity_type, 'INTEREST_RECEIVED');

        assert.strictEqual(items[1].person_name, 'Person A');
        assert.strictEqual(items[1].person_id, p1Id);
        assert.strictEqual(items[1].activity_type, 'PRINCIPAL_RECEIVED');
    });

    // ─── Test 7: Same timestamp deterministic ordering (§23.7) ──
    console.log('\n--- Test 7: Same Timestamp Deterministic Ordering ---');
    await runTest('Test 7 — Two transactions with same date ordered deterministically by id DESC', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Gaurav Kapoor', '9876543214')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 500000, 500000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-06-01', 'ACTIVE')`, [personId]);
        const loanId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Insert first tx on 2026-04-10
        db.run(`INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date, notes)
                VALUES (?, ?, 'PRINCIPAL_RECEIVED', 10000, '2026-04-10', 'First inserted')`, [loanId, personId]);
        const id1 = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Insert second tx on SAME date 2026-04-10
        db.run(`INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date, notes)
                VALUES (?, ?, 'PRINCIPAL_RECEIVED', 20000, '2026-04-10', 'Second inserted')`, [loanId, personId]);
        const id2 = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const items = getRecentActivity(db);
        assert.strictEqual(items.length, 2);

        // id2 was inserted second -> higher ID -> appears first
        assert.strictEqual(items[0].activity_id, id2);
        assert.strictEqual(items[0].notes, 'Second inserted');

        assert.strictEqual(items[1].activity_id, id1);
        assert.strictEqual(items[1].notes, 'First inserted');
    });

    // ─── Test 8: Reversed transaction (§23.8) ────────────────────
    console.log('\n--- Test 8: Reversed Transaction ---');
    await runTest('Test 8 — Transaction with reversal note / status follows status convention', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Harish Salve', '9876543215')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 1000000, 1000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-06-01', 'ACTIVE')`, [personId]);
        const loanId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Transaction annotated as REVERSED
        db.run(`INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date, notes)
                VALUES (?, ?, 'OTHER', 50000, '2026-05-01', 'REVERSED: payment bounced')`, [loanId, personId]);

        const items = getRecentActivity(db);
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].status, 'REVERSED');
    });

    // ─── Test 9: Unauthorized activity (§23.9) ───────────────────
    console.log('\n--- Test 9: Unauthorized Activity / Scoping ---');
    await runTest('Test 9 — Scoping via person_id isolates data, rejects invalid inputs (404/400)', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('User Alpha', '9111111111')");
        const p1Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;
        db.run("INSERT INTO people (name, phone) VALUES ('User Beta', '9222222222')");
        const p2Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 100000, 100000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-06-01', 'ACTIVE')`, [p1Id]);
        const l1Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 200000, 200000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-06-01', 'ACTIVE')`, [p2Id]);
        const l2Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (?, ?, 'PRINCIPAL_RECEIVED', 10000, '2026-05-10')`, [l1Id, p1Id]);

        db.run(`INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (?, ?, 'PRINCIPAL_RECEIVED', 20000, '2026-05-11')`, [l2Id, p2Id]);

        // Scoped to User Alpha
        const alphaItems = getRecentActivity(db, { person_id: p1Id });
        assert.strictEqual(alphaItems.length, 1);
        assert.strictEqual(alphaItems[0].person_id, p1Id);
        assert.strictEqual(alphaItems[0].amount, 100.00);

        // Scoped to User Beta
        const betaItems = getRecentActivity(db, { person_id: p2Id });
        assert.strictEqual(betaItems.length, 1);
        assert.strictEqual(betaItems[0].person_id, p2Id);
        assert.strictEqual(betaItems[0].amount, 200.00);

        // Non-existent person -> 404
        assert.throws(() => {
            getRecentActivity(db, { person_id: 99999 });
        }, (err) => err.statusCode === 404);

        // Invalid person_id -> 400
        assert.throws(() => {
            getRecentActivity(db, { person_id: 'invalid-id' });
        }, (err) => err.statusCode === 400);
    });

    // ─── Test 10: Read-only (§23.10) ─────────────────────────────
    console.log('\n--- Test 10: Read-Only Verification ---');
    await runTest('Test 10 — getRecentActivity performs zero database mutations', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Irfan Pathan', '9876543216')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 100000, 100000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-06-01', 'ACTIVE')`, [personId]);
        const loanId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`INSERT INTO transactions (account_id, person_id, transaction_type, amount, transaction_date)
                VALUES (?, ?, 'PRINCIPAL_RECEIVED', 25000, '2026-06-01')`, [loanId, personId]);

        const getCounts = () => ({
            people: queryOne(db, 'SELECT COUNT(*) as c FROM people').c,
            accounts: queryOne(db, 'SELECT COUNT(*) as c FROM accounts').c,
            transactions: queryOne(db, 'SELECT COUNT(*) as c FROM transactions').c,
            interest_records: queryOne(db, 'SELECT COUNT(*) as c FROM interest_records').c
        });

        const before = getCounts();

        // Query multiple times with different parameters
        getRecentActivity(db);
        getRecentActivity(db, { person_id: personId });
        getRecentActivity(db, { limit: 5 });

        const after = getCounts();
        assert.deepStrictEqual(before, after);
    });

    // ─── Test 11: Cross-check with domain records (§24) ──────────
    console.log('\n--- Test 11: Cross-Check With Transaction Records ---');
    await runTest('Test 11 — Activity fields match Part 5 transaction records without transformation', async () => {
        const db = await createFreshInMemoryDb(SQL);

        db.run("INSERT INTO people (name, phone) VALUES ('Jasprit Bumrah', '9876543217')");
        const personId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`INSERT INTO accounts (person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (?, 'MONEY_GIVEN', 500000, 500000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-06-01', 'ACTIVE')`, [personId]);
        const loanId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`INSERT INTO transactions (account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference, notes)
                VALUES (?, ?, 'INTEREST_RECEIVED', 123456, 'BANK_TRANSFER', '2026-07-01', 'TX-MATCH-01', 'Audit verified')`, [loanId, personId]);
        const txId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const rawTx = queryOne(db, 'SELECT * FROM transactions WHERE id = ?', [txId]);
        const activity = getRecentActivity(db)[0];

        assert.strictEqual(activity.activity_id, rawTx.id);
        assert.strictEqual(activity.amount_paisa, rawTx.amount);
        assert.strictEqual(activity.activity_type, rawTx.transaction_type);
        assert.strictEqual(activity.date_time, rawTx.transaction_date);
        assert.strictEqual(activity.reference, rawTx.reference);
        assert.strictEqual(activity.notes, rawTx.notes);
        assert.strictEqual(activity.payment_method, rawTx.payment_method);
    });

    // ─── Test 12: Live API Endpoints (§12) ───────────────────────
    console.log('\n--- Test 12: Live API Endpoints ---');
    await runTest('Test 12 — Live HTTP GET /api/dashboard/recent-activity and alias /api/dashboard/activity', async () => {
        const res1 = await httpRequest('GET', '/dashboard/recent-activity');
        assert.strictEqual(res1.statusCode, 200);
        assert.strictEqual(Array.isArray(res1.body.items), true);
        assert.strictEqual(typeof res1.body.count, 'number');

        // Test alias endpoint
        const res2 = await httpRequest('GET', '/dashboard/activity');
        assert.strictEqual(res2.statusCode, 200);
        assert.strictEqual(Array.isArray(res2.body.items), true);

        // Test limit query parameter
        const res3 = await httpRequest('GET', '/dashboard/recent-activity?limit=3');
        assert.strictEqual(res3.statusCode, 200);
        assert.strictEqual(res3.body.items.length <= 3, true);

        // Test 404 for non-existent person
        const res4 = await httpRequest('GET', '/dashboard/recent-activity?person_id=99999');
        assert.strictEqual(res4.statusCode, 404);

        // Test 400 for invalid person_id
        const res5 = await httpRequest('GET', '/dashboard/recent-activity?person_id=invalid');
        assert.strictEqual(res5.statusCode, 400);
    });

    console.log('\n================================================================');
    console.log(`Step 7G Tests: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runAll().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
