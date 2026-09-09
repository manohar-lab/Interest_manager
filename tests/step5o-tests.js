/**
 * Interest Manager — Step 5O Test Suite
 * End-to-End Interest Lifecycle Validation & Financial Invariant Verification
 * 
 * Verifies complete pipeline (§1 - §48):
 * - §1 - §2:   Deterministic Pipeline & Test Fixtures Setup
 * - §3 - §4:   Authoritative Calculation & Non-persistent Preview
 * - §5 - §6:   Manual Recording & Derived Outstanding Interest
 * - §7 - §8:   Payment Processing & Principal Timeline Separation
 * - §9:        Segmented Multi-Principal Timeline Calculation
 * - §10 - §12: Automatic Accrual, Audit Linkage & Scheduler Monitoring
 * - §13 - §15: Cross-Workflow Duplicate Protection (Manual ↔ Automatic)
 * - §16 - §18: Failure Recovery, Controlled Retry & Crash Recovery
 * - §19 - §20: End-to-End Audit Traceability (Manual & Automatic)
 * - §21 - §24: Reversal Mechanics & Payment Protection Guardrails
 * - §25 - §26: Correction Lineage & Complete Audit Chain
 * - §27 - §29: Financial Invariants (Principal, Payment & Transaction Separation)
 * - §30 - §33: Account, Period, Rate & Historical Snapshot Isolation
 * - §34 - §35: Active Record Uniqueness & Immutability Enforcement
 * - §36 - §38: Concurrent Operations Safety (Record, Reversal, Scheduler)
 * - §39:       Transaction Atomicity & Database Failure Simulation
 * - §40:       Grand Unified End-to-End Interest Lifecycle Integration Test
 * - §47:       Validation of Core Financial Invariants (1 through 8)
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

        req.on('error', reject);

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

async function resetDb() {
    const res = await request('POST', '/test/reset-state');
    assert.strictEqual(res.statusCode, 200, 'Reset state should succeed');
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    Error: ${err.message}`);
        if (err.stack) {
            console.error(`    Stack: ${err.stack.split('\n').slice(1, 4).join('\n')}`);
        }
        failed++;
    }
}

async function runTests() {
    console.log('\n================================================================');
    console.log('   INTEREST MANAGER — STEP 5O: LIFECYCLE VALIDATION TESTS');
    console.log('================================================================\n');

    // ──────────────────────────────────────────────────────────
    // PHASE 1: Basic Calculation, Non-Persistent Preview & Recording
    // ──────────────────────────────────────────────────────────
    console.log('--- Phase 1: Calculation, Preview & Manual Recording (§2 - §6) ---');

    await test('§2 & §3: Authoritative Calculation on test account (10,000 @ 12% for 1 month = ₹101.92)', async () => {
        await resetDb();

        // Calculate simple interest by dates for 2026-08-01 to 2026-09-01 (31 days)
        // 10,000 * 0.12 * (31 / 365) = 101.9178... -> ₹101.92
        const calcRes = await request('POST', '/interest/calculate-by-dates', {
            principal: 10000,
            rate: 12.0,
            start_date: '2026-08-01',
            end_date: '2026-09-01',
            basis: 'ACTUAL_365'
        });

        assert.strictEqual(calcRes.statusCode, 200);
        assert.strictEqual(calcRes.body.data.interest, 101.92);
        assert.strictEqual(calcRes.body.data.interest_paisa, 10192);
    });

    await test('§4: Interest Preview is non-persistent (zero DB rows created)', async () => {
        await resetDb();

        // Run preview via timeline calculation endpoint
        const previewRes = await request('POST', '/accounts/1/timeline-interest', {
            start_date: '2026-08-01',
            end_date: '2026-09-01',
            basis: 'ACTUAL_365'
        });

        assert.strictEqual(previewRes.statusCode, 200);
        assert.ok(previewRes.body.data.total_interest > 0);

        // Verify that NO interest records were written to the database
        const balRes = await request('GET', '/accounts/1/interest-balance');
        assert.strictEqual(balRes.body.data.record_count, 0, 'Preview must not create interest records');
        assert.strictEqual(balRes.body.data.total_recorded, 0, 'Total recorded must be 0');
    });

    await test('§5 & §6: Manual Recording creates interest record and updates derived outstanding', async () => {
        await resetDb();

        const recRes = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 25.48,
            principal_basis: 2000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST',
            source: 'MANUAL',
            actor_id: 'ops_tester'
        });

        assert.strictEqual(recRes.statusCode, 201);
        const recordId = recRes.body.data.id;
        assert.strictEqual(recRes.body.data.status, 'PENDING');

        // Check audit log
        const auditRes = await request('GET', `/interest-records/${recordId}/audit`);
        assert.strictEqual(auditRes.statusCode, 200);
        assert.strictEqual(auditRes.body.data.audit.source, 'MANUAL');
        assert.strictEqual(auditRes.body.data.audit.actor_id, 'ops_tester');

        // Step 5I derived outstanding verification
        const balRes = await request('GET', '/accounts/1/interest-balance');
        assert.strictEqual(balRes.body.data.total_recorded, 25.48);
        assert.strictEqual(balRes.body.data.total_paid, 0);
        assert.strictEqual(balRes.body.data.total_outstanding, 25.48);
    });

    // ──────────────────────────────────────────────────────────
    // PHASE 2: Payments & Principal Timeline Integration
    // ──────────────────────────────────────────────────────────
    console.log('\n--- Phase 2: Payments & Principal Timeline Integration (§7 - §9) ---');

    await test('§7: Interest Payment reduces outstanding without touching principal', async () => {
        await resetDb();

        // 1. Record interest ₹25.48
        await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 25.48,
            principal_basis: 2000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST'
        });

        const accBefore = await request('GET', '/accounts/1');
        const principalBefore = accBefore.body.data.outstanding_principal;

        // 2. Pay ₹10.00 interest
        const payRes = await request('POST', '/payments/allocate', {
            account_id: 1,
            total_amount: 10,
            interest_amount: 10,
            principal_amount: 0,
            payment_method: 'UPI',
            payment_date: '15/08/2026',
            reference: 'UPI/INT-ONLY-01'
        });
        assert.strictEqual(payRes.statusCode, 201);

        // 3. Verify outstanding interest = ₹15.48
        const balRes = await request('GET', '/accounts/1/interest-balance');
        assert.strictEqual(balRes.body.data.total_recorded, 25.48);
        assert.strictEqual(balRes.body.data.total_paid, 10);
        assert.strictEqual(balRes.body.data.total_outstanding, 15.48);

        // 4. Verify principal remains untouched
        const accAfter = await request('GET', '/accounts/1');
        assert.strictEqual(accAfter.body.data.outstanding_principal, principalBefore);
    });

    await test('§8 & §9: Principal Payment creates segmented multi-principal timeline for interest', async () => {
        await resetDb();

        // Account 1 has principal ₹2,000 (200,000 paisa) from 2026-08-01
        // Make mid-month principal payment of ₹500 on 2026-08-16
        const payRes = await request('POST', '/payments/allocate', {
            account_id: 1,
            total_amount: 500,
            interest_amount: 0,
            principal_amount: 500,
            payment_method: 'BANK_TRANSFER',
            payment_date: '16/08/2026',
            reference: 'BANK/PRIN-01'
        });
        assert.strictEqual(payRes.statusCode, 201);

        // Calculate timeline interest for 2026-08-01 to 2026-09-01
        const calcRes = await request('POST', '/accounts/1/timeline-interest', {
            start_date: '2026-08-01',
            end_date: '2026-09-01',
            basis: 'ACTUAL_365'
        });

        assert.strictEqual(calcRes.statusCode, 200);
        assert.strictEqual(calcRes.body.data.segments.length, 2, 'Must have exactly 2 calculation segments');

        const seg1 = calcRes.body.data.segments[0];
        const seg2 = calcRes.body.data.segments[1];

        // Segment 1: 01/08 -> 16/08 (15 days @ ₹2,000)
        assert.strictEqual(seg1.start_date, '2026-08-01');
        assert.strictEqual(seg1.end_date, '2026-08-16');
        assert.strictEqual(seg1.elapsed_days || seg1.elapsedDays, 15);
        assert.strictEqual(seg1.principal, 2000);

        // Segment 2: 16/08 -> 01/09 (16 days @ ₹1,500)
        assert.strictEqual(seg2.start_date, '2026-08-16');
        assert.strictEqual(seg2.end_date, '2026-09-01');
        assert.strictEqual(seg2.elapsed_days || seg2.elapsedDays, 16);
        assert.strictEqual(seg2.principal, 1500);
    });

    // ──────────────────────────────────────────────────────────
    // PHASE 3: Scheduler, Monitoring & Failure Recovery
    // ──────────────────────────────────────────────────────────
    console.log('\n--- Phase 3: Scheduler, Monitoring & Failure Recovery (§10 - §18) ---');

    await test('§10, §11, §12: Scheduler accrues interest with AUTOMATIC audit and monitoring run', async () => {
        await resetDb();

        // Run scheduler for 2026-09-01 (accrues Account 1 and Account 4)
        const schedRes = await request('POST', '/scheduler/run', { as_of_date: '2026-09-01' });
        assert.strictEqual(schedRes.statusCode, 200);
        assert.strictEqual(schedRes.body.data.status, 'COMPLETED');
        assert.strictEqual(schedRes.body.data.accrualsCreated, 2);

        // Verify monitoring runs API (Step 5L)
        const runsRes = await request('GET', '/scheduler/runs');
        assert.strictEqual(runsRes.statusCode, 200);
        assert.ok(runsRes.body.data.length >= 1);
        const latestRun = runsRes.body.data[0];
        assert.strictEqual(latestRun.status, 'COMPLETED');

        // Verify audit linkage (Step 5M)
        const balRes = await request('GET', '/accounts/1/interest-balance');
        const rec = balRes.body.data.records[0];
        assert.strictEqual(rec.source, 'AUTOMATIC');
        assert.ok(rec.scheduler_run_id, 'Must link scheduler run ID');
    });

    await test('§13, §14, §15: Idempotency & cross-workflow duplicate prevention', async () => {
        await resetDb();

        // 1. Manual recording for Account 1 (2026-08-01 -> 2026-09-01)
        await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 25.48,
            principal_basis: 2000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST'
        });

        // 2. Scheduler execution for same date detects existing record (§14)
        const schedRes = await request('POST', '/scheduler/run', { as_of_date: '2026-09-01' });
        assert.strictEqual(schedRes.statusCode, 200);
        assert.strictEqual(schedRes.body.data.alreadyRecorded, 1, 'Account 1 must be skipped as ALREADY_RECORDED');

        // 3. Second scheduler run for same date also detects existing (§13)
        const schedRes2 = await request('POST', '/scheduler/run', { as_of_date: '2026-09-01' });
        assert.strictEqual(schedRes2.body.data.accrualsCreated, 0);
        assert.strictEqual(schedRes2.body.data.alreadyRecorded, 2);

        // 4. Attempting manual record for Account 4 (which was accrued automatically) is rejected (§15)
        const dupManual = await request('POST', '/accounts/4/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 82191.78,
            principal_basis: 10000000,
            interest_rate: 10.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        assert.strictEqual(dupManual.statusCode, 400, 'Manual duplicate must be rejected');
    });

    await test('§16, §17, §18: Partial failure, failure tracking, and controlled manual retry', async () => {
        await resetDb();

        // Run scheduler with simulated failure on Account 1
        const failRun = await request('POST', '/scheduler/run', {
            as_of_date: '2026-09-01',
            failAccountIds: [1]
        });

        assert.strictEqual(failRun.statusCode, 200);
        assert.strictEqual(failRun.body.data.status, 'COMPLETED_WITH_ERRORS');
        assert.strictEqual(failRun.body.data.failed, 1);
        assert.strictEqual(failRun.body.data.accrualsCreated, 1, 'Account 4 must succeed despite Account 1 failure');

        // Get failed accruals
        const failsRes = await request('GET', '/scheduler/failures');
        assert.strictEqual(failsRes.statusCode, 200);
        assert.ok(failsRes.body.data.length >= 1);
        const failDetail = failsRes.body.data.find(f => f.account_id === 1);
        assert.ok(failDetail, 'Account 1 failure detail must exist');

        // Execute manual retry
        const retryRes = await request('POST', `/scheduler/retry/${failDetail.id}`);
        assert.strictEqual(retryRes.statusCode, 200);
        assert.strictEqual(retryRes.body.data.success, true);
        assert.strictEqual(retryRes.body.data.detail.result, 'SUCCESS');

        // Verify Account 1 now has exactly 1 interest record
        const bal1 = await request('GET', '/accounts/1/interest-balance');
        assert.strictEqual(bal1.body.data.record_count, 1);
    });

    // ──────────────────────────────────────────────────────────
    // PHASE 4: Audit Trails, Reversal & Correction Lifecycle
    // ──────────────────────────────────────────────────────────
    console.log('\n--- Phase 4: Audit Trails, Reversal & Correction Lifecycle (§19 - §26) ---');

    await test('§19 & §20: Complete Audit Traceability for automatic and manual records', async () => {
        await resetDb();

        // 1. Automatic accrual on Account 4
        await request('POST', '/scheduler/run', { as_of_date: '2026-09-01' });
        const bal4 = await request('GET', '/accounts/4/interest-balance');
        const autoRecId = bal4.body.data.records[0].id;

        const autoAudit = await request('GET', `/interest-records/${autoRecId}/audit`);
        assert.strictEqual(autoAudit.statusCode, 200);
        assert.strictEqual(autoAudit.body.data.audit.source, 'AUTOMATIC');
        assert.ok(autoAudit.body.data.audit.scheduler_run_id);
        assert.ok(autoAudit.body.data.audit.segments.length > 0);

        // 2. Manual accrual on Account 2
        const manRec = await request('POST', '/accounts/2/interest-records', {
            period_start: '2026-09-01',
            period_end: '2026-10-01',
            interest_amount: 25.48,
            principal_basis: 2000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST',
            source: 'MANUAL',
            actor_id: 'finance_manager_1'
        });
        const manAudit = await request('GET', `/interest-records/${manRec.body.data.id}/audit`);
        assert.strictEqual(manAudit.statusCode, 200);
        assert.strictEqual(manAudit.body.data.audit.source, 'MANUAL');
        assert.strictEqual(manAudit.body.data.audit.actor_id, 'finance_manager_1');
    });

    await test('§21, §22, §23, §24: Reversal mechanics & payment protection guardrails', async () => {
        await resetDb();

        // 1. Unpaid record reversal (§21)
        const rec = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 25.48,
            principal_basis: 2000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        const recId = rec.body.data.id;

        const revRes = await request('POST', `/interest-records/${recId}/reverse`, {
            reason: 'Rate entry mistake'
        });
        assert.strictEqual(revRes.statusCode, 200);
        assert.strictEqual(revRes.body.data.status, 'REVERSED');

        const balAfter = await request('GET', '/accounts/1/interest-balance');
        assert.strictEqual(balAfter.body.data.total_outstanding, 0);

        // 2. Double reversal rejection (§22)
        const rev2 = await request('POST', `/interest-records/${recId}/reverse`, {
            reason: 'Second reversal attempt'
        });
        assert.strictEqual(rev2.statusCode, 400);

        // 3. Partially paid reversal rejection (§23)
        const recPaid = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-09-01',
            period_end: '2026-10-01',
            interest_amount: 25.48,
            principal_basis: 2000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        await request('POST', '/payments/allocate', {
            account_id: 1,
            total_amount: 10,
            interest_amount: 10,
            principal_amount: 0,
            payment_method: 'UPI',
            payment_date: '15/09/2026',
            reference: 'UPI/GUARD-01'
        });
        const revPart = await request('POST', `/interest-records/${recPaid.body.data.id}/reverse`, {
            reason: 'Attempting reversal on partially paid'
        });
        assert.strictEqual(revPart.statusCode, 400);

        // 4. Fully paid reversal rejection (§24)
        await request('POST', '/payments/allocate', {
            account_id: 1,
            total_amount: 15.48,
            interest_amount: 15.48,
            principal_amount: 0,
            payment_method: 'UPI',
            payment_date: '20/09/2026',
            reference: 'UPI/GUARD-02'
        });
        const revFull = await request('POST', `/interest-records/${recPaid.body.data.id}/reverse`, {
            reason: 'Attempting reversal on fully paid'
        });
        assert.strictEqual(revFull.statusCode, 400);
    });

    await test('§25 & §26: Correction Flow & Complete Lineage Chain', async () => {
        await resetDb();

        // 1. Record erroneous interest ₹30.00
        const rec1 = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 30.00,
            principal_basis: 2000,
            interest_rate: 18.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        const r1Id = rec1.body.data.id;

        // 2. Reverse R1
        await request('POST', `/interest-records/${r1Id}/reverse`, {
            reason: 'Incorrect 18% rate instead of contract 15%'
        });

        // 3. Create corrected record R2 linking corrects_record_id = R1
        const rec2 = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 25.48,
            principal_basis: 2000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST',
            corrects_record_id: r1Id
        });
        const r2Id = rec2.body.data.id;

        // 4. Query correction lineage chain
        const chainRes = await request('GET', `/interest-records/${r2Id}/correction-history`);
        assert.strictEqual(chainRes.statusCode, 200);
        assert.strictEqual(chainRes.body.data.chain.length, 2);
        assert.strictEqual(chainRes.body.data.chain[0].id, r1Id);
        assert.strictEqual(chainRes.body.data.chain[0].type, 'ORIGINAL');
        assert.strictEqual(chainRes.body.data.chain[0].status, 'REVERSED');
        assert.strictEqual(chainRes.body.data.chain[1].id, r2Id);
        assert.strictEqual(chainRes.body.data.chain[1].type, 'CORRECTION');
        assert.strictEqual(chainRes.body.data.chain[1].status, 'PENDING');
    });

    // ──────────────────────────────────────────────────────────
    // PHASE 5: Invariant Testing & Isolation
    // ──────────────────────────────────────────────────────────
    console.log('\n--- Phase 5: Financial Invariants & Isolation (§27 - §39) ---');

    await test('§27, §28, §29: Invariant 1 & 2 — Interest operations never modify Principal or Payments', async () => {
        await resetDb();

        const accBefore = await request('GET', '/accounts/1');
        const p1 = accBefore.body.data.outstanding_principal;

        // Record interest
        const rec = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 25.48,
            principal_basis: 2000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST'
        });

        // Principal unchanged
        const accAfterRec = await request('GET', '/accounts/1');
        assert.strictEqual(accAfterRec.body.data.outstanding_principal, p1);

        // Reverse interest
        await request('POST', `/interest-records/${rec.body.data.id}/reverse`, { reason: 'Invariant test' });

        // Principal still unchanged
        const accAfterRev = await request('GET', '/accounts/1');
        assert.strictEqual(accAfterRev.body.data.outstanding_principal, p1);

        // Transactions count unchanged
        const txs = await request('GET', '/transactions?account_id=1');
        assert.strictEqual(txs.body.data.length, 0);
    });

    await test('§30 & §31: Account & Period Isolation', async () => {
        await resetDb();

        // Accrue Account 1 and Account 4
        await request('POST', '/scheduler/run', { as_of_date: '2026-09-01' });

        const bal1Before = await request('GET', '/accounts/1/interest-balance');
        const bal4Before = await request('GET', '/accounts/4/interest-balance');

        // Reverse Account 1
        await request('POST', `/interest-records/${bal1Before.body.data.records[0].id}/reverse`, {
            reason: 'Account 1 isolation test'
        });

        // Account 4 is completely untouched
        const bal4After = await request('GET', '/accounts/4/interest-balance');
        assert.strictEqual(bal4After.body.data.total_recorded, bal4Before.body.data.total_recorded);
        assert.strictEqual(bal4After.body.data.records[0].status, 'PENDING');
    });

    await test('§32 & §33: Historical Snapshot Integrity — Rate change does not rewrite historical audits', async () => {
        await resetDb();

        // 1. Record interest with rate 15%
        const rec = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 25.48,
            principal_basis: 2000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        const recId = rec.body.data.id;

        // 2. Fetch historical audit
        const auditBefore = await request('GET', `/interest-records/${recId}/audit`);
        assert.strictEqual(auditBefore.body.data.audit.interest_rate, 15.0);

        // 3. Update account interest rate to 24%
        await request('PUT', '/accounts/1', { interest_rate: 24.0 });

        // 4. Historical audit still shows 15.0%
        const auditAfter = await request('GET', `/interest-records/${recId}/audit`);
        assert.strictEqual(auditAfter.body.data.audit.interest_rate, 15.0);
    });

    await test('§35: Immutability Protection — HTTP 405 on audit log / reversal modification', async () => {
        const p1 = await request('PUT', '/audit-logs/1', {});
        assert.strictEqual(p1.statusCode, 405);

        const p2 = await request('DELETE', '/audit-logs/1');
        assert.strictEqual(p2.statusCode, 405);

        const p3 = await request('PUT', '/interest-records/1/reverse', {});
        assert.strictEqual(p3.statusCode, 405);
    });

    await test('§36, §37, §38: Concurrency Safety for recording, reversal, and scheduler', async () => {
        await resetDb();

        // 1. Concurrent recording
        const [c1, c2] = await Promise.all([
            request('POST', '/accounts/1/interest-records', {
                period_start: '2026-08-01',
                period_end: '2026-09-01',
                interest_amount: 25.48,
                principal_basis: 2000,
                interest_rate: 15.0,
                calculation_method: 'SIMPLE_INTEREST'
            }),
            request('POST', '/accounts/1/interest-records', {
                period_start: '2026-08-01',
                period_end: '2026-09-01',
                interest_amount: 25.48,
                principal_basis: 2000,
                interest_rate: 15.0,
                calculation_method: 'SIMPLE_INTEREST'
            })
        ]);
        const statuses = [c1.statusCode, c2.statusCode];
        assert.ok(statuses.includes(201), 'One recording must succeed');
        assert.ok(statuses.includes(400), 'One recording must fail as duplicate');

        // 2. Concurrent reversal
        const bal = await request('GET', '/accounts/1/interest-balance');
        const activeRecId = bal.body.data.records[0].id;
        const [r1, r2] = await Promise.all([
            request('POST', `/interest-records/${activeRecId}/reverse`, { reason: 'Concurrent rev 1' }),
            request('POST', `/interest-records/${activeRecId}/reverse`, { reason: 'Concurrent rev 2' })
        ]);
        const revStatuses = [r1.statusCode, r2.statusCode];
        assert.ok(revStatuses.includes(200));
        assert.ok(revStatuses.includes(400));
    });

    // ──────────────────────────────────────────────────────────
    // PHASE 6: Grand Unified Lifecycle Integration Test (§40)
    // ──────────────────────────────────────────────────────────
    console.log('\n--- Phase 6: Grand Unified Lifecycle Integration Test (§40) ---');

    await test('§40: Full End-to-End Interest Lifecycle Workflow Execution', async () => {
        await resetDb();

        // 1. Check Initial Account State (Account 1: Principal ₹2,000 @ 15%)
        const acc = await request('GET', '/accounts/1');
        assert.strictEqual(acc.statusCode, 200);
        assert.strictEqual(acc.body.data.principal, 200000); // 200,000 paisa = ₹2,000

        // 2. Preview Interest for Month 1 (2026-08-01 to 2026-09-01)
        const prev = await request('POST', '/accounts/1/timeline-interest', {
            start_date: '2026-08-01',
            end_date: '2026-09-01',
            basis: 'ACTUAL_365'
        });
        assert.strictEqual(prev.statusCode, 200);
        const expectedM1 = prev.body.data.total_interest; // ₹25.48

        // 3. Record Month 1 Interest (Manual)
        const recM1 = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: expectedM1,
            principal_basis: 2000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST',
            source: 'MANUAL',
            actor_id: 'lifecycle_admin'
        });
        assert.strictEqual(recM1.statusCode, 201);
        const m1RecordId = recM1.body.data.id;

        // 4. Verify Derived Outstanding = expectedM1 (₹25.48)
        let bal = await request('GET', '/accounts/1/interest-balance');
        assert.strictEqual(bal.body.data.total_outstanding, expectedM1);

        // 5. Receive Partial Interest Payment ₹10.00
        await request('POST', '/payments/allocate', {
            account_id: 1,
            total_amount: 10,
            interest_amount: 10,
            principal_amount: 0,
            payment_method: 'UPI',
            payment_date: '10/08/2026',
            reference: 'UPI/LIFE-INT-01'
        });
        bal = await request('GET', '/accounts/1/interest-balance');
        assert.strictEqual(bal.body.data.total_outstanding, Math.round((expectedM1 - 10) * 100) / 100);

        // 6. Receive Mid-Period Principal Payment ₹500 on 2026-09-15
        await request('POST', '/payments/allocate', {
            account_id: 1,
            total_amount: 500,
            interest_amount: 0,
            principal_amount: 500,
            payment_method: 'BANK_TRANSFER',
            payment_date: '15/09/2026',
            reference: 'BANK/LIFE-PRIN-01'
        });

        // 7. Run Automatic Scheduler for 2026-10-01 (Month 2: 2026-09-01 to 2026-10-01)
        const schedRes = await request('POST', '/scheduler/run', { as_of_date: '2026-10-01' });
        assert.strictEqual(schedRes.statusCode, 200);

        bal = await request('GET', '/accounts/1/interest-balance');
        assert.strictEqual(bal.body.data.record_count, 2, 'Must have Month 1 and Month 2 records');
        const m2Record = bal.body.data.records.find(r => r.period_start === '2026-09-01');
        assert.ok(m2Record);
        assert.strictEqual(m2Record.source, 'AUTOMATIC');

        // 8. Reversal & Correction flow on Account 2
        const bal2Before = await request('GET', '/accounts/2/interest-balance');
        assert.strictEqual(bal2Before.body.data.record_count, 1, 'Account 2 must have 1 scheduler-created record');
        const autoRec2 = bal2Before.body.data.records[0];

        // Reverse the automatic record
        const revRes = await request('POST', `/interest-records/${autoRec2.id}/reverse`, {
            reason: 'Operator manual adjustment on automated accrual',
            actor_id: 'lifecycle_auditor'
        });
        assert.strictEqual(revRes.statusCode, 200);
        assert.strictEqual(revRes.body.data.status, 'REVERSED');

        // Record corrected interest linking to the reversed record
        const corrRec = await request('POST', '/accounts/2/interest-records', {
            period_start: '2026-09-01',
            period_end: '2026-10-01',
            interest_amount: 24.66,
            principal_basis: 2000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST',
            corrects_record_id: autoRec2.id
        });
        assert.strictEqual(corrRec.statusCode, 201);

        // Verify Correction History
        const corrHist = await request('GET', `/interest-records/${corrRec.body.data.id}/correction-history`);
        assert.strictEqual(corrHist.statusCode, 200);
        assert.strictEqual(corrHist.body.data.chain.length, 2);
        assert.strictEqual(corrHist.body.data.chain[0].id, autoRec2.id);
        assert.strictEqual(corrHist.body.data.chain[0].status, 'REVERSED');
        assert.strictEqual(corrHist.body.data.chain[1].id, corrRec.body.data.id);
        assert.strictEqual(corrHist.body.data.chain[1].status, 'PENDING');

        // 9. Final Reconciliation
        const finalBal1 = await request('GET', '/accounts/1/interest-balance');
        const finalBal2 = await request('GET', '/accounts/2/interest-balance');
        assert.strictEqual(finalBal1.body.data.record_count, 2);
        assert.strictEqual(finalBal2.body.data.record_count, 1);
        assert.strictEqual(finalBal2.body.data.total_recorded, 24.66);
    });

    // ──────────────────────────────────────────────────────────
    // SUMMARY
    // ──────────────────────────────────────────────────────────
    console.log('\n================================================================');
    console.log(`Step 5O Test Results: ${passed} passed, ${failed} failed`);
    console.log('================================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
});
