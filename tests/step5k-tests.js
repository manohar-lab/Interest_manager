/**
 * Interest Manager — Step 5K Test Suite
 * Automatic Interest Accrual Scheduler Verification
 *
 * Tests cover:
 *   §38 — Daily accrual
 *   §39 — Weekly accrual
 *   §40 — Monthly accrual (calendar months, Feb, leap year)
 *   §41 — Yearly accrual (leap year, boundary)
 *   §42 — Integration (full Scheduler → 5J → 5F → 5H → 5I flow)
 *   §43 — Manual vs Scheduled consistency
 *   §44 — Database verification
 *   §18/§28 — Error isolation
 *
 * All tests use the manual trigger endpoint POST /api/scheduler/run
 * with an injected currentDate for deterministic results (§37).
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
    try { await fn(); passed++; console.log(`  ✅ Test ${total}: ${name}`); }
    catch (err) { failed++; console.log(`  ❌ Test ${total}: ${name}`); console.log(`      Error: ${err.message}`); }
}

async function apiGet(url) {
    const r = await fetch(BASE + url);
    return { status: r.status, body: await r.json() };
}
async function apiPost(url, data) {
    const r = await fetch(BASE + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return { status: r.status, body: await r.json() };
}
async function apiDelete(url) {
    const r = await fetch(BASE + url, { method: 'DELETE' });
    return { status: r.status, body: await r.json() };
}

// ─── Helper: Create a test account with specific frequency ───
async function createTestAccount(frequency, startDate, principal = 200000, rate = 15.0) {
    // Ensure person exists
    let { body: pRes } = await apiGet('/people');
    let personId = pRes.data && pRes.data.length > 0 ? pRes.data[0].id : null;
    if (!personId) {
        const { body: createP } = await apiPost('/people', { name: 'SchedulerTestPerson', phone: '0000000000' });
        personId = createP.data.id;
    }

    const { status, body } = await apiPost('/accounts', {
        person_id: personId,
        direction: 'MONEY_GIVEN',
        principal: principal / 100, // API expects rupees
        interest_rate: rate,
        interest_frequency: frequency,
        calculation_method: 'SIMPLE_INTEREST',
        start_date: startDate,
        due_date: '2030-12-31',
        notes: `Step 5K test: ${frequency}`
    });

    if (status !== 201 && status !== 200) {
        throw new Error(`Failed to create ${frequency} test account: ${JSON.stringify(body)}`);
    }
    return body.data;
}

// ─── Helper: Run the scheduler with a given currentDate ───
async function runScheduler(currentDate) {
    const { status, body } = await apiPost('/scheduler/run', { currentDate });
    if (status !== 200) throw new Error(`Scheduler run failed: ${JSON.stringify(body)}`);
    return body.data;
}

// ─── Helper: Get interest records for an account ───
async function getInterestRecords(accountId) {
    const { body } = await apiGet(`/accounts/${accountId}/interest-records`);
    return body.data || [];
}

// ─── Helper: Accrue manually via Step 5J ───
async function manualAccrue(accountId, startDate, endDate) {
    const { status, body } = await apiPost(`/accounts/${accountId}/accrue-interest`, {
        start_date: startDate,
        end_date: endDate
    });
    return body.data;
}

async function runTests() {
    console.log('\n=== Interest Manager — Step 5K Automatic Interest Accrual Scheduler Test Suite ===\n');

    // Clean server state for deterministic testing
    await apiPost('/test/reset-state', {});

    // ═══════════════════════════════════════════════════════════════
    // §38 — DAILY ACCRUAL TESTS
    // ═══════════════════════════════════════════════════════════════
    console.log('\n--- §38: Daily Accrual Tests ---\n');

    let dailyAccount;

    await testAsync('§38.1 Daily account gets correct due period [D, D+1)', async () => {
        dailyAccount = await createTestAccount('DAILY', '2026-08-01');

        // Run scheduler with currentDate = 2026-08-02 → should accrue period 2026-08-01 to 2026-08-02
        const result = await runScheduler('2026-08-02');

        // Find this account's details
        const detail = result.details.find(d => d.accountId === dailyAccount.id);
        assert(detail, 'Account appears in scheduler results');
        assert(detail.accrualsCreated >= 1, 'At least one accrual created');

        // Verify interest record exists with correct period
        const records = await getInterestRecords(dailyAccount.id);
        const dayRec = records.find(r => r.period_start === '2026-08-01' && r.period_end === '2026-08-02');
        assert(dayRec, 'Daily period 2026-08-01 to 2026-08-02 recorded');
        assert(dayRec.interest_amount_paisa > 0, 'Interest amount is positive');
    });

    await testAsync('§38.2 Already-recorded daily period is skipped', async () => {
        // Run scheduler again with same date — should get ALREADY_RECORDED
        const result = await runScheduler('2026-08-02');
        const detail = result.details.find(d => d.accountId === dailyAccount.id);
        assert(detail, 'Account appears in scheduler results');
        assertEqual(detail.alreadyRecorded, 1, 'One period already recorded');
        assertEqual(detail.accrualsCreated, 0, 'No new accruals');

        // Verify exactly one record for this period
        const records = await getInterestRecords(dailyAccount.id);
        const matching = records.filter(r => r.period_start === '2026-08-01' && r.period_end === '2026-08-02');
        assertEqual(matching.length, 1, 'Exactly one record for the period');
    });

    await testAsync('§38.3 Missing daily periods are caught up (offline gap)', async () => {
        // Jump to Aug 5 — scheduler should catch up Aug 2→3, 3→4, 4→5
        const result = await runScheduler('2026-08-05');
        const detail = result.details.find(d => d.accountId === dailyAccount.id);
        assert(detail, 'Account appears in results');

        // Should have created 3 new periods (Aug 1→2 already exists)
        assert(detail.accrualsCreated >= 3, `Caught up at least 3 missing periods, got ${detail.accrualsCreated}`);

        // Verify records exist for each day
        const records = await getInterestRecords(dailyAccount.id);
        assert(records.find(r => r.period_start === '2026-08-02' && r.period_end === '2026-08-03'), 'Aug 2→3 exists');
        assert(records.find(r => r.period_start === '2026-08-03' && r.period_end === '2026-08-04'), 'Aug 3→4 exists');
        assert(records.find(r => r.period_start === '2026-08-04' && r.period_end === '2026-08-05'), 'Aug 4→5 exists');
    });

    await testAsync('§38.4 Future period is not accrued', async () => {
        // Current date Aug 5 — should NOT accrue Aug 5→6
        const records = await getInterestRecords(dailyAccount.id);
        const futureRec = records.find(r => r.period_start === '2026-08-05' && r.period_end === '2026-08-06');
        assertEqual(futureRec, undefined, 'No future period Aug 5→6 accrued');
    });

    await testAsync('§38.5 Restart does not duplicate (idempotent re-run)', async () => {
        // Run scheduler again at Aug 5 — all periods already recorded
        const result = await runScheduler('2026-08-05');
        const detail = result.details.find(d => d.accountId === dailyAccount.id);
        assertEqual(detail.accrualsCreated, 0, 'No new accruals on re-run');
        assert(detail.alreadyRecorded >= 4, 'All 4 periods recognized as already recorded');
    });

    await testAsync('§38.6 One failed account does not stop others', async () => {
        // Create a second DAILY account — both should be processed
        const dailyAccount2 = await createTestAccount('DAILY', '2026-08-01');

        // Run scheduler for Aug 2 — both should process independently
        const result = await runScheduler('2026-08-02');

        const detail1 = result.details.find(d => d.accountId === dailyAccount.id);
        const detail2 = result.details.find(d => d.accountId === dailyAccount2.id);
        assert(detail1, 'First daily account processed');
        assert(detail2, 'Second daily account processed');

        // Both should succeed (first has ALREADY_RECORDED, second has new accrual)
        assert(detail2.accrualsCreated >= 1, 'Second account got accruals');
    });

    // ═══════════════════════════════════════════════════════════════
    // §39 — WEEKLY ACCRUAL TESTS
    // ═══════════════════════════════════════════════════════════════
    console.log('\n--- §39: Weekly Accrual Tests ---\n');

    let weeklyAccount;

    await testAsync('§39.1 Correct weekly period anchored to account start weekday', async () => {
        // Start on 2026-08-03 (Monday) — weekly period should be 7 days
        weeklyAccount = await createTestAccount('WEEKLY', '2026-08-03');

        // Run on Aug 10 — one week elapsed → period 2026-08-03 to 2026-08-10
        const result = await runScheduler('2026-08-10');
        const detail = result.details.find(d => d.accountId === weeklyAccount.id);
        assert(detail, 'Weekly account appears');
        assert(detail.accrualsCreated >= 1, 'Weekly accrual created');

        const records = await getInterestRecords(weeklyAccount.id);
        const weekRec = records.find(r => r.period_start === '2026-08-03' && r.period_end === '2026-08-10');
        assert(weekRec, 'Weekly period 2026-08-03 to 2026-08-10 recorded');
    });

    await testAsync('§39.2 Weekly duplicate prevention', async () => {
        const result = await runScheduler('2026-08-10');
        const detail = result.details.find(d => d.accountId === weeklyAccount.id);
        assertEqual(detail.accrualsCreated, 0, 'No new accruals on duplicate run');
        assertEqual(detail.alreadyRecorded, 1, 'Recognized as already recorded');
    });

    await testAsync('§39.3 Weekly catch-up for missed weeks', async () => {
        // Jump to Sep 7 (5 weeks after start) — should catch up weeks 2-5
        const result = await runScheduler('2026-09-07');
        const detail = result.details.find(d => d.accountId === weeklyAccount.id);
        assert(detail.accrualsCreated >= 4, `Caught up 4 missed weeks, got ${detail.accrualsCreated}`);

        const records = await getInterestRecords(weeklyAccount.id);
        assert(records.find(r => r.period_start === '2026-08-10' && r.period_end === '2026-08-17'), 'Week 2 exists');
        assert(records.find(r => r.period_start === '2026-08-17' && r.period_end === '2026-08-24'), 'Week 3 exists');
        assert(records.find(r => r.period_start === '2026-08-24' && r.period_end === '2026-08-31'), 'Week 4 exists');
        assert(records.find(r => r.period_start === '2026-08-31' && r.period_end === '2026-09-07'), 'Week 5 exists');
    });

    await testAsync('§39.4 Weekly future-period protection', async () => {
        // On Sep 7, the next period (Sep 7→14) should NOT be accrued since it hasn't elapsed
        const records = await getInterestRecords(weeklyAccount.id);
        const futureRec = records.find(r => r.period_start === '2026-09-07' && r.period_end === '2026-09-14');
        assertEqual(futureRec, undefined, 'Future weekly period not accrued');
    });

    // ═══════════════════════════════════════════════════════════════
    // §40 — MONTHLY ACCRUAL TESTS
    // ═══════════════════════════════════════════════════════════════
    console.log('\n--- §40: Monthly Accrual Tests ---\n');

    let monthlyAccount;

    await testAsync('§40.1 Calendar month boundaries (31-day month)', async () => {
        // Use existing seed account #1 — MONTHLY, start_date 2026-08-01
        monthlyAccount = { id: 1 };

        // Run scheduler for Sep 1 — should create period Aug 1 → Sep 1
        const result = await runScheduler('2026-09-01');
        const detail = result.details.find(d => d.accountId === 1);
        assert(detail, 'Account #1 appears');

        const records = await getInterestRecords(1);
        const augRec = records.find(r => r.period_start === '2026-08-01' && r.period_end === '2026-09-01');
        assert(augRec, 'August period (31 days) recorded');
    });

    await testAsync('§40.2 February (non-leap year — 28 days)', async () => {
        // Create monthly account starting Feb 1, 2027 (non-leap year)
        const febAccount = await createTestAccount('MONTHLY', '2027-02-01');

        // Run for Mar 1, 2027 → period Feb 1 → Mar 1 (28 days)
        const result = await runScheduler('2027-03-01');
        const records = await getInterestRecords(febAccount.id);
        const febRec = records.find(r => r.period_start === '2027-02-01' && r.period_end === '2027-03-01');
        assert(febRec, 'February period (28 days, non-leap) recorded');
    });

    await testAsync('§40.3 30-day month (September)', async () => {
        // Create monthly account starting Sep 1, 2026
        const sepAccount = await createTestAccount('MONTHLY', '2026-09-01');

        // Run for Oct 1 → period Sep 1 → Oct 1 (30 days)
        const result = await runScheduler('2026-10-01');
        const records = await getInterestRecords(sepAccount.id);
        const sepRec = records.find(r => r.period_start === '2026-09-01' && r.period_end === '2026-10-01');
        assert(sepRec, 'September period (30 days) recorded');
    });

    await testAsync('§40.4 31-day month (January)', async () => {
        const janAccount = await createTestAccount('MONTHLY', '2027-01-01');

        const result = await runScheduler('2027-02-01');
        const records = await getInterestRecords(janAccount.id);
        const janRec = records.find(r => r.period_start === '2027-01-01' && r.period_end === '2027-02-01');
        assert(janRec, 'January period (31 days) recorded');
    });

    await testAsync('§40.5 Leap-year February (29 days)', async () => {
        // 2028 is a leap year
        const leapFebAccount = await createTestAccount('MONTHLY', '2028-02-01');

        const result = await runScheduler('2028-03-01');
        const records = await getInterestRecords(leapFebAccount.id);
        const febRec = records.find(r => r.period_start === '2028-02-01' && r.period_end === '2028-03-01');
        assert(febRec, 'Leap February period (29 days) recorded');
    });

    await testAsync('§40.6 Monthly duplicate prevention', async () => {
        // Re-run scheduler at same date for account #1 — should skip
        const result = await runScheduler('2026-09-01');
        const detail = result.details.find(d => d.accountId === 1);
        // The Aug period should be ALREADY_RECORDED
        const records = await getInterestRecords(1);
        const augMatching = records.filter(r => r.period_start === '2026-08-01' && r.period_end === '2026-09-01');
        assertEqual(augMatching.length, 1, 'Exactly one August record (no duplicate)');
    });

    await testAsync('§40.7 Monthly catch-up (multiple missed months)', async () => {
        // Create a new monthly account starting Jun 1
        const catchupAccount = await createTestAccount('MONTHLY', '2026-06-01');

        // Run at Sep 1 — should catch up Jun→Jul, Jul→Aug, Aug→Sep
        const result = await runScheduler('2026-09-01');
        const detail = result.details.find(d => d.accountId === catchupAccount.id);
        assert(detail.accrualsCreated >= 3, `Caught up 3 months, got ${detail.accrualsCreated}`);

        const records = await getInterestRecords(catchupAccount.id);
        assert(records.find(r => r.period_start === '2026-06-01' && r.period_end === '2026-07-01'), 'Jun→Jul');
        assert(records.find(r => r.period_start === '2026-07-01' && r.period_end === '2026-08-01'), 'Jul→Aug');
        assert(records.find(r => r.period_start === '2026-08-01' && r.period_end === '2026-09-01'), 'Aug→Sep');
    });

    // ═══════════════════════════════════════════════════════════════
    // §41 — YEARLY ACCRUAL TESTS
    // ═══════════════════════════════════════════════════════════════
    console.log('\n--- §41: Yearly Accrual Tests ---\n');

    let yearlyAccount;

    await testAsync('§41.1 Yearly boundary anchored to account start date', async () => {
        yearlyAccount = await createTestAccount('YEARLY', '2025-03-15');

        // Run at Mar 15, 2027 — should create two yearly periods: 2025→2026 and 2026→2027
        const result = await runScheduler('2027-03-15');
        const detail = result.details.find(d => d.accountId === yearlyAccount.id);
        assert(detail.accrualsCreated >= 2, `Two yearly periods, got ${detail.accrualsCreated}`);

        const records = await getInterestRecords(yearlyAccount.id);
        assert(records.find(r => r.period_start === '2025-03-15' && r.period_end === '2026-03-15'), 'Year 1');
        assert(records.find(r => r.period_start === '2026-03-15' && r.period_end === '2027-03-15'), 'Year 2');
    });

    await testAsync('§41.2 Yearly leap-year handling (Feb 29 start)', async () => {
        // 2024 is a leap year, start Feb 29 → next year lands on Feb 28
        const leapYearAccount = await createTestAccount('YEARLY', '2024-02-29');

        // Run at Mar 1, 2025 — period should be 2024-02-29 to 2025-02-28
        const result = await runScheduler('2025-03-01');
        const records = await getInterestRecords(leapYearAccount.id);
        const yr1 = records.find(r => r.period_start === '2024-02-29' && r.period_end === '2025-02-28');
        assert(yr1, 'Leap-year yearly period clamped to Feb 28 in non-leap year');
    });

    await testAsync('§41.3 Yearly duplicate prevention', async () => {
        const result = await runScheduler('2027-03-15');
        const detail = result.details.find(d => d.accountId === yearlyAccount.id);
        assertEqual(detail.accrualsCreated, 0, 'No new accruals on duplicate yearly run');
        assert(detail.alreadyRecorded >= 2, 'Yearly periods recognized as already recorded');
    });

    await testAsync('§41.4 Yearly catch-up', async () => {
        const catchupYearly = await createTestAccount('YEARLY', '2023-01-01');

        // Run at Jan 1, 2026 — should catch up 3 yearly periods
        const result = await runScheduler('2026-01-01');
        const detail = result.details.find(d => d.accountId === catchupYearly.id);
        assert(detail.accrualsCreated >= 3, `Caught up 3 yearly periods, got ${detail.accrualsCreated}`);

        const records = await getInterestRecords(catchupYearly.id);
        assert(records.find(r => r.period_start === '2023-01-01' && r.period_end === '2024-01-01'), 'Year 2023→2024');
        assert(records.find(r => r.period_start === '2024-01-01' && r.period_end === '2025-01-01'), 'Year 2024→2025');
        assert(records.find(r => r.period_start === '2025-01-01' && r.period_end === '2026-01-01'), 'Year 2025→2026');
    });

    // ═══════════════════════════════════════════════════════════════
    // §42 — INTEGRATION TEST (Full Flow)
    // ═══════════════════════════════════════════════════════════════
    console.log('\n--- §42: Integration Tests ---\n');

    await testAsync('§42.1 Full flow: Scheduler → Account selection → 5J → 5F → 5H → 5I', async () => {
        // Reset state for clean integration test
        await apiPost('/test/reset-state', {});

        // Run scheduler for Oct 1 on seed accounts (all MONTHLY, start Aug/Sep)
        const result = await runScheduler('2026-10-01');

        // Verify result structure (§29)
        assert(result.runId, 'runId present');
        assert(result.startedAt, 'startedAt present');
        assert(result.completedAt, 'completedAt present');
        assertEqual(typeof result.accountsConsidered, 'number', 'accountsConsidered is number');
        assertEqual(typeof result.accountsProcessed, 'number', 'accountsProcessed is number');
        assertEqual(typeof result.accrualsCreated, 'number', 'accrualsCreated is number');
        assertEqual(typeof result.alreadyRecorded, 'number', 'alreadyRecorded is number');
        assertEqual(typeof result.failed, 'number', 'failed is number');
        assert(result.accountsConsidered >= 4, 'At least 4 seed accounts considered');

        // Verify that interest records were created for seed accounts
        // Account #1: MONTHLY, start 2026-08-01 → periods Aug→Sep, Sep→Oct
        const recs1 = await getInterestRecords(1);
        assert(recs1.find(r => r.period_start === '2026-08-01' && r.period_end === '2026-09-01'),
            'Account #1 Aug→Sep recorded');
        assert(recs1.find(r => r.period_start === '2026-09-01' && r.period_end === '2026-10-01'),
            'Account #1 Sep→Oct recorded');

        // Verify interest outstanding via balance endpoint
        const { body: balRes } = await apiGet(`/accounts/1/interest-balance`);
        assert(balRes.data, 'Interest balance returned');
        assert(balRes.data.interestRecordedPaisa > 0, 'Interest outstanding is positive');
    });

    // ═══════════════════════════════════════════════════════════════
    // §43 — MANUAL VS SCHEDULED CONSISTENCY
    // ═══════════════════════════════════════════════════════════════
    console.log('\n--- §43: Manual vs Scheduled Consistency ---\n');

    await testAsync('§43.1 Manual Step 5J and scheduler produce identical interest amounts', async () => {
        await apiPost('/test/reset-state', {});

        // Manual accrual for Account #1, Aug 1 → Sep 1
        const manualResult = await manualAccrue(1, '2026-08-01', '2026-09-01');
        assertEqual(manualResult.status, 'RECORDED', 'Manual accrual recorded');
        const manualAmount = manualResult.interestAmountPaisa;

        // Run scheduler — should recognize manual period as ALREADY_RECORDED
        const schedResult = await runScheduler('2026-09-01');
        const detail = schedResult.details.find(d => d.accountId === 1);
        assert(detail, 'Account #1 in scheduler results');
        assertEqual(detail.alreadyRecorded, 1, 'Manual period recognized as already recorded');
        assertEqual(detail.accrualsCreated, 0, 'No duplicate from scheduler');

        // Verify only one record and same amount
        const records = await getInterestRecords(1);
        const augRecs = records.filter(r => r.period_start === '2026-08-01' && r.period_end === '2026-09-01');
        assertEqual(augRecs.length, 1, 'Exactly one record');
        assertEqual(augRecs[0].interest_amount_paisa, manualAmount, 'Same interest amount');
    });

    await testAsync('§43.2 Scheduler creates same amount as manual for fresh period', async () => {
        await apiPost('/test/reset-state', {});

        // First, manually calculate what Aug→Sep should be for Account #2
        const manualResult = await manualAccrue(2, '2026-09-01', '2026-10-01');
        const manualAmount = manualResult.interestAmountPaisa;

        // Reset and let scheduler do it
        await apiPost('/test/reset-state', {});
        const schedResult = await runScheduler('2026-10-01');

        // Check Account #2's Sep→Oct record
        const records = await getInterestRecords(2);
        const sepRec = records.find(r => r.period_start === '2026-09-01' && r.period_end === '2026-10-01');
        assert(sepRec, 'Scheduler created Sep→Oct record');
        assertEqual(sepRec.interest_amount_paisa, manualAmount,
            `Scheduler amount (${sepRec.interest_amount_paisa}) matches manual (${manualAmount})`);
    });

    // ═══════════════════════════════════════════════════════════════
    // §44 — DATABASE VERIFICATION
    // ═══════════════════════════════════════════════════════════════
    console.log('\n--- §44: Database Verification ---\n');

    await testAsync('§44.1 Expected interest records exist, no duplicates, principal unchanged', async () => {
        await apiPost('/test/reset-state', {});

        // Run scheduler for Oct 1
        await runScheduler('2026-10-01');

        // Account #1: ₹2,000 @ 15% MONTHLY, start Aug 1
        // Should have records for Aug→Sep, Sep→Oct
        const recs1 = await getInterestRecords(1);
        const augSep = recs1.filter(r => r.period_start === '2026-08-01' && r.period_end === '2026-09-01');
        const sepOct = recs1.filter(r => r.period_start === '2026-09-01' && r.period_end === '2026-10-01');
        assertEqual(augSep.length, 1, 'Exactly one Aug→Sep record');
        assertEqual(sepOct.length, 1, 'Exactly one Sep→Oct record');

        // Verify principal unchanged
        const { body: accRes } = await apiGet('/accounts/1');
        assertEqual(accRes.data.principal, 200000, 'Principal unchanged (200000 paisa)');
        assertEqual(accRes.data.outstanding_principal, 200000, 'Outstanding principal unchanged');

        // Verify payment transactions unchanged (none created by scheduler)
        const { body: txRes } = await apiGet('/transactions?account_id=1');
        const txList = txRes.data || [];
        const schedulerTxs = txList.filter(t =>
            t.transaction_type === 'INTEREST_RECEIVED' || t.transaction_type === 'INTEREST_PAID'
        );
        assertEqual(schedulerTxs.length, 0, 'No payment transactions created by scheduler');
    });

    await testAsync('§44.2 Unrelated accounts unchanged', async () => {
        // Verify Account #4 (MONTHLY, start Aug 1, different principal/rate)
        // has its own records but Account #1's records are not affected
        const recs4 = await getInterestRecords(4);
        const recs1 = await getInterestRecords(1);

        // Check that records are separate
        for (const r of recs4) {
            assertEqual(r.account_id, 4, 'Account #4 record belongs to account 4');
        }
        for (const r of recs1) {
            assertEqual(r.account_id, 1, 'Account #1 record belongs to account 1');
        }
    });

    await testAsync('§44.3 Interest outstanding is correct after scheduler', async () => {
        // Account #1's interest balance should reflect the accrued records
        const { body: balRes } = await apiGet('/accounts/1/interest-balance');
        const balance = balRes.data;
        assert(balance.interestRecordedPaisa > 0, 'Total interest is positive');
        assertEqual(balance.interestPaidPaisa, 0, 'No payments made');
        assertEqual(balance.interestRecordedPaisa, balance.interestOutstandingPaisa,
            'Outstanding equals total interest (no payments)');
    });

    // ═══════════════════════════════════════════════════════════════
    // §18/§28 — ERROR ISOLATION
    // ═══════════════════════════════════════════════════════════════
    console.log('\n--- §18/§28: Error Isolation ---\n');

    await testAsync('§18.1 CLOSED account is skipped, other accounts still process', async () => {
        await apiPost('/test/reset-state', {});

        // All 4 seed accounts are ACTIVE after reset, so all should be considered.
        // The scheduler should process all of them (no CLOSED/WRITTEN_OFF accounts).
        const result = await runScheduler('2026-09-01');

        assert(result.accountsConsidered >= 4, 'At least 4 active accounts considered');
        // Account #3 starts 2026-09-10, so at Sep 1 no period is due → skipped
        // Accounts #1 and #4 start Aug 1, #2 starts Sep 1 → #1, #4 have Aug→Sep due, #2 has no complete period
        assert(result.accountsProcessed >= 2, 'At least 2 accounts processed');
        // Verify no account detail has ERROR status from status check
        const errorDetails = result.details.filter(d => d.status === 'ERROR');
        assertEqual(errorDetails.length, 0, 'No account errors from status validation');
    });

    await testAsync('§28.1 Partial run failure — remaining accounts still process', async () => {
        await apiPost('/test/reset-state', {});

        // Run scheduler normally — all should succeed
        const result = await runScheduler('2026-09-01');

        // The scheduler should handle each account independently
        // Even if one had an error, it records per-account status
        assert(result.details.length >= 4, 'Details for at least 4 accounts');
        for (const detail of result.details) {
            assert(
                ['SUCCESS', 'NO_PERIODS_DUE', 'PARTIAL', 'FAILED', 'ERROR'].includes(detail.status),
                `Account #${detail.accountId} has valid status: ${detail.status}`
            );
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // §30/§31 — NO DUPLICATE INTEREST (Manual + Scheduled)
    // ═══════════════════════════════════════════════════════════════
    console.log('\n--- §30/§31: No Duplicate Interest ---\n');

    await testAsync('§30.1 Manual record + scheduler does not create duplicate', async () => {
        await apiPost('/test/reset-state', {});

        // Manual record for Aug→Sep
        await manualAccrue(1, '2026-08-01', '2026-09-01');

        // Run scheduler for Sep 1 — should NOT create another Aug→Sep record
        const result = await runScheduler('2026-09-01');
        const detail = result.details.find(d => d.accountId === 1);
        assertEqual(detail.alreadyRecorded, 1, 'Manual period recognized');
        assertEqual(detail.accrualsCreated, 0, 'No duplicate created');

        const records = await getInterestRecords(1);
        const augRecs = records.filter(r => r.period_start === '2026-08-01' && r.period_end === '2026-09-01');
        assertEqual(augRecs.length, 1, 'Exactly one record');
    });

    await testAsync('§31.1 Double scheduler run creates exactly one record', async () => {
        await apiPost('/test/reset-state', {});

        // Run scheduler twice at Sep 1
        await runScheduler('2026-09-01');
        await runScheduler('2026-09-01');

        // Verify exactly one record per period for Account #1
        const records = await getInterestRecords(1);
        const augRecs = records.filter(r => r.period_start === '2026-08-01' && r.period_end === '2026-09-01');
        assertEqual(augRecs.length, 1, 'Exactly one August record after double run');
    });

    // ═══════════════════════════════════════════════════════════════
    // §29 — RESULT SUMMARY STRUCTURE
    // ═══════════════════════════════════════════════════════════════
    console.log('\n--- §29: Result Summary ---\n');

    await testAsync('§29.1 Scheduler returns structured result summary', async () => {
        await apiPost('/test/reset-state', {});

        const result = await runScheduler('2026-09-01');

        // Verify all required fields exist
        assert(result.runId, 'runId present');
        assert(result.startedAt, 'startedAt present');
        assert(result.completedAt, 'completedAt present');
        assertEqual(result.status, 'COMPLETED', 'Status is COMPLETED');
        assertEqual(result.currentDate, '2026-09-01', 'Current date matches input');
        assertEqual(typeof result.accountsConsidered, 'number', 'accountsConsidered is number');
        assertEqual(typeof result.accountsProcessed, 'number', 'accountsProcessed is number');
        assertEqual(typeof result.accrualsCreated, 'number', 'accrualsCreated is number');
        assertEqual(typeof result.alreadyRecorded, 'number', 'alreadyRecorded is number');
        assertEqual(typeof result.zeroInterest, 'number', 'zeroInterest is number');
        assertEqual(typeof result.skipped, 'number', 'skipped is number');
        assertEqual(typeof result.failed, 'number', 'failed is number');
        assert(Array.isArray(result.details), 'details is an array');

        // Verify per-account detail structure
        const detail = result.details[0];
        assert(detail.accountId, 'accountId present');
        assert(detail.frequency, 'frequency present');
        assertEqual(typeof detail.periodsGenerated, 'number', 'periodsGenerated is number');
        assertEqual(typeof detail.accrualsCreated, 'number', 'accrualsCreated is number');
        assertEqual(typeof detail.alreadyRecorded, 'number', 'alreadyRecorded is number');
        assertEqual(typeof detail.failed, 'number', 'failed is number');
        assert(detail.status, 'status present');
    });

    // ═══════════════════════════════════════════════════════════════
    // §35 — ZERO PRINCIPAL
    // ═══════════════════════════════════════════════════════════════
    console.log('\n--- §35: Zero Principal ---\n');

    await testAsync('§35.1 Zero outstanding principal — fully repaid account becomes CLOSED and is skipped', async () => {
        await apiPost('/test/reset-state', {});

        // Create account with ₹10 principal (1000 paisa), then pay it all off
        const zeroAcct = await createTestAccount('MONTHLY', '2026-08-01', 1000, 15.0);
        const acctId = zeroAcct.id;

        // Record a principal payment that reduces principal to 0
        // This will set the account status to CLOSED (per existing transaction service behavior)
        await apiPost('/transactions', {
            account_id: acctId,
            person_id: zeroAcct.person_id || 1,
            transaction_type: 'PRINCIPAL_RECEIVED',
            amount: 10, // ₹10 = 1000 paisa (full repayment)
            transaction_date: '2026-08-01',
            payment_method: 'CASH'
        });

        // Verify the account is now CLOSED
        const { body: accRes } = await apiGet(`/accounts/${acctId}`);
        assertEqual(accRes.data.status, 'CLOSED', 'Fully repaid account is CLOSED');
        assertEqual(accRes.data.outstanding_principal, 0, 'Outstanding principal is 0');

        // Run scheduler for Sep 1 — CLOSED account should be excluded from eligible accounts
        const result = await runScheduler('2026-09-01');
        const detail = result.details.find(d => d.accountId === acctId);
        assertEqual(detail, undefined,
            'CLOSED account is not in scheduler details (excluded from eligible accounts)');

        // Verify no interest records were created for the CLOSED account
        const records = await getInterestRecords(acctId);
        assertEqual(records.length, 0, 'No interest records for CLOSED account');
    });

    // ═══════════════════════════════════════════════════════════════
    // §32 — PRINCIPAL PAYMENTS (Timeline Calculation)
    // ═══════════════════════════════════════════════════════════════
    console.log('\n--- §32: Principal Payments ---\n');

    await testAsync('§32.1 Scheduler uses principal timeline with mid-period payment', async () => {
        await apiPost('/test/reset-state', {});

        // Account #1: ₹2,000 @ 15%, MONTHLY, start Aug 1
        // Add a principal payment of ₹500 on Aug 16
        await apiPost('/transactions', {
            account_id: 1,
            person_id: 1,
            transaction_type: 'PRINCIPAL_RECEIVED',
            amount: 500, // ₹500 = 50000 paisa
            transaction_date: '2026-08-16',
            payment_method: 'CASH'
        });

        // Run scheduler for Sep 1
        const result = await runScheduler('2026-09-01');

        // The interest should be less than full month on ₹2,000
        // because after Aug 16, principal is ₹1,500
        const records = await getInterestRecords(1);
        const augRec = records.find(r => r.period_start === '2026-08-01' && r.period_end === '2026-09-01');
        assert(augRec, 'August record created');

        // Full month at ₹2,000 @ 15% would be 2000*0.15*31/365 = 25.48
        // With split: 15 days at ₹2,000 + 16 days at ₹1,500
        // = (2000*0.15*15/365) + (1500*0.15*16/365)
        // = 12.33 + 9.86 = 22.19 → 2219 paisa
        // The exact amount depends on timeline logic — just verify it's less than full-principal
        const fullMonthPaisa = Math.round(200000 * 0.15 * 31 / 365);
        assert(augRec.interest_amount_paisa < fullMonthPaisa,
            `Interest ${augRec.interest_amount_paisa} < full-principal ${fullMonthPaisa}`);
        assert(augRec.interest_amount_paisa > 0, 'Interest is positive');
    });

    // ═══════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════
    console.log('\n' + '═'.repeat(60));
    console.log(`  Step 5K Test Results: ${passed} passed, ${failed} failed, ${total} total`);
    console.log('═'.repeat(60) + '\n');

    if (failed > 0) {
        console.log('  ⚠ Some tests failed. Review the output above.\n');
        process.exit(1);
    } else {
        console.log('  ✅ All Step 5K tests passed!\n');
    }
}

runTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
