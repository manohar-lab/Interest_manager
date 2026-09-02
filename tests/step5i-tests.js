/**
 * Interest Manager — Step 5I Test Suite
 * Interest Outstanding & Payment Allocation Verification
 */

const { getDatabase, saveDatabase } = require('../db/connection');
const { queryOne, queryAll } = require('../db/helpers');
const { recordInterest, getAccountInterestBalance } = require('../services/interestService');
const { allocatePayment } = require('../services/transactionService');

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
    console.log('\n=== Interest Manager — Step 5I Interest Outstanding & Allocation Test Suite ===\n');

    // Ensure server-side clean slate for idempotent testing
    await apiPost('/test/reset-state', {});

    const db = await getDatabase();

    // Fetch accounts
    const { body: accsRes } = await apiGet('/accounts');
    const accounts = accsRes.data || [];
    assert(accounts.length >= 3, 'At least 3 accounts exist in database');

    const acc1 = accounts.find(a => a.id === 1) || accounts[0];
    const acc2 = accounts.find(a => a.id === 2) || accounts[1];
    const acc3 = accounts.find(a => a.id === 3) || accounts[2];
    assert(acc1, 'Account #001 (Ramesh @ 15%) exists');
    assert(acc2, 'Account #002 (Ramesh @ 15%) exists');
    assert(acc3, 'Account #003 (Ramesh @ 18%) exists');

    // ─── Test 1: Recorded interest with no payment ───
    await testAsync('1. Recorded interest with no payment: Recorded=₹300, Paid=₹0, Outstanding=₹300', async () => {
        // Record interest on acc1: ₹300 for 01/01/2026 -> 01/01/2027
        const { status, body } = await apiPost(`/accounts/${acc1.id}/interest-records`, {
            period_start: '2026-01-01',
            period_end: '2027-01-01',
            interest_amount: 300,
            principal_basis: 2000,
            interest_rate: 15
        });
        assertEqual(status, 201, 'HTTP 201 Created');
        assertEqual(body.data.interest_amount, 30000, '30,000 paisa recorded');
        assertEqual(body.data.status, 'PENDING', 'Status is PENDING');

        const { body: bal } = await apiGet(`/accounts/${acc1.id}/interest-balance`);
        assertEqual(bal.data.interestRecorded, 300, 'Interest Recorded is ₹300');
        assertEqual(bal.data.interestPaid, 0, 'Interest Paid is ₹0');
        assertEqual(bal.data.interestOutstanding, 300, 'Interest Outstanding is ₹300');
    });

    // ─── Test 2: Partial interest payment ───
    await testAsync('2. Partial interest payment: Pay ₹100 interest -> Recorded=₹300, Paid=₹100, Outstanding=₹200', async () => {
        const { status, body } = await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 100,
            interest_amount: 100,
            principal_amount: 0,
            payment_method: 'UPI',
            payment_date: '02/01/2026',
            reference: 'UPI/INT-001'
        });
        assertEqual(status, 201, 'HTTP 201 Created');

        const { body: bal } = await apiGet(`/accounts/${acc1.id}/interest-balance`);
        assertEqual(bal.data.interestRecorded, 300, 'Interest Recorded is ₹300');
        assertEqual(bal.data.interestPaid, 100, 'Interest Paid is ₹100');
        assertEqual(bal.data.interestOutstanding, 200, 'Interest Outstanding is ₹200');

        // Check record status
        const rec = bal.data.records[0];
        assertEqual(rec.paid_amount, 100, 'Record paid_amount is ₹100');
        assertEqual(rec.outstanding_amount, 200, 'Record outstanding_amount is ₹200');
        assertEqual(rec.status, 'PARTIALLY_PAID', 'Record status is PARTIALLY_PAID');
    });

    // ─── Test 3: Full interest payment ───
    await testAsync('3. Full interest payment: Pay remaining ₹200 interest -> Outstanding=₹0, Status=PAID', async () => {
        const { status, body } = await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 200,
            interest_amount: 200,
            principal_amount: 0,
            payment_method: 'CASH',
            payment_date: '03/01/2026',
            reference: 'CASH/INT-002'
        });
        assertEqual(status, 201, 'HTTP 201 Created');

        const { body: bal } = await apiGet(`/accounts/${acc1.id}/interest-balance`);
        assertEqual(bal.data.interestRecorded, 300, 'Interest Recorded is ₹300');
        assertEqual(bal.data.interestPaid, 300, 'Interest Paid is ₹300');
        assertEqual(bal.data.interestOutstanding, 0, 'Interest Outstanding is ₹0');

        const rec = bal.data.records[0];
        assertEqual(rec.paid_amount, 300, 'Record paid_amount is ₹300');
        assertEqual(rec.outstanding_amount, 0, 'Record outstanding_amount is ₹0');
        assertEqual(rec.status, 'PAID', 'Record status is PAID');
    });

    // ─── Test 4: Multiple interest payments ───
    await testAsync('4. Multiple interest payments on new record: ₹100 + ₹150 + ₹250 = ₹500', async () => {
        // Record new interest: ₹500
        await apiPost(`/accounts/${acc1.id}/interest-records`, {
            period_start: '2027-01-01',
            period_end: '2028-01-01',
            interest_amount: 500,
            principal_basis: 2000,
            interest_rate: 15
        });

        // Pay 1: ₹100
        await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 100,
            interest_amount: 100,
            principal_amount: 0,
            payment_method: 'BANK_TRANSFER',
            payment_date: '05/01/2027'
        });

        // Pay 2: ₹150
        await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 150,
            interest_amount: 150,
            principal_amount: 0,
            payment_method: 'UPI',
            payment_date: '06/01/2027'
        });

        // Pay 3: ₹250
        await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 250,
            interest_amount: 250,
            principal_amount: 0,
            payment_method: 'CASH',
            payment_date: '07/01/2027'
        });

        const { body: bal } = await apiGet(`/accounts/${acc1.id}/interest-balance`);
        assertEqual(bal.data.interestRecorded, 800, 'Total recorded: 300 + 500 = ₹800');
        assertEqual(bal.data.interestPaid, 800, 'Total paid: 300 + 100 + 150 + 250 = ₹800');
        assertEqual(bal.data.interestOutstanding, 0, 'Total outstanding: ₹0');
    });

    // ─── Test 5: Interest-only payment does NOT reduce principal ───
    await testAsync('5. Principal immunity: Interest-only payment leaves outstanding_principal unchanged', async () => {
        const { body: accBefore } = await apiGet(`/accounts/${acc1.id}`);
        const principalBefore = accBefore.data.outstanding_principal;

        // Record ₹200 interest
        await apiPost(`/accounts/${acc1.id}/interest-records`, {
            period_start: '2028-01-01',
            period_end: '2029-01-01',
            interest_amount: 200,
            principal_basis: 2000,
            interest_rate: 15
        });

        // Pay ₹100 interest only
        await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 100,
            interest_amount: 100,
            principal_amount: 0,
            payment_method: 'CASH',
            payment_date: '10/01/2028'
        });

        const { body: accAfter } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(accAfter.data.outstanding_principal, principalBefore, 'Principal unchanged after interest payment');
    });

    // ─── Test 6: Principal-only payment does NOT reduce interest outstanding ───
    await testAsync('6. Interest immunity: Principal-only payment leaves interest outstanding unchanged', async () => {
        const { body: balBefore } = await apiGet(`/accounts/${acc1.id}/interest-balance`);
        const intOutstandingBefore = balBefore.data.interestOutstanding; // ₹100
        assertEqual(intOutstandingBefore, 100, 'Interest outstanding is ₹100');

        // Pay ₹500 principal only
        const { status } = await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 500,
            interest_amount: 0,
            principal_amount: 500,
            payment_method: 'BANK_TRANSFER',
            payment_date: '15/01/2028'
        });
        assertEqual(status, 201, 'HTTP 201 Created');

        const { body: balAfter } = await apiGet(`/accounts/${acc1.id}/interest-balance`);
        assertEqual(balAfter.data.interestOutstanding, 100, 'Interest outstanding remains ₹100');

        const { body: accAfter } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(accAfter.data.outstanding_principal, 150000, 'Outstanding principal reduced to ₹1,500');
    });

    // ─── Test 7: Mixed payment ───
    await testAsync('7. Mixed payment: ₹600 payment (₹100 Interest + ₹500 Principal)', async () => {
        const { status } = await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 600,
            interest_amount: 100,
            principal_amount: 500,
            payment_method: 'UPI',
            payment_date: '20/01/2028'
        });
        assertEqual(status, 201, 'HTTP 201 Created');

        const { body: bal } = await apiGet(`/accounts/${acc1.id}/interest-balance`);
        assertEqual(bal.data.interestOutstanding, 0, 'Interest outstanding reduced from ₹100 to ₹0');

        const { body: acc } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(acc.data.outstanding_principal, 100000, 'Principal reduced from ₹1,500 to ₹1,000');
    });

    // ─── Test 8: Over-allocation rejection ───
    await testAsync('8. Over-allocation rejection: Attempting to pay ₹300 interest when outstanding is ₹200 is rejected with HTTP 400', async () => {
        // Record ₹200 interest
        await apiPost(`/accounts/${acc1.id}/interest-records`, {
            period_start: '2029-01-01',
            period_end: '2030-01-01',
            interest_amount: 200,
            principal_basis: 1000,
            interest_rate: 15
        });

        // Try to allocate ₹300 interest
        const { status, body } = await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 300,
            interest_amount: 300,
            principal_amount: 0,
            payment_method: 'CASH',
            payment_date: '01/02/2029'
        });
        assertEqual(status, 400, 'HTTP 400 Bad Request');
        assert(body.error.includes('cannot exceed current outstanding interest'), 'Error message specifies over-allocation');
    });

    // ─── Test 9: Zero outstanding interest rejection ───
    await testAsync('9. Zero outstanding interest: Attempting to pay interest when outstanding is ₹0 is rejected', async () => {
        // Pay off the remaining ₹200
        await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 200,
            interest_amount: 200,
            principal_amount: 0,
            payment_method: 'CASH',
            payment_date: '05/02/2029'
        });

        // Verify outstanding is now ₹0
        const { body: bal } = await apiGet(`/accounts/${acc1.id}/interest-balance`);
        assertEqual(bal.data.interestOutstanding, 0, 'Outstanding interest is ₹0');

        // Now attempt to pay ₹50 interest
        const { status, body } = await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 50,
            interest_amount: 50,
            principal_amount: 0,
            payment_method: 'CASH',
            payment_date: '10/02/2029'
        });
        assertEqual(status, 400, 'HTTP 400 Bad Request');
        assert(body.error.includes('₹0 outstanding interest'), 'Error message specifies ₹0 outstanding interest');
    });

    // ─── Test 10: Multiple interest records FIFO allocation ───
    await testAsync('10. Multiple interest records: Record A (₹300) + Record B (₹200) -> Pay ₹350 -> A=0, B=₹150, Total=₹150', async () => {
        // Use Account #002
        await apiPost(`/accounts/${acc2.id}/interest-records`, {
            period_start: '2026-01-01',
            period_end: '2026-02-01',
            interest_amount: 300,
            principal_basis: 2000,
            interest_rate: 15
        });
        await apiPost(`/accounts/${acc2.id}/interest-records`, {
            period_start: '2026-02-01',
            period_end: '2026-03-01',
            interest_amount: 200,
            principal_basis: 2000,
            interest_rate: 15
        });

        const { body: balBefore } = await apiGet(`/accounts/${acc2.id}/interest-balance`);
        assertEqual(balBefore.data.interestRecorded, 500, 'Total recorded: ₹500');
        assertEqual(balBefore.data.interestOutstanding, 500, 'Total outstanding: ₹500');

        // Pay ₹350 interest
        const { status } = await apiPost('/payments/allocate', {
            account_id: acc2.id,
            total_amount: 350,
            interest_amount: 350,
            principal_amount: 0,
            payment_method: 'UPI',
            payment_date: '15/02/2026'
        });
        assertEqual(status, 201, 'HTTP 201 Created');

        const { body: balAfter } = await apiGet(`/accounts/${acc2.id}/interest-balance`);
        assertEqual(balAfter.data.interestPaid, 350, 'Total paid: ₹350');
        assertEqual(balAfter.data.interestOutstanding, 150, 'Total outstanding: ₹150');

        // Verify Record A is PAID (₹300 paid, ₹0 left)
        const recA = balAfter.data.records[0];
        assertEqual(recA.paid_amount, 300, 'Record A paid ₹300');
        assertEqual(recA.outstanding_amount, 0, 'Record A outstanding ₹0');
        assertEqual(recA.status, 'PAID', 'Record A status PAID');

        // Verify Record B is PARTIALLY_PAID (₹50 paid, ₹150 left)
        const recB = balAfter.data.records[1];
        assertEqual(recB.paid_amount, 50, 'Record B paid ₹50');
        assertEqual(recB.outstanding_amount, 150, 'Record B outstanding ₹150');
        assertEqual(recB.status, 'PARTIALLY_PAID', 'Record B status PARTIALLY_PAID');
    });

    // ─── Test 11: Payment after new interest record ───
    await testAsync('11. Payment after new interest record: Outstanding ₹150 + New ₹200 = ₹350 -> Pay ₹100 -> Outstanding=₹250', async () => {
        // Record new interest on acc2: ₹200
        await apiPost(`/accounts/${acc2.id}/interest-records`, {
            period_start: '2026-03-01',
            period_end: '2026-04-01',
            interest_amount: 200,
            principal_basis: 2000,
            interest_rate: 15
        });

        const { body: balBefore } = await apiGet(`/accounts/${acc2.id}/interest-balance`);
        assertEqual(balBefore.data.interestOutstanding, 350, 'Outstanding becomes ₹150 + ₹200 = ₹350');

        // Pay ₹100
        await apiPost('/payments/allocate', {
            account_id: acc2.id,
            total_amount: 100,
            interest_amount: 100,
            principal_amount: 0,
            payment_method: 'CASH',
            payment_date: '20/03/2026'
        });

        const { body: balAfter } = await apiGet(`/accounts/${acc2.id}/interest-balance`);
        assertEqual(balAfter.data.interestOutstanding, 250, 'Outstanding becomes ₹250');
        assertEqual(balAfter.data.interestPaid, 450, 'Total paid becomes ₹450');
    });

    // ─── Test 12: Duplicate payment protection ───
    await testAsync('12. Duplicate payment protection: Duplicate idempotency key does not double-count payment', async () => {
        const key = 'IDEM-STEP5I-' + Date.now();
        const payload = {
            account_id: acc2.id,
            total_amount: 50,
            interest_amount: 50,
            principal_amount: 0,
            payment_method: 'UPI',
            payment_date: '22/03/2026',
            idempotency_key: key
        };

        const res1 = await apiPost('/payments/allocate', payload, { 'Idempotency-Key': key });
        assertEqual(res1.status, 201, 'First request creates payment');

        const { body: bal1 } = await apiGet(`/accounts/${acc2.id}/interest-balance`);
        const paid1 = bal1.data.interestPaid;

        // Resend identical request
        const res2 = await apiPost('/payments/allocate', payload, { 'Idempotency-Key': key });
        assertEqual(res2.body.data.isDuplicate, true, 'Second request identified as duplicate');

        const { body: bal2 } = await apiGet(`/accounts/${acc2.id}/interest-balance`);
        assertEqual(bal2.data.interestPaid, paid1, 'Interest Paid did not increase on duplicate');
    });

    // ─── Test 13: Account isolation ───
    await testAsync('13. Account isolation: Paying interest on Account #001 does not reduce Account #003 interest', async () => {
        // Record ₹900 on Account #003
        await apiPost(`/accounts/${acc3.id}/interest-records`, {
            period_start: '2026-01-01',
            period_end: '2027-01-01',
            interest_amount: 900,
            principal_basis: 5000,
            interest_rate: 18
        });

        const { body: bal3Before } = await apiGet(`/accounts/${acc3.id}/interest-balance`);
        assertEqual(bal3Before.data.interestOutstanding, 900, 'Account #003 outstanding is ₹900');

        // Pay ₹50 on Account #002
        await apiPost('/payments/allocate', {
            account_id: acc2.id,
            total_amount: 50,
            interest_amount: 50,
            principal_amount: 0,
            payment_method: 'CASH',
            payment_date: '25/03/2026'
        });

        const { body: bal3After } = await apiGet(`/accounts/${acc3.id}/interest-balance`);
        assertEqual(bal3After.data.interestOutstanding, 900, 'Account #003 outstanding unchanged at ₹900');
    });

    // ─── Test 14: Interest-record isolation ───
    await testAsync('14. Interest record isolation: Payment to earlier records does not falsely mark subsequent record as paid', async () => {
        // Record new interest Record D (₹300)
        await apiPost(`/accounts/${acc2.id}/interest-records`, {
            period_start: '2026-04-01',
            period_end: '2026-05-01',
            interest_amount: 300,
            principal_basis: 2000,
            interest_rate: 15
        });

        const { body: bal } = await apiGet(`/accounts/${acc2.id}/interest-balance`);
        const recD = bal.data.records.find(r => r.period_start === '2026-04-01');

        assert(recD, 'Record D exists');
        assertEqual(recD.paid_amount, 0, 'Record D has 0 payments allocated');
        assertEqual(recD.outstanding_amount, 300, 'Record D outstanding is ₹300');
        assertEqual(recD.status, 'PENDING', 'Record D remains PENDING');
    });

    // ─── Test 15: Atomic payment transaction ───
    await testAsync('15. Atomic payment transaction: Failed allocation leaves no partial transaction records', async () => {
        const txsBefore = queryAll(db, 'SELECT * FROM transactions WHERE account_id = ?', [acc1.id]);

        // Attempt allocation with principal exceeding outstanding (e.g. ₹999,999)
        const { status } = await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 1000000,
            interest_amount: 1,
            principal_amount: 999999,
            payment_method: 'CASH',
            payment_date: '01/04/2026'
        });
        assertEqual(status, 400, 'HTTP 400 Bad Request');

        const txsAfter = queryAll(db, 'SELECT * FROM transactions WHERE account_id = ?', [acc1.id]);
        assertEqual(txsBefore.length, txsAfter.length, 'No transactions committed upon failure');
    });

    // ─── Test 16: Page refresh consistency ───
    await testAsync('16. Page refresh consistency: Derived calculation returns identical value on repeated queries', async () => {
        const { body: r1 } = await apiGet(`/accounts/${acc2.id}/interest-balance`);
        const { body: r2 } = await apiGet(`/accounts/${acc2.id}/interest-balance`);
        const { body: r3 } = await apiGet(`/accounts/${acc2.id}/interest-balance`);

        assertEqual(r1.data.interestRecorded, r2.data.interestRecorded, 'Recorded matches across refreshes');
        assertEqual(r1.data.interestPaid, r3.data.interestPaid, 'Paid matches across refreshes');
        assertEqual(r1.data.interestOutstanding, r2.data.interestOutstanding, 'Outstanding matches across refreshes');
    });

    // ─── Test 17: Database consistency ───
    await testAsync('17. Database consistency: Total interest_allocations equal sum of INTEREST_RECEIVED amounts', async () => {
        const allocs = queryAll(db, `
            SELECT account_id, SUM(amount) as total_allocated
            FROM interest_allocations
            GROUP BY account_id
        `);

        for (const a of allocs) {
            const txSum = queryOne(db, `
                SELECT SUM(amount) as total_interest_tx
                FROM transactions
                WHERE account_id = ? AND transaction_type = 'INTEREST_RECEIVED'
            `, [a.account_id]);

            assertEqual(a.total_allocated, txSum.total_interest_tx, `Allocated sum matches transaction sum for Account #${a.account_id}`);
        }
    });

    // Clean up test records after run
    await apiPost('/test/reset-state', {});

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Step 5I Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
