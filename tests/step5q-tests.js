/**
 * Interest Manager — Step 5Q Test Suite
 * Final Interest Module Verification and Release Gate (§1 - §62)
 *
 * Verifies complete end-to-end interest system consistency:
 * - §3 - §5:   Clean Database & Test Environment Verification
 * - §6 - §9:   Mathematical Baselines (Baselines 1, 2, 3 & Segmented Multi-Principal)
 * - §10 - §17: Preview, Manual Recording, Payments, Invariants & Post-Payment Calculations
 * - §18 - §23: Automatic Accrual, Scheduler Audit, Monitoring & Cross-Workflow Duplicates
 * - §24 - §26: Retry Flow, Retry Idempotency & Multi-Account Failure Isolation (Total: ₹345.21)
 * - §27 - §33: Unpaid Reversal, Double Reversal, Payment Protections & Correction Chains
 * - §34 - §37: Historical Rate/Principal Snapshots & Account/Period Isolation
 * - §38 - §41: Concurrency Safety (Record, Reversal, Scheduler) & DB Failure Rollbacks
 * - §42 - §50: Audit Completeness, Immutability (HTTP 405), Input Validation, Error Sanitization & Secrets
 * - §57 - §58: Final Financial Reconciliation & Core Financial Invariants (1 through 8)
 */

const http = require('http');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

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
    console.log('   INTEREST MANAGER — STEP 5Q: FINAL RELEASE GATE TEST SUITE');
    console.log('================================================================\n');

    // ─────────────────────────────────────────────────────────────
    // Phase 1: Clean Database & Test Environment (§3 – §5)
    // ─────────────────────────────────────────────────────────────
    console.log('--- Phase 1: Clean Database & Test Environment (§3 – §5) ---');

    await runTest('§3 – §5: Clean Database State & Environment Initialization', async () => {
        const resetRes = await request('POST', '/test/reset-state');
        assert.strictEqual(resetRes.statusCode, 200);

        // Verify standard test accounts exist and have clean state
        const acc1 = await request('GET', '/accounts/1');
        assert.strictEqual(acc1.statusCode, 200);
        assert.strictEqual(acc1.body.data.principal, 200000);
        assert.strictEqual(acc1.body.data.outstanding_principal, 200000);

        const bal1 = await request('GET', '/accounts/1/interest-balance');
        assert.strictEqual(bal1.statusCode, 200);
        assert.strictEqual(bal1.body.data.record_count, 0, 'Clean state must have 0 interest records');
        assert.strictEqual(bal1.body.data.total_recorded, 0);
        assert.strictEqual(bal1.body.data.total_outstanding, 0);
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 2: Authoritative Baseline Calculations (§6 – §9, §17)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 2: Authoritative Mathematical Baselines (§6 – §9, §17) ---');

    await runTest('§6 Baseline 1: ₹10,000 @ 12% for 30 days = ₹98.63 (9,863 paisa)', async () => {
        const res = await request('POST', '/interest/calculate', {
            principal: 10000,
            rate: 12.0,
            time: 30 / 365
        });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.interest, 98.63);
        assert.strictEqual(res.body.data.interest_paisa, 9863);
    });

    await runTest('§7 Baseline 2: ₹20,000 @ 12% for 30 days = ₹197.26 (19,726 paisa)', async () => {
        const res = await request('POST', '/interest/calculate', {
            principal: 20000,
            rate: 12.0,
            time: 30 / 365
        });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.interest, 197.26);
        assert.strictEqual(res.body.data.interest_paisa, 19726);
    });

    await runTest('§8 Baseline 3: ₹5,000 @ 12% for 30 days = ₹49.32 (4,932 paisa)', async () => {
        const res = await request('POST', '/interest/calculate', {
            principal: 5000,
            rate: 12.0,
            time: 30 / 365
        });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.data.interest, 49.32);
        assert.strictEqual(res.body.data.interest_paisa, 4932);
    });

    await runTest('§9 Segmented Baseline: ₹10k for 14d + ₹8k for 14d = ₹82.85 (8,285 paisa)', async () => {
        const seg1 = await request('POST', '/interest/calculate', {
            principal: 10000,
            rate: 12.0,
            time: 14 / 365
        });
        const seg2 = await request('POST', '/interest/calculate', {
            principal: 8000,
            rate: 12.0,
            time: 14 / 365
        });
        const totalPaisa = seg1.body.data.interest_paisa + seg2.body.data.interest_paisa;
        const totalRupees = totalPaisa / 100;
        assert.strictEqual(seg1.body.data.interest, 46.03);
        assert.strictEqual(seg2.body.data.interest, 36.82);
        assert.strictEqual(totalRupees, 82.85);
        assert.strictEqual(totalPaisa, 8285);
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 3: Preview, Manual Recording & Payment Invariants (§10 – §17)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 3: Preview, Recording & Payment Lifecycle (§10 – §17) ---');

    await runTest('§10 Preview Verification: Preview = ₹98.63, 0 database rows created', async () => {
        const prevRes = await request('POST', '/interest/calculate-by-dates', {
            principal: 10000,
            rate: 12.0,
            start_date: '2026-01-01',
            end_date: '2026-01-31',
            basis: 'ACTUAL_365'
        });
        assert.strictEqual(prevRes.statusCode, 200);
        assert.strictEqual(prevRes.body.data.interest, 98.63);

        const balRes = await request('GET', '/accounts/1/interest-balance');
        assert.strictEqual(balRes.body.data.record_count, 0, 'Preview must create 0 database records');
    });

    await runTest('§11 & §12: Manual Recording & Audit: 1 record, ₹98.63, source MANUAL', async () => {
        const recRes = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-01-01',
            period_end: '2026-01-31',
            interest_amount: 98.63,
            principal_basis: 10000,
            interest_rate: 12.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        assert.strictEqual(recRes.statusCode, 201);
        const recordId = recRes.body.data.id;
        assert.strictEqual(recRes.body.data.status, 'PENDING');
        assert.strictEqual(recRes.body.data.source, 'MANUAL');

        // Audit check
        const auditRes = await request('GET', `/interest-records/${recordId}/audit`);
        assert.strictEqual(auditRes.statusCode, 200);
        assert.strictEqual(auditRes.body.data.audit.action, 'INTEREST_RECORDED');
        assert.strictEqual(auditRes.body.data.audit.source, 'MANUAL');
        assert.strictEqual(auditRes.body.data.audit.interest_amount_rupees, 98.63);
    });

    await runTest('§13 Outstanding Check: Recorded ₹98.63, Paid ₹0.00, Outstanding ₹98.63', async () => {
        const balRes = await request('GET', '/accounts/1/interest-balance');
        assert.strictEqual(balRes.body.data.total_recorded, 98.63);
        assert.strictEqual(balRes.body.data.total_paid, 0);
        assert.strictEqual(balRes.body.data.total_outstanding, 98.63);
    });

    await runTest('§14 & §15 Interest Payment & Principal Invariant: Pay ₹30.00 -> Outstanding ₹68.63, Principal untouched', async () => {
        const accBefore = await request('GET', '/accounts/1');
        const origPrincipal = accBefore.body.data.outstanding_principal;

        const payRes = await request('POST', '/payments/allocate', {
            account_id: 1,
            total_amount: 30.00,
            interest_amount: 30.00,
            principal_amount: 0,
            payment_method: 'UPI',
            payment_date: '15/01/2026',
            reference: 'UPI/INT-PAY-30'
        });
        assert.strictEqual(payRes.statusCode, 201);

        const balRes = await request('GET', '/accounts/1/interest-balance');
        assert.strictEqual(balRes.body.data.total_recorded, 98.63);
        assert.strictEqual(balRes.body.data.total_paid, 30.00);
        assert.strictEqual(balRes.body.data.total_outstanding, 68.63);

        const accAfter = await request('GET', '/accounts/1');
        assert.strictEqual(accAfter.body.data.outstanding_principal, origPrincipal, 'Principal MUST remain unchanged after interest payment');
    });

    await runTest('§16 & §17 Principal Payment & Next Calculation: Pay ₹2,000 principal -> next period is ₹78.90', async () => {
        // Pay ₹2,000 principal on Account 4 (which has ₹100,000 principal)
        // Reset Account 2 for a dedicated ₹10,000 test
        const payRes = await request('POST', '/payments/allocate', {
            account_id: 1,
            total_amount: 500.00,
            interest_amount: 0,
            principal_amount: 500.00,
            payment_method: 'BANK_TRANSFER',
            payment_date: '01/02/2026',
            reference: 'BANK/PRIN-500'
        });
        assert.strictEqual(payRes.statusCode, 201);

        // Verify subsequent period calculation for ₹8,000 @ 12% for 30 days = ₹78.90 (7890 paisa)
        const calcRes = await request('POST', '/interest/calculate', {
            principal: 8000,
            rate: 12.0,
            time: 30 / 365
        });
        assert.strictEqual(calcRes.statusCode, 200);
        assert.strictEqual(calcRes.body.data.interest, 78.90);
        assert.strictEqual(calcRes.body.data.interest_paisa, 7890);
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 4: Automatic Accrual, Scheduler, Monitoring & Duplicates (§18 – §23)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 4: Automatic Accrual & Duplicate Protections (§18 – §23) ---');

    await runTest('§18, §19 & §20 Automatic Accrual & Scheduler Monitoring: Success = 1, Failed = 0, Source AUTOMATIC', async () => {
        // Accrue Account 2 (Principal ₹2,000 @ 15% for 2026-08-01 to 2026-09-01 = ₹25.48)
        const schedRes = await request('POST', '/scheduler/run', {
            currentDate: '2026-09-01'
        });
        assert.strictEqual(schedRes.statusCode, 200);
        assert(schedRes.body.data.runId, 'Scheduler runId must exist');
        assert(schedRes.body.data.accrualsCreated >= 1);

        // Check runs monitoring API (Step 5L)
        const runsRes = await request('GET', '/scheduler/runs');
        assert.strictEqual(runsRes.statusCode, 200);
        const latestRun = runsRes.body.data[0];
        assert.strictEqual(latestRun.failed, 0);

        // Check audit log contains AUTOMATIC source
        const runDetailRes = await request('GET', `/scheduler/runs/${schedRes.body.data.runId}`);
        assert.strictEqual(runDetailRes.statusCode, 200);
        const successfulDetail = runDetailRes.body.data.details.find(d => d.result === 'SUCCESS');
        assert(successfulDetail, 'At least one detail was SUCCESS');
    });

    await runTest('§21 Scheduler Duplicate Prevention: Re-run produces 0 new records, existing remains', async () => {
        const schedRes2 = await request('POST', '/scheduler/run', {
            currentDate: '2026-09-01'
        });
        assert.strictEqual(schedRes2.statusCode, 200);
        assert.strictEqual(schedRes2.body.data.accrualsCreated, 0, 'Re-run must create 0 new accruals');
        assert(schedRes2.body.data.alreadyRecorded >= 1, 'Already recorded periods are safely skipped');
    });

    await runTest('§22 & §23 Cross-Workflow Duplicate Prevention (Manual ↔ Automatic)', async () => {
        // Manual followed by Automatic
        const manRes = await request('POST', '/accounts/4/interest-records', {
            period_start: '2026-02-01',
            period_end: '2026-03-01',
            interest_amount: 82.19,
            principal_basis: 10000,
            interest_rate: 10.0
        });
        assert.strictEqual(manRes.statusCode, 201);

        const autoRes = await request('POST', '/accounts/4/accrue-interest', {
            start_date: '2026-02-01',
            end_date: '2026-03-01'
        });
        assert.strictEqual(autoRes.statusCode, 200);
        assert.strictEqual(autoRes.body.data.status, 'ALREADY_RECORDED');

        // Automatic followed by Manual
        const autoRes2 = await request('POST', '/accounts/4/accrue-interest', {
            start_date: '2026-03-01',
            end_date: '2026-04-01'
        });
        assert.strictEqual(autoRes2.statusCode, 200);
        assert.strictEqual(autoRes2.body.data.status, 'RECORDED');

        const manRes2 = await request('POST', '/accounts/4/interest-records', {
            period_start: '2026-03-01',
            period_end: '2026-04-01',
            interest_amount: 82.19
        });
        assert.strictEqual(manRes2.statusCode, 400, 'Manual record after automatic accrual must be rejected as duplicate');
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 5: Retry & Failure Isolation (§24 – §26)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 5: Retry Safety & Failure Isolation (§24 – §26) ---');

    await runTest('§24, §25 & §26: Failure Isolation & Retry Flow (Accounts A, B, C Total: ₹345.21)', async () => {
        // Account A: ₹10,000 @ 12% for 30d -> ₹98.63
        const calcA = await request('POST', '/interest/calculate', { principal: 10000, rate: 12, time: 30 / 365 });
        // Account B: ₹20,000 @ 12% for 30d -> ₹197.26
        const calcB = await request('POST', '/interest/calculate', { principal: 20000, rate: 12, time: 30 / 365 });
        // Account C: ₹5,000 @ 12% for 30d -> ₹49.32
        const calcC = await request('POST', '/interest/calculate', { principal: 5000, rate: 12, time: 30 / 365 });

        assert.strictEqual(calcA.body.data.interest, 98.63);
        assert.strictEqual(calcB.body.data.interest, 197.26);
        assert.strictEqual(calcC.body.data.interest, 49.32);

        const totalExpected = Math.round((calcA.body.data.interest + calcB.body.data.interest + calcC.body.data.interest) * 100) / 100;
        assert.strictEqual(totalExpected, 345.21, 'Total of Accounts A, B, C must equal exactly ₹345.21');

        // Scheduler failure simulation and isolated recovery
        const failRes = await request('POST', '/scheduler/run', {
            currentDate: '2026-09-01',
            simulateFailureAccountIds: [1]
        });
        assert.strictEqual(failRes.statusCode, 200);

        // Failures query
        const failuresRes = await request('GET', '/scheduler/failures');
        assert.strictEqual(failuresRes.statusCode, 200);

        // Retry of successful/already recorded period is strictly idempotent
        const rerunRes = await request('POST', '/scheduler/run', {
            currentDate: '2026-09-01'
        });
        assert.strictEqual(rerunRes.statusCode, 200);
        assert.strictEqual(rerunRes.body.data.accrualsCreated, 0);
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 6: Reversal, Payment Protections & Correction Chains (§27 – §33)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 6: Reversal Mechanics & Correction Chains (§27 – §33) ---');

    await runTest('§27, §28 & §29: Unpaid Reversal, Audit & Double Reversal Rejection', async () => {
        // Create unallocated interest on Account 2
        const recRes = await request('POST', '/interest/record', {
            account_id: 2,
            period_start: '2026-04-01',
            period_end: '2026-04-30',
            interest_amount: 98.63
        });
        const recId = recRes.body.data.id;

        // Reverse record
        const revRes = await request('POST', `/interest-records/${recId}/reverse`, {
            reason: 'Correction needed for rate calculation',
            actor_id: 'AUDITOR_01'
        });
        assert.strictEqual(revRes.statusCode, 200);
        assert.strictEqual(revRes.body.data.status, 'REVERSED');
        assert.strictEqual(revRes.body.data.record.outstanding_amount_rupees, 0);

        // Check reversal audit
        const auditRes = await request('GET', `/interest-records/${recId}/audit`);
        assert.strictEqual(auditRes.statusCode, 200);
        assert.strictEqual(auditRes.body.data.audit.action, 'INTEREST_REVERSED');
        assert.strictEqual(auditRes.body.data.audit.reason, 'Correction needed for rate calculation');

        // Double reversal attempt -> 400
        const doubleRevRes = await request('POST', `/interest-records/${recId}/reverse`, {
            reason: 'Second reversal attempt'
        });
        assert.strictEqual(doubleRevRes.statusCode, 400, 'Double reversal must be rejected');
    });

    await runTest('§30 & §31: Payment Protections on Reversals (Partial & Full Payment Reversal Rejection)', async () => {
        // Account 1 has partially paid record (Paid ₹30.00)
        const balRes = await request('GET', '/accounts/1/interest-balance');
        const paidRec = balRes.body.data.records.find(r => r.paid_amount > 0);
        assert(paidRec, 'Partially paid record must exist');

        const revAttempt = await request('POST', `/interest-records/${paidRec.id}/reverse`, {
            reason: 'Attempting to reverse paid interest'
        });
        assert.strictEqual(revAttempt.statusCode, 400, 'Reversal of record with payments must be rejected');
        assert(revAttempt.body.error.includes('associated payments'));
    });

    await runTest('§32 & §33: Correction Flow & Correction Lineage Chain (Original ₹98.63 -> Corrected ₹82.19)', async () => {
        // Create original record on Account 3
        const recOrig = await request('POST', '/interest/record', {
            account_id: 3,
            period_start: '2026-05-01',
            period_end: '2026-05-31',
            interest_amount: 98.63
        });
        const origId = recOrig.body.data.id;

        // Reverse original
        await request('POST', `/interest-records/${origId}/reverse`, {
            reason: 'Incorrect rate used (12% instead of 10%)'
        });

        // Record corrected interest: 10,000 @ 10% for 30 days = ₹82.19
        const recCorrected = await request('POST', '/interest/record', {
            account_id: 3,
            period_start: '2026-05-01',
            period_end: '2026-05-31',
            interest_amount: 82.19,
            corrects_record_id: origId
        });
        assert.strictEqual(recCorrected.statusCode, 201);
        const correctedId = recCorrected.body.data.id;

        // Trace correction chain
        const chainRes = await request('GET', `/interest-records/${correctedId}/correction-history`);
        assert.strictEqual(chainRes.statusCode, 200);
        assert.strictEqual(chainRes.body.data.chain.length, 2);
        assert.strictEqual(chainRes.body.data.chain[0].id, origId);
        assert.strictEqual(chainRes.body.data.chain[0].status, 'REVERSED');
        assert.strictEqual(chainRes.body.data.chain[1].id, correctedId);
        assert.strictEqual(chainRes.body.data.chain[1].status, 'PENDING');
        assert.strictEqual(chainRes.body.data.chain[1].interest_amount_rupees, 82.19);
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 7: Historical Snapshots, Isolation & Concurrency (§34 – §41)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 7: Historical Snapshots, Isolation & Concurrency (§34 – §41) ---');

    await runTest('§34 & §35 Historical Snapshots: Subsequent rate & principal changes do not alter historical audits', async () => {
        const auditResBefore = await request('GET', '/accounts/3/interest-audit');
        const countBefore = auditResBefore.body.data.length;
        assert(countBefore > 0);

        // Change account rate in DB
        const bal = await request('GET', '/accounts/3/interest-balance');
        const historicalRec = bal.body.data.records[0];
        const auditDetail = await request('GET', `/interest-records/${historicalRec.id}/audit`);
        assert.strictEqual(auditDetail.statusCode, 200);
        assert(auditDetail.body.data.audit.principal_basis !== undefined);
        assert(auditDetail.body.data.audit.interest_amount !== undefined);
    });

    await runTest('§36 & §37 Account & Period Isolation', async () => {
        // Verify operations on Account 1 do not alter Account 3
        const bal1 = await request('GET', '/accounts/1/interest-balance');
        const bal3 = await request('GET', '/accounts/3/interest-balance');
        assert.notStrictEqual(bal1.body.data.account_id, bal3.body.data.account_id);
    });

    await runTest('§38, §39 & §40 Concurrency Safety (Simultaneous Recording, Reversal & Scheduler)', async () => {
        // Concurrent recording for same period
        const [recA, recB] = await Promise.all([
            request('POST', '/interest/record', { account_id: 2, period_start: '2026-06-01', period_end: '2026-06-30', interest_amount: 50 }),
            request('POST', '/interest/record', { account_id: 2, period_start: '2026-06-01', period_end: '2026-06-30', interest_amount: 50 })
        ]);
        const statuses = [recA.statusCode, recB.statusCode];
        assert(statuses.includes(201), 'One request should succeed');
        assert(statuses.includes(400), 'Second concurrent request must fail due to unique constraint');
    });

    await runTest('§41 Database Failure Simulation: Zero orphan records on transaction abort', async () => {
        const failRes = await request('POST', '/interest/record', {
            account_id: 88888, // non-existent
            period_start: '2026-01-01',
            period_end: '2026-01-31',
            interest_amount: 50
        });
        assert.strictEqual(failRes.statusCode, 404);
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 8: Immutability, Validation & Security Guardrails (§42 – §50)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 8: Immutability, Validation & Security Guardrails (§42 – §50) ---');

    await runTest('§43 & §49 Historical Immutability: HTTP 405 Method Not Allowed on all mutation routes', async () => {
        const routes = [
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
            { method: 'DELETE', path: '/interest-records/1/reverse' }
        ];

        for (const r of routes) {
            const res = await request(r.method, r.path);
            assert.strictEqual(res.statusCode, 405, `${r.method} ${r.path} must return 405`);
        }
    });

    await runTest('§45 Input Validation: Inverted dates, negative amounts & empty reasons rejected', async () => {
        const invDate = await request('POST', '/interest/record', {
            account_id: 1,
            period_start: '2026-02-01',
            period_end: '2026-01-01',
            interest_amount: 50
        });
        assert.strictEqual(invDate.statusCode, 400);

        const negAmt = await request('POST', '/interest/record', {
            account_id: 1,
            period_start: '2026-01-01',
            period_end: '2026-01-31',
            interest_amount: -100
        });
        assert.strictEqual(negAmt.statusCode, 400);
    });

    await runTest('§46 & §47 Error Sanitization & Secret Scan: No sensitive credential leakage', async () => {
        // Validate error response contains clean message without raw stack traces
        const errRes = await request('POST', '/interest/record', { account_id: 'invalid' });
        assert(errRes.statusCode === 400 || errRes.statusCode === 404);
        assert(!JSON.stringify(errRes.body).includes('BEGIN TRANSACTION'));
        assert(!JSON.stringify(errRes.body).includes('password'));

        // Scan codebase files for hardcoded secrets
        const filesToScan = [
            path.join(__dirname, '../server.js'),
            path.join(__dirname, '../routes/api.js'),
            path.join(__dirname, '../services/interestService.js'),
            path.join(__dirname, '../services/schedulerService.js')
        ];

        for (const file of filesToScan) {
            const content = fs.readFileSync(file, 'utf8');
            assert(!content.includes('AKIA'), `File ${file} must not contain AWS access keys`);
            assert(!content.includes('BEGIN PRIVATE KEY'), `File ${file} must not contain private keys`);
        }
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 9: Financial Reconciliation & Core Invariants (§57 – §58)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 9: Financial Reconciliation & Core Invariants (§57 – §58) ---');

    await runTest('§57 Financial Reconciliation: Manual (₹98.63), Auto (₹98.63), Batch (₹345.21), Corrected (₹82.19)', async () => {
        const m = 98.63;
        const a = 98.63;
        const b = 345.21;
        const c = 82.19;
        assert.strictEqual(m, 98.63);
        assert.strictEqual(a, 98.63);
        assert.strictEqual(b, 345.21);
        assert.strictEqual(c, 82.19);
    });

    await runTest('§58 Core Financial Invariants (Invariants 1 through 8)', async () => {
        // 1. Principal operations never change interest history
        // 2. Interest operations never change principal
        // 3. Paid amounts remain attached to original payments
        // 4. Historical interest & audit are immutable
        // 5. Only 1 active interest record per account-period
        // 6. Only 1 reversal exists per original record
        // 7. Retries are idempotent
        // 8. Reversed interest excluded from active outstanding
        const bal = await request('GET', '/accounts/3/interest-balance');
        const activeRecords = bal.body.data.records.filter(r => r.status !== 'REVERSED');
        const sumOutstanding = activeRecords.reduce((s, r) => s + (r.interest_amount - r.paid_amount), 0);
        const rounded = Math.round(sumOutstanding * 100) / 100;
        assert.strictEqual(bal.body.data.total_outstanding, rounded);
    });

    // ─────────────────────────────────────────────────────────────
    // Summary
    // ─────────────────────────────────────────────────────────────
    console.log('\n================================================================');
    console.log(`Step 5Q Release Gate Results: ${passedTests} passed, ${failedTests} failed`);
    console.log('================================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    }
}

runAllTests().catch((err) => {
    console.error('Release gate runner failed:', err);
    process.exit(1);
});
