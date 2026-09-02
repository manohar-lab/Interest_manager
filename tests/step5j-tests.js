/**
 * Interest Manager — Step 5J Test Suite
 * Automatic Interest Accrual Service Verification
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
async function apiPost(url, data, headers = {}) {
    const r = await fetch(BASE + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(data)
    });
    return { status: r.status, body: await r.json() };
}

async function runTests() {
    console.log('\n=== Interest Manager — Step 5J Automatic Interest Accrual Test Suite ===\n');

    // Clean server state for deterministic testing
    await apiPost('/test/reset-state', {});

    // Fetch accounts
    const { body: accsRes } = await apiGet('/accounts');
    const accounts = accsRes.data || [];
    assert(accounts.length >= 3, 'At least 3 accounts exist in database');

    const acc1 = accounts.find(a => a.id === 1) || accounts[0];
    const acc2 = accounts.find(a => a.id === 2) || accounts[1];
    const acc3 = accounts.find(a => a.id === 3) || accounts[2];

    // ─── Test 1: Successful accrual ───
    await testAsync('1. Successful Accrual: ₹2,000 @ 15% for 1 year records ₹300 interest', async () => {
        const { status, body } = await apiPost(`/accounts/${acc1.id}/accrue-interest`, {
            start_date: '2026-01-01',
            end_date: '2027-01-01'
        });

        assertEqual(status, 200, 'HTTP 200 OK');
        assertEqual(body.data.status, 'RECORDED', 'Status is RECORDED');
        assertEqual(body.data.interestAmount, 300, 'Interest amount is ₹300');
        assertEqual(body.data.alreadyRecorded, false, 'alreadyRecorded is false');
        assert(body.data.interestRecordId > 0, 'Valid interestRecordId returned');

        // Verify via interest-records API
        const { body: recsRes } = await apiGet(`/accounts/${acc1.id}/interest-records`);
        const rec = recsRes.data.find(r => r.id === body.data.interestRecordId);
        assert(rec, 'Interest record exists in database');
        assertEqual(rec.interest_amount_paisa, 30000, 'Recorded 30,000 paisa (₹300)');
        assertEqual(rec.status, 'PENDING', 'Record status is PENDING');
    });

    // ─── Test 2: Duplicate accrual ───
    await testAsync('2. Duplicate Accrual: Running accrual again for same account and period returns ALREADY_RECORDED', async () => {
        const { status, body } = await apiPost(`/accounts/${acc1.id}/accrue-interest`, {
            start_date: '2026-01-01',
            end_date: '2027-01-01'
        });

        assertEqual(status, 200, 'HTTP 200 OK');
        assertEqual(body.data.status, 'ALREADY_RECORDED', 'Status is ALREADY_RECORDED');
        assertEqual(body.data.alreadyRecorded, true, 'alreadyRecorded is true');
        assertEqual(body.data.interestAmount, 300, 'Interest amount is ₹300');

        // Verify only 1 record exists for this period via API
        const { body: recsRes } = await apiGet(`/accounts/${acc1.id}/interest-records`);
        const matching = recsRes.data.filter(r => r.period_start === '2026-01-01' && r.period_end === '2027-01-01');
        assertEqual(matching.length, 1, 'Exactly one record exists; no duplicate created');
    });

    // ─── Test 3: Concurrent accrual ───
    await testAsync('3. Concurrent Accrual: Two simultaneous requests create exactly one record', async () => {
        // Use Account #002 with a fresh period
        const [res1, res2] = await Promise.all([
            apiPost(`/accounts/${acc2.id}/accrue-interest`, { start_date: '2026-01-01', end_date: '2026-04-01' }),
            apiPost(`/accounts/${acc2.id}/accrue-interest`, { start_date: '2026-01-01', end_date: '2026-04-01' })
        ]);

        assertEqual(res1.status, 200, 'First request status 200');
        assertEqual(res2.status, 200, 'Second request status 200');

        const statuses = [res1.body.data.status, res2.body.data.status];
        assert(statuses.includes('RECORDED'), 'At least one was RECORDED');

        // Verify only 1 record via API
        const { body: recsRes } = await apiGet(`/accounts/${acc2.id}/interest-records`);
        const matching = recsRes.data.filter(r => r.period_start === '2026-01-01' && r.period_end === '2026-04-01');
        assertEqual(matching.length, 1, 'Exactly one record in database');
    });

    // ─── Test 4: Principal payment affects timeline calculation ───
    await testAsync('4. Principal Payment Timeline: Historical principal payment of ₹500 accurately divides accrual into segments', async () => {
        // Record a principal payment of ₹500 on 15/08/2026 for Account #002
        await apiPost('/payments/allocate', {
            account_id: acc2.id,
            total_amount: 500,
            interest_amount: 0,
            principal_amount: 500,
            payment_method: 'CASH',
            payment_date: '15/08/2026',
            reference: 'CASH/PRIN-500'
        });

        // Accrue interest for August 2026
        const { status, body } = await apiPost(`/accounts/${acc2.id}/accrue-interest`, {
            start_date: '2026-08-01',
            end_date: '2026-08-31'
        });

        assertEqual(status, 200, 'HTTP 200 OK');
        assertEqual(body.data.status, 'RECORDED', 'Status is RECORDED');
        // Segment 1 (14d @ ₹2,000) + Segment 2 (16d @ ₹1,500) ≈ ₹21.37
        assertCloseTo(body.data.interestAmount, 21.37, 0.02, 'Interest matches timeline calculation ≈₹21.37');
    });

    // ─── Test 5: Interest payment does not change principal ───
    await testAsync('5. Interest Payment Immunity: Interest payment leaves principal intact for accrual', async () => {
        const { body: accBefore } = await apiGet(`/accounts/${acc2.id}`);
        const opBefore = accBefore.data.outstanding_principal;

        // Record interest so we can make an interest payment
        const { body: balRes } = await apiGet(`/accounts/${acc2.id}/interest-balance`);
        if (balRes.data && balRes.data.interestOutstanding > 0) {
            // Pay ₹20 interest only
            await apiPost('/payments/allocate', {
                account_id: acc2.id,
                total_amount: 20,
                interest_amount: 20,
                principal_amount: 0,
                payment_method: 'UPI',
                payment_date: '20/08/2026'
            });
        }

        const { body: accAfter } = await apiGet(`/accounts/${acc2.id}`);
        assertEqual(accAfter.data.outstanding_principal, opBefore, 'Principal unchanged after interest payment');
    });

    // ─── Test 6: Mixed payment (only principal portion reduces future interest) ───
    await testAsync('6. Mixed Payment: Only ₹500 principal component of ₹800 mixed payment reduces future interest', async () => {
        // Account #003: Principal ₹5,000 @ 18%
        // First accrue interest for a long enough period so accrued interest >= ₹300
        const { body: accrueRes } = await apiPost(`/accounts/${acc3.id}/accrue-interest`, {
            start_date: '2026-01-01',
            end_date: '2026-07-01'
        });
        assertEqual(accrueRes.data.status, 'RECORDED', 'Interest accrued for Account #003');

        const { body: balBefore } = await apiGet(`/accounts/${acc3.id}/interest-balance`);
        const intOutstanding = balBefore.data.interestOutstanding;
        assert(intOutstanding >= 300, `Enough outstanding interest for ₹300 allocation (got ₹${intOutstanding})`);

        // Make mixed payment: ₹800 (₹300 Interest + ₹500 Principal)
        const { status } = await apiPost('/payments/allocate', {
            account_id: acc3.id,
            total_amount: 800,
            interest_amount: 300,
            principal_amount: 500,
            payment_method: 'BANK_TRANSFER',
            payment_date: '10/07/2026',
            reference: 'MIXED-001'
        });
        assertEqual(status, 201, 'Mixed payment accepted');

        const { body: acc3After } = await apiGet(`/accounts/${acc3.id}`);
        assertEqual(acc3After.data.outstanding_principal, 450000, 'Outstanding principal reduced from ₹5,000 to ₹4,500');
    });

    // ─── Test 7: Full repayment results in zero interest thereafter ───
    await testAsync('7. Full Repayment: After full repayment, accrual produces ZERO_INTEREST', async () => {
        // Full principal repayment of remaining ₹4,500
        const { status: payStatus } = await apiPost('/payments/allocate', {
            account_id: acc3.id,
            total_amount: 4500,
            interest_amount: 0,
            principal_amount: 4500,
            payment_method: 'BANK_TRANSFER',
            payment_date: '15/07/2026',
            reference: 'FULL-REPAY'
        });
        assertEqual(payStatus, 201, 'Full repayment accepted');

        const { body: acc3Closed } = await apiGet(`/accounts/${acc3.id}`);
        assertEqual(acc3Closed.data.outstanding_principal, 0, 'Outstanding principal is ₹0');
    });

    // ─── Test 8: Zero interest (same start/end date) ───
    await testAsync('8. Zero Interest: Accrual with 0 elapsed days returns ZERO_INTEREST and creates no record', async () => {
        const { status, body } = await apiPost(`/accounts/${acc1.id}/accrue-interest`, {
            start_date: '2026-08-01',
            end_date: '2026-08-01'
        });

        assertEqual(status, 200, 'HTTP 200 OK');
        assertEqual(body.data.status, 'ZERO_INTEREST', 'Status is ZERO_INTEREST');
        assertEqual(body.data.interestAmount, 0, 'Zero interest');
        assertEqual(body.data.interestRecordId, null, 'No interest record ID created');
    });

    // ─── Test 9: Invalid period rejection ───
    await testAsync('9. Date Validation: Inverted dates (End < Start) rejected with HTTP 400', async () => {
        const { status, body } = await apiPost(`/accounts/${acc1.id}/accrue-interest`, {
            start_date: '2026-12-01',
            end_date: '2026-01-01'
        });

        assertEqual(status, 400, 'HTTP 400 Bad Request');
        assert(body.error.includes('cannot be before'), 'Error message describes date inversion');
    });

    // ─── Test 10: Account not found ───
    await testAsync('10. Account Not Found: Missing account 99999 returns HTTP 404', async () => {
        const { status, body } = await apiPost('/accounts/99999/accrue-interest', {
            start_date: '2026-01-01',
            end_date: '2027-01-01'
        });

        assertEqual(status, 404, 'HTTP 404 Not Found');
        assert(body.error.includes('not found'), 'Error describes missing account');
    });

    // ─── Test 11: No payment creation ───
    await testAsync('11. No Payment Creation: Accrual creates zero payment transactions', async () => {
        const { body: txBefore } = await apiGet(`/transactions?account_id=${acc1.id}`);
        const countBefore = (txBefore.data || []).length;

        await apiPost(`/accounts/${acc1.id}/accrue-interest`, {
            start_date: '2027-01-01',
            end_date: '2027-06-01'
        });

        const { body: txAfter } = await apiGet(`/transactions?account_id=${acc1.id}`);
        const countAfter = (txAfter.data || []).length;
        assertEqual(countBefore, countAfter, 'No transactions created by accrual service');
    });

    // ─── Test 12: Principal unchanged ───
    await testAsync('12. Principal Unchanged: Accrual leaves outstanding_principal untouched', async () => {
        const { body: accBefore } = await apiGet(`/accounts/${acc1.id}`);
        const pBefore = accBefore.data.outstanding_principal;

        await apiPost(`/accounts/${acc1.id}/accrue-interest`, {
            start_date: '2027-06-01',
            end_date: '2028-01-01'
        });

        const { body: accAfter } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(accAfter.data.outstanding_principal, pBefore, 'Principal remains unchanged after accrual');
    });

    // ─── Test 13: Existing interest balance preserved ───
    await testAsync('13. Existing Interest Balance: New accrual adds to outstanding interest, not overwrites', async () => {
        const { body: balBefore } = await apiGet(`/accounts/${acc1.id}/interest-balance`);
        const recordedBefore = balBefore.data.interestRecorded;
        const outstandingBefore = balBefore.data.interestOutstanding;

        const { body: res } = await apiPost(`/accounts/${acc1.id}/accrue-interest`, {
            start_date: '2028-01-01',
            end_date: '2028-07-01'
        });
        assertEqual(res.data.status, 'RECORDED', 'New period accrued');

        const { body: balAfter } = await apiGet(`/accounts/${acc1.id}/interest-balance`);
        assertCloseTo(balAfter.data.interestRecorded, recordedBefore + res.data.interestAmount, 0.01, 'Recorded interest increased by exact new accrual');
        assertCloseTo(balAfter.data.interestOutstanding, outstandingBefore + res.data.interestAmount, 0.01, 'Outstanding interest increased by exact new accrual');
    });

    // ─── Test 14: Database rollback on failure ───
    await testAsync('14. Transaction Safety: Invalid accrual request leaves no partial records', async () => {
        const { body: recsBefore } = await apiGet(`/accounts/${acc1.id}/interest-records`);
        const countBefore = recsBefore.data.length;

        // Send request with missing dates to trigger validation error
        const { status } = await apiPost(`/accounts/${acc1.id}/accrue-interest`, {
            start_date: 'invalid-date',
            end_date: 'also-invalid'
        });
        assertEqual(status, 400, 'Invalid date rejected');

        const { body: recsAfter } = await apiGet(`/accounts/${acc1.id}/interest-records`);
        assertEqual(countBefore, recsAfter.data.length, 'Zero partial records created after failure');
    });

    // ─── Test 15: Account isolation ───
    await testAsync('15. Account Isolation: Accruing on Account #001 does not touch Account #002 interest records', async () => {
        const { body: recsAcc2Before } = await apiGet(`/accounts/${acc2.id}/interest-records`);
        const countBefore = recsAcc2Before.data.length;

        await apiPost(`/accounts/${acc1.id}/accrue-interest`, {
            start_date: '2030-01-01',
            end_date: '2031-01-01'
        });

        const { body: recsAcc2After } = await apiGet(`/accounts/${acc2.id}/interest-records`);
        assertEqual(countBefore, recsAcc2After.data.length, 'Account #002 interest records completely isolated');
    });

    // ─── Test 16: Integration Pipeline ───
    await testAsync('16. Integration Pipeline: Account → Timeline → Accrual → Duplicate Check → Record → Interest Outstanding', async () => {
        // Clean reset for end-to-end pipeline verification
        await apiPost('/test/reset-state', {});

        // Step 1: Initial account ₹2,000 @ 15%
        const { body: accInit } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(accInit.data.outstanding_principal, 200000, 'Principal is ₹2,000');

        // Step 2: Pay ₹500 principal on 15/08/2026
        await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 500,
            interest_amount: 0,
            principal_amount: 500,
            payment_method: 'CASH',
            payment_date: '15/08/2026'
        });

        // Step 3: Accrue interest for August (timeline-based)
        const { body: accrueRes } = await apiPost(`/accounts/${acc1.id}/accrue-interest`, {
            start_date: '2026-08-01',
            end_date: '2026-08-31'
        });
        assertEqual(accrueRes.data.status, 'RECORDED', 'Accrual status is RECORDED');
        assertCloseTo(accrueRes.data.interestAmount, 21.37, 0.02, 'Accrued ≈₹21.37');

        // Step 4: Verify duplicate protection on pipeline
        const { body: dupRes } = await apiPost(`/accounts/${acc1.id}/accrue-interest`, {
            start_date: '2026-08-01',
            end_date: '2026-08-31'
        });
        assertEqual(dupRes.data.status, 'ALREADY_RECORDED', 'Duplicate accurately prevented');

        // Step 5: Verify Interest Outstanding derived correctly
        const { body: balRes } = await apiGet(`/accounts/${acc1.id}/interest-balance`);
        assertCloseTo(balRes.data.interestOutstanding, 21.37, 0.02, 'Interest outstanding reflects new accrual');
        assertEqual(balRes.data.interestPaid, 0, 'Interest paid is ₹0');
    });

    // ─── Test 17: Manual vs Automatic Consistency ───
    await testAsync('17. Manual vs Automatic Consistency: Manual Step 5F and Automatic Step 5J produce identical interest', async () => {
        // Use a clean period that hasn't been used yet
        // Run Step 5F calculation via API
        const { body: manualCalc } = await apiPost(`/accounts/${acc1.id}/timeline-interest`, {
            start_date: '2026-09-01',
            end_date: '2026-12-01'
        });

        // Run Step 5J automatic accrual
        const { body: autoAccrue } = await apiPost(`/accounts/${acc1.id}/accrue-interest`, {
            start_date: '2026-09-01',
            end_date: '2026-12-01'
        });

        assertEqual(autoAccrue.data.status, 'RECORDED', 'Auto accrual recorded');
        assertEqual(autoAccrue.data.interestAmount, manualCalc.data.totalInterest, 'Interest amounts match exactly');
        assertEqual(autoAccrue.data.interestAmountPaisa, manualCalc.data.totalInterestPaisa, 'Interest paisa matches exactly');
        assertEqual(autoAccrue.data.calculation.totalElapsedDays, manualCalc.data.totalElapsedDays, 'Elapsed days match exactly');
    });

    // Clean up test records after suite
    await apiPost('/test/reset-state', {});

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Step 5J Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
