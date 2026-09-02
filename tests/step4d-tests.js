/**
 * Interest Manager — Step 4D Test Suite
 * Record Principal Payment (PRINCIPAL_RECEIVED) & Outstanding Principal Reduction Verification
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
    console.log('\n=== Interest Manager — Step 4D Record Principal Payment Test Suite ===\n');

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

    let tx1Id = null;
    let tx2Id = null;

    // Test 1: Partial Principal Payment (₹500 on ₹2,000)
    await testAsync('1. Partial Payment: Pay ₹500 principal against Acc #001 (₹2,000 -> ₹1,500)', async () => {
        const { status, body } = await apiPost('/transactions', {
            account_id: acc1.id,
            transaction_type: 'PRINCIPAL_RECEIVED',
            amount: 500,
            payment_method: 'CASH',
            transaction_date: '01/09/2026',
            notes: 'First principal repayment'
        });

        assertEqual(status, 201, 'HTTP 201 Created');
        assertEqual(body.data.transaction_type, 'PRINCIPAL_RECEIVED', 'Tx type');
        assertEqual(body.data.amount, 50000, 'Amount 500 INR in paisa');
        tx1Id = body.data.id;

        // Check account outstanding principal
        const { body: updatedAcc } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(updatedAcc.data.principal, 200000, 'Original principal remains ₹2,000 (200000 paisa)');
        assertEqual(updatedAcc.data.outstanding_principal, 150000, 'Outstanding principal reduced to ₹1,500 (150000 paisa)');
        assertEqual(updatedAcc.data.status, 'PARTIALLY_PAID', 'Account status updated to PARTIALLY_PAID');
    });

    // Test 2: Second Partial Payment (Another ₹500 on ₹1,500)
    await testAsync('2. Second Payment: Pay another ₹500 principal against Acc #001 (₹1,500 -> ₹1,000)', async () => {
        const { status, body } = await apiPost('/transactions', {
            account_id: acc1.id,
            transaction_type: 'PRINCIPAL_RECEIVED',
            amount: 500,
            payment_method: 'UPI',
            transaction_date: '02/09/2026',
            reference: 'UPI/9876543210'
        });

        assertEqual(status, 201, 'HTTP 201 Created');
        tx2Id = body.data.id;
        assert(tx2Id !== tx1Id, 'Two separate transaction rows created');

        // Check account outstanding principal
        const { body: updatedAcc } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(updatedAcc.data.principal, 200000, 'Original principal remains ₹2,000');
        assertEqual(updatedAcc.data.outstanding_principal, 100000, 'Outstanding principal reduced to ₹1,000');
    });

    // Test 3: Overpayment Rejection (Attempt ₹1,001 on ₹1,000 outstanding)
    await testAsync('3. Overpayment Rejection: Attempting ₹1,001 on ₹1,000 outstanding is rejected', async () => {
        const { status, body } = await apiPost('/transactions', {
            account_id: acc1.id,
            transaction_type: 'PRINCIPAL_RECEIVED',
            amount: 1001,
            payment_method: 'CASH',
            transaction_date: '03/09/2026'
        });

        assertEqual(status, 400, 'HTTP 400 Bad Request');
        assert(body.error.includes('cannot exceed current outstanding principal'), 'Error message contains overpayment notice');

        // Verify account balance was unchanged
        const { body: checkAcc } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(checkAcc.data.outstanding_principal, 100000, 'Outstanding principal remains ₹1,000');
    });

    // Test 4: Full Principal Payment (Pay remaining ₹1,000)
    await testAsync('4. Full Payment: Pay remaining ₹1,000 (Outstanding -> ₹0, Status -> CLOSED)', async () => {
        const { status, body } = await apiPost('/transactions', {
            account_id: acc1.id,
            transaction_type: 'PRINCIPAL_RECEIVED',
            amount: 1000,
            payment_method: 'BANK_TRANSFER',
            transaction_date: '03/09/2026',
            reference: 'HDFC/NEFT123'
        });

        assertEqual(status, 201, 'HTTP 201 Created');

        // Check account outstanding principal & status
        const { body: updatedAcc } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(updatedAcc.data.principal, 200000, 'Original principal remains ₹2,000');
        assertEqual(updatedAcc.data.outstanding_principal, 0, 'Outstanding principal is exactly ₹0');
        assertEqual(updatedAcc.data.status, 'CLOSED', 'Status updated to CLOSED upon full principal repayment');
    });

    // Test 5: Rejection when outstanding is ₹0
    await testAsync('5. Zero Balance Rejection: Attempting principal payment when outstanding is ₹0 is rejected', async () => {
        const { status, body } = await apiPost('/transactions', {
            account_id: acc1.id,
            transaction_type: 'PRINCIPAL_RECEIVED',
            amount: 100,
            payment_method: 'CASH',
            transaction_date: '04/09/2026'
        });

        assertEqual(status, 400, 'HTTP 400 Bad Request');
    });

    // Test 6: Invalid Amount (₹0 and negative)
    await testAsync('6. Invalid Amounts: ₹0 and -₹100 rejected with 400', async () => {
        const { status: s0 } = await apiPost('/transactions', {
            account_id: acc2.id, transaction_type: 'PRINCIPAL_RECEIVED', amount: 0,
            payment_method: 'CASH', transaction_date: '01/09/2026'
        });
        assertEqual(s0, 400, 'Amount ₹0 rejected');

        const { status: sNeg } = await apiPost('/transactions', {
            account_id: acc2.id, transaction_type: 'PRINCIPAL_RECEIVED', amount: -100,
            payment_method: 'CASH', transaction_date: '01/09/2026'
        });
        assertEqual(sNeg, 400, 'Negative amount rejected');
    });

    // Test 7: Account Isolation
    await testAsync('7. Account Isolation: Payments on Acc #001 did NOT affect Acc #002 or Acc #003', async () => {
        const { body: checkAcc2 } = await apiGet(`/accounts/${acc2.id}`);
        const { body: checkAcc3 } = await apiGet(`/accounts/${acc3.id}`);

        assertEqual(checkAcc2.data.outstanding_principal, acc2.principal, 'Acc #002 outstanding untouched');
        assertEqual(checkAcc3.data.outstanding_principal, acc3.principal, 'Acc #003 outstanding untouched');
    });

    // Test 8: Interest Payment vs Principal Payment Separation
    await testAsync('8. Separation: INTEREST_RECEIVED (₹300) leaves principal untouched, then PRINCIPAL_RECEIVED (₹500) reduces it', async () => {
        // Record interest payment on Acc #002
        const { status: si } = await apiPost('/transactions', {
            account_id: acc2.id,
            transaction_type: 'INTEREST_RECEIVED',
            amount: 300,
            payment_method: 'CASH',
            transaction_date: '01/09/2026'
        });
        assertEqual(si, 201, 'Interest payment recorded');

        const { body: checkAcc2a } = await apiGet(`/accounts/${acc2.id}`);
        assertEqual(checkAcc2a.data.outstanding_principal, 200000, 'Outstanding principal remains ₹2,000 after interest payment');

        // Record principal payment on Acc #002
        const { status: sp } = await apiPost('/transactions', {
            account_id: acc2.id,
            transaction_type: 'PRINCIPAL_RECEIVED',
            amount: 500,
            payment_method: 'CASH',
            transaction_date: '02/09/2026'
        });
        assertEqual(sp, 201, 'Principal payment recorded');

        const { body: checkAcc2b } = await apiGet(`/accounts/${acc2.id}`);
        assertEqual(checkAcc2b.data.outstanding_principal, 150000, 'Outstanding principal reduced to ₹1,500 after principal payment');
    });

    // Test 9: Reject PRINCIPAL_RECEIVED on MONEY_TAKEN Account
    await testAsync('9. Direction Guard: Reject PRINCIPAL_RECEIVED against MONEY_TAKEN account (Mahesh)', async () => {
        const { status, body } = await apiPost('/transactions', {
            account_id: maheshAcc.id,
            transaction_type: 'PRINCIPAL_RECEIVED',
            amount: 1000,
            payment_method: 'CASH',
            transaction_date: '01/09/2026'
        });

        assertEqual(status, 400, 'HTTP 400 Bad Request');
        assert(body.error.includes('PRINCIPAL_RECEIVED is only allowed'), 'Error message');
    });

    // Test 10: Payment Methods (CASH, UPI, BANK_TRANSFER, OTHER)
    await testAsync('10. Payment Methods: Test all payment methods for principal repayments', async () => {
        for (const method of ['CASH', 'UPI', 'BANK_TRANSFER', 'OTHER']) {
            const { status, body } = await apiPost('/transactions', {
                account_id: acc3.id,
                transaction_type: 'PRINCIPAL_RECEIVED',
                amount: 100,
                payment_method: method,
                transaction_date: '05/09/2026'
            });
            assertEqual(status, 201, `Status for ${method}`);
            assertEqual(body.data.payment_method, method, `Stored method ${method}`);
        }
    });

    // Test 11: Duplicate Submission Protection
    await testAsync('11. Duplicate Protection: Submitting identical request with idempotency key does NOT double-deduct principal', async () => {
        const { body: beforeAcc } = await apiGet(`/accounts/${acc3.id}`);
        const startingOutstanding = beforeAcc.data.outstanding_principal;

        const key = 'idem-4d-key-' + Date.now();
        const payload = {
            account_id: acc3.id,
            transaction_type: 'PRINCIPAL_RECEIVED',
            amount: 500,
            payment_method: 'UPI',
            transaction_date: '06/09/2026'
        };

        const res1 = await apiPost('/transactions', payload, { 'Idempotency-Key': key });
        assertEqual(res1.status, 201, 'First post created');

        const res2 = await apiPost('/transactions', payload, { 'Idempotency-Key': key });
        assertEqual(res2.body.data.id, res1.body.data.id, 'Duplicate returns identical tx ID');

        // Verify principal was only deducted once (₹500, not ₹1,000)
        const { body: afterAcc } = await apiGet(`/accounts/${acc3.id}`);
        assertEqual(afterAcc.data.outstanding_principal, startingOutstanding - 50000, 'Principal was deducted exactly once (500 INR)');
    });

    // Test 12: Data Persistence
    await testAsync('12. Persistence: Re-fetch transaction list to verify database persistence', async () => {
        const { status, body } = await apiGet(`/transactions?account_id=${acc1.id}`);
        assertEqual(status, 200, 'HTTP 200');
        assert(body.data.some(t => t.id === tx1Id), 'Tx 1 persists');
        assert(body.data.some(t => t.id === tx2Id), 'Tx 2 persists');
    });

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
