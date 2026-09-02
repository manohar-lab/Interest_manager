/**
 * Interest Manager — Step 4C Test Suite
 * Record Interest Payment (INTEREST_RECEIVED) Verification
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
    console.log('\n=== Interest Manager — Step 4C Record Interest Payment Test Suite ===\n');

    // Fetch Ramesh & Mahesh
    const { body: peopleRes } = await apiGet('/people');
    const ramesh = peopleRes.data.find(p => p.name === 'Ramesh');
    const mahesh = peopleRes.data.find(p => p.name === 'Mahesh');
    assert(ramesh && mahesh, 'Ramesh and Mahesh exist');

    const { body: rameshAccs } = await apiGet(`/accounts?person_id=${ramesh.id}`);
    const { body: maheshAccs } = await apiGet(`/accounts?person_id=${mahesh.id}`);

    const acc1 = rameshAccs.data[0]; // MONEY_GIVEN (2000 INR principal)
    const acc2 = rameshAccs.data[1]; // MONEY_GIVEN (2000 INR principal)
    const maheshAcc = maheshAccs.data[0]; // MONEY_TAKEN

    let createdTx1 = null;

    // Test 1: Basic Interest Payment
    await testAsync('1. Record INTEREST_RECEIVED for Ramesh Account #001 (₹300, CASH, 2026-09-01)', async () => {
        const { status, body } = await apiPost('/transactions', {
            account_id: acc1.id,
            transaction_type: 'INTEREST_RECEIVED',
            amount: 300,
            payment_method: 'CASH',
            transaction_date: '01/09/2026',
            notes: 'Monthly interest payment for Aug 2026'
        });

        assertEqual(status, 201, 'HTTP 201 Created');
        assertEqual(body.data.account_id, acc1.id, 'account_id');
        assertEqual(body.data.person_id, ramesh.id, 'person_id');
        assertEqual(body.data.transaction_type, 'INTEREST_RECEIVED', 'type');
        assertEqual(body.data.amount, 30000, 'amount in paisa (300 INR = 30000 paisa)');
        createdTx1 = body.data;
    });

    // Test 2: Principal Must NOT Change
    await testAsync('2. Critical Rule: Outstanding principal remains strictly unchanged after interest payment', async () => {
        const { body: accCheck } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(accCheck.data.outstanding_principal, acc1.outstanding_principal, 'Outstanding principal remains ₹2,000');
    });

    // Test 3: Record Interest Payment for Different Account (Acc #002)
    await testAsync('3. Record INTEREST_RECEIVED for Account #002 (Acc #001 remains isolated)', async () => {
        const { status, body } = await apiPost('/transactions', {
            account_id: acc2.id,
            transaction_type: 'INTEREST_RECEIVED',
            amount: 300,
            payment_method: 'UPI',
            transaction_date: '01/09/2026',
            reference: 'UPI/7766554433'
        });

        assertEqual(status, 201, 'HTTP 201 Created');
        assertEqual(body.data.account_id, acc2.id, 'Belongs to Acc 2');

        const { body: txs1 } = await apiGet(`/transactions?account_id=${acc1.id}`);
        assert(!txs1.data.some(t => t.id === body.data.id), 'New tx does not appear under Acc 1');
    });

    // Test 4: Reject INTEREST_RECEIVED on MONEY_TAKEN Account
    await testAsync('4. Reject INTEREST_RECEIVED against MONEY_TAKEN account (Mahesh)', async () => {
        const { status, body } = await apiPost('/transactions', {
            account_id: maheshAcc.id,
            transaction_type: 'INTEREST_RECEIVED',
            amount: 1000,
            payment_method: 'CASH',
            transaction_date: '01/09/2026'
        });

        assertEqual(status, 400, 'Rejected with 400 Bad Request');
        assert(body.error.includes('INTEREST_RECEIVED is only allowed'), 'Direction error message');
    });

    // Test 5: Test Payment Methods (Cash, UPI, Bank Transfer, Other)
    await testAsync('5. Test all payment methods for interest payment', async () => {
        for (const method of ['CASH', 'UPI', 'BANK_TRANSFER', 'OTHER']) {
            const { status, body } = await apiPost('/transactions', {
                account_id: acc1.id,
                transaction_type: 'INTEREST_RECEIVED',
                amount: 150,
                payment_method: method,
                transaction_date: '2026-09-02'
            });
            assertEqual(status, 201, `Status 201 for ${method}`);
            assertEqual(body.data.payment_method, method, `Stored method ${method}`);
        }
    });

    // Test 6: Invalid Amount (₹0, negative)
    await testAsync('6. Invalid amounts (₹0 and negative) rejected with 400', async () => {
        const { status: s0 } = await apiPost('/transactions', {
            account_id: acc1.id, transaction_type: 'INTEREST_RECEIVED', amount: 0,
            payment_method: 'CASH', transaction_date: '2026-09-01'
        });
        assertEqual(s0, 400, 'Amount ₹0 rejected');

        const { status: sNeg } = await apiPost('/transactions', {
            account_id: acc1.id, transaction_type: 'INTEREST_RECEIVED', amount: -100,
            payment_method: 'CASH', transaction_date: '2026-09-01'
        });
        assertEqual(sNeg, 400, 'Negative amount rejected');
    });

    // Test 7: Duplicate Submission Protection
    await testAsync('7. Duplicate submission protection via Idempotency Key', async () => {
        const key = 'idem-4c-key-' + Date.now();
        const payload = {
            account_id: acc1.id,
            transaction_type: 'INTEREST_RECEIVED',
            amount: 300,
            payment_method: 'CASH',
            transaction_date: '2026-09-05'
        };

        const res1 = await apiPost('/transactions', payload, { 'Idempotency-Key': key });
        assertEqual(res1.status, 201, 'First submission creates tx');

        const res2 = await apiPost('/transactions', payload, { 'Idempotency-Key': key });
        assertEqual(res2.body.data.id, res1.body.data.id, 'Duplicate returns identical tx ID');
    });

    // Test 8: Data Persistence Verification
    await testAsync('8. Re-fetch transaction list to verify database persistence', async () => {
        const { status, body } = await apiGet(`/transactions?account_id=${acc1.id}`);
        assertEqual(status, 200, 'HTTP 200');
        assert(body.data.some(t => t.id === createdTx1.id), 'Transaction persists in database');
    });

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
