/**
 * Interest Manager — Step 4G Test Suite
 * Transaction Integrity, Accounting Rules, Concurrency, and Final Verification
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
async function apiPut(url, data) {
    const r = await fetch(BASE + url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return { status: r.status, body: await r.json() };
}
async function apiDelete(url) {
    const r = await fetch(BASE + url, { method: 'DELETE' });
    return { status: r.status, body: await r.json() };
}
async function apiPatch(url, data) {
    const r = await fetch(BASE + url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return { status: r.status, body: await r.json() };
}

// Helper to create a valid test account with all required fields
async function createTestAccount(personId, principal, rate = 15) {
    const res = await apiPost('/accounts', {
        person_id: personId,
        principal: principal,
        interest_rate: rate,
        interest_frequency: 'MONTHLY',
        calculation_method: 'SIMPLE_INTEREST',
        direction: 'MONEY_GIVEN',
        start_date: '01/01/2026',
        due_date: '01/01/2027'
    });
    if (res.status !== 201) {
        throw new Error(`Account creation failed (${res.status}): ${res.body.error || JSON.stringify(res.body)}`);
    }
    return res.body.data;
}

async function runTests() {
    console.log('\n=== Interest Manager — Step 4G Transaction Integrity & Verification ===\n');

    // ─── Setup & Fetch Baseline Data ───
    const { body: peopleRes } = await apiGet('/people');
    const ramesh = peopleRes.data.find(p => p.name === 'Ramesh');
    const mahesh = peopleRes.data.find(p => p.name === 'Mahesh');
    assert(ramesh && mahesh, 'Ramesh and Mahesh exist in DB');

    const { body: rameshAccs } = await apiGet(`/accounts?person_id=${ramesh.id}`);
    const givenAccs = rameshAccs.data.filter(a => a.direction === 'MONEY_GIVEN');
    assert(givenAccs.length >= 3, 'Ramesh has at least 3 accounts (#001, #002, #003)');

    const acc1 = givenAccs[0];
    const acc2 = givenAccs[1];
    const acc3 = givenAccs[2];

    const { body: maheshAccs } = await apiGet(`/accounts?person_id=${mahesh.id}`);
    const maheshAcc = maheshAccs.data.find(a => a.direction === 'MONEY_TAKEN');
    assert(maheshAcc, 'Mahesh has MONEY_TAKEN account');

    // ─── 1. TRANSACTION IMMUTABILITY ───
    await testAsync('1. Immutability: PUT / PATCH / DELETE on transactions are rejected with HTTP 405', async () => {
        // Seed a transaction first so ID 1 exists
        await apiPost('/transactions', {
            account_id: acc1.id,
            transaction_type: 'MONEY_LENT',
            amount: 100,
            payment_method: 'CASH',
            transaction_date: '01/01/2026'
        });

        const putRes = await apiPut('/transactions/1', { amount: 9999 });
        assertEqual(putRes.status, 405, 'PUT /transactions/1 rejected with 405');

        const patchRes = await apiPatch('/transactions/1', { amount: 9999 });
        assertEqual(patchRes.status, 405, 'PATCH /transactions/1 rejected with 405');

        const delRes = await apiDelete('/transactions/1');
        assertEqual(delRes.status, 405, 'DELETE /transactions/1 rejected with 405');
    });

    // ─── 2. ACCOUNT ISOLATION ───
    await testAsync('2. Account Isolation: Operations on Acc #001 do not affect Acc #002 or #003', async () => {
        const { body: a2Before } = await apiGet(`/accounts/${acc2.id}`);
        const { body: a3Before } = await apiGet(`/accounts/${acc3.id}`);

        await apiPost('/transactions', {
            account_id: acc1.id,
            transaction_type: 'INTEREST_RECEIVED',
            amount: 150,
            payment_method: 'CASH',
            transaction_date: '05/09/2026'
        });

        const { body: a2After } = await apiGet(`/accounts/${acc2.id}`);
        const { body: a3After } = await apiGet(`/accounts/${acc3.id}`);

        assertEqual(a2After.data.outstanding_principal, a2Before.data.outstanding_principal, 'Acc #002 balance unchanged');
        assertEqual(a3After.data.outstanding_principal, a3Before.data.outstanding_principal, 'Acc #003 balance unchanged');
    });

    // ─── 3. PERSON RELATIONSHIP INTEGRITY ───
    await testAsync('3. Person Relationship: Transaction with mismatched person_id is rejected (HTTP 400)', async () => {
        const res = await apiPost('/transactions', {
            account_id: acc1.id,
            person_id: mahesh.id, // Mismatched — Acc #001 belongs to Ramesh
            transaction_type: 'INTEREST_RECEIVED',
            amount: 100,
            payment_method: 'CASH',
            transaction_date: '05/09/2026'
        });
        assertEqual(res.status, 400, 'HTTP 400 for mismatched person_id');
        assert(res.body.error.includes('does not match owner'), 'Error explains ownership mismatch');
    });

    // ─── 4. INTEREST VS PRINCIPAL ACCOUNTING SEPARATION ───
    await testAsync('4. Accounting Rule: Interest payment leaves outstanding unchanged; Principal reduces it', async () => {
        const testAcc = await createTestAccount(ramesh.id, 2000, 15);
        assertEqual(testAcc.outstanding_principal, 200000, 'Initial outstanding ₹2,000');

        // Interest payment of ₹300 — must NOT change outstanding
        await apiPost('/transactions', {
            account_id: testAcc.id,
            transaction_type: 'INTEREST_RECEIVED',
            amount: 300,
            payment_method: 'UPI',
            transaction_date: '01/02/2026'
        });

        const { body: afterInt } = await apiGet(`/accounts/${testAcc.id}`);
        assertEqual(afterInt.data.outstanding_principal, 200000, 'Outstanding remains ₹2,000 after interest payment');

        // Principal payment of ₹500 — must reduce outstanding
        await apiPost('/transactions', {
            account_id: testAcc.id,
            transaction_type: 'PRINCIPAL_RECEIVED',
            amount: 500,
            payment_method: 'CASH',
            transaction_date: '01/02/2026'
        });

        const { body: afterPrin } = await apiGet(`/accounts/${testAcc.id}`);
        assertEqual(afterPrin.data.outstanding_principal, 150000, 'Outstanding is ₹1,500 after principal payment');
        assertEqual(afterPrin.data.principal, 200000, 'Original principal preserved at ₹2,000');
    });

    // ─── 5 & 6. MIXED PAYMENT ALLOCATION & TOTAL EQUALITY ───
    await testAsync('5 & 6. Mixed Payment: ₹800 (₹300 int + ₹500 prin) reduces outstanding by exactly ₹500', async () => {
        const testAcc = await createTestAccount(ramesh.id, 2000, 15);

        // Mismatched allocation rejected
        const badAlloc = await apiPost('/payments/allocate', {
            account_id: testAcc.id,
            total_amount: 800,
            interest_amount: 300,
            principal_amount: 600, // 300 + 600 != 800
            payment_method: 'UPI',
            payment_date: '05/02/2026'
        });
        assertEqual(badAlloc.status, 400, 'Mismatched allocation rejected (HTTP 400)');

        // Valid allocation: ₹300 interest + ₹500 principal = ₹800
        const { status, body } = await apiPost('/payments/allocate', {
            account_id: testAcc.id,
            total_amount: 800,
            interest_amount: 300,
            principal_amount: 500,
            payment_method: 'UPI',
            payment_date: '05/02/2026'
        });
        assertEqual(status, 201, 'Allocation committed successfully');
        assertEqual(body.data.account.outstanding_principal, 150000, 'Outstanding reduced by ₹500 to ₹1,500');
        assertEqual(body.data.transactions.length, 2, '2 transaction rows created');
    });

    // ─── 7. ATOMICITY / ROLLBACK ───
    await testAsync('7. Atomicity: Failed operations leave no partial state', async () => {
        const { body: accBefore } = await apiGet(`/accounts/${acc1.id}`);

        const res = await apiPost('/payments/allocate', {
            account_id: acc1.id,
            total_amount: 500,
            interest_amount: 200,
            principal_amount: 300,
            payment_method: 'INVALID_METHOD', // Fails validation
            payment_date: '01/03/2026'
        });
        assertEqual(res.status, 400, 'Invalid request rejected');

        const { body: accAfter } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(accAfter.data.outstanding_principal, accBefore.data.outstanding_principal, 'Balance unchanged');
    });

    // ─── 8. OVERPAYMENT PROTECTION ───
    await testAsync('8. Overpayment Protection: ₹1,001 on ₹1,000 outstanding is rejected', async () => {
        const testAcc = await createTestAccount(ramesh.id, 1000, 12);

        const overpayRes = await apiPost('/transactions', {
            account_id: testAcc.id,
            transaction_type: 'PRINCIPAL_RECEIVED',
            amount: 1001,
            payment_method: 'CASH',
            transaction_date: '01/02/2026'
        });
        assertEqual(overpayRes.status, 400, 'Overpayment rejected with HTTP 400');

        const { body: verifyAcc } = await apiGet(`/accounts/${testAcc.id}`);
        assertEqual(verifyAcc.data.outstanding_principal, 100000, 'Outstanding preserved at ₹1,000');
    });

    // ─── 9. FULL PAYMENT TO EXACT ZERO ───
    await testAsync('9. Full Payment: ₹1,000 on ₹1,000 outstanding → ₹0, status CLOSED', async () => {
        const testAcc = await createTestAccount(ramesh.id, 1000, 12);

        const payRes = await apiPost('/transactions', {
            account_id: testAcc.id,
            transaction_type: 'PRINCIPAL_RECEIVED',
            amount: 1000,
            payment_method: 'UPI',
            transaction_date: '01/02/2026'
        });
        assertEqual(payRes.status, 201, 'Full payment accepted');

        const { body: verifyAcc } = await apiGet(`/accounts/${testAcc.id}`);
        assertEqual(verifyAcc.data.outstanding_principal, 0, 'Outstanding is exactly ₹0');
        assertEqual(verifyAcc.data.status, 'CLOSED', 'Account transitioned to CLOSED');
    });

    // ─── 10. MULTIPLE PAYMENTS (NO MERGING) ───
    await testAsync('10. Multiple Payments: 3 payments (₹500+₹300+₹200) create 3 records, outstanding ₹1,000', async () => {
        const testAcc = await createTestAccount(ramesh.id, 2000, 15);

        await apiPost('/transactions', { account_id: testAcc.id, transaction_type: 'PRINCIPAL_RECEIVED', amount: 500, payment_method: 'CASH', transaction_date: '01/02/2026', reference: 'P1-4G' });
        await apiPost('/transactions', { account_id: testAcc.id, transaction_type: 'PRINCIPAL_RECEIVED', amount: 300, payment_method: 'CASH', transaction_date: '02/02/2026', reference: 'P2-4G' });
        await apiPost('/transactions', { account_id: testAcc.id, transaction_type: 'PRINCIPAL_RECEIVED', amount: 200, payment_method: 'CASH', transaction_date: '03/02/2026', reference: 'P3-4G' });

        const { body: verifyAcc } = await apiGet(`/accounts/${testAcc.id}`);
        assertEqual(verifyAcc.data.outstanding_principal, 100000, 'Outstanding is ₹1,000');

        const { body: txList } = await apiGet(`/transactions?account_id=${testAcc.id}`);
        assertEqual(txList.data.length, 3, 'Exactly 3 individual transaction records');
    });

    // ─── 11. DUPLICATE SUBMISSION PROTECTION ───
    await testAsync('11. Duplicate Protection: Same idempotency key returns existing record, not duplicate', async () => {
        const idempotencyKey = 'IDEMP-4G-' + Date.now();
        const payload = {
            account_id: acc1.id,
            transaction_type: 'INTEREST_RECEIVED',
            amount: 50,
            payment_method: 'UPI',
            transaction_date: '10/09/2026',
            reference: 'DUP-TEST-4G'
        };

        const res1 = await apiPost('/transactions', payload, { 'idempotency-key': idempotencyKey });
        const res2 = await apiPost('/transactions', payload, { 'idempotency-key': idempotencyKey });

        assertEqual(res1.status, 201, 'First request created');
        assertEqual(res2.status, 200, 'Duplicate request returned 200 OK');
        assertEqual(res2.body.isDuplicate, true, 'Marked isDuplicate');
        assertEqual(res1.body.data.id, res2.body.data.id, 'Same transaction record returned');
    });

    // ─── 12. CONCURRENT PAYMENT PROTECTION ───
    await testAsync('12. Concurrency: Two ₹700 payments on ₹1,000 cannot push balance negative', async () => {
        const testAcc = await createTestAccount(ramesh.id, 1000, 15);

        const [p1, p2] = await Promise.all([
            apiPost('/transactions', { account_id: testAcc.id, transaction_type: 'PRINCIPAL_RECEIVED', amount: 700, payment_method: 'UPI', transaction_date: '12/09/2026', reference: 'CONC-A' }),
            apiPost('/transactions', { account_id: testAcc.id, transaction_type: 'PRINCIPAL_RECEIVED', amount: 700, payment_method: 'UPI', transaction_date: '12/09/2026', reference: 'CONC-B' })
        ]);

        const statuses = [p1.status, p2.status].sort();
        // At least one must succeed (201), the other must either succeed or be rejected (400)
        assert(statuses.includes(201), 'At least one request succeeded');

        const { body: verifyAcc } = await apiGet(`/accounts/${testAcc.id}`);
        assert(verifyAcc.data.outstanding_principal >= 0, 'Outstanding principal never negative (>= 0)');
    });

    // ─── 13. TRANSACTION AMOUNT VALIDATION ───
    await testAsync('13. Amount Validation: Zero and negative amounts are rejected (HTTP 400)', async () => {
        const rZero = await apiPost('/transactions', { account_id: acc1.id, transaction_type: 'INTEREST_RECEIVED', amount: 0, payment_method: 'CASH', transaction_date: '01/09/2026' });
        assertEqual(rZero.status, 400, 'Zero amount rejected');

        const rNeg = await apiPost('/transactions', { account_id: acc1.id, transaction_type: 'INTEREST_RECEIVED', amount: -500, payment_method: 'CASH', transaction_date: '01/09/2026' });
        assertEqual(rNeg.status, 400, 'Negative amount rejected');
    });

    // ─── 14. TRANSACTION TYPE VALIDATION ───
    await testAsync('14. Type Validation: Invalid transaction type "MAGIC_TRANSFER" is rejected (HTTP 400)', async () => {
        const res = await apiPost('/transactions', { account_id: acc1.id, transaction_type: 'MAGIC_TRANSFER', amount: 500, payment_method: 'CASH', transaction_date: '01/09/2026' });
        assertEqual(res.status, 400, 'Invalid transaction type rejected');
    });

    // ─── 15. PAYMENT METHOD VALIDATION ───
    await testAsync('15. Method Validation: Invalid payment method "BITCOIN" is rejected (HTTP 400)', async () => {
        const res = await apiPost('/transactions', { account_id: acc1.id, transaction_type: 'INTEREST_RECEIVED', amount: 500, payment_method: 'BITCOIN', transaction_date: '01/09/2026' });
        assertEqual(res.status, 400, 'Invalid payment method rejected');
    });

    // ─── 16. ACCOUNT DIRECTION RULES ───
    await testAsync('16. Direction Rules: MONEY_TAKEN accounts reject MONEY_LENT transaction type', async () => {
        const res = await apiPost('/transactions', {
            account_id: maheshAcc.id,
            transaction_type: 'MONEY_LENT',
            amount: 5000,
            payment_method: 'BANK_TRANSFER',
            transaction_date: '01/09/2026'
        });
        assertEqual(res.status, 400, 'MONEY_LENT rejected on MONEY_TAKEN account');
    });

    // ─── 17. TRANSACTION DATE VALIDATION ───
    await testAsync('17. Date Validation: Invalid date "not-a-date" is rejected (HTTP 400)', async () => {
        const res = await apiPost('/transactions', { account_id: acc1.id, transaction_type: 'INTEREST_RECEIVED', amount: 500, payment_method: 'CASH', transaction_date: 'not-a-date' });
        assertEqual(res.status, 400, 'Invalid date rejected');
    });

    // ─── 18. AUDIT LOGGING VERIFICATION ───
    await testAsync('18. Audit Logging: Transactions have created_at timestamps (audit trail)', async () => {
        const { body: txList } = await apiGet('/transactions');
        assert(txList.data.length > 0, 'Transactions exist');
        const latestTx = txList.data[0];
        assert(latestTx.created_at, 'Transaction has created_at timestamp');
    });

    // ─── 19. LEDGER & DATABASE CONSISTENCY ───
    await testAsync('19. Ledger Consistency: All transactions have valid ID, person_name, positive amount', async () => {
        const { status, body } = await apiGet('/transactions');
        assertEqual(status, 200, 'HTTP 200');
        assert(body.data.every(t => t.id && t.person_name && t.amount > 0), 'Every transaction is valid');
    });

    // ─── 20. ACCOUNT DETAIL MATCHING ───
    await testAsync('20. Account Detail Consistency: Filter by account returns only that account', async () => {
        const { body: acc1Txs } = await apiGet(`/transactions?account_id=${acc1.id}`);
        assert(acc1Txs.data.every(t => t.account_id === acc1.id), 'Only Acc #001 transactions');

        const { body: acc2Txs } = await apiGet(`/transactions?account_id=${acc2.id}`);
        assert(acc2Txs.data.every(t => t.account_id === acc2.id), 'Only Acc #002 transactions');

        const { body: acc3Txs } = await apiGet(`/transactions?account_id=${acc3.id}`);
        assert(acc3Txs.data.every(t => t.account_id === acc3.id), 'Only Acc #003 transactions');
    });

    // ─── 21. PERSON DETAIL MATCHING ───
    await testAsync('21. Person Profile Consistency: Ramesh transactions preserve account identifiers', async () => {
        const { body: rameshTxs } = await apiGet(`/transactions?person_id=${ramesh.id}`);
        assert(rameshTxs.data.every(t => t.person_id === ramesh.id), 'Only Ramesh transactions');
        assert(rameshTxs.data.every(t => t.account_id !== undefined), 'Each identifies its account');
    });

    // ─── 22. DIRECT DATABASE HEALTH & INTEGRITY ───
    await testAsync('22. Database Health: No negative balances, all principals > 0, all IDs valid', async () => {
        const { body: accounts } = await apiGet('/accounts');
        assert(accounts.data.every(a => a.outstanding_principal >= 0), 'All outstanding_principal >= 0');
        assert(accounts.data.every(a => a.principal > 0), 'All principal > 0');
        assert(accounts.data.every(a => a.id && a.person_id), 'All IDs valid');
    });

    // ─── 23. REGRESSION TEST ───
    await testAsync('23. Regression: Account CRUD, People, and Ledger routes all still functional', async () => {
        // People list
        const { status: pStatus } = await apiGet('/people');
        assertEqual(pStatus, 200, 'People list works');

        // Accounts list
        const { status: aStatus } = await apiGet('/accounts');
        assertEqual(aStatus, 200, 'Accounts list works');

        // Account detail
        const { status: adStatus } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(adStatus, 200, 'Account detail works');

        // Transaction ledger
        const { status: tStatus } = await apiGet('/transactions');
        assertEqual(tStatus, 200, 'Transaction ledger works');

        // Create account
        const newAcc = await createTestAccount(ramesh.id, 500, 10);
        assert(newAcc.id, 'Account creation still works');

        // Edit account
        const editRes = await apiPut(`/accounts/${newAcc.id}`, { interest_rate: 12, notes: 'regression test' });
        assertEqual(editRes.status, 200, 'Account edit works');
    });

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Step 4G Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
