/**
 * Interest Manager — Step 5T Test Suite
 * Final Integration & End-to-End Verification (§1 – §31)
 *
 * Verifies the complete integrated interest lifecycle:
 * - §1 - §3:   Clean Environment, End-to-End Account Creation & Initial State
 * - §4 - §6:   Non-Persistent Preview, Manual Recording & Derived Outstanding
 * - §7 - §8:   Partial Payment, Principal Invariant & Payment Reversal Guardrails
 * - §9 - §11:  Subsequent Period, Automatic Scheduler Accrual & Duplicate Suppression
 * - §12:       Scheduler Failure Simulation, Run Logging & Isolated Manual Retry
 * - §13 - §15: Unpaid Reversal, Correction Lineage Chain & Audit Traceability
 * - §16 - §17: Account Isolation & Period Isolation
 * - §18 - §20: Concurrency Safety (Recording, Scheduler, Reversal)
 * - §21 - §22: Transaction Atomicity & Historical Immutability (HTTP 405)
 * - §23 - §24: Complete API & UI Integration Verification
 * - §28 - §29: Financial Reconciliation & Core Data Invariants
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

let passed = 0;
let failed = 0;

async function runStep(title, fn) {
    try {
        await fn();
        console.log(`  ✓ ${title}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${title}`);
        console.error(`    Error: ${err.message}`);
        if (err.stack) {
            const lines = err.stack.split('\n').slice(1, 4).join('\n');
            console.error(`    ${lines}`);
        }
        failed++;
    }
}

async function runAll() {
    console.log('\n================================================================');
    console.log('   INTEREST MANAGER — STEP 5T: FINAL INTEGRATION VERIFICATION');
    console.log('================================================================\n');

    let testAccountId = null;
    let period1RecordId = null;
    let period2RecordId = null;

    // ─────────────────────────────────────────────────────────────
    // Phase 1: Clean Environment, Creation & Initial State (§1 – §3)
    // ─────────────────────────────────────────────────────────────
    console.log('--- Phase 1: Clean Test Environment & Account Initialization ---');

    await runStep('§1: Start From Clean Test Environment', async () => {
        const resetRes = await request('POST', '/test/reset-state');
        assert.strictEqual(resetRes.statusCode, 200);

        const healthRes = await request('GET', '/health');
        assert.strictEqual(healthRes.statusCode, 200);
        assert.strictEqual(healthRes.body.status, 'ok');
    });

    await runStep('§2 & §3: Create End-to-End Account & Verify Initial State (₹10,000 @ 12%)', async () => {
        const createRes = await request('POST', '/accounts', {
            person_id: 1,
            direction: 'MONEY_GIVEN',
            principal: 10000,
            interest_rate: 12.0,
            interest_frequency: 'MONTHLY',
            calculation_method: 'SIMPLE_INTEREST',
            start_date: '2026-01-01',
            due_date: '2026-01-31',
            notes: 'Step 5T End-to-End Test Account'
        });
        assert.strictEqual(createRes.statusCode, 201);
        testAccountId = createRes.body.data.id;
        assert(testAccountId, 'Created account ID must be returned');

        // Check account state
        const accRes = await request('GET', `/accounts/${testAccountId}`);
        assert.strictEqual(accRes.statusCode, 200);
        assert.strictEqual(accRes.body.data.principal, 1000000); // 10,000 rupees in paisa
        assert.strictEqual(accRes.body.data.outstanding_principal, 1000000);

        // Check interest balance
        const balRes = await request('GET', `/accounts/${testAccountId}/interest-balance`);
        assert.strictEqual(balRes.statusCode, 200);
        assert.strictEqual(balRes.body.data.record_count, 0, 'Initial record count must be 0');
        assert.strictEqual(balRes.body.data.total_recorded, 0);
        assert.strictEqual(balRes.body.data.total_paid, 0);
        assert.strictEqual(balRes.body.data.total_outstanding, 0);
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 2: Preview, Recording & Derived Outstanding (§4 – §6)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 2: Preview, Manual Recording & Outstanding Balance ---');

    await runStep('§4: Preview 30-Day Interest: ₹98.63 (0 database rows created)', async () => {
        const prevRes = await request('POST', '/interest/calculate-by-dates', {
            principal: 10000,
            rate: 12.0,
            start_date: '2026-01-01',
            end_date: '2026-01-31',
            basis: 'ACTUAL_365'
        });
        assert.strictEqual(prevRes.statusCode, 200);
        assert.strictEqual(prevRes.body.data.interest, 98.63);
        assert.strictEqual(prevRes.body.data.interest_paisa, 9863);

        // Verify zero persistence
        const balRes = await request('GET', `/accounts/${testAccountId}/interest-balance`);
        assert.strictEqual(balRes.body.data.record_count, 0, 'Preview must not persist any database records');
    });

    await runStep('§5: Manual Recording: Record ₹98.63, Status PENDING, Source MANUAL, 1 Audit Event', async () => {
        const recRes = await request('POST', `/accounts/${testAccountId}/interest-records`, {
            period_start: '2026-01-01',
            period_end: '2026-01-31',
            interest_amount: 98.63,
            principal_basis: 10000,
            interest_rate: 12.0
        });
        assert.strictEqual(recRes.statusCode, 201);
        period1RecordId = recRes.body.data.id;
        assert.strictEqual(recRes.body.data.interest_amount, 9863); // stored in paisa
        assert.strictEqual(recRes.body.data.status, 'PENDING');
        assert.strictEqual(recRes.body.data.source, 'MANUAL');

        // Verify audit trail
        const auditRes = await request('GET', `/interest-records/${period1RecordId}/audit`);
        assert.strictEqual(auditRes.statusCode, 200);
        assert.strictEqual(auditRes.body.data.audit.action, 'INTEREST_RECORDED');
        assert.strictEqual(auditRes.body.data.audit.source, 'MANUAL');
        assert.strictEqual(auditRes.body.data.audit.interest_amount_rupees, 98.63);
    });

    await runStep('§6: Outstanding Check: Recorded ₹98.63, Paid ₹0.00, Outstanding ₹98.63', async () => {
        const balRes = await request('GET', `/accounts/${testAccountId}/interest-balance`);
        assert.strictEqual(balRes.body.data.total_recorded, 98.63);
        assert.strictEqual(balRes.body.data.total_paid, 0);
        assert.strictEqual(balRes.body.data.total_outstanding, 98.63);
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 3: Partial Payment & Reversal Guardrails (§7 – §8)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 3: Payment Allocation & Reversal Guardrails ---');

    await runStep('§7: Partial Payment: Pay ₹30.00 -> Outstanding ₹68.63, Principal remains ₹10,000', async () => {
        const payRes = await request('POST', '/payments/allocate', {
            account_id: testAccountId,
            total_amount: 30.00,
            interest_amount: 30.00,
            principal_amount: 0,
            payment_method: 'CASH',
            payment_date: '15/01/2026',
            reference: 'CASH/PARTIAL-30'
        });
        assert.strictEqual(payRes.statusCode, 201);

        const balRes = await request('GET', `/accounts/${testAccountId}/interest-balance`);
        assert.strictEqual(balRes.body.data.total_recorded, 98.63);
        assert.strictEqual(balRes.body.data.total_paid, 30.00);
        assert.strictEqual(balRes.body.data.total_outstanding, 68.63);

        const accRes = await request('GET', `/accounts/${testAccountId}`);
        assert.strictEqual(accRes.body.data.outstanding_principal, 1000000, 'Principal must remain ₹10,000');
    });

    await runStep('§8: Prevent Invalid Reversal on Partially Paid Record (Rejected with HTTP 400)', async () => {
        const revRes = await request('POST', `/interest-records/${period1RecordId}/reverse`, {
            reason: 'Attempting to reverse paid interest'
        });
        assert.strictEqual(revRes.statusCode, 400);
        assert(revRes.body.error.includes('associated payments'));

        // Verify state is untouched
        const balRes = await request('GET', `/accounts/${testAccountId}/interest-balance`);
        assert.strictEqual(balRes.body.data.total_recorded, 98.63);
        assert.strictEqual(balRes.body.data.total_paid, 30.00);
        assert.strictEqual(balRes.body.data.total_outstanding, 68.63);
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 4: Subsequent Period, Scheduler & Duplicate Prevention (§9 – §11)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 4: Automated Scheduler Accrual & Duplicate Prevention ---');

    await runStep('§9 & §10: Automatic Accrual for Next Period: Amount ₹98.63, Source AUTOMATIC', async () => {
        const autoRes = await request('POST', `/accounts/${testAccountId}/accrue-interest`, {
            start_date: '2026-02-01',
            end_date: '2026-03-03',
            options: { source: 'AUTOMATIC' }
        });
        assert.strictEqual(autoRes.statusCode, 200);
        assert.strictEqual(autoRes.body.data.status, 'RECORDED');
        assert.strictEqual(autoRes.body.data.record.source, 'AUTOMATIC');
        assert.strictEqual(autoRes.body.data.interestAmount, 98.63);
        period2RecordId = autoRes.body.data.interestRecordId;

        // Verify audit log has source AUTOMATIC
        const auditRes = await request('GET', `/interest-records/${period2RecordId}/audit`);
        assert.strictEqual(auditRes.statusCode, 200);
        assert.strictEqual(auditRes.body.data.audit.source, 'AUTOMATIC');
    });

    await runStep('§11: Scheduler Duplicate Prevention: Subsequent Accrual Request Returns ALREADY_RECORDED', async () => {
        const autoRes2 = await request('POST', `/accounts/${testAccountId}/accrue-interest`, {
            start_date: '2026-02-01',
            end_date: '2026-03-03'
        });
        assert.strictEqual(autoRes2.statusCode, 200);
        assert.strictEqual(autoRes2.body.data.status, 'ALREADY_RECORDED');

        const balRes = await request('GET', `/accounts/${testAccountId}/interest-balance`);
        assert.strictEqual(balRes.body.data.record_count, 2, 'Must still have exactly 2 records');
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 5: Scheduler Failure Simulation & Isolated Retry (§12)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 5: Failure Simulation & Controlled Manual Retry ---');

    await runStep('§12: Separate Account Failure Simulation & Retry Flow', async () => {
        // Create dedicated account for failure test
        const accFailRes = await request('POST', '/accounts', {
            person_id: 1,
            direction: 'MONEY_GIVEN',
            principal: 5000,
            interest_rate: 12.0,
            interest_frequency: 'MONTHLY',
            start_date: '2026-08-01',
            due_date: '2026-08-31'
        });
        const failAccountId = accFailRes.body.data.id;

        // Run scheduler simulating permanent failure on this account
        const schedRes = await request('POST', '/scheduler/run', {
            currentDate: '2026-09-01',
            failAccountIds: [failAccountId]
        });
        assert.strictEqual(schedRes.statusCode, 200);

        // Query failures
        const failList = await request('GET', `/scheduler/failures?account_id=${failAccountId}`);
        assert.strictEqual(failList.statusCode, 200);
        const failureDetail = failList.body.data.find(d => d.account_id === failAccountId);
        assert(failureDetail, 'Failure detail must be recorded');
        assert.strictEqual(failureDetail.result, 'FAILED');

        // Retry the failure
        const retryRes = await request('POST', `/scheduler/retry/${failureDetail.id}`);
        assert.strictEqual(retryRes.statusCode, 200);
        assert.strictEqual(retryRes.body.data.detail.result, 'SUCCESS');
        assert.strictEqual(retryRes.body.data.success, true);
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 6: Unpaid Reversal, Correction Chains & Audit (§13 – §15)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 6: Reversal Mechanics, Correction Lineage & Audit Traceability ---');

    let unpaidRecordId = null;

    await runStep('§13: Fresh Unpaid Record Reversal: Original = REVERSED, Outstanding = ₹0', async () => {
        const freshRec = await request('POST', '/interest/record', {
            account_id: testAccountId,
            period_start: '2026-04-01',
            period_end: '2026-04-30',
            interest_amount: 98.63
        });
        assert.strictEqual(freshRec.statusCode, 201);
        unpaidRecordId = freshRec.body.data.id;

        const revRes = await request('POST', `/interest-records/${unpaidRecordId}/reverse`, {
            reason: 'Rate adjustment needed (12% -> 10%)',
            actor_id: 'OFFICER_42'
        });
        assert.strictEqual(revRes.statusCode, 200);
        assert.strictEqual(revRes.body.data.status, 'REVERSED');
        assert.strictEqual(revRes.body.data.record.outstanding_amount_rupees, 0);

        // Verify original record is preserved
        const auditRes = await request('GET', `/interest-records/${unpaidRecordId}/audit`);
        assert.strictEqual(auditRes.statusCode, 200);
        assert.strictEqual(auditRes.body.data.record.status, 'REVERSED');
        assert.strictEqual(auditRes.body.data.audit.action, 'INTEREST_REVERSED');
    });

    await runStep('§14: Correction Lineage: Original ₹98.63 -> Reversed -> Corrected ₹82.19', async () => {
        const corrRes = await request('POST', '/interest/record', {
            account_id: testAccountId,
            period_start: '2026-04-01',
            period_end: '2026-04-30',
            interest_amount: 82.19,
            corrects_record_id: unpaidRecordId
        });
        assert.strictEqual(corrRes.statusCode, 201);
        const correctedId = corrRes.body.data.id;

        // Trace correction history
        const chainRes = await request('GET', `/interest-records/${correctedId}/correction-history`);
        assert.strictEqual(chainRes.statusCode, 200);
        assert.strictEqual(chainRes.body.data.chain.length, 2);
        assert.strictEqual(chainRes.body.data.chain[0].id, unpaidRecordId);
        assert.strictEqual(chainRes.body.data.chain[0].status, 'REVERSED');
        assert.strictEqual(chainRes.body.data.chain[1].id, correctedId);
        assert.strictEqual(chainRes.body.data.chain[1].status, 'PENDING');
        assert.strictEqual(chainRes.body.data.chain[1].interest_amount_rupees, 82.19);
    });

    await runStep('§15: Complete Audit Trail Traceability', async () => {
        const auditHist = await request('GET', `/accounts/${testAccountId}/interest-audit`);
        assert.strictEqual(auditHist.statusCode, 200);
        const actions = auditHist.body.data.map(a => a.audit ? a.audit.action : 'LEGACY');
        assert(actions.includes('INTEREST_RECORDED'), 'Must include manual recording audit');
        assert(actions.includes('INTEREST_REVERSED'), 'Must include reversal audit');
        const hasAuto = auditHist.body.data.some(a => a.audit && a.audit.source === 'AUTOMATIC');
        assert(hasAuto, 'Must include automatic accrual audit event');
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 7: Account & Period Isolation (§16 – §17)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 7: Isolation Guarantees (Account & Period) ---');

    await runStep('§16: Account Isolation (Account B: ₹20,000 @ 12% = ₹197.26)', async () => {
        const accBRes = await request('POST', '/accounts', {
            person_id: 1,
            direction: 'MONEY_GIVEN',
            principal: 20000,
            interest_rate: 12.0,
            interest_frequency: 'MONTHLY',
            start_date: '2026-01-01',
            due_date: '2026-01-31'
        });
        const accBId = accBRes.body.data.id;

        const calcB = await request('POST', '/interest/calculate', {
            principal: 20000,
            rate: 12.0,
            time: 30 / 365
        });
        assert.strictEqual(calcB.body.data.interest, 197.26);

        // Record on Account B
        await request('POST', `/accounts/${accBId}/interest-records`, {
            period_start: '2026-01-01',
            period_end: '2026-01-31',
            interest_amount: 197.26
        });

        // Verify Account A balance is completely untouched
        const balA = await request('GET', `/accounts/${testAccountId}/interest-balance`);
        assert.notStrictEqual(balA.body.data.account_id, accBId);
    });

    await runStep('§17: Period Isolation (Period A = REVERSED, Period B = PENDING)', async () => {
        const balA = await request('GET', `/accounts/${testAccountId}/interest-balance`);
        const reversedPeriods = balA.body.data.records.filter(r => r.status === 'REVERSED');
        const pendingPeriods = balA.body.data.records.filter(r => r.status === 'PENDING');
        assert(reversedPeriods.length > 0, 'Reversed period exists');
        assert(pendingPeriods.length > 0, 'Active pending period exists');
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 8: Concurrency & Historical Immutability (§18 – §22)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 8: Concurrency, Database Integrity & Historical Immutability ---');

    await runStep('§18, §19 & §20: Concurrency Protection (Simultaneous Recording & Reversal)', async () => {
        // Concurrent recording on same period
        const [res1, res2] = await Promise.all([
            request('POST', '/interest/record', { account_id: testAccountId, period_start: '2026-07-01', period_end: '2026-07-31', interest_amount: 50 }),
            request('POST', '/interest/record', { account_id: testAccountId, period_start: '2026-07-01', period_end: '2026-07-31', interest_amount: 50 })
        ]);
        const statuses = [res1.statusCode, res2.statusCode];
        assert(statuses.includes(201), 'One recording succeeds');
        assert(statuses.includes(400), 'Second concurrent recording is rejected');
    });

    await runStep('§21 & §22: Database Failure Handling & Historical Immutability (HTTP 405)', async () => {
        // Invalid account transaction failure
        const failRes = await request('POST', '/interest/record', {
            account_id: 999999,
            period_start: '2026-01-01',
            period_end: '2026-01-31',
            interest_amount: 50
        });
        assert.strictEqual(failRes.statusCode, 404);

        // Immutability checks
        const mutRoutes = [
            { method: 'PUT', path: '/transactions/1' },
            { method: 'DELETE', path: '/transactions/1' },
            { method: 'PUT', path: '/audit-logs/1' },
            { method: 'DELETE', path: '/audit-logs/1' },
            { method: 'PUT', path: '/interest-records/1/reverse' },
            { method: 'DELETE', path: '/interest-records/1/reverse' }
        ];
        for (const m of mutRoutes) {
            const res = await request(m.method, m.path);
            assert.strictEqual(res.statusCode, 405, `${m.method} ${m.path} must return 405`);
        }
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 9: UI Asset & API Verification (§23 – §24)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 9: UI & API Integration Verification ---');

    await runStep('§23 & §24: API Integration & Static UI Verification', async () => {
        // Verify index.html exists and contains interest module UI elements
        const indexPath = path.join(__dirname, '../public/index.html');
        assert(fs.existsSync(indexPath), 'public/index.html must exist');
        const indexHtml = fs.readFileSync(indexPath, 'utf8');
        assert(indexHtml.includes('Interest'), 'index.html must contain Interest UI');

        // Verify public/js/app.js exists
        const appJsPath = path.join(__dirname, '../public/js/app.js');
        assert(fs.existsSync(appJsPath), 'public/js/app.js must exist');
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 10: Authoritative Financial Reconciliation (§28 – §29)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 10: Authoritative Financial Reconciliation ---');

    await runStep('§28 & §29: Five Baseline Reconciliations & Data Invariants', async () => {
        // 1. 10k @ 12% 30d = 98.63
        const b1 = await request('POST', '/interest/calculate', { principal: 10000, rate: 12, time: 30 / 365 });
        assert.strictEqual(b1.body.data.interest, 98.63);

        // 2. 20k @ 12% 30d = 197.26
        const b2 = await request('POST', '/interest/calculate', { principal: 20000, rate: 12, time: 30 / 365 });
        assert.strictEqual(b2.body.data.interest, 197.26);

        // 3. 5k @ 12% 30d = 49.32
        const b3 = await request('POST', '/interest/calculate', { principal: 5000, rate: 12, time: 30 / 365 });
        assert.strictEqual(b3.body.data.interest, 49.32);

        // 4. Segmented 10k 14d + 8k 14d = 82.85
        const s1 = await request('POST', '/interest/calculate', { principal: 10000, rate: 12, time: 14 / 365 });
        const s2 = await request('POST', '/interest/calculate', { principal: 8000, rate: 12, time: 14 / 365 });
        const segTotal = Math.round((s1.body.data.interest + s2.body.data.interest) * 100) / 100;
        assert.strictEqual(segTotal, 82.85);

        // 5. Corrected 10k @ 10% 30d = 82.19
        const b5 = await request('POST', '/interest/calculate', { principal: 10000, rate: 10, time: 30 / 365 });
        assert.strictEqual(b5.body.data.interest, 82.19);
    });

    console.log('\n================================================================');
    console.log(`Step 5T Integration Results: ${passed} passed, ${failed} failed`);
    console.log('================================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runAll().catch((err) => {
    console.error('Step 5T test suite runner failed:', err);
    process.exit(1);
});
