/**
 * Interest Manager — Step 4A Test Suite
 * Transaction Foundation & Creation Service Verification
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
    console.log('\n=== Interest Manager — Step 4A Transaction Foundation Test Suite ===\n');

    // Fetch Ramesh & accounts
    const { body: peopleRes } = await apiGet('/people');
    const ramesh = peopleRes.data.find(p => p.name === 'Ramesh');
    assert(ramesh, 'Ramesh exists');

    const { body: rameshAccs } = await apiGet(`/accounts?person_id=${ramesh.id}`);
    assert(rameshAccs.data.length >= 1, 'Ramesh has accounts');
    const acc1 = rameshAccs.data.find(a => a.direction === 'MONEY_GIVEN') || rameshAccs.data[0];
    const initialOutstanding = acc1.outstanding_principal;
    const testAmountRupees = acc1.principal / 100;

    let createdTx1 = null;

    // Test 1: Create MONEY_LENT transaction for Ramesh Account #001
    await testAsync(`1. Create MONEY_LENT transaction (₹${testAmountRupees}, CASH, 2026-08-01)`, async () => {
        const { status, body } = await apiPost('/transactions', {
            account_id: acc1.id,
            transaction_type: 'MONEY_LENT',
            amount: testAmountRupees,
            payment_method: 'CASH',
            transaction_date: '01/08/2026',
            notes: 'Test transaction 1'
        });

        assertEqual(status, 201, 'HTTP 201 Created');
        assert(body.data.id, 'Transaction has ID');
        assertEqual(body.data.amount, 200000, 'Amount stored as paisa (2000 INR = 200000 paisa)');
        createdTx1 = body.data;
    });

    // Test 2: Verify account and person references
    await testAsync('2. Verify transaction references correct account_id and person_id', async () => {
        const { status, body } = await apiGet(`/transactions/${createdTx1.id}`);
        assertEqual(status, 200, 'HTTP status');
        assertEqual(body.data.account_id, acc1.id, 'account_id matches');
        assertEqual(body.data.person_id, ramesh.id, 'person_id matches');
        assertEqual(body.data.person_name, 'Ramesh', 'person_name resolves');
    });

    // Test 3: Reject ₹0 amount
    await testAsync('3. Reject transaction with amount = ₹0', async () => {
        const { status, body } = await apiPost('/transactions', {
            account_id: acc1.id,
            transaction_type: 'MONEY_RECEIVED',
            amount: 0,
            payment_method: 'CASH',
            transaction_date: '2026-08-02'
        });

        assertEqual(status, 400, 'Amount ₹0 rejected');
        assert(body.error.includes('greater than zero'), 'Error message');
    });

    // Test 4: Reject negative amount
    await testAsync('4. Reject transaction with negative amount', async () => {
        const { status, body } = await apiPost('/transactions', {
            account_id: acc1.id,
            transaction_type: 'MONEY_RECEIVED',
            amount: -500,
            payment_method: 'CASH',
            transaction_date: '2026-08-02'
        });

        assertEqual(status, 400, 'Negative amount rejected');
        assert(body.error.includes('greater than zero'), 'Error message');
    });

    // Test 5: Reject invalid transaction type
    await testAsync('5. Reject invalid transaction type', async () => {
        const { status, body } = await apiPost('/transactions', {
            account_id: acc1.id,
            transaction_type: 'INVALID_TYPE_XYZ',
            amount: 1000,
            payment_method: 'CASH',
            transaction_date: '2026-08-02'
        });

        assertEqual(status, 400, 'Invalid type rejected');
        assert(body.error.includes('type is invalid'), 'Error message');
    });

    // Test 6: Reject invalid payment method
    await testAsync('6. Reject invalid payment method', async () => {
        const { status, body } = await apiPost('/transactions', {
            account_id: acc1.id,
            transaction_type: 'MONEY_RECEIVED',
            amount: 1000,
            payment_method: 'BITCOIN',
            transaction_date: '2026-08-02'
        });

        assertEqual(status, 400, 'Invalid payment method rejected');
        assert(body.error.includes('method is invalid'), 'Error message');
    });

    // Test 7: Multiple legitimate transactions remain separate rows
    await testAsync('7. Create second legitimate transaction for same account', async () => {
        const { status, body } = await apiPost('/transactions', {
            account_id: acc1.id,
            transaction_type: 'INTEREST_RECEIVED',
            amount: 300,
            payment_method: 'UPI',
            transaction_date: '2026-09-01',
            reference: 'UPI/123456'
        });

        assertEqual(status, 201, 'HTTP 201');
        assert(body.data.id !== createdTx1.id, 'Distinct transaction ID');

        const { body: txList } = await apiGet(`/transactions?account_id=${acc1.id}`);
        assert(txList.data.length >= 2, 'Account has multiple transactions');
    });

    // Test 8: Duplicate submission protection
    await testAsync('8. Duplicate submission with Idempotency-Key returns existing transaction', async () => {
        const key = 'idem-test-key-999';
        const payload = {
            account_id: acc1.id,
            transaction_type: 'MONEY_RECEIVED',
            amount: 500,
            payment_method: 'BANK_TRANSFER',
            transaction_date: '2026-09-05'
        };

        const res1 = await apiPost('/transactions', payload, { 'Idempotency-Key': key });
        assertEqual(res1.status, 201, 'First request creates tx');

        const res2 = await apiPost('/transactions', payload, { 'Idempotency-Key': key });
        assertEqual(res2.body.data.id, res1.body.data.id, 'Second request returns identical tx ID');
        assert(res2.body.isDuplicate, 'Flagged as duplicate');
    });

    // Test 9: Important accounting rule — creating transaction does NOT alter account outstanding principal in Step 4A
    await testAsync('9. Accounting Rule: Creating transaction does NOT modify account outstanding principal yet', async () => {
        const { body: accCheck } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(accCheck.data.outstanding_principal, initialOutstanding, 'Outstanding principal remains completely unchanged');
    });

    // Test 10: Persistence verification after refresh/re-fetch
    await testAsync('10. Re-fetch transaction list to verify persistence', async () => {
        const { status, body } = await apiGet(`/transactions?account_id=${acc1.id}`);
        assertEqual(status, 200, 'HTTP 200');
        assert(body.data.some(t => t.id === createdTx1.id), 'Created transaction persists in DB');
    });

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
