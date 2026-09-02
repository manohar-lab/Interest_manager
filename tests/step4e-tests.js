/**
 * Interest Manager — Step 4E Test Suite
 * Payment Allocation (Interest + Principal splitting, atomic grouping, balance deduction, validation)
 */

const BASE = 'http://localhost:3000/api';
let passed = 0, failed = 0, total = 0;

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error((msg || '') + ` — expected: ${JSON.stringify(b)}, got: ${JSON.stringify(a)}`); }

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
    console.log('\n=== Interest Manager — Step 4E Payment Allocation Test Suite ===\n');

    // Fetch Ramesh & Mahesh
    const { body: peopleRes } = await apiGet('/people');
    const ramesh = peopleRes.data.find(p => p.name === 'Ramesh');
    const mahesh = peopleRes.data.find(p => p.name === 'Mahesh');
    assert(ramesh && mahesh, 'Ramesh & Mahesh exist in database');

    const { body: rameshAccs } = await apiGet(`/accounts?person_id=${ramesh.id}`);
    const { body: maheshAccs } = await apiGet(`/accounts?person_id=${mahesh.id}`);

    const givenAccs = rameshAccs.data.filter(a => a.direction === 'MONEY_GIVEN');
    assert(givenAccs.length >= 3, 'Ramesh has 3 MONEY_GIVEN accounts');

    const acc1 = givenAccs[0]; // ₹2,000 principal
    const acc2 = givenAccs[1]; // ₹2,000 principal
    const acc3 = givenAccs[2]; // ₹5,000 principal
    const maheshAcc = maheshAccs.data.find(a => a.direction === 'MONEY_TAKEN');

    let mixedPaymentId = null;

    // Test 1: Mixed Payment (Total ₹800 = ₹300 Interest + ₹500 Principal)
    await testAsync('1. Mixed Payment: Allocate ₹800 (₹300 Interest, ₹500 Principal) on Acc #001', async () => {
        const { status, body } = await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 800,
            interest_amount: 300,
            principal_amount: 500,
            payment_method: 'UPI',
            payment_date: '01/09/2026',
            reference: 'UPI/ALLOC-001',
            notes: 'Mixed interest and principal payment'
        });

        assertEqual(status, 201, 'HTTP 201 Created');
        assert(body.data.payment_id, 'payment_id generated');
        assertEqual(body.data.transactions.length, 2, '2 transactions created');

        const interestTx = body.data.transactions.find(t => t.transaction_type === 'INTEREST_RECEIVED');
        const principalTx = body.data.transactions.find(t => t.transaction_type === 'PRINCIPAL_RECEIVED');

        assert(interestTx, 'INTEREST_RECEIVED transaction exists');
        assert(principalTx, 'PRINCIPAL_RECEIVED transaction exists');
        assertEqual(interestTx.amount, 30000, 'Interest amount is ₹300 (30000 paisa)');
        assertEqual(principalTx.amount, 50000, 'Principal amount is ₹500 (50000 paisa)');
        assertEqual(interestTx.payment_id, body.data.payment_id, 'Both txs share payment_id');
        assertEqual(principalTx.payment_id, body.data.payment_id, 'Both txs share payment_id');

        mixedPaymentId = body.data.payment_id;

        // Verify account balance: Outstanding should be ₹1,500, Original ₹2,000
        const { body: checkAcc } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(checkAcc.data.principal, 200000, 'Original principal remains ₹2,000');
        assertEqual(checkAcc.data.outstanding_principal, 150000, 'Outstanding principal reduced to ₹1,500');
        assertEqual(checkAcc.data.status, 'PARTIALLY_PAID', 'Status updated to PARTIALLY_PAID');
    });

    // Test 2: Interest-Only Payment (Total ₹300 = ₹300 Interest + ₹0 Principal)
    await testAsync('2. Interest Only: Allocate ₹300 (₹300 Interest, ₹0 Principal) on Acc #001', async () => {
        const { status, body } = await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 300,
            interest_amount: 300,
            principal_amount: 0,
            payment_method: 'CASH',
            payment_date: '02/09/2026'
        });

        assertEqual(status, 201, 'HTTP 201 Created');
        assertEqual(body.data.transactions.length, 1, 'Only 1 transaction created (no zero tx)');
        assertEqual(body.data.transactions[0].transaction_type, 'INTEREST_RECEIVED', 'Type is INTEREST_RECEIVED');

        // Verify account balance unchanged
        const { body: checkAcc } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(checkAcc.data.outstanding_principal, 150000, 'Outstanding principal remains ₹1,500 after interest-only payment');
    });

    // Test 3: Principal-Only Payment (Total ₹500 = ₹0 Interest + ₹500 Principal)
    await testAsync('3. Principal Only: Allocate ₹500 (₹0 Interest, ₹500 Principal) on Acc #001', async () => {
        const { status, body } = await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 500,
            interest_amount: 0,
            principal_amount: 500,
            payment_method: 'BANK_TRANSFER',
            payment_date: '03/09/2026'
        });

        assertEqual(status, 201, 'HTTP 201 Created');
        assertEqual(body.data.transactions.length, 1, 'Only 1 transaction created (no zero tx)');
        assertEqual(body.data.transactions[0].transaction_type, 'PRINCIPAL_RECEIVED', 'Type is PRINCIPAL_RECEIVED');

        // Verify account balance reduced to ₹1,000
        const { body: checkAcc } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(checkAcc.data.outstanding_principal, 100000, 'Outstanding principal reduced to ₹1,000');
    });

    // Test 4: Invalid Allocation (Under-allocated: ₹300 + ₹400 != ₹800)
    await testAsync('4. Under-allocation: Total ₹800 with ₹300 + ₹400 is rejected with 400', async () => {
        const { status, body } = await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 800,
            interest_amount: 300,
            principal_amount: 400,
            payment_method: 'CASH',
            payment_date: '04/09/2026'
        });

        assertEqual(status, 400, 'HTTP 400 Bad Request');
        assert(body.error.includes('Allocation mismatch'), 'Error message mentions allocation mismatch');

        // Check account untouched
        const { body: checkAcc } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(checkAcc.data.outstanding_principal, 100000, 'Balance unchanged');
    });

    // Test 5: Over-allocated (₹500 + ₹500 != ₹800)
    await testAsync('5. Over-allocation: Total ₹800 with ₹500 + ₹500 is rejected with 400', async () => {
        const { status, body } = await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 800,
            interest_amount: 500,
            principal_amount: 500,
            payment_method: 'CASH',
            payment_date: '04/09/2026'
        });

        assertEqual(status, 400, 'HTTP 400 Bad Request');
        assert(body.error.includes('Allocation mismatch'), 'Error message');
    });

    // Test 6: Principal Overpayment Rejection & Full Payment
    await testAsync('6. Principal Limit: Principal ₹1,001 on ₹1,000 outstanding rejected; Principal ₹1,000 accepted (Outstanding -> ₹0, CLOSED)', async () => {
        // Attempt overpayment
        const { status: sOver } = await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 1501,
            interest_amount: 500,
            principal_amount: 1001,
            payment_method: 'UPI',
            payment_date: '05/09/2026'
        });
        assertEqual(sOver, 400, 'Principal overpayment rejected with 400');

        // Full repayment: ₹500 Interest + ₹1,000 Principal = ₹1,500 Total
        const { status: sFull, body: bFull } = await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 1500,
            interest_amount: 500,
            principal_amount: 1000,
            payment_method: 'UPI',
            payment_date: '05/09/2026'
        });
        assertEqual(sFull, 201, 'Full repayment succeeded');

        const { body: checkAcc } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(checkAcc.data.principal, 200000, 'Original principal remains ₹2,000');
        assertEqual(checkAcc.data.outstanding_principal, 0, 'Outstanding principal is exactly ₹0');
        assertEqual(checkAcc.data.status, 'CLOSED', 'Status updated to CLOSED upon full payoff');
    });

    // Test 7: Account Isolation
    await testAsync('7. Account Isolation: Payments on Acc #001 did NOT affect Acc #002 or Acc #003', async () => {
        const { body: checkAcc2 } = await apiGet(`/accounts/${acc2.id}`);
        const { body: checkAcc3 } = await apiGet(`/accounts/${acc3.id}`);

        assertEqual(checkAcc2.data.outstanding_principal, acc2.principal, 'Acc #002 untouched');
        assertEqual(checkAcc3.data.outstanding_principal, acc3.principal, 'Acc #003 untouched');
    });

    // Test 8: MONEY_TAKEN Account Rejection
    await testAsync('8. Direction Guard: Reject payment allocation on MONEY_TAKEN account (Mahesh)', async () => {
        const { status, body } = await apiPost('/payments/allocate', {
            account_id: maheshAcc.id,
            total_amount: 1000,
            interest_amount: 200,
            principal_amount: 800,
            payment_method: 'CASH',
            payment_date: '01/09/2026'
        });

        assertEqual(status, 400, 'HTTP 400 Bad Request');
        assert(body.error.includes('MONEY_GIVEN'), 'Error mentions MONEY_GIVEN requirement');
    });

    // Test 9: All Payment Methods (CASH, UPI, BANK_TRANSFER, OTHER)
    await testAsync('9. Payment Methods: Test all payment methods for allocation', async () => {
        for (const method of ['CASH', 'UPI', 'BANK_TRANSFER', 'OTHER']) {
            const { status, body } = await apiPost('/payments/allocate', {
                account_id: acc2.id,
                total_amount: 200,
                interest_amount: 50,
                principal_amount: 150,
                payment_method: method,
                payment_date: '06/09/2026'
            });
            assertEqual(status, 201, `Status for ${method}`);
            assert(body.data.transactions.every(t => t.payment_method === method), `Stored method is ${method}`);
        }
    });

    // Test 10: Duplicate Protection via Idempotency Key
    await testAsync('10. Duplicate Protection: Submitting identical allocation with idempotency key does not duplicate txs or deductions', async () => {
        const { body: beforeAcc } = await apiGet(`/accounts/${acc3.id}`);
        const startingOutstanding = beforeAcc.data.outstanding_principal;

        const key = 'idem-alloc-key-' + Date.now();
        const payload = {
            account_id: acc3.id,
            total_amount: 1000,
            interest_amount: 400,
            principal_amount: 600,
            payment_method: 'UPI',
            payment_date: '07/09/2026'
        };

        const res1 = await apiPost('/payments/allocate', payload, { 'Idempotency-Key': key });
        assertEqual(res1.status, 201, 'First post created');

        const res2 = await apiPost('/payments/allocate', payload, { 'Idempotency-Key': key });
        assertEqual(res2.body.data.payment_id, res1.body.data.payment_id, 'Duplicate returns identical payment_id');

        // Verify principal was only deducted once (₹600, not ₹1,200)
        const { body: afterAcc } = await apiGet(`/accounts/${acc3.id}`);
        assertEqual(afterAcc.data.outstanding_principal, startingOutstanding - 60000, 'Principal was deducted exactly once (600 INR)');
    });

    // Test 11: Transaction Persistence & Query by payment_id
    await testAsync('11. Persistence: Verify transactions stored with payment_id in database', async () => {
        const { status, body } = await apiGet(`/transactions?account_id=${acc1.id}`);
        assertEqual(status, 200, 'HTTP 200');

        const mixedTxs = body.data.filter(t => t.payment_id === mixedPaymentId);
        assertEqual(mixedTxs.length, 2, '2 transactions found for mixedPaymentId');
        assert(mixedTxs.some(t => t.transaction_type === 'INTEREST_RECEIVED'), 'Interest tx found');
        assert(mixedTxs.some(t => t.transaction_type === 'PRINCIPAL_RECEIVED'), 'Principal tx found');
    });

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
