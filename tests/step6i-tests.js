/**
 * Interest Manager — Step 6I: Recalculation & Correction Tests
 *
 * Verifies:
 *   Test 1: Recalculate unchanged amount (Original = ₹100, Correct = ₹100 → No unnecessary correction)
 *   Test 2: Correct unpaid record (Original = ₹100, Correct = ₹80, Paid = ₹0 → Original preserved, Corrected = ₹80)
 *   Test 3: Original calculation snapshot (Original record preserves principal, rate, days, amount, period)
 *   Test 4: Correct calculation (Uses actual 6B/6C/6D engine to compute corrected amount dynamically)
 *   Test 5: Duplicate correction (Submitting same correction twice handled idempotently, no duplicate created)
 *   Test 6: Invalid record (Attempting to correct nonexistent record fails with 404 domain error)
 *   Test 7: Transaction rollback (Forced failure rolls back cleanly leaving original unchanged and no partial record)
 *   Test 8: History integration (6H exposes original REVERSED record and new PENDING corrected record with linkage)
 *   Test 9: Paid interest protection (Partially/fully paid records safely rejected as UNSUPPORTED, payments intact)
 *   Test 10: Authorization enforcement (Unauthorized actor rejected with 403 error)
 *   Test 11: Audit log integration (INTEREST_CORRECTED audit event written with old/new amounts & difference)
 *   Test 12: Difference calculation (Verifies exact signed financial difference)
 *   Test 13: Read-only preview (recalculateInterestForRecord causes zero database mutations)
 *   Test 14: HTTP API endpoints (/recalculate and /correct work seamlessly over HTTP)
 */

const assert = require('assert');
const { getDatabase } = require('../db/connection');
const { queryOne, queryAll } = require('../db/helpers');
const { calculateAccrual } = require('../services/interestAccrualService');
const { recordAccrualResult } = require('../services/interestRecordingService');
const { allocatePaymentToInterestRecord } = require('../services/interestPaymentService');
const { getAccountInterestHistory } = require('../services/interestHistoryService');
const {
    recalculateInterestForRecord,
    correctInterestRecord
} = require('../services/interestCorrectionService');

let passedTests = 0;
let failedTests = 0;

async function testAsync(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        if (err.stack) {
            console.error(`    ${err.stack.split('\n').slice(1, 4).join('\n')}`);
        }
        failedTests++;
    }
}

async function runStep6ITests() {
    console.log('\n================================================================');
    console.log('   INTEREST MANAGER — STEP 6I: RECALCULATION & CORRECTION TESTS');
    console.log('================================================================\n');

    const db = await getDatabase();

    // Helper: Create fresh person
    function createTestPerson(name, phone) {
        db.run('INSERT INTO people (name, phone) VALUES (?, ?)', [name, phone]);
        return queryOne(db, 'SELECT last_insert_rowid() as id').id;
    }

    // Helper: Create fresh account
    function createTestAccount(personId, principal = 1000000, rate = 12, direction = 'MONEY_GIVEN', startDate = '2026-01-01') {
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (?, ?, ?, ?, ?, 'MONTHLY', 'SIMPLE_INTEREST', ?, '2026-12-31', 'ACTIVE')
        `, [personId, direction, principal, principal, rate, startDate]);
        return queryOne(db, 'SELECT last_insert_rowid() as id').id;
    }

    // Helper: Record interest directly
    function insertCustomInterestRecord(accountId, { periodStart, periodEnd, principalPaisa, rate, amountPaisa, status = 'PENDING', source = 'MANUAL' }) {
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis,
                interest_rate, calculation_method, interest_amount,
                paid_amount, status, source
            ) VALUES (?, ?, ?, ?, ?, 'SIMPLE_INTEREST', ?, 0, ?, ?)
        `, [accountId, periodStart, periodEnd, principalPaisa, rate, amountPaisa, status, source]);
        return queryOne(db, 'SELECT last_insert_rowid() as id').id;
    }

    // ─── Test 1: Recalculate Unchanged Amount ───
    console.log('--- Test 1: Zero Difference / No Change ---');
    await testAsync('Test 1 — Recalculate unchanged amount (Original = ₹100, Correct = ₹100 → No unnecessary correction)', async () => {
        const pId = createTestPerson('Correction P1', '9980001001');
        const accId = createTestAccount(pId, 1000000, 12); // ₹10,000 @ 12%

        // 30 days of ₹10,000 @ 12% is ₹98.63 (9863 paisa)
        const recId = insertCustomInterestRecord(accId, {
            periodStart: '2026-01-01',
            periodEnd: '2026-01-31',
            principalPaisa: 1000000,
            rate: 12,
            amountPaisa: 9863
        });

        const countBefore = queryOne(db, 'SELECT COUNT(*) as count FROM interest_records').count;

        // Attempt correction with exact same parameters (no change)
        const res = correctInterestRecord(db, recId);

        assert.strictEqual(res.status, 'NO_CHANGE');
        assert.strictEqual(res.changed, false);
        assert.strictEqual(res.difference, 0);
        assert.strictEqual(res.difference_paisa, 0);

        const countAfter = queryOne(db, 'SELECT COUNT(*) as count FROM interest_records').count;
        assert.strictEqual(countAfter, countBefore, 'Zero new records should be created when difference is zero');

        const original = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [recId]);
        assert.strictEqual(original.status, 'PENDING', 'Original record status must remain unchanged');
    });

    // ─── Test 2: Correct Unpaid Record ───
    console.log('--- Test 2: Correct Unpaid Record ---');
    let test2OriginalId = null;
    let test2CorrectedId = null;
    await testAsync('Test 2 — Correct unpaid record (Original = ₹100, Correct = ₹80, Paid = ₹0)', async () => {
        const pId = createTestPerson('Correction P2', '9980001002');
        const accId = createTestAccount(pId, 1000000, 12);

        // Record original at ₹100 (10000 paisa)
        test2OriginalId = insertCustomInterestRecord(accId, {
            periodStart: '2026-01-01',
            periodEnd: '2026-01-31',
            principalPaisa: 1000000,
            rate: 12,
            amountPaisa: 10000
        });

        // Correct to rate = 9.7333% or specify principal/rate so interest becomes ₹80.00
        // ₹10,000 for 30 days @ 9.733333% = ₹80.00
        // Or override rate to 9.7333333
        // Or rate = 9.6 with days = 30 → let's check: 10000 * 0.0973333 * 30 / 365 = 80.00
        // Or we can provide a rate that yields ₹80.00 (e.g. rate = 9.733333) or override principal
        const correctedRate = (80 * 365 * 100) / (10000 * 30); // 9.733333333333334%

        const res = correctInterestRecord(db, test2OriginalId, {
            rate: correctedRate,
            reason: 'Correcting rate from 12% to audited agreed rate'
        });

        assert.strictEqual(res.status, 'CORRECTED');
        assert.strictEqual(res.changed, true);
        assert.strictEqual(res.original_record_id, test2OriginalId);
        assert.ok(res.corrected_record_id > 0);
        test2CorrectedId = res.corrected_record_id;

        // Verify corrected record
        const corrected = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [test2CorrectedId]);
        assert.strictEqual(corrected.interest_amount, 8000, 'Corrected interest amount must be ₹80.00 (8000 paisa)');
        assert.strictEqual(corrected.status, 'PENDING');
        assert.strictEqual(corrected.source, 'CORRECTION');
        assert.strictEqual(corrected.corrects_record_id, test2OriginalId);

        // Verify original record
        const original = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [test2OriginalId]);
        assert.strictEqual(original.interest_amount, 10000, 'Original record interest amount must remain ₹100.00 (10000 paisa)');
        assert.strictEqual(original.status, 'REVERSED');
        assert.strictEqual(original.corrected_by_record_id, test2CorrectedId);
        assert.strictEqual(original.reversal_source, 'CORRECTION');

        // Verify difference
        assert.strictEqual(res.difference, -20.00);
        assert.strictEqual(res.difference_paisa, -2000);
    });

    // ─── Test 3: Original Calculation Snapshot ───
    console.log('--- Test 3: Original Calculation Snapshot ---');
    await testAsync('Test 3 — Original calculation snapshot preserved after correction', async () => {
        const original = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [test2OriginalId]);

        assert.strictEqual(original.interest_amount, 10000, 'Original amount must be 10000 paisa');
        assert.strictEqual(original.principal_basis, 1000000, 'Original principal basis must be 1000000 paisa');
        assert.strictEqual(original.interest_rate, 12, 'Original rate must be 12%');
        assert.strictEqual(original.period_start, '2026-01-01');
        assert.strictEqual(original.period_end, '2026-01-31');
        assert.strictEqual(original.status, 'REVERSED');
        assert.strictEqual(original.corrected_by_record_id, test2CorrectedId);
    });

    // ─── Test 4: Correct Calculation Engine Integration ───
    console.log('--- Test 4: Dynamic Engine Calculation ---');
    await testAsync('Test 4 — Uses actual 6B/6C/6D engine (not hardcoded)', async () => {
        const pId = createTestPerson('Correction P4', '9980001004');
        const accId = createTestAccount(pId, 1000000, 12); // ₹10,000 @ 12%

        // Original was recorded with erroneous 18% rate (₹147.95)
        const origRecId = insertCustomInterestRecord(accId, {
            periodStart: '2026-01-01',
            periodEnd: '2026-01-31',
            principalPaisa: 1000000,
            rate: 18,
            amountPaisa: 14795
        });

        // Recalculate using correct 10% rate via Step 6B engine:
        // 10000 * 0.10 * 30 / 365 = 82.1917... → ₹82.19 (8219 paisa)
        const res = correctInterestRecord(db, origRecId, {
            rate: 10,
            reason: 'Agreed loan contract rate is 10%'
        });

        assert.strictEqual(res.corrected_record.interest_amount, 8219);
        assert.strictEqual(res.recalculation.calculated_interest, 82.19);
        assert.strictEqual(res.recalculation.days, 30);
        assert.strictEqual(res.recalculation.rate, 10);
        assert.strictEqual(res.difference, -65.76);
    });

    // ─── Test 5: Duplicate Correction (Idempotency) ───
    console.log('--- Test 5: Duplicate Correction ---');
    await testAsync('Test 5 — Duplicate correction handled idempotently', async () => {
        const countBefore = queryOne(db, 'SELECT COUNT(*) as count FROM interest_records').count;

        // Submit correction on test2OriginalId again
        const res = correctInterestRecord(db, test2OriginalId, {
            rate: (80 * 365 * 100) / (10000 * 30),
            reason: 'Resubmission of same correction'
        });

        assert.strictEqual(res.status, 'ALREADY_CORRECTED');
        assert.strictEqual(res.is_duplicate, true);
        assert.strictEqual(res.corrected_record_id, test2CorrectedId);

        const countAfter = queryOne(db, 'SELECT COUNT(*) as count FROM interest_records').count;
        assert.strictEqual(countAfter, countBefore, 'Duplicate correction must not insert additional records');
    });

    // ─── Test 6: Invalid Record ───
    console.log('--- Test 6: Invalid Record ---');
    await testAsync('Test 6 — Invalid record ID fails with 404 domain error', async () => {
        const countBefore = queryOne(db, 'SELECT COUNT(*) as count FROM interest_records').count;

        assert.throws(() => {
            correctInterestRecord(db, 999999);
        }, (err) => {
            assert.strictEqual(err.statusCode, 404);
            assert.match(err.message, /not found/);
            return true;
        });

        const countAfter = queryOne(db, 'SELECT COUNT(*) as count FROM interest_records').count;
        assert.strictEqual(countAfter, countBefore, 'Failed request must not alter database state');
    });

    // ─── Test 7: Transaction Rollback ───
    console.log('--- Test 7: Transaction Rollback ---');
    await testAsync('Test 7 — Transaction rollback leaves original unchanged', async () => {
        const pId = createTestPerson('Correction P7', '9980001007');
        const accId = createTestAccount(pId, 1000000, 12);
        const recId = insertCustomInterestRecord(accId, {
            periodStart: '2026-01-01',
            periodEnd: '2026-01-31',
            principalPaisa: 1000000,
            rate: 12,
            amountPaisa: 9863
        });

        // Trigger forced rollback inside the transaction
        assert.throws(() => {
            correctInterestRecord(db, recId, {
                rate: 10,
                _forceFailure: true
            });
        }, /Simulated transaction failure/);

        // Verify original record is completely untouched
        const original = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [recId]);
        assert.strictEqual(original.status, 'PENDING');
        assert.strictEqual(original.corrected_by_record_id, null);
        assert.strictEqual(original.reversal_reason, null);

        // Verify zero new corrected records exist for this period
        const records = queryAll(db, 'SELECT * FROM interest_records WHERE account_id = ?', [accId]);
        assert.strictEqual(records.length, 1);
    });

    // ─── Test 8: History Integration ───
    console.log('--- Test 8: History Integration ---');
    await testAsync('Test 8 — 6H history exposes original and corrected relationship', async () => {
        const pId = createTestPerson('Correction P8', '9980001008');
        const accId = createTestAccount(pId, 1000000, 12);

        // Original = ₹100
        const origId = insertCustomInterestRecord(accId, {
            periodStart: '2026-01-01',
            periodEnd: '2026-01-31',
            principalPaisa: 1000000,
            rate: 12,
            amountPaisa: 10000
        });

        // Correct to ₹80
        const correctedRate = (80 * 365 * 100) / (10000 * 30);
        const corrRes = correctInterestRecord(db, origId, { rate: correctedRate });
        const corrId = corrRes.corrected_record_id;

        // Retrieve history using Step 6H service
        const history = getAccountInterestHistory(db, accId);

        assert.strictEqual(history.total, 2, 'History must contain both original and corrected records');
        assert.strictEqual(history.items.length, 2);

        // Record 1: Original (Reversed)
        const histOrig = history.items.find(i => i.id === origId);
        assert.ok(histOrig, 'Original record must exist in history');
        assert.strictEqual(histOrig.status, 'REVERSED');
        assert.strictEqual(histOrig.interest_amount, 100.00);
        assert.strictEqual(histOrig.outstanding_amount, 0.00);
        assert.strictEqual(histOrig.corrected_by_record_id, corrId);

        // Record 2: Corrected (Active Pending)
        const histCorr = history.items.find(i => i.id === corrId);
        assert.ok(histCorr, 'Corrected record must exist in history');
        assert.strictEqual(histCorr.status, 'PENDING');
        assert.strictEqual(histCorr.interest_amount, 80.00);
        assert.strictEqual(histCorr.outstanding_amount, 80.00);
        assert.strictEqual(histCorr.corrects_record_id, origId);

        // Account Financial Totals (Excludes reversed)
        assert.strictEqual(history.summary.total_recorded, 80.00);
        assert.strictEqual(history.summary.total_outstanding, 80.00);
    });

    // ─── Test 9: Paid Interest Protection ───
    console.log('--- Test 9: Paid Interest Protection ---');
    await testAsync('Test 9 — Paid interest records safely rejected as UNSUPPORTED, payment history intact', async () => {
        const pId = createTestPerson('Correction P9', '9980001009');
        const accId = createTestAccount(pId, 1000000, 12);

        // Create record with ₹100 interest
        const recId = insertCustomInterestRecord(accId, {
            periodStart: '2026-01-01',
            periodEnd: '2026-01-31',
            principalPaisa: 1000000,
            rate: 12,
            amountPaisa: 10000
        });

        // Allocate ₹50.00 payment
        allocatePaymentToInterestRecord(db, {
            account_id: accId,
            interest_record_id: recId,
            amount: 50.00,
            payment_method: 'UPI',
            payment_date: '2026-02-05',
            reference: 'UPI/CORR/50'
        });

        // Verify paid_amount is 5000 paisa
        const recordBefore = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [recId]);
        assert.strictEqual(recordBefore.paid_amount, 5000);

        // Attempt correction: must be rejected with UNSUPPORTED error code
        assert.throws(() => {
            correctInterestRecord(db, recId, { rate: 10 });
        }, (err) => {
            assert.strictEqual(err.statusCode, 400);
            assert.strictEqual(err.code, 'PAID_RECORD_CORRECTION_UNSUPPORTED');
            assert.match(err.message, /not supported in Step 6I/);
            return true;
        });

        // Verify payment history and record state remain 100% intact
        const recordAfter = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [recId]);
        assert.strictEqual(recordAfter.status, 'PARTIALLY_PAID');
        assert.strictEqual(recordAfter.paid_amount, 5000);
        assert.strictEqual(recordAfter.interest_amount, 10000);
        assert.strictEqual(recordAfter.corrected_by_record_id, null);

        const allocs = queryAll(db, 'SELECT * FROM interest_allocations WHERE interest_record_id = ?', [recId]);
        assert.strictEqual(allocs.length, 1);
        assert.strictEqual(allocs[0].amount, 5000);
    });

    // ─── Test 10: Authorization Enforcement ───
    console.log('--- Test 10: Authorization Enforcement ---');
    await testAsync('Test 10 — Unauthorized actor rejected with 403 error', async () => {
        const pId = createTestPerson('Correction P10', '9980001010');
        const accId = createTestAccount(pId, 1000000, 12);
        const recId = insertCustomInterestRecord(accId, {
            periodStart: '2026-01-01',
            periodEnd: '2026-01-31',
            principalPaisa: 1000000,
            rate: 12,
            amountPaisa: 10000
        });

        assert.throws(() => {
            correctInterestRecord(db, recId, {
                rate: 10,
                is_authorized: false
            });
        }, (err) => {
            assert.strictEqual(err.statusCode, 403);
            assert.match(err.message, /Unauthorized/);
            return true;
        });
    });

    // ─── Test 11: Audit Log Integration ───
    console.log('--- Test 11: Audit Log Integration ---');
    await testAsync('Test 11 — Audit log captures INTEREST_CORRECTED with difference & metadata', async () => {
        const pId = createTestPerson('Correction P11', '9980001011');
        const accId = createTestAccount(pId, 1000000, 12);
        const origId = insertCustomInterestRecord(accId, {
            periodStart: '2026-01-01',
            periodEnd: '2026-01-31',
            principalPaisa: 1000000,
            rate: 12,
            amountPaisa: 10000
        });

        const corrRes = correctInterestRecord(db, origId, {
            rate: 10,
            reason: 'Audit correction reason test',
            actor_id: 'AUDITOR_01'
        });

        const audit = queryOne(db, `
            SELECT * FROM audit_logs
            WHERE entity_type = 'INTEREST_RECORD' AND entity_id = ? AND action = 'INTEREST_CORRECTED'
        `, [corrRes.corrected_record_id]);

        assert.ok(audit, 'Audit log entry must be created');
        const payload = JSON.parse(audit.new_value);
        assert.strictEqual(payload.event_type, 'INTEREST_CORRECTED');
        assert.strictEqual(payload.original_record_id, origId);
        assert.strictEqual(payload.corrected_record_id, corrRes.corrected_record_id);
        assert.strictEqual(payload.old_amount, 100.00);
        assert.strictEqual(payload.new_amount, 82.19);
        assert.strictEqual(payload.difference, -17.81);
        assert.strictEqual(payload.actor_id, 'AUDITOR_01');
        assert.strictEqual(payload.reason, 'Audit correction reason test');
    });

    // ─── Test 12: Read-Only Recalculation Preview ───
    console.log('--- Test 12: Read-Only Recalculation Preview ---');
    await testAsync('Test 12 — recalculateInterestForRecord produces preview without DB writes', async () => {
        const pId = createTestPerson('Correction P12', '9980001012');
        const accId = createTestAccount(pId, 1000000, 12);
        const recId = insertCustomInterestRecord(accId, {
            periodStart: '2026-01-01',
            periodEnd: '2026-01-31',
            principalPaisa: 1000000,
            rate: 12,
            amountPaisa: 9863
        });

        const countBefore = queryOne(db, 'SELECT COUNT(*) as count FROM interest_records').count;

        const preview = recalculateInterestForRecord(db, recId, { rate: 10 });
        assert.strictEqual(preview.original_interest, 98.63);
        assert.strictEqual(preview.calculated_interest, 82.19);
        assert.strictEqual(preview.difference, -16.44);
        assert.strictEqual(preview.is_changed, true);

        const countAfter = queryOne(db, 'SELECT COUNT(*) as count FROM interest_records').count;
        assert.strictEqual(countAfter, countBefore, 'Recalculation preview must perform zero DB writes');
    });

    // ─── Test 13: HTTP API Endpoints ───
    console.log('--- Test 13: HTTP API Endpoints ---');
    const http = require('http');
    const express = require('express');
    const apiRoutes = require('../routes/api');

    const app = express();
    app.use(express.json());
    app.use('/api', apiRoutes);

    const testServer = http.createServer(app);
    await new Promise(resolve => testServer.listen(0, resolve));
    const testPort = testServer.address().port;
    const baseUrl = `http://127.0.0.1:${testPort}/api`;

    const loginRes = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bypass-rate-limit': 'test-internal' },
        body: JSON.stringify({ username: 'admin', password: 'AdminPassword@123' })
    });
    const { token } = await loginRes.json();
    const authFetch = (url, opts = {}) => {
        opts.headers = opts.headers || {};
        opts.headers['Authorization'] = `Bearer ${token}`;
        return fetch(url, opts);
    };

    try {
        await testAsync('Test 13a — API: POST /interest-records/:id/recalculate', async () => {
            const pId = createTestPerson('API P13a', '9980001013');
            const accId = createTestAccount(pId, 1000000, 12);
            const recId = insertCustomInterestRecord(accId, {
                periodStart: '2026-01-01',
                periodEnd: '2026-01-31',
                principalPaisa: 1000000,
                rate: 12,
                amountPaisa: 10000
            });

            const res = await authFetch(`${baseUrl}/interest-records/${recId}/recalculate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rate: 10 })
            });

            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.data.calculated_interest, 82.19);
            assert.strictEqual(data.data.difference, -17.81);
        });

        await testAsync('Test 13b — API: POST /interest-records/:id/correct', async () => {
            const pId = createTestPerson('API P13b', '9980001014');
            const accId = createTestAccount(pId, 1000000, 12);
            const recId = insertCustomInterestRecord(accId, {
                periodStart: '2026-01-01',
                periodEnd: '2026-01-31',
                principalPaisa: 1000000,
                rate: 12,
                amountPaisa: 10000
            });

            const res = await authFetch(`${baseUrl}/interest-records/${recId}/correct`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rate: 10, reason: 'API correction test' })
            });

            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.data.status, 'CORRECTED');
            assert.strictEqual(data.data.original_record_id, recId);
            assert.ok(data.data.corrected_record_id > 0);
            assert.strictEqual(data.data.corrected_record.interest_amount, 8219);
        });
    } finally {
        await new Promise(resolve => testServer.close(resolve));
    }

    // ─── Summary ───
    console.log('\n================================================================');
    console.log(`Step 6I Test Results: ${passedTests} passed, ${failedTests} failed`);
    console.log('================================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    }
}

runStep6ITests().catch((err) => {
    console.error('Fatal error running Step 6I tests:', err);
    process.exit(1);
});
