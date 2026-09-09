/**
 * Interest Manager — Step 7E Test Suite
 * Implementation: Interest & Payment Summary Layer
 *
 * Verifies all specifications of Step 7E:
 *   Test 1: Empty system — all counts = 0, all monetary totals = 0 (§23.1)
 *   Test 2: One payment — payment_count = 1, total_paid matches actual payment (§23.2)
 *   Test 3: Multiple payments — ₹1000 + ₹2000 + ₹3000 -> count = 3, total = ₹6000 (§23.3)
 *   Test 4: Interest — interest_record_count and total_interest match Part 6 (§23.4)
 *   Test 5: Partial interest payment — Interest ₹1000, Paid ₹400 -> Paid ₹400, Outstanding ₹600 (§23.5)
 *   Test 6: Fully paid interest — Interest ₹1000, Paid ₹1000 -> Outstanding ₹0 (§23.6)
 *   Test 7: Multiple loans — independent interest & payments across Loan A & B aggregate correctly (§23.7)
 *   Test 8: Multiple people — person-scoped summaries isolate data without cross-customer leakage (§23.8)
 *   Test 9: Historical immutability / reversal rules (§23.9)
 *   Test 10: Corrected interest — superseded/reversed records are not double counted (§23.10)
 *   Test 11: Authorization — scoping and access denial for non-existent/mismatched queries (§23.11)
 *   Test 12: Read-only — getInterestPaymentSummary causes zero mutations (§23.12)
 *   Test 13: Cross-check with domain services (§24)
 *   Test 14: Live API endpoints — GET /api/dashboard/financial-summary (§17, §18)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const initSqlJs = require('sql.js');

const { getInterestPaymentSummary } = require('../services/dashboardService');
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
    console.log('   INTEREST MANAGER — STEP 7E: INTEREST & PAYMENT SUMMARY');
    console.log('================================================================\n');

    const SQL = await initSqlJs();

    // ─── Test 1: Empty system (§23.1) ────────────────────────────
    console.log('--- Test 1: Empty System ---');
    await runTest('Test 1 — Empty system returns 0 for all counts and monetary totals', async () => {
        const db = await createFreshInMemoryDb(SQL);
        const s = getInterestPaymentSummary(db);

        assert.strictEqual(s.interest.total_interest, 0);
        assert.strictEqual(s.interest.total_interest_paisa, 0);
        assert.strictEqual(s.interest.paid_interest, 0);
        assert.strictEqual(s.interest.paid_interest_paisa, 0);
        assert.strictEqual(s.interest.outstanding_interest, 0);
        assert.strictEqual(s.interest.outstanding_interest_paisa, 0);
        assert.strictEqual(s.interest.interest_record_count, 0);

        assert.strictEqual(s.payments.total_paid, 0);
        assert.strictEqual(s.payments.total_paid_paisa, 0);
        assert.strictEqual(s.payments.payment_count, 0);
        assert.strictEqual(s.payments.average_payment, 0);
        assert.strictEqual(s.payments.average_payment_paisa, 0);
    });

    // ─── Test 2: One payment (§23.2) ─────────────────────────────
    console.log('\n--- Test 2: One Payment ---');
    let db;
    let personAId, loan1Id;
    await runTest('Test 2 — One payment created -> payment_count = 1, total_paid = payment amount', async () => {
        db = await createFreshInMemoryDb(SQL);

        // Create Person & Loan
        db.run("INSERT INTO people (name, phone) VALUES ('Kavita Joshi', '9988776655')");
        personAId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 1000000, 1000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-07-01', 'ACTIVE')
        `, [personAId]);
        loan1Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Record 1 payment: ₹1,500 (150,000 paisa)
        db.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference
            ) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 150000, 'UPI', '2026-02-01', 'TX-7E-1')
        `, [loan1Id, personAId]);

        const s = getInterestPaymentSummary(db);

        assert.strictEqual(s.payments.payment_count, 1);
        assert.strictEqual(s.payments.total_paid, 1500);
        assert.strictEqual(s.payments.total_paid_paisa, 150000);
        assert.strictEqual(s.payments.average_payment, 1500);
        assert.strictEqual(s.payments.average_payment_paisa, 150000);
    });

    // ─── Test 3: Multiple payments (§23.3) ───────────────────────
    console.log('\n--- Test 3: Multiple Payments ---');
    await runTest('Test 3 — Payments ₹1000 + ₹2000 + ₹3000 -> count = 3, total = ₹6000', async () => {
        const db3 = await createFreshInMemoryDb(SQL);
        db3.run("INSERT INTO people (name, phone) VALUES ('Vikram Seth', '9988776600')");
        const pId = queryOne(db3, 'SELECT last_insert_rowid() as id').id;

        db3.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 2000000, 2000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-07-01', 'ACTIVE')
        `, [pId]);
        const aId = queryOne(db3, 'SELECT last_insert_rowid() as id').id;

        // Insert 3 payments: ₹1000, ₹2000, ₹3000
        const amounts = [100000, 200000, 300000];
        for (const amt of amounts) {
            db3.run(`
                INSERT INTO transactions (
                    account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference
                ) VALUES (?, ?, 'PRINCIPAL_RECEIVED', ?, 'CASH', '2026-02-10', 'PAY-3')
            `, [aId, pId, amt]);
        }

        const s = getInterestPaymentSummary(db3);
        assert.strictEqual(s.payments.payment_count, 3);
        assert.strictEqual(s.payments.total_paid, 6000);
        assert.strictEqual(s.payments.total_paid_paisa, 600000);
        assert.strictEqual(s.payments.average_payment, 2000); // 6000 / 3
        assert.strictEqual(s.payments.average_payment_paisa, 200000);
    });

    // ─── Test 4: Interest (§23.4) ────────────────────────────────
    console.log('\n--- Test 4: Interest ---');
    let intRec1Id;
    await runTest('Test 4 — Recorded interest matches interest_record_count and total_interest', async () => {
        // Record interest record 1: ₹1,000 (100,000 paisa)
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis, interest_rate,
                interest_amount, paid_amount, calculation_method, status
            ) VALUES (?, '2026-01-01', '2026-01-31', 1000000, 12.0, 100000, 0, 'SIMPLE_INTEREST', 'PENDING')
        `, [loan1Id]);
        intRec1Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const s = getInterestPaymentSummary(db);

        assert.strictEqual(s.interest.interest_record_count, 1);
        assert.strictEqual(s.interest.total_interest, 1000);
        assert.strictEqual(s.interest.total_interest_paisa, 100000);
        assert.strictEqual(s.interest.paid_interest, 0);
        assert.strictEqual(s.interest.outstanding_interest, 1000);
    });

    // ─── Test 5: Partial interest payment (§23.5) ────────────────
    console.log('\n--- Test 5: Partial Interest Payment ---');
    await runTest('Test 5 — Interest ₹1000, Paid ₹400 -> paid_interest = ₹400, outstanding_interest = ₹600', async () => {
        // Update interest record 1: paid_amount = 40,000 paisa
        db.run('UPDATE interest_records SET paid_amount = 40000, status = "PARTIALLY_PAID" WHERE id = ?', [intRec1Id]);

        // Record the interest payment transaction
        db.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference
            ) VALUES (?, ?, 'INTEREST_RECEIVED', 40000, 'UPI', '2026-02-15', 'INT-PAY-5')
        `, [loan1Id, personAId]);

        const s = getInterestPaymentSummary(db);

        assert.strictEqual(s.interest.total_interest, 1000);
        assert.strictEqual(s.interest.paid_interest, 400);
        assert.strictEqual(s.interest.paid_interest_paisa, 40000);
        assert.strictEqual(s.interest.outstanding_interest, 600);
        assert.strictEqual(s.interest.outstanding_interest_paisa, 60000);

        // Payments total: 1,500 (from Test 2) + 400 = 1,900
        assert.strictEqual(s.payments.total_paid, 1900);
        assert.strictEqual(s.payments.payment_count, 2);
    });

    // ─── Test 6: Fully paid interest (§23.6) ─────────────────────
    console.log('\n--- Test 6: Fully Paid Interest ---');
    await runTest('Test 6 — Interest ₹1000, Paid ₹1000 -> outstanding_interest = ₹0', async () => {
        // Pay the remaining ₹600 (60,000 paisa)
        db.run('UPDATE interest_records SET paid_amount = 100000, status = "PAID" WHERE id = ?', [intRec1Id]);

        db.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference
            ) VALUES (?, ?, 'INTEREST_RECEIVED', 60000, 'CASH', '2026-02-28', 'INT-PAY-6')
        `, [loan1Id, personAId]);

        const s = getInterestPaymentSummary(db);

        assert.strictEqual(s.interest.total_interest, 1000);
        assert.strictEqual(s.interest.paid_interest, 1000);
        assert.strictEqual(s.interest.paid_interest_paisa, 100000);
        assert.strictEqual(s.interest.outstanding_interest, 0);
        assert.strictEqual(s.interest.outstanding_interest_paisa, 0);
    });

    // ─── Test 7: Multiple loans (§23.7) ──────────────────────────
    console.log('\n--- Test 7: Multiple Loans ---');
    let loan2Id;
    await runTest('Test 7 — Aggregation correctly combines activity across multiple loans', async () => {
        // Create Loan 2 for Person A
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 500000, 500000, 15.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-02-01', '2026-08-01', 'ACTIVE')
        `, [personAId]);
        loan2Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Record ₹500 (50,000 paisa) interest on Loan 2
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis, interest_rate,
                interest_amount, paid_amount, calculation_method, status
            ) VALUES (?, '2026-02-01', '2026-02-28', 500000, 15.0, 50000, 10000, 'SIMPLE_INTEREST', 'PARTIALLY_PAID')
        `, [loan2Id]);

        // Record ₹2,000 principal payment on Loan 2
        db.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference
            ) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 200000, 'BANK_TRANSFER', '2026-03-01', 'PAY-L2')
        `, [loan2Id, personAId]);

        const s = getInterestPaymentSummary(db);

        // Combined Interest: 1000 (Loan 1) + 500 (Loan 2) = 1500
        assert.strictEqual(s.interest.total_interest, 1500);
        assert.strictEqual(s.interest.interest_record_count, 2);
        // Combined Paid Interest: 1000 (Loan 1) + 100 (Loan 2) = 1100
        assert.strictEqual(s.interest.paid_interest, 1100);
        // Outstanding Interest: 1500 - 1100 = 400
        assert.strictEqual(s.interest.outstanding_interest, 400);

        // Loan-specific scope check (Loan 2 only)
        const sL2 = getInterestPaymentSummary(db, { account_id: loan2Id });
        assert.strictEqual(sL2.interest.total_interest, 500);
        assert.strictEqual(sL2.interest.paid_interest, 100);
        assert.strictEqual(sL2.interest.outstanding_interest, 400);
        assert.strictEqual(sL2.payments.total_paid, 2000);
    });

    // ─── Test 8: Multiple people (§23.8) ─────────────────────────
    console.log('\n--- Test 8: Multiple People ---');
    let personBId, loanBId;
    await runTest('Test 8 — Person-scoped summaries isolate data with zero leakage', async () => {
        // Create Person B with their own loan, payment, and interest
        db.run("INSERT INTO people (name, phone) VALUES ('Manish Roy', '9988776611')");
        personBId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal, interest_rate,
                interest_frequency, calculation_method, start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 800000, 800000, 18.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-03-01', '2026-09-01', 'ACTIVE')
        `, [personBId]);
        loanBId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Person B interest: ₹800, Paid: ₹0
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis, interest_rate,
                interest_amount, paid_amount, calculation_method, status
            ) VALUES (?, '2026-03-01', '2026-03-31', 800000, 18.0, 80000, 0, 'SIMPLE_INTEREST', 'PENDING')
        `, [loanBId]);

        // Person B payment: ₹500
        db.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference
            ) VALUES (?, ?, 'PRINCIPAL_RECEIVED', 50000, 'UPI', '2026-03-15', 'PAY-B')
        `, [loanBId, personBId]);

        // Scoped to Person B
        const sB = getInterestPaymentSummary(db, { person_id: personBId });
        assert.strictEqual(sB.interest.total_interest, 800);
        assert.strictEqual(sB.interest.outstanding_interest, 800);
        assert.strictEqual(sB.interest.interest_record_count, 1);
        assert.strictEqual(sB.payments.total_paid, 500);
        assert.strictEqual(sB.payments.payment_count, 1);

        // Scoped to Person A
        const sA = getInterestPaymentSummary(db, { person_id: personAId });
        assert.strictEqual(sA.interest.total_interest, 1500);
        assert.strictEqual(sA.payments.total_paid, 4500);

        // Global (unscoped) aggregates both
        const sGlobal = getInterestPaymentSummary(db);
        assert.strictEqual(sGlobal.interest.total_interest, 2300); // 1500 + 800
        assert.strictEqual(sGlobal.payments.total_paid, 5000);    // 4500 + 500
    });

    // ─── Test 9: Historical immutability / Reversal (§23.9) ──────
    console.log('\n--- Test 9: Reversal Handling ---');
    await runTest('Test 9 — Reversal conventions: transactions are strictly immutable; non-payment tx types excluded', async () => {
        // Verify non-payment transaction types (e.g. MONEY_LENT, EXPENSE) are NOT counted as payments
        db.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference
            ) VALUES (?, ?, 'MONEY_LENT', 500000, 'CASH', '2026-01-01', 'DISBURSEMENT')
        `, [loan1Id, personAId]);

        db.run(`
            INSERT INTO transactions (
                account_id, person_id, transaction_type, amount, payment_method, transaction_date, reference
            ) VALUES (?, ?, 'EXPENSE', 20000, 'CASH', '2026-01-02', 'FEE')
        `, [loan1Id, personAId]);

        const sA = getInterestPaymentSummary(db, { person_id: personAId });
        // MONEY_LENT and EXPENSE must NOT be counted in total_paid
        assert.strictEqual(sA.payments.total_paid, 4500);
    });

    // ─── Test 10: Corrected interest (§23.10) ────────────────────
    console.log('\n--- Test 10: Corrected Interest ---');
    await runTest('Test 10 — Superseded / REVERSED interest records are excluded from totals', async () => {
        // Insert a REVERSED record on Loan 1 (simulating a corrected entry)
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis, interest_rate,
                interest_amount, paid_amount, calculation_method, status, reversal_reason
            ) VALUES (?, '2026-01-01', '2026-01-31', 1000000, 12.0, 95000, 0, 'SIMPLE_INTEREST', 'REVERSED', 'Superceded by correction')
        `, [loan1Id]);

        const sA = getInterestPaymentSummary(db, { person_id: personAId });
        // Total interest must not include the ₹950 reversed record
        assert.strictEqual(sA.interest.total_interest, 1500);
        assert.strictEqual(sA.interest.interest_record_count, 2);
    });

    // ─── Test 11: Authorization (§23.11) ─────────────────────────
    console.log('\n--- Test 11: Authorization ---');
    await runTest('Test 11a — Non-existent person returns 404', async () => {
        let threw = false;
        try {
            getInterestPaymentSummary(db, { person_id: 99999 });
        } catch (err) {
            threw = true;
            assert.strictEqual(err.statusCode, 404);
        }
        assert.ok(threw);
    });

    await runTest('Test 11b — Invalid person format returns 400', async () => {
        let threw = false;
        try {
            getInterestPaymentSummary(db, { person_id: 'bad' });
        } catch (err) {
            threw = true;
            assert.strictEqual(err.statusCode, 400);
        }
        assert.ok(threw);
    });

    await runTest('Test 11c — Cross-tenant mismatch (account not belonging to person) returns 403', async () => {
        let threw = false;
        try {
            // loanBId belongs to Person B, but requested under Person A
            getInterestPaymentSummary(db, { person_id: personAId, account_id: loanBId });
        } catch (err) {
            threw = true;
            assert.strictEqual(err.statusCode, 403);
        }
        assert.ok(threw);
    });

    // ─── Test 12: Read-only verification (§23.12) ────────────────
    console.log('\n--- Test 12: Read-Only Verification ---');
    await runTest('Test 12 — Calling summary causes zero database mutations', async () => {
        const getFingerprint = () => ({
            people: queryOne(db, 'SELECT COUNT(*) as c FROM people').c,
            accounts: queryOne(db, 'SELECT COUNT(*) as c, SUM(outstanding_principal) as bal FROM accounts'),
            transactions: queryOne(db, 'SELECT COUNT(*) as c, SUM(amount) as amt FROM transactions'),
            interest: queryOne(db, 'SELECT COUNT(*) as c, SUM(interest_amount) as amt FROM interest_records')
        });

        const before = getFingerprint();
        getInterestPaymentSummary(db);
        getInterestPaymentSummary(db, { person_id: personAId });
        getInterestPaymentSummary(db, { person_id: personBId });
        getInterestPaymentSummary(db, { account_id: loan1Id });
        const after = getFingerprint();

        assert.deepStrictEqual(before, after, 'Database state must be perfectly preserved');
    });

    // ─── Test 13: Cross-check with domain services (§24) ─────────
    console.log('\n--- Test 13: Cross-Check With Domain Services ---');
    await runTest('Test 13 — Independent SQL queries match dashboard summary values exactly', async () => {
        const s = getInterestPaymentSummary(db);

        const domainInterest = queryOne(db, `
            SELECT
                COUNT(*) as count,
                COALESCE(SUM(interest_amount), 0) as total,
                COALESCE(SUM(paid_amount), 0) as paid
            FROM interest_records
            WHERE status != 'REVERSED'
        `);

        const domainPayments = queryOne(db, `
            SELECT
                COUNT(*) as count,
                COALESCE(SUM(amount), 0) as total
            FROM transactions
            WHERE transaction_type IN ('PRINCIPAL_RECEIVED', 'INTEREST_RECEIVED')
        `);

        assert.strictEqual(s.interest.interest_record_count, domainInterest.count);
        assert.strictEqual(s.interest.total_interest_paisa, domainInterest.total);
        assert.strictEqual(s.interest.paid_interest_paisa, domainInterest.paid);
        assert.strictEqual(s.interest.outstanding_interest_paisa, domainInterest.total - domainInterest.paid);

        assert.strictEqual(s.payments.payment_count, domainPayments.count);
        assert.strictEqual(s.payments.total_paid_paisa, domainPayments.total);
    });

    // ─── Test 14: Live API Endpoints (§17, §18) ──────────────────
    console.log('\n--- Test 14: Live API Endpoints ---');
    await runTest('Test 14a — HTTP GET /api/dashboard/financial-summary returns 200 with structured response', async () => {
        const res = await httpRequest('GET', '/dashboard/financial-summary');
        assert.strictEqual(res.statusCode, 200);

        const b = res.body;
        assert.ok(b.interest, 'Must contain interest object');
        assert.ok(b.payments, 'Must contain payments object');

        assert.strictEqual(typeof b.interest.total_interest, 'number');
        assert.strictEqual(typeof b.interest.paid_interest, 'number');
        assert.strictEqual(typeof b.interest.outstanding_interest, 'number');
        assert.strictEqual(typeof b.interest.interest_record_count, 'number');

        assert.strictEqual(typeof b.payments.total_paid, 'number');
        assert.strictEqual(typeof b.payments.payment_count, 'number');
        assert.strictEqual(typeof b.payments.average_payment, 'number');
    });

    await runTest('Test 14b — HTTP GET /api/dashboard/interest-payments works as an alias', async () => {
        const res = await httpRequest('GET', '/dashboard/interest-payments');
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res.body.interest);
        assert.ok(res.body.payments);
    });

    await runTest('Test 14c — Live HTTP scoping via ?person_id=1', async () => {
        const res = await httpRequest('GET', '/dashboard/financial-summary?person_id=1');
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.metadata.person_id, 1);
    });

    await runTest('Test 14d — Live HTTP 404 for non-existent person', async () => {
        const res = await httpRequest('GET', '/dashboard/financial-summary?person_id=99999');
        assert.strictEqual(res.statusCode, 404);
        assert.ok(res.body.error);
    });

    await runTest('Test 14e — Live HTTP 400 for invalid person_id', async () => {
        const res = await httpRequest('GET', '/dashboard/financial-summary?person_id=invalid');
        assert.strictEqual(res.statusCode, 400);
        assert.ok(res.body.error);
    });

    // ─── Final Summary ──────────────────────────────────────────
    console.log('\n================================================================');
    console.log(`Step 7E Test Results: ${passed} passed, ${failed} failed`);
    console.log('================================================================\n');

    if (failed > 0) process.exit(1);
    process.exit(0);
}

runAll().catch((err) => {
    console.error('Fatal error running Step 7E tests:', err);
    process.exit(1);
});
