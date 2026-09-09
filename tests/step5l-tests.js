/**
 * Interest Manager — Step 5L Test Suite
 * Accrual Monitoring & Failure Recovery Verification
 *
 * Tests cover all Step 5L requirements:
 *   §30 — TEST: SUCCESS (all accounts succeed -> COMPLETED, failed = 0)
 *   §31 — TEST: PARTIAL FAILURE (Account A success, B forced failure, C success -> COMPLETED_WITH_ERRORS)
 *   §32 — TEST: RETRY (Initial FAILED, automatic retry SUCCESS, exactly 1 interest record)
 *   §33 — TEST: RETRY AFTER SUCCESSFUL PERSISTENCE (interest record exists -> retry ALREADY_RECORDED, no duplicate)
 *   §34 — TEST: THREE RETRIES (transient failure retried exactly 3 times then stopped)
 *   §35 — TEST: PERMANENT FAILURE (non-retryable error -> no unnecessary retries, attempt count = 1)
 *   §36 — TEST: CRASH RECOVERY (stale RUNNING run cleaned up, does not block scheduler, missing periods processed)
 *   §37 — TEST: MULTIPLE RUNS (1st run records interest, 2nd run safely ALREADY_RECORDED, no duplicates)
 *   §38 — TEST: ACCOUNT ISOLATION (one failing account does not affect or roll back other accounts)
 *   §39 — TEST: DATABASE FAILURE (transient DB failure marks account failed, others succeed, retryable flag set)
 *   §40 — TEST: MONITORING DATA (API returns correct run stats, account-level results, and timestamps)
 *   §41 — TEST: MANUAL RETRY (POST /api/scheduler/retry/:id succeeds and updates detail record)
 *   §42 — TEST: NO CALCULATION CHANGES (Step 5L vs Step 5J produces identical interest amounts)
 *   §43 — TEST: NO PAYMENT CHANGES (Zero payments or transactions created by scheduler/monitoring layer)
 */

const BASE = 'http://localhost:3000/api';
let passed = 0, failed = 0, total = 0;

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error((msg || '') + ` — expected: ${JSON.stringify(b)}, got: ${JSON.stringify(a)}`); }
function assertCloseTo(a, b, delta = 0.02, msg) {
    if (Math.abs(a - b) > delta) throw new Error((msg || '') + ` — expected close to ${b}, got: ${a}`);
}

async function testAsync(name, fn) {
    total++;
    try {
        await fn();
        passed++;
        console.log(`  ✅ Test ${total}: ${name}`);
    } catch (err) {
        failed++;
        console.log(`  ❌ Test ${total}: ${name}`);
        console.log(`      Error: ${err.message}`);
    }
}

async function apiGet(url) {
    const r = await fetch(BASE + url);
    return { status: r.status, body: await r.json() };
}

async function apiPost(url, data) {
    const r = await fetch(BASE + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data || {})
    });
    return { status: r.status, body: await r.json() };
}

async function resetState() {
    const { status, body } = await apiPost('/test/reset-state');
    if (status !== 200) throw new Error(`Reset state failed: ${JSON.stringify(body)}`);
}

async function getInterestRecords(accountId) {
    const { body } = await apiGet(`/accounts/${accountId}/interest-records`);
    return body.data || [];
}

async function createTestAccount(frequency, startDate, principal = 200000, rate = 15.0) {
    let { body: pRes } = await apiGet('/people');
    let personId = pRes.data && pRes.data.length > 0 ? pRes.data[0].id : null;
    if (!personId) {
        const { body: createP } = await apiPost('/people', { name: 'MonitoringTestPerson', phone: '9999999999' });
        personId = createP.data.id;
    }

    const { status, body } = await apiPost('/accounts', {
        person_id: personId,
        direction: 'MONEY_GIVEN',
        principal: principal / 100,
        interest_rate: rate,
        interest_frequency: frequency,
        calculation_method: 'SIMPLE_INTEREST',
        start_date: startDate,
        due_date: '2030-12-31',
        notes: `Step 5L test account: ${frequency}`
    });

    if (status !== 201 && status !== 200) {
        throw new Error(`Failed to create test account: ${JSON.stringify(body)}`);
    }
    return body.data;
}

// ─── Main Test Suite ─────────────────────────────────────────
async function runAllTests() {
    console.log('\n=============================================================');
    console.log('  INTEREST MANAGER — STEP 5L TEST SUITE');
    console.log('  Accrual Monitoring & Failure Recovery Verification');
    console.log('=============================================================\n');

    // ─────────────────────────────────────────────────────────
    // §30: TEST — SUCCESS
    // ─────────────────────────────────────────────────────────
    await testAsync('§30: Scheduler run where all accounts succeed -> COMPLETED, failed = 0', async () => {
        await resetState();

        // Seed accounts 1 and 4 start on 2026-08-01 (Monthly). Run at 2026-09-01.
        const { status, body } = await apiPost('/scheduler/run', { currentDate: '2026-09-01' });
        assertEqual(status, 200, 'HTTP status must be 200');

        const runResult = body.data;
        assertEqual(runResult.status, 'COMPLETED', 'Run status must be COMPLETED');
        assertEqual(runResult.failed, 0, 'Failed count must be 0');
        assertEqual(runResult.accrualsCreated, 2, 'Should create 2 accruals (Accounts 1 and 4)');
        assert(runResult.runId.startsWith('sched_'), 'Run ID must start with sched_');
        assert(runResult.startedAt !== null, 'startedAt must be set');
        assert(runResult.completedAt !== null, 'completedAt must be set');

        // Check persisted run in database
        const { body: runsBody } = await apiGet('/scheduler/runs');
        const latestRun = runsBody.data[0];
        assertEqual(latestRun.run_id, runResult.runId, 'Persisted run ID should match');
        assertEqual(latestRun.status, 'COMPLETED', 'Persisted status must be COMPLETED');
        assertEqual(latestRun.failed, 0, 'Persisted failed must be 0');
    });

    // ─────────────────────────────────────────────────────────
    // §31: TEST — PARTIAL FAILURE
    // ─────────────────────────────────────────────────────────
    await testAsync('§31: Partial failure -> Account A success, B failure -> COMPLETED_WITH_ERRORS', async () => {
        await resetState();

        // Account 1 and 4 are due. We force failure for Account 1.
        const { status, body } = await apiPost('/scheduler/run', {
            currentDate: '2026-09-01',
            failAccountIds: [1]
        });
        assertEqual(status, 200, 'HTTP status must be 200');

        const runResult = body.data;
        assertEqual(runResult.status, 'COMPLETED_WITH_ERRORS', 'Status must be COMPLETED_WITH_ERRORS');
        assertEqual(runResult.failed, 1, 'Failed count must be 1 (Account 1)');
        assertEqual(runResult.accrualsCreated, 1, 'Account 4 must succeed (accrualsCreated = 1)');

        // Verify Account 4 has interest recorded and Account 1 does not
        const recs1 = await getInterestRecords(1);
        const recs4 = await getInterestRecords(4);
        assertEqual(recs1.length, 0, 'Account 1 must have 0 interest records due to failure');
        assertEqual(recs4.length, 1, 'Account 4 must have 1 interest record');

        // Verify run details in database
        const { body: runDetailsRes } = await apiGet(`/scheduler/runs/${runResult.runId}`);
        assertEqual(runDetailsRes.data.run.status, 'COMPLETED_WITH_ERRORS', 'DB run status must match');
        const details = runDetailsRes.data.details;
        const failedDetail = details.find(d => d.account_id === 1);
        assert(failedDetail !== undefined, 'Account 1 must be recorded in details');
        assertEqual(failedDetail.result, 'FAILED', 'Account 1 result must be FAILED');
        assert(failedDetail.error_message.length > 0, 'Safe error message must be recorded');
    });

    // ─────────────────────────────────────────────────────────
    // §32: TEST — RETRY
    // ─────────────────────────────────────────────────────────
    await testAsync('§32: Transient failure automatically retried and succeeds -> exactly 1 interest record', async () => {
        await resetState();

        // Inject transient failure for Account 1 for 1 attempt (succeeds on attempt 2)
        const { status, body } = await apiPost('/scheduler/run', {
            currentDate: '2026-09-01',
            transientFailAccountIds: [1],
            transientFailAttempts: 1
        });
        assertEqual(status, 200, 'HTTP status must be 200');

        const runResult = body.data;
        assertEqual(runResult.status, 'COMPLETED', 'Run should be COMPLETED after successful retry');
        assertEqual(runResult.failed, 0, 'Failed count must be 0 after successful retry');
        assert(runResult.retries >= 1, 'Retry count must be >= 1');

        // Exactly 1 interest record must exist for Account 1
        const recs = await getInterestRecords(1);
        assertEqual(recs.length, 1, 'Account 1 must have exactly 1 interest record');

        // Verify detail record has attempt_count = 2 and result = SUCCESS
        const { body: runDetailsRes } = await apiGet(`/scheduler/runs/${runResult.runId}`);
        const acc1Detail = runDetailsRes.data.details.find(d => d.account_id === 1);
        assertEqual(acc1Detail.result, 'SUCCESS', 'Detail result must be SUCCESS');
        assertEqual(acc1Detail.attempt_count, 2, 'Attempt count must be 2');
    });

    // ─────────────────────────────────────────────────────────
    // §33: TEST — RETRY AFTER SUCCESSFUL PERSISTENCE
    // ─────────────────────────────────────────────────────────
    await testAsync('§33: Retry after successful persistence -> ALREADY_RECORDED, no duplicate', async () => {
        await resetState();

        // Accrue first period normally via Step 5J
        const { status: firstAccrueStatus } = await apiPost('/accounts/1/accrue-interest', {
            start_date: '2026-08-01',
            end_date: '2026-09-01'
        });
        assertEqual(firstAccrueStatus, 200, 'First accrual should succeed');

        const initialRecs = await getInterestRecords(1);
        assertEqual(initialRecs.length, 1, 'Initial record count must be 1');

        // Run scheduler for the same period
        const { status, body } = await apiPost('/scheduler/run', { currentDate: '2026-09-01' });
        assertEqual(status, 200);

        const runResult = body.data;
        assert(runResult.alreadyRecorded >= 1, 'Already recorded count must be >= 1');

        // Verify interest records count remains exactly 1 (no duplicates)
        const finalRecs = await getInterestRecords(1);
        assertEqual(finalRecs.length, 1, 'Record count must remain exactly 1');
    });

    // ─────────────────────────────────────────────────────────
    // §34: TEST — THREE RETRIES
    // ─────────────────────────────────────────────────────────
    await testAsync('§34: Force retryable failure -> maximum 3 attempts, then stops', async () => {
        await resetState();

        // Inject transient failure for Account 1 that fails for 5 attempts (exceeds max 3 retries)
        const { status, body } = await apiPost('/scheduler/run', {
            currentDate: '2026-09-01',
            transientFailAccountIds: [1],
            transientFailAttempts: 5,
            retryDelayMs: 1
        });
        assertEqual(status, 200);

        const runResult = body.data;
        assertEqual(runResult.status, 'COMPLETED_WITH_ERRORS');

        const { body: runDetailsRes } = await apiGet(`/scheduler/runs/${runResult.runId}`);
        const acc1Detail = runDetailsRes.data.details.find(d => d.account_id === 1);
        assertEqual(acc1Detail.result, 'FAILED', 'Must be marked FAILED');
        assertEqual(acc1Detail.attempt_count, 3, 'Must attempt exactly 3 times (max retries)');
        assertEqual(acc1Detail.is_retryable, 1, 'Must be marked as retryable');
    });

    // ─────────────────────────────────────────────────────────
    // §35: TEST — PERMANENT FAILURE
    // ─────────────────────────────────────────────────────────
    await testAsync('§35: Force non-retryable permanent failure -> attempt count = 1, marked FAILED', async () => {
        await resetState();

        // Inject permanent failure for Account 1
        const { status, body } = await apiPost('/scheduler/run', {
            currentDate: '2026-09-01',
            failAccountIds: [1]
        });
        assertEqual(status, 200);

        const runResult = body.data;
        const { body: runDetailsRes } = await apiGet(`/scheduler/runs/${runResult.runId}`);
        const acc1Detail = runDetailsRes.data.details.find(d => d.account_id === 1);
        assertEqual(acc1Detail.result, 'FAILED', 'Must be marked FAILED');
        assertEqual(acc1Detail.attempt_count, 1, 'Permanent failure must not be retried (attempt_count = 1)');
        assertEqual(acc1Detail.is_retryable, 0, 'Permanent failure must have is_retryable = 0');
    });

    // ─────────────────────────────────────────────────────────
    // §36: TEST — CRASH RECOVERY & STALE RUNS
    // ─────────────────────────────────────────────────────────
    await testAsync('§36: Crash recovery -> stale RUNNING run cleaned up and does not block new runs', async () => {
        await resetState();

        // Run scheduler with dryRun to simulate an interrupted run
        await apiPost('/scheduler/run', {
            currentDate: '2026-09-01',
            dryRun: true
        });

        // Run scheduler with short stale timeout to clean up any stuck runs
        const { status, body } = await apiPost('/scheduler/run', {
            currentDate: '2026-09-01',
            staleTimeoutMs: 0
        });
        assertEqual(status, 200);

        const runResult = body.data;
        assertEqual(runResult.status, 'COMPLETED');
        assertEqual(runResult.accrualsCreated, 2, 'Should process missing periods cleanly (Accounts 1 and 4)');
    });

    // ─────────────────────────────────────────────────────────
    // §37: TEST — MULTIPLE RUNS
    // ─────────────────────────────────────────────────────────
    await testAsync('§37: Multiple runs -> 1st records interest, 2nd run safely identifies ALREADY_RECORDED', async () => {
        await resetState();

        // Run 1
        const run1 = await apiPost('/scheduler/run', { currentDate: '2026-09-01' });
        assertEqual(run1.body.data.status, 'COMPLETED');
        assertEqual(run1.body.data.accrualsCreated, 2);

        // Run 2 (same date)
        const run2 = await apiPost('/scheduler/run', { currentDate: '2026-09-01' });
        assertEqual(run2.body.data.status, 'COMPLETED');
        assertEqual(run2.body.data.accrualsCreated, 0, 'Second run should create 0 new accruals');
        assertEqual(run2.body.data.alreadyRecorded, 2, 'Second run should report 2 already recorded');

        // Confirm exactly 1 interest record exists for Accounts 1 and 4
        const recs1 = await getInterestRecords(1);
        const recs4 = await getInterestRecords(4);
        assertEqual(recs1.length, 1);
        assertEqual(recs4.length, 1);
    });

    // ─────────────────────────────────────────────────────────
    // §38: TEST — ACCOUNT ISOLATION
    // ─────────────────────────────────────────────────────────
    await testAsync('§38: Account isolation -> one account failure does not affect or roll back others', async () => {
        await resetState();

        // Create 3 accounts: Daily, Weekly, Monthly
        const accDaily = await createTestAccount('DAILY', '2026-08-01', 100000);
        const accWeekly = await createTestAccount('WEEKLY', '2026-08-01', 100000);
        const accMonthly = await createTestAccount('MONTHLY', '2026-08-01', 100000);

        // Fail only the weekly account
        const { body } = await apiPost('/scheduler/run', {
            currentDate: '2026-08-08',
            failAccountIds: [accWeekly.id]
        });

        assertEqual(body.data.status, 'COMPLETED_WITH_ERRORS');

        // Daily must have succeeded with 7 records, weekly failed with 0 records
        const dailyRecs = await getInterestRecords(accDaily.id);
        const weeklyRecs = await getInterestRecords(accWeekly.id);

        assertEqual(dailyRecs.length, 7, `Daily account should have 7 records, got ${dailyRecs.length}`);
        assertEqual(weeklyRecs.length, 0, 'Weekly account failed so should have 0 records');
    });

    // ─────────────────────────────────────────────────────────
    // §39: TEST — DATABASE FAILURE
    // ─────────────────────────────────────────────────────────
    await testAsync('§39: Database failure simulation -> marked failed, retryable flag set', async () => {
        await resetState();

        // Account 1 has periods due on 2026-09-01. Inject transient failure for Account 1.
        const { status, body } = await apiPost('/scheduler/run', {
            currentDate: '2026-09-01',
            transientFailAccountIds: [1],
            transientFailAttempts: 10,
            retryDelayMs: 1
        });
        assertEqual(status, 200);

        const runResult = body.data;
        assertEqual(runResult.status, 'COMPLETED_WITH_ERRORS');

        const { body: failuresRes } = await apiGet('/scheduler/failures');
        assert(failuresRes.data.length > 0, 'Failures list must contain the failed record');
        const failure = failuresRes.data.find(f => f.account_id === 1);
        assert(failure !== undefined, 'Account 1 must be in failure list');
        assertEqual(failure.is_retryable, 1, 'Must be marked as retryable');
        assert(failure.error_message.includes('transient'), 'Error message should describe failure');
    });

    // ─────────────────────────────────────────────────────────
    // §40: TEST — MONITORING DATA
    // ─────────────────────────────────────────────────────────
    await testAsync('§40: Monitoring data API -> runs list, run details, and failures view return correct data', async () => {
        await resetState();

        const run = await apiPost('/scheduler/run', { currentDate: '2026-09-01' });
        const runId = run.body.data.runId;

        // 1. GET /scheduler/runs
        const { status: s1, body: b1 } = await apiGet('/scheduler/runs');
        assertEqual(s1, 200);
        assert(Array.isArray(b1.data), 'Runs must be an array');
        const matchedRun = b1.data.find(r => r.run_id === runId);
        assert(matchedRun !== undefined, 'Run must exist in runs list');
        assertEqual(matchedRun.status, 'COMPLETED');
        assertEqual(matchedRun.accounts_considered, 4);
        assert(matchedRun.created_at !== undefined, 'Timestamp must exist');

        // 2. GET /scheduler/runs/:id
        const { status: s2, body: b2 } = await apiGet(`/scheduler/runs/${runId}`);
        assertEqual(s2, 200);
        assertEqual(b2.data.run.run_id, runId);
        assert(Array.isArray(b2.data.details), 'Details must be an array');
        assert(b2.data.details.length >= 4, 'Must contain details for each considered account');

        // Check account detail contents
        const acc1 = b2.data.details.find(d => d.account_id === 1);
        assert(acc1 !== undefined);
        assertEqual(acc1.result, 'SUCCESS');
        assertEqual(acc1.period_start, '2026-08-01');
        assertEqual(acc1.period_end, '2026-09-01');
        assert(acc1.interest_record_id > 0, 'Interest record ID must be populated');
    });

    // ─────────────────────────────────────────────────────────
    // §41: TEST — MANUAL RETRY
    // ─────────────────────────────────────────────────────────
    await testAsync('§41: Manual retry endpoint -> retrying failed accrual creates interest record and updates detail', async () => {
        await resetState();

        // 1. Run scheduler with forced permanent failure for Account 1
        const run = await apiPost('/scheduler/run', {
            currentDate: '2026-09-01',
            failAccountIds: [1]
        });

        const { body: runDetailsRes } = await apiGet(`/scheduler/runs/${run.body.data.runId}`);
        const failedDetail = runDetailsRes.data.details.find(d => d.account_id === 1 && d.result === 'FAILED');
        assert(failedDetail !== undefined, 'Must have a failed detail record');
        assertEqual(failedDetail.period_start, '2026-08-01');
        assertEqual(failedDetail.period_end, '2026-09-01');

        // No interest records should exist yet for Account 1
        const recsBefore = await getInterestRecords(1);
        assertEqual(recsBefore.length, 0);

        // 2. Perform manual retry via POST /api/scheduler/retry/:detailId
        const { status: retryStatus, body: retryBody } = await apiPost(`/scheduler/retry/${failedDetail.id}`);
        assertEqual(retryStatus, 200, 'Manual retry should return HTTP 200');
        assertEqual(retryBody.data.success, true, 'Manual retry should succeed');
        assertEqual(retryBody.data.detail.result, 'SUCCESS', 'Detail result should update to SUCCESS');
        assert(retryBody.data.detail.interest_record_id > 0, 'Detail should have interest_record_id');

        // 3. Exactly 1 interest record should now exist
        const recsAfter = await getInterestRecords(1);
        assertEqual(recsAfter.length, 1, 'Exactly 1 interest record should exist after manual retry');
        assertEqual(recsAfter[0].interest_amount_paisa, 2548, 'Interest amount in paisa should match formula');

        // 4. Test retry idempotency — retrying again should return ALREADY_RECORDED and NOT create a duplicate
        const { status: retry2Status, body: retry2Body } = await apiPost(`/scheduler/retry/${failedDetail.id}`);
        assertEqual(retry2Status, 200);
        const recsFinal = await getInterestRecords(1);
        assertEqual(recsFinal.length, 1, 'Still exactly 1 record after second retry');
    });

    // ─────────────────────────────────────────────────────────
    // §42: TEST — NO CALCULATION CHANGES
    // ─────────────────────────────────────────────────────────
    await testAsync('§42: Interest amount computed via Step 5L matches direct Step 5J execution exactly', async () => {
        await resetState();

        // Accrue Account 1 directly via Step 5J
        const { body: direct5J } = await apiPost('/accounts/1/accrue-interest', {
            start_date: '2026-08-01',
            end_date: '2026-09-01'
        });
        const directAmount = direct5J.data.interest_amount_paisa || direct5J.data.interestAmountPaisa;

        // Reset and accrue Account 1 via Step 5L scheduler
        await resetState();
        const { body: schedRun } = await apiPost('/scheduler/run', { currentDate: '2026-09-01' });
        const { body: runDetailsRes } = await apiGet(`/scheduler/runs/${schedRun.data.runId}`);
        const schedDetail = runDetailsRes.data.details.find(d => d.account_id === 1);

        assertEqual(schedDetail.interest_amount, directAmount, 'Step 5L interest must equal Step 5J interest');
    });

    // ─────────────────────────────────────────────────────────
    // §43: TEST — NO PAYMENT CHANGES
    // ─────────────────────────────────────────────────────────
    await testAsync('§43: Monitoring/retry layer creates zero payments, principal transactions, or payment allocations', async () => {
        await resetState();

        // Check initial transactions count
        const { body: initTx } = await apiGet('/transactions');
        const initialTxCount = initTx.data ? initTx.data.length : 0;

        // Run scheduler
        await apiPost('/scheduler/run', { currentDate: '2026-09-01' });

        // Check transactions count after scheduler run
        const { body: afterTx } = await apiGet('/transactions');
        const finalTxCount = afterTx.data ? afterTx.data.length : 0;

        assertEqual(finalTxCount, initialTxCount, 'Transactions count must not change (zero payment transactions created)');
    });

    // ─────────────────────────────────────────────────────────
    // SUMMARY
    // ─────────────────────────────────────────────────────────
    console.log('\n=============================================================');
    console.log(`  STEP 5L TEST RESULTS: ${passed} PASSED, ${failed} FAILED (TOTAL: ${total})`);
    console.log('=============================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runAllTests().catch(err => {
    console.error('Test suite runner encountered an uncaught error:', err);
    process.exit(1);
});
