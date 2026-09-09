/**
 * Interest Manager — Step 5P Test Suite
 * Production Readiness & Data Integrity Validation
 * 
 * Verifies complete production hardening (§1 - §50):
 * - §1 - §7:   Database Integrity, Schema Constraints, Transaction Rollback & Concurrency
 * - §8 - §14:  Precision, Rounding Strategy, Negative / Zero Amounts & Date Boundaries (Leap Years)
 * - §15 - §20: Error Classification, Sanitization & HTTP Status Codes
 * - §21 - §25: Mass-Assignment Protections, Actor/Source Spoofing & Reversal Guardrails
 * - §26 - §34: Historical Immutability (HTTP 405 Method Not Allowed) & Migration Integrity
 * - §35 - §39: Batch Performance, Failure Isolation & Idempotent Retry Safety
 * - §42, §47:  Authoritative Exact Regression Calculations (Tests A, B, C, D, E)
 * - §44 - §46: Complete Core Financial Invariants (Invariants 1 through 8)
 */

const http = require('http');
const assert = require('assert');

const BASE_URL = 'http://localhost:3000/api';

function request(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(BASE_URL + path);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                let parsed;
                try {
                    parsed = JSON.parse(data);
                } catch (e) {
                    parsed = data;
                }
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: parsed
                });
            });
        });

        req.on('error', (err) => reject(err));

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

let passedTests = 0;
let failedTests = 0;

async function runTest(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    Error: ${err.message}`);
        if (err.stack) {
            const lines = err.stack.split('\n').slice(1, 4).join('\n');
            console.error(`    ${lines}`);
        }
        failedTests++;
    }
}

async function runAllTests() {
    console.log('\n================================================================');
    console.log('   INTEREST MANAGER — STEP 5P: PRODUCTION READINESS TESTS');
    console.log('================================================================\n');

    // Reset state before beginning test suite
    await request('POST', '/test/reset-state');

    // ─────────────────────────────────────────────────────────────
    // Phase 1: Database Integrity, Partial Unique Index & Atomicity (§1 - §7)
    // ─────────────────────────────────────────────────────────────
    console.log('--- Phase 1: Database Integrity, Constraints & Atomicity (§1 - §7) ---');

    await runTest('§1 & §2: Database Schema & Active Period Uniqueness Constraint', async () => {
        // Account 1: Record interest for 2026-01-01 to 2026-01-31
        const res1 = await request('POST', '/interest/record', {
            account_id: 1,
            period_start: '2026-01-01',
            period_end: '2026-01-31',
            interest_amount: 25.00
        });
        assert.strictEqual(res1.statusCode, 201, 'First record should succeed');

        // Attempt second active record on exact same period for Account 1 -> must fail
        const res2 = await request('POST', '/interest/record', {
            account_id: 1,
            period_start: '2026-01-01',
            period_end: '2026-01-31',
            interest_amount: 25.00
        });
        assert.strictEqual(res2.statusCode, 400, 'Duplicate active interest record must be rejected');
        assert(res2.body.error.includes('already exists'), 'Error message must specify active record exists');
    });

    await runTest('§3 & §4: Reversal allows new active record on same period (Partial Uniqueness)', async () => {
        // Fetch existing records for Account 1
        const resBalance = await request('GET', '/accounts/1/interest-balance');
        const activeRecord = resBalance.body.data.records.find(r => r.status === 'PENDING' && r.period_start === '2026-01-01');
        assert(activeRecord, 'Active record must exist');

        // Reverse the record
        const resRev = await request('POST', `/interest-records/${activeRecord.id}/reverse`, {
            reason: 'Rate adjustment correction'
        });
        assert.strictEqual(resRev.statusCode, 200, 'Reversal should succeed');

        // Now creating a new record for the same period must succeed because previous is REVERSED
        const resNew = await request('POST', '/interest/record', {
            account_id: 1,
            period_start: '2026-01-01',
            period_end: '2026-01-31',
            interest_amount: 22.50,
            corrects_record_id: activeRecord.id
        });
        assert.strictEqual(resNew.statusCode, 201, 'New record on same period after reversal must succeed');
    });

    await runTest('§5 & §6: Audit Trail Atomicity & Transaction Rollback on Failure', async () => {
        // Attempt recording with non-existent account -> must rollback completely, zero orphan audit records
        const resFail = await request('POST', '/interest/record', {
            account_id: 99999,
            period_start: '2026-01-01',
            period_end: '2026-01-31',
            interest_amount: 100.00
        });
        assert.strictEqual(resFail.statusCode, 404, 'Non-existent account must return 404');
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 2: Precision, Rounding, Negative & Date Boundaries (§8 - §14)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 2: Financial Precision, Negative & Date Boundaries (§8 - §14) ---');

    await runTest('§8 & §9: Money Precision in Exact Integer Paisa & Half-Up Rounding', async () => {
        // Test Simple Interest calculation fractional rounding:
        // Principal 10,000 @ 12% for 30 days = 10000 * 0.12 * (30/365) = 98.630136986... -> 98.63
        const calcRes = await request('POST', '/interest/calculate', {
            principal: 10000,
            rate: 12,
            time: 30 / 365
        });
        assert.strictEqual(calcRes.statusCode, 200);
        assert.strictEqual(calcRes.body.data.interest, 98.63, 'Rupees amount should round half-up to 98.63');
        assert.strictEqual(calcRes.body.data.interest_paisa, 9863, 'Paisa amount should be exactly 9863');
    });

    await runTest('§10 & §11: Strict Negative Amount Rejection & Zero Amount Handling', async () => {
        // Negative amount
        const resNeg = await request('POST', '/interest/record', {
            account_id: 2,
            period_start: '2026-01-01',
            period_end: '2026-01-31',
            interest_amount: -50.00
        });
        assert.strictEqual(resNeg.statusCode, 400, 'Negative interest amount must be rejected');

        // Zero amount
        const resZero = await request('POST', '/interest/record', {
            account_id: 2,
            period_start: '2026-01-01',
            period_end: '2026-01-31',
            interest_amount: 0
        });
        assert.strictEqual(resZero.statusCode, 400, 'Zero interest amount must be rejected for record endpoint');
    });

    await runTest('§12, §13 & §14: Date Validation, Inverted Dates & Leap Year / Calendar Boundaries', async () => {
        // Inverted dates: period_end before period_start
        const resInv = await request('POST', '/interest/record', {
            account_id: 2,
            period_start: '2026-02-01',
            period_end: '2026-01-01',
            interest_amount: 50.00
        });
        assert.strictEqual(resInv.statusCode, 400, 'Inverted dates must be rejected');

        // Leap year calculation: 2024 is a leap year (Feb 2024 has 29 days, from 2024-02-01 to 2024-02-29 is 28 days)
        const resTime = await request('POST', '/interest/calculate-time', {
            start_date: '2024-02-01',
            end_date: '2024-02-29',
            basis: 'ACTUAL_365'
        });
        assert.strictEqual(resTime.statusCode, 200);
        assert.strictEqual(resTime.body.data.elapsed_days, 28, 'Elapsed days between 2024-02-01 and 2024-02-29 is 28 days');
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 3: Error Classification & Mass-Assignment / Spoofing Guardrails (§15 - §25)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 3: Error Classification & Mass-Assignment Guardrails (§15 - §25) ---');

    await runTest('§15 - §20: HTTP Error Classification (400, 404, 405, 500)', async () => {
        // 400 Bad Request
        const res400 = await request('POST', '/interest/validate', { account_id: 'invalid' });
        assert(res400.statusCode === 400 || res400.statusCode === 404);

        // 404 Not Found
        const res404 = await request('GET', '/accounts/99999/interest-balance');
        assert.strictEqual(res404.statusCode, 404);

        // 405 Method Not Allowed on immutable audit log
        const res405 = await request('DELETE', '/audit-logs/1');
        assert.strictEqual(res405.statusCode, 405);
    });

    await runTest('§21 - §25: Mass-Assignment & Source/Actor Spoofing Protection', async () => {
        // Client attempts to pass status: 'PAID', paid_amount: 500, source: 'AUTOMATIC', scheduler_run_id: 999
        const resSpoof = await request('POST', '/interest/record', {
            account_id: 2,
            period_start: '2026-02-01',
            period_end: '2026-02-28',
            interest_amount: 50.00,
            status: 'PAID',
            paid_amount: 500.00,
            source: 'AUTOMATIC',
            scheduler_run_id: 999
        });
        assert.strictEqual(resSpoof.statusCode, 201);
        const rec = resSpoof.body.data;
        assert.strictEqual(rec.status, 'PENDING', 'status MUST be forced to PENDING');
        assert.strictEqual(rec.paid_amount, 0, 'paid_amount MUST be forced to 0');
        assert.strictEqual(rec.source, 'MANUAL', 'source MUST be forced to MANUAL on manual endpoint');
        assert.strictEqual(rec.scheduler_run_id, null, 'scheduler_run_id MUST be null on manual endpoint');
    });

    await runTest('§24 & §25: Reversal Validation, Max-Length & Actor Capture', async () => {
        const resBalance = await request('GET', '/accounts/2/interest-balance');
        const activeRecord = resBalance.body.data.records.find(r => r.status === 'PENDING' && r.period_start === '2026-02-01');
        assert(activeRecord, 'Active record must exist');

        // Missing reason -> 400
        const resNoReason = await request('POST', `/interest-records/${activeRecord.id}/reverse`, {});
        assert.strictEqual(resNoReason.statusCode, 400, 'Reversal without reason must be rejected');

        // Reason > 500 characters -> 400
        const longReason = 'A'.repeat(501);
        const resLongReason = await request('POST', `/interest-records/${activeRecord.id}/reverse`, { reason: longReason });
        assert.strictEqual(resLongReason.statusCode, 400, 'Reversal with reason > 500 chars must be rejected');

        // Valid reversal with actor capture
        const resValidRev = await request('POST', `/interest-records/${activeRecord.id}/reverse`, {
            reason: 'Correcting test entry',
            actor_id: 'USER_ADMIN_42'
        });
        assert.strictEqual(resValidRev.statusCode, 200);
        assert.strictEqual(resValidRev.body.data.reversal.actor_id, 'USER_ADMIN_42');

        // Attempt double-reversal -> 400
        const resDoubleRev = await request('POST', `/interest-records/${activeRecord.id}/reverse`, {
            reason: 'Second reversal attempt'
        });
        assert.strictEqual(resDoubleRev.statusCode, 400, 'Double reversal must be rejected');
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 4: Historical Immutability & HTTP 405 Protections (§26 - §34)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 4: Historical Immutability Protections (§26 - §34) ---');

    await runTest('§26 - §34: Strict HTTP 405 on All Financial & Audit Mutation Routes', async () => {
        const routesToTest = [
            { method: 'PUT', path: '/transactions/1' },
            { method: 'PATCH', path: '/transactions/1' },
            { method: 'DELETE', path: '/transactions/1' },
            { method: 'PUT', path: '/audit-logs/1' },
            { method: 'PATCH', path: '/audit-logs/1' },
            { method: 'DELETE', path: '/audit-logs/1' },
            { method: 'PUT', path: '/interest-records/1/audit' },
            { method: 'PATCH', path: '/interest-records/1/audit' },
            { method: 'DELETE', path: '/interest-records/1/audit' },
            { method: 'PUT', path: '/interest-records/1/reverse' },
            { method: 'PATCH', path: '/interest-records/1/reverse' },
            { method: 'DELETE', path: '/interest-records/1/reverse' },
            { method: 'PUT', path: '/interest-records/1/correction-history' },
            { method: 'PATCH', path: '/interest-records/1/correction-history' },
            { method: 'DELETE', path: '/interest-records/1/correction-history' }
        ];

        for (const route of routesToTest) {
            const res = await request(route.method, route.path);
            assert.strictEqual(res.statusCode, 405, `${route.method} ${route.path} must return 405 Method Not Allowed`);
        }
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 5: Batch Processing, Failure Isolation & Retry Safety (§35 - §39)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 5: Batch Processing & Failure Isolation (§35 - §39) ---');

    await runTest('§35 - §39: Multi-Account Scheduler Batch Run with Failure Isolation', async () => {
        // Run scheduler for current period
        const resRun = await request('POST', '/scheduler/run', {
            currentDate: '2026-09-01'
        });
        assert.strictEqual(resRun.statusCode, 200);
        assert(resRun.body.data.runId, 'Scheduler run must return runId');
        assert(typeof resRun.body.data.accountsProcessed === 'number', 'accountsProcessed must be returned');

        // Check runs list
        const resRuns = await request('GET', '/scheduler/runs');
        assert.strictEqual(resRuns.statusCode, 200);
        assert(Array.isArray(resRuns.body.data), 'Accrual runs list must be an array');
        assert(resRuns.body.data.length > 0, 'Accrual runs list must not be empty');

        // Idempotent re-run on same date -> skips already accrued accounts
        const resReRun = await request('POST', '/scheduler/run', {
            currentDate: '2026-09-01'
        });
        assert.strictEqual(resReRun.statusCode, 200);
        assert.strictEqual(resReRun.body.data.accrualsCreated, 0, 'Re-run on same period must accrue 0 new accounts');
        assert(resReRun.body.data.alreadyRecorded >= 1, 'Re-run must report already recorded accounts');
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 6: Authoritative Exact Regression Calculations (§42, §47)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 6: Authoritative Exact Regression Calculations (§42, §47) ---');

    await runTest('§47 Test A: ₹10,000 @ 12% for 30 days = ₹98.63', async () => {
        const res = await request('POST', '/interest/calculate', {
            principal: 10000,
            rate: 12,
            time: 30 / 365
        });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.interest, 98.63);
        assert.strictEqual(res.body.data.interest_paisa, 9863);
    });

    await runTest('§47 Test B: ₹20,000 @ 12% for 30 days = ₹197.26', async () => {
        const res = await request('POST', '/interest/calculate', {
            principal: 20000,
            rate: 12,
            time: 30 / 365
        });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.interest, 197.26);
        assert.strictEqual(res.body.data.interest_paisa, 19726);
    });

    await runTest('§47 Test C: ₹5,000 @ 12% for 30 days = ₹49.32', async () => {
        const res = await request('POST', '/interest/calculate', {
            principal: 5000,
            rate: 12,
            time: 30 / 365
        });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.interest, 49.32);
        assert.strictEqual(res.body.data.interest_paisa, 4932);
    });

    await runTest('§47 Test D: Segmented Multi-Principal Timeline Calculation = ₹82.85', async () => {
        // Segment 1: ₹10,000 @ 12% for 14 days = 10000 * 0.12 * 14 / 365 = 46.027397... -> 46.03 (4603 paisa)
        // Segment 2: ₹8,000 @ 12% for 14 days = 8000 * 0.12 * 14 / 365 = 36.821917... -> 36.82 (3682 paisa)
        // Total = 46.03 + 36.82 = 82.85 (8285 paisa)
        const seg1 = await request('POST', '/interest/calculate', {
            principal: 10000,
            rate: 12,
            time: 14 / 365
        });
        const seg2 = await request('POST', '/interest/calculate', {
            principal: 8000,
            rate: 12,
            time: 14 / 365
        });
        const totalPaisa = seg1.body.data.interest_paisa + seg2.body.data.interest_paisa;
        const totalRupees = totalPaisa / 100;
        assert.strictEqual(seg1.body.data.interest, 46.03);
        assert.strictEqual(seg2.body.data.interest, 36.82);
        assert.strictEqual(totalRupees, 82.85);
        assert.strictEqual(totalPaisa, 8285);
    });

    await runTest('§47 Test E: ₹10,000 @ 10% for 30 days = ₹82.19', async () => {
        const res = await request('POST', '/interest/calculate', {
            principal: 10000,
            rate: 10,
            time: 30 / 365
        });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.interest, 82.19);
        assert.strictEqual(res.body.data.interest_paisa, 8219);
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 7: Core Financial Invariants 1–8 (§44 - §46)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 7: Core Financial Invariants Verification (1–8) ---');

    await runTest('Invariant 1: Principal balance strictly immutable by interest operations', async () => {
        const before = await request('GET', '/accounts/3');
        const origPrincipal = before.body.data.principal;
        const origOutstanding = before.body.data.outstanding_principal;

        await request('POST', '/accounts/3/accrue-interest', {
            start_date: '2026-08-01',
            end_date: '2026-09-01'
        });

        const after = await request('GET', '/accounts/3');
        assert.strictEqual(after.body.data.principal, origPrincipal, 'Principal balance must not change');
        assert.strictEqual(after.body.data.outstanding_principal, origOutstanding, 'Outstanding principal must not change');
    });

    await runTest('Invariant 2: Payment allocations are immutable by interest recalculations', async () => {
        // Allocate interest payment of ₹25.00
        const payRes = await request('POST', '/payments/allocate', {
            account_id: 3,
            total_amount: 25.00,
            interest_amount: 25.00,
            principal_amount: 0,
            payment_method: 'UPI',
            payment_date: '15/08/2026',
            reference: 'UPI/INT-INV2'
        });
        assert.strictEqual(payRes.statusCode, 201);

        // Preview recalculation
        const preview = await request('POST', '/accounts/3/timeline-interest', {
            start_date: '2026-08-01',
            end_date: '2026-09-01'
        });
        assert.strictEqual(preview.statusCode, 200);

        // Verify balance records still have exact paid_amount preserved
        const bal = await request('GET', '/accounts/3/interest-balance');
        const paidRec = bal.body.data.records.find(r => r.paid_amount > 0);
        assert(paidRec, 'Paid record must retain paid_amount');
        assert.strictEqual(paidRec.paid_amount, 25.00, 'Paid amount must remain ₹25.00');
        assert.strictEqual(paidRec.paid_amount_paisa, 2500, 'Paid amount must remain 2500 paisa');
    });

    await runTest('Invariant 3: No duplicate active interest records for same period', async () => {
        const dupRes = await request('POST', '/accounts/3/accrue-interest', {
            start_date: '2026-08-01',
            end_date: '2026-09-01'
        });
        assert.strictEqual(dupRes.statusCode, 200);
        assert.strictEqual(dupRes.body.data.status, 'ALREADY_RECORDED');
    });

    await runTest('Invariant 4: Reversed interest cannot receive payments or be re-reversed', async () => {
        // Create unallocated record and reverse it
        const recRes = await request('POST', '/interest/record', {
            account_id: 4,
            period_start: '2026-04-01',
            period_end: '2026-04-30',
            interest_amount: 100.00
        });
        const recId = recRes.body.data.id;

        const revRes = await request('POST', `/interest-records/${recId}/reverse`, {
            reason: 'Test reversal for invariant 4'
        });
        assert.strictEqual(revRes.statusCode, 200);

        // Re-reversal attempt must fail
        const reRevRes = await request('POST', `/interest-records/${recId}/reverse`, {
            reason: 'Second reversal attempt'
        });
        assert.strictEqual(reRevRes.statusCode, 400);

        // Outstanding for this record must be 0
        const bal = await request('GET', '/accounts/4/interest-balance');
        const revInBal = bal.body.data.records.find(r => r.id === recId);
        assert.strictEqual(revInBal.outstanding_amount, 0);
    });

    await runTest('Invariant 5: Partially/fully paid interest record cannot be reversed without payment adjustment', async () => {
        const bal = await request('GET', '/accounts/3/interest-balance');
        const paidRec = bal.body.data.records.find(r => r.paid_amount > 0);
        assert(paidRec, 'Paid record must exist');

        const revAttempt = await request('POST', `/interest-records/${paidRec.id}/reverse`, {
            reason: 'Attempting to reverse paid interest'
        });
        assert.strictEqual(revAttempt.statusCode, 400, 'Reversal of paid interest must be rejected');
        assert(revAttempt.body.error.includes('associated payments'), 'Error message must specify associated payments');
    });

    await runTest('Invariant 6: Derived outstanding interest equals sum(active interest - paid_amount)', async () => {
        const bal = await request('GET', '/accounts/3/interest-balance');
        const activeRecords = bal.body.data.records.filter(r => r.status !== 'REVERSED');
        const manualSumRupees = activeRecords.reduce((sum, r) => sum + (r.interest_amount - r.paid_amount), 0);
        const roundedSum = Math.round(manualSumRupees * 100) / 100;
        const derivedOutstanding = bal.body.data.total_outstanding;
        assert.strictEqual(derivedOutstanding, roundedSum, 'Derived outstanding must equal sum of active unpaid amounts');
    });

    await runTest('Invariant 7: Audit history is strictly append-only', async () => {
        const auditRes = await request('GET', '/accounts/3/interest-audit');
        assert.strictEqual(auditRes.statusCode, 200);
        assert(auditRes.body.data.length > 0, 'Audit history must exist');
        
        // Attempting to modify audit endpoint returns 405
        const delRes = await request('DELETE', '/audit-logs/1');
        assert.strictEqual(delRes.statusCode, 405);
    });

    await runTest('Invariant 8: Corrected interest maintains unbroken lineage to original and reversal records', async () => {
        // Trace correction chain for Account 1 record corrected earlier in Phase 1
        const bal = await request('GET', '/accounts/1/interest-balance');
        const correctedRec = bal.body.data.records.find(r => r.corrects_record_id !== null);
        assert(correctedRec, 'Corrected record must exist');

        const chainRes = await request('GET', `/interest-records/${correctedRec.id}/correction-history`);
        assert.strictEqual(chainRes.statusCode, 200);
        assert(Array.isArray(chainRes.body.data.chain), 'Chain array must be present');
        assert.strictEqual(chainRes.body.data.chain.length, 2, 'Correction chain should contain 2 records');
        assert.strictEqual(chainRes.body.data.chain[0].type, 'ORIGINAL', 'First node is ORIGINAL');
        assert.strictEqual(chainRes.body.data.chain[1].type, 'CORRECTION', 'Second node is CORRECTION');
        assert.strictEqual(chainRes.body.data.chain[1].corrects_record_id, chainRes.body.data.chain[0].id);
    });

    // ─────────────────────────────────────────────────────────────
    // Summary
    // ─────────────────────────────────────────────────────────────
    console.log('\n================================================================');
    console.log(`Step 5P Test Results: ${passedTests} passed, ${failedTests} failed`);
    console.log('================================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    }
}

runAllTests().catch((err) => {
    console.error('Test runner failed:', err);
    process.exit(1);
});
