/**
 * Interest Manager — Step 4F Test Suite
 * Transaction / Ledger Screen & Query API Verification
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
    console.log('\n=== Interest Manager — Step 4F Transaction Ledger Test Suite ===\n');

    // Fetch Ramesh & Mahesh
    const { body: peopleRes } = await apiGet('/people');
    const ramesh = peopleRes.data.find(p => p.name === 'Ramesh');
    const mahesh = peopleRes.data.find(p => p.name === 'Mahesh');
    assert(ramesh && mahesh, 'Ramesh & Mahesh exist in database');

    const { body: rameshAccs } = await apiGet(`/accounts?person_id=${ramesh.id}`);
    const { body: maheshAccs } = await apiGet(`/accounts?person_id=${mahesh.id}`);

    const givenAccs = rameshAccs.data.filter(a => a.direction === 'MONEY_GIVEN');
    assert(givenAccs.length >= 3, 'Ramesh has 3 MONEY_GIVEN accounts');

    const acc1 = givenAccs[0];
    const acc2 = givenAccs[1];
    const maheshAcc = maheshAccs.data.find(a => a.direction === 'MONEY_TAKEN');

    // Seed test transactions
    // 1. Money Lent on Ramesh Acc #001
    await apiPost('/transactions', {
        account_id: acc1.id,
        transaction_type: 'MONEY_LENT',
        amount: 2000,
        payment_method: 'CASH',
        transaction_date: '01/08/2026',
        reference: 'INIT-LEND-001'
    });

    // 2. Interest Received on Ramesh Acc #001
    await apiPost('/transactions', {
        account_id: acc1.id,
        transaction_type: 'INTEREST_RECEIVED',
        amount: 300,
        payment_method: 'UPI',
        transaction_date: '01/09/2026',
        reference: 'UPI/INT-300'
    });

    // 3. Principal Received on Ramesh Acc #001
    await apiPost('/transactions', {
        account_id: acc1.id,
        transaction_type: 'PRINCIPAL_RECEIVED',
        amount: 500,
        payment_method: 'CASH',
        transaction_date: '01/09/2026',
        reference: 'CASH/PRIN-500'
    });

    // 4. Money Received on Mahesh Acc
    await apiPost('/transactions', {
        account_id: maheshAcc.id,
        transaction_type: 'MONEY_RECEIVED',
        amount: 100000,
        payment_method: 'BANK_TRANSFER',
        transaction_date: '15/08/2026',
        reference: 'NEFT/MAHESH-1L'
    });

    // 5. Mixed Payment on Ramesh Acc #002 (₹300 Interest + ₹500 Principal = ₹800)
    let mixedPaymentId = null;
    const { body: allocRes } = await apiPost('/payments/allocate', {
        account_id: acc2.id,
        total_amount: 800,
        interest_amount: 300,
        principal_amount: 500,
        payment_method: 'UPI',
        payment_date: '02/09/2026',
        reference: 'UPI/ALLOC-RAMESH2'
    });
    mixedPaymentId = allocRes.data.payment_id;

    // Test 1: Fetch all transactions
    await testAsync('1. Full Ledger: GET /api/transactions returns real DB records with person and account info', async () => {
        const { status, body } = await apiGet('/transactions');
        assertEqual(status, 200, 'HTTP 200');
        assert(Array.isArray(body.data), 'Returns array');
        assert(body.data.length >= 5, 'Contains at least 5 seeded transactions');

        const first = body.data[0];
        assert(first.person_name, 'Includes person_name');
        assert(first.transaction_type, 'Includes transaction_type');
        assert(first.amount > 0, 'Amount > 0');
    });

    // Test 2: Filter by Person (Ramesh)
    await testAsync('2. Person Filter: Filter by Ramesh returns only Ramesh transactions', async () => {
        const { status, body } = await apiGet(`/transactions?person_id=${ramesh.id}`);
        assertEqual(status, 200, 'HTTP 200');
        assert(body.data.length >= 4, 'Has Ramesh transactions');
        assert(body.data.every(t => t.person_id === ramesh.id), 'All transactions belong to Ramesh');
    });

    // Test 3: Filter by Account (Account #001)
    await testAsync('3. Account Filter: Filter by Account #001 returns only Acc #001 transactions', async () => {
        const { status, body } = await apiGet(`/transactions?account_id=${acc1.id}`);
        assertEqual(status, 200, 'HTTP 200');
        assert(body.data.every(t => t.account_id === acc1.id), 'All transactions belong to Acc #001');
    });

    // Test 4: Filter by Transaction Type (INTEREST_RECEIVED)
    await testAsync('4. Type Filter: Filter by INTEREST_RECEIVED returns only interest payments', async () => {
        const { status, body } = await apiGet('/transactions?transaction_type=INTEREST_RECEIVED');
        assertEqual(status, 200, 'HTTP 200');
        assert(body.data.length >= 2, 'Has interest received transactions');
        assert(body.data.every(t => t.transaction_type === 'INTEREST_RECEIVED'), 'Only INTEREST_RECEIVED returned');
    });

    // Test 5: Filter by Transaction Type (PRINCIPAL_RECEIVED)
    await testAsync('5. Type Filter: Filter by PRINCIPAL_RECEIVED returns only principal payments', async () => {
        const { status, body } = await apiGet('/transactions?transaction_type=PRINCIPAL_RECEIVED');
        assertEqual(status, 200, 'HTTP 200');
        assert(body.data.length >= 2, 'Has principal received transactions');
        assert(body.data.every(t => t.transaction_type === 'PRINCIPAL_RECEIVED'), 'Only PRINCIPAL_RECEIVED returned');
    });

    // Test 6: Filter by Payment Method (UPI)
    await testAsync('6. Method Filter: Filter by UPI returns only UPI transactions', async () => {
        const { status, body } = await apiGet('/transactions?payment_method=UPI');
        assertEqual(status, 200, 'HTTP 200');
        assert(body.data.length >= 2, 'Has UPI transactions');
        assert(body.data.every(t => t.payment_method === 'UPI'), 'Only UPI returned');
    });

    // Test 7: Date Range Filter
    await testAsync('7. Date Filter: Filter by date range isolates transactions within window', async () => {
        const { status, body } = await apiGet('/transactions?start_date=2026-09-01&end_date=2026-09-03');
        assertEqual(status, 200, 'HTTP 200');
        assert(body.data.every(t => t.transaction_date >= '2026-09-01' && t.transaction_date <= '2026-09-03'), 'Transactions inside date range');
    });

    // Test 8: Search by Person name and Reference
    await testAsync('8. Search: Search by name (Ramesh) and Reference (MAHESH-1L)', async () => {
        const { body: resRamesh } = await apiGet('/transactions?search=Ramesh');
        assert(resRamesh.data.every(t => t.person_name === 'Ramesh'), 'Search Ramesh matched');

        const { body: resRef } = await apiGet('/transactions?search=MAHESH-1L');
        assertEqual(resRef.data.length, 1, 'Search reference matched exactly 1');
        assertEqual(resRef.data[0].amount, 10000000, 'Amount is ₹1,00,000');
    });

    // Test 9: Sorting (amount_desc, amount_asc, oldest, newest)
    await testAsync('9. Sorting: Verify sorting by amount_desc, amount_asc, and date', async () => {
        const { body: resDesc } = await apiGet('/transactions?sort=amount_desc');
        assertEqual(resDesc.data[0].amount, 10000000, 'Largest transaction (₹1,00,000) is first in amount_desc');

        const { body: resAsc } = await apiGet('/transactions?sort=amount_asc');
        assert(resAsc.data[0].amount <= resAsc.data[resAsc.data.length - 1].amount, 'Ascending order confirmed');
    });

    // Test 10: Mixed Payment Group Traceability
    await testAsync('10. Traceability: Mixed payment creates 2 separate transactions with same payment_id', async () => {
        const { status, body } = await apiGet(`/transactions?payment_id=${mixedPaymentId}`);
        assertEqual(status, 200, 'HTTP 200');
        assertEqual(body.data.length, 2, '2 transactions found for mixed payment event');

        const intTx = body.data.find(t => t.transaction_type === 'INTEREST_RECEIVED');
        const prinTx = body.data.find(t => t.transaction_type === 'PRINCIPAL_RECEIVED');
        assert(intTx && prinTx, 'Both interest (₹300) and principal (₹500) exist separately');
        assertEqual(intTx.amount, 30000, 'Interest ₹300');
        assertEqual(prinTx.amount, 50000, 'Principal ₹500');
    });

    // Test 11: Account Isolation
    await testAsync('11. Account Isolation: Filtering Acc #001 does not include Acc #002 or Mahesh transactions', async () => {
        const { body: b1 } = await apiGet(`/transactions?account_id=${acc1.id}`);
        const { body: b2 } = await apiGet(`/transactions?account_id=${acc2.id}`);

        assert(b1.data.every(t => t.account_id === acc1.id), 'Only Acc #001 in b1');
        assert(b2.data.every(t => t.account_id === acc2.id), 'Only Acc #002 in b2');
    });

    // Test 12: Single Transaction Detail Endpoint
    await testAsync('12. Transaction Detail: GET /api/transactions/:id returns full metadata', async () => {
        const { body: all } = await apiGet('/transactions');
        const txId = all.data[0].id;

        const { status, body } = await apiGet(`/transactions/${txId}`);
        assertEqual(status, 200, 'HTTP 200');
        assertEqual(body.data.id, txId, 'Same ID returned');
        assert(body.data.person_name, 'Person name returned');
        assert(body.data.transaction_date, 'Transaction date returned');
    });

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
