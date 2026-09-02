/**
 * Interest Manager — Step 4B Test Suite
 * Record Money Lent / Money Taken (Initial Funding Transactions)
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
    console.log('\n=== Interest Manager — Step 4B Money Lent / Money Taken Test Suite ===\n');

    // Fetch Ramesh & Mahesh
    const { body: peopleRes } = await apiGet('/people');
    const ramesh = peopleRes.data.find(p => p.name === 'Ramesh');
    const mahesh = peopleRes.data.find(p => p.name === 'Mahesh');
    assert(ramesh && mahesh, 'Ramesh and Mahesh exist');

    const { body: rameshAccs } = await apiGet(`/accounts?person_id=${ramesh.id}`);
    const { body: maheshAccs } = await apiGet(`/accounts?person_id=${mahesh.id}`);

    const givenAccs = rameshAccs.data.filter(a => a.direction === 'MONEY_GIVEN');
    assert(givenAccs.length >= 3, 'Ramesh has 3 MONEY_GIVEN accounts');

    const acc1 = givenAccs[0]; // MONEY_GIVEN
    const acc2 = givenAccs[1]; // MONEY_GIVEN
    const acc3 = givenAccs[2]; // MONEY_GIVEN
    const maheshAcc = maheshAccs.data.find(a => a.direction === 'MONEY_TAKEN') || maheshAccs.data[0]; // MONEY_TAKEN

    // Test 1: Record MONEY_LENT for Ramesh Account #001
    await testAsync(`1. Record MONEY_LENT for Ramesh Account #${acc1.id} (₹${acc1.principal / 100}, CASH, 2026-08-01)`, async () => {
        const { status, body } = await apiPost('/transactions', {
            account_id: acc1.id,
            transaction_type: 'MONEY_LENT',
            amount: acc1.principal / 100,
            payment_method: 'CASH',
            transaction_date: '01/08/2026',
            notes: 'Initial funding for Acc 1'
        });

        assertEqual(status, 201, 'HTTP 201 Created');
        assertEqual(body.data.account_id, acc1.id, 'account_id');
        assertEqual(body.data.person_id, ramesh.id, 'person_id');
        assertEqual(body.data.transaction_type, 'MONEY_LENT', 'type');
        assertEqual(body.data.amount, 200000, 'amount in paisa');
    });

    // Test 2: Record MONEY_RECEIVED for Mahesh Account #004
    await testAsync('2. Record MONEY_RECEIVED for Mahesh Account #004 (₹1,00,000, BANK_TRANSFER, 2026-08-01)', async () => {
        const { status, body } = await apiPost('/transactions', {
            account_id: maheshAcc.id,
            transaction_type: 'MONEY_RECEIVED',
            amount: 100000,
            payment_method: 'BANK_TRANSFER',
            transaction_date: '01/08/2026',
            reference: 'HDFC/UTRN123456'
        });

        assertEqual(status, 201, 'HTTP 201 Created');
        assertEqual(body.data.account_id, maheshAcc.id, 'account_id');
        assertEqual(body.data.person_id, mahesh.id, 'person_id');
        assertEqual(body.data.transaction_type, 'MONEY_RECEIVED', 'type');
        assertEqual(body.data.amount, 10000000, 'amount in paisa (100000 INR = 10000000 paisa)');
    });

    // Test 3: Test all payment methods (CASH, UPI, BANK_TRANSFER, OTHER)
    await testAsync('3. Test all payment methods (CASH, UPI, BANK_TRANSFER, OTHER)', async () => {
        for (const method of ['CASH', 'UPI', 'BANK_TRANSFER', 'OTHER']) {
            const { status, body } = await apiPost('/transactions', {
                account_id: acc2.id,
                transaction_type: 'MONEY_LENT',
                amount: 100,
                payment_method: method,
                transaction_date: '2026-09-01'
            });
            assertEqual(status, 201, `Status for ${method}`);
            assertEqual(body.data.payment_method, method, `Stored payment method ${method}`);
        }
    });

    // Test 4: Invalid amount validations (0, negative, > principal)
    await testAsync('4. Amount validations (0, negative, > original principal rejected)', async () => {
        // Zero
        const { status: s0 } = await apiPost('/transactions', {
            account_id: acc1.id, transaction_type: 'MONEY_LENT', amount: 0,
            payment_method: 'CASH', transaction_date: '2026-08-01'
        });
        assertEqual(s0, 400, 'Amount 0 rejected');

        // Negative
        const { status: sNeg } = await apiPost('/transactions', {
            account_id: acc1.id, transaction_type: 'MONEY_LENT', amount: -500,
            payment_method: 'CASH', transaction_date: '2026-08-01'
        });
        assertEqual(sNeg, 400, 'Negative amount rejected');

        // Exceeding principal (principal is 2000 INR, try 5000 INR)
        const { status: sExceed } = await apiPost('/transactions', {
            account_id: acc1.id, transaction_type: 'MONEY_LENT', amount: 5000,
            payment_method: 'CASH', transaction_date: '2026-08-01'
        });
        assertEqual(sExceed, 400, 'Amount exceeding principal rejected');
    });

    // Test 5: Direction mismatch validation
    await testAsync('5. Direction mismatch rejection (MONEY_GIVEN + MONEY_RECEIVED / MONEY_TAKEN + MONEY_LENT)', async () => {
        // Acc 1 is MONEY_GIVEN -> Try MONEY_RECEIVED -> Must fail
        const { status: s1, body: b1 } = await apiPost('/transactions', {
            account_id: acc1.id,
            transaction_type: 'MONEY_RECEIVED',
            amount: 1000,
            payment_method: 'CASH',
            transaction_date: '2026-08-01'
        });
        assertEqual(s1, 400, 'MONEY_GIVEN + MONEY_RECEIVED rejected');
        assert(b1.error.includes('MONEY_RECEIVED is only allowed'), 'Error message for MONEY_RECEIVED on MONEY_GIVEN');

        // Mahesh Acc is MONEY_TAKEN -> Try MONEY_LENT -> Must fail
        const { status: s2, body: b2 } = await apiPost('/transactions', {
            account_id: maheshAcc.id,
            transaction_type: 'MONEY_LENT',
            amount: 1000,
            payment_method: 'CASH',
            transaction_date: '2026-08-01'
        });
        assertEqual(s2, 400, 'MONEY_TAKEN + MONEY_LENT rejected');
        assert(b2.error.includes('MONEY_LENT is only allowed'), 'Error message for MONEY_LENT on MONEY_TAKEN');
    });

    // Test 6: Duplicate submission protection
    await testAsync('6. Idempotent duplicate submission protection', async () => {
        const key = 'idem-4b-key-' + Date.now();
        const payload = {
            account_id: acc3.id,
            transaction_type: 'MONEY_LENT',
            amount: 5000,
            payment_method: 'UPI',
            transaction_date: '2026-09-10'
        };

        const res1 = await apiPost('/transactions', payload, { 'Idempotency-Key': key });
        assertEqual(res1.status, 201, 'First post created');

        const res2 = await apiPost('/transactions', payload, { 'Idempotency-Key': key });
        assertEqual(res2.body.data.id, res1.body.data.id, 'Duplicate returns same tx ID');
    });

    // Test 7: Account Independence
    await testAsync('7. Account Independence: Tx on Acc #001 does not create tx for Acc #002 or #003', async () => {
        const { body: txs1 } = await apiGet(`/transactions?account_id=${acc1.id}`);
        const { body: txs3 } = await apiGet(`/transactions?account_id=${acc3.id}`);

        assert(txs1.data.every(t => t.account_id === acc1.id), 'All txs in list 1 belong to Acc 1');
        assert(txs3.data.every(t => t.account_id === acc3.id), 'All txs in list 3 belong to Acc 3');
    });

    // Test 8: Balance isolation
    await testAsync('8. Balance Isolation: Recording funding tx does NOT modify outstanding principal yet', async () => {
        const { body: accCheck } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(accCheck.data.outstanding_principal, acc1.outstanding_principal, 'Outstanding principal untouched');
    });

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
