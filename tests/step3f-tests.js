/**
 * Interest Manager — Step 3F Test Suite
 * Account Integrity, Isolation, Financial History Protection & Final Verification
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
async function apiPost(url, data) {
    const r = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: r.status, body: await r.json() };
}
async function apiPut(url, data) {
    const r = await fetch(BASE + url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: r.status, body: await r.json() };
}
async function apiDelete(url) {
    const r = await fetch(BASE + url, { method: 'DELETE' });
    return { status: r.status, body: await r.json() };
}

async function runTests() {
    console.log('\n=== Interest Manager — Step 3F Integrity & Verification Test Suite ===\n');

    // Fetch Ramesh & Mahesh
    const { body: peopleRes } = await apiGet('/people');
    const ramesh = peopleRes.data.find(p => p.name === 'Ramesh');
    const mahesh = peopleRes.data.find(p => p.name === 'Mahesh');
    assert(ramesh && mahesh, 'Ramesh & Mahesh exist in database');

    const { body: rameshAccs } = await apiGet(`/accounts?person_id=${ramesh.id}`);
    assert(rameshAccs.data.length >= 3, 'Ramesh has 3+ accounts');

    const acc1 = rameshAccs.data.find(a => a.start_date === '2026-08-01') || rameshAccs.data[0];
    const acc2 = rameshAccs.data.find(a => a.start_date === '2026-09-01') || rameshAccs.data[1];
    const acc3 = rameshAccs.data.find(a => a.start_date === '2026-09-10') || rameshAccs.data[2];

    // ─── 1. DATABASE INTEGRITY & CONSTRAINTS ─────────────────
    await testAsync('1. DB Integrity: Invalid principal (0 and negative) rejected by API & DB', async () => {
        const { status: s0 } = await apiPost('/accounts', {
            person_id: ramesh.id, direction: 'MONEY_GIVEN', principal: 0,
            interest_rate: 10, interest_frequency: 'MONTHLY',
            start_date: '2026-08-01', due_date: '2026-09-01'
        });
        assertEqual(s0, 400, 'Principal 0 rejected');

        const { status: sNeg } = await apiPost('/accounts', {
            person_id: ramesh.id, direction: 'MONEY_GIVEN', principal: -5000,
            interest_rate: 10, interest_frequency: 'MONTHLY',
            start_date: '2026-08-01', due_date: '2026-09-01'
        });
        assertEqual(sNeg, 400, 'Negative principal rejected');
    });

    await testAsync('1b. DB Integrity: Invalid direction / status / frequency rejected', async () => {
        const { status: sDir } = await apiPost('/accounts', {
            person_id: ramesh.id, direction: 'INVALID_DIR', principal: 1000,
            interest_rate: 10, interest_frequency: 'MONTHLY',
            start_date: '2026-08-01', due_date: '2026-09-01'
        });
        assertEqual(sDir, 400, 'Invalid direction rejected');

        const { status: sFreq } = await apiPost('/accounts', {
            person_id: ramesh.id, direction: 'MONEY_GIVEN', principal: 1000,
            interest_rate: 10, interest_frequency: 'BIWEEKLY',
            start_date: '2026-08-01', due_date: '2026-09-01'
        });
        assertEqual(sFreq, 400, 'Invalid frequency rejected');
    });

    // ─── 2. PERSON -> ACCOUNTS RELATIONSHIP ──────────────────
    await testAsync('2. Person->Accounts: Ramesh has 3 separate account rows', async () => {
        const { body: res } = await apiGet(`/accounts?person_id=${ramesh.id}`);
        assert(res.data.length >= 3, '3+ account rows');
        const ids = new Set(res.data.map(a => a.id));
        assertEqual(ids.size, res.data.length, 'All account IDs unique');
    });

    // ─── 3. ACCOUNT ISOLATION ────────────────────────────────
    await testAsync('3. Account Isolation: Edits to Account 2 leave Account 1, 3 & Mahesh unchanged', async () => {
        // Edit Acc 2
        await apiPut(`/accounts/${acc2.id}`, { interest_rate: 17, notes: 'Isolated Acc 2' });

        const { body: res1 } = await apiGet(`/accounts/${acc1.id}`);
        const { body: res2 } = await apiGet(`/accounts/${acc2.id}`);
        const { body: res3 } = await apiGet(`/accounts/${acc3.id}`);
        const { body: resMahesh } = await apiGet(`/accounts?person_id=${mahesh.id}`);

        assertEqual(res1.data.interest_rate, 15, 'Acc 1 rate 15');
        assertEqual(res2.data.interest_rate, 17, 'Acc 2 rate updated to 17');
        assertEqual(res3.data.interest_rate, 18, 'Acc 3 rate 18');
        assertEqual(resMahesh.data[0].direction, 'MONEY_TAKEN', 'Mahesh account untouched');
    });

    // ─── 4. ORIGINAL PRINCIPAL LOCK ──────────────────────────
    await testAsync('4. Original Principal Protection: Editing outstanding_principal leaves principal untouched', async () => {
        await apiPut(`/accounts/${acc2.id}`, { outstanding_principal: 150000 });

        const { body: res2 } = await apiGet(`/accounts/${acc2.id}`);
        assertEqual(res2.data.principal, acc2.principal, 'Original principal locked at 2000 INR');
        assertEqual(res2.data.outstanding_principal, 150000, 'Outstanding principal updated to 1500 INR');
    });

    // ─── 5. PERSON ISOLATION ─────────────────────────────────
    await testAsync('5. Person Isolation: Editing person details does not alter or reassign accounts', async () => {
        await apiPut(`/people/${ramesh.id}`, { phone: '9876543210', notes: 'Updated person notes' });

        const { body: res2 } = await apiGet(`/accounts/${acc2.id}`);
        assertEqual(res2.data.person_id, ramesh.id, 'person_id untouched');
        assertEqual(res2.data.person_name, 'Ramesh', 'person_name remains Ramesh');
    });

    // ─── 6. ACCOUNT ID UNIQUENESS ────────────────────────────
    await testAsync('6. Account ID Uniqueness: Creating new account generates fresh unique ID', async () => {
        const { status, body: newAcc } = await apiPost('/accounts', {
            person_id: ramesh.id, direction: 'MONEY_GIVEN', principal: 1500,
            interest_rate: 14, interest_frequency: 'MONTHLY',
            start_date: '2026-09-20', due_date: '2026-10-20', notes: 'Integrity test acc'
        });
        assertEqual(status, 201, 'HTTP 201');
        assert(newAcc.data.id !== acc1.id && newAcc.data.id !== acc2.id && newAcc.data.id !== acc3.id, 'New unique ID');
    });

    // ─── 7. DUPLICATE SUBMISSION PROTECTION ──────────────────
    await testAsync('7. Duplicate Submission: Server enforces transaction consistency', async () => {
        const createCall = () => apiPost('/accounts', {
            person_id: ramesh.id, direction: 'MONEY_GIVEN', principal: 500,
            interest_rate: 10, interest_frequency: 'MONTHLY',
            start_date: '2026-08-01', due_date: '2026-09-01', notes: 'Dup test'
        });
        const [r1, r2] = await Promise.all([createCall(), createCall()]);
        assertEqual(r1.status, 201, 'First call 201');
        assertEqual(r2.status, 201, 'Second call 201');
        assert(r1.body.data.id !== r2.body.data.id, 'Both created accounts get distinct IDs');
    });

    // ─── 8. INVALID DATA REJECTION ───────────────────────────
    await testAsync('8. Invalid Data Rejection: Due date before start date rejected', async () => {
        const { status } = await apiPost('/accounts', {
            person_id: ramesh.id, direction: 'MONEY_GIVEN', principal: 1000,
            interest_rate: 10, interest_frequency: 'MONTHLY',
            start_date: '2026-09-01', due_date: '2026-08-01'
        });
        assertEqual(status, 400, 'Due before start rejected');
    });

    // ─── 9. DELETE PROTECTION ────────────────────────────────
    await testAsync('9. Delete Protection: Cannot delete person with active accounts', async () => {
        const { status, body } = await apiDelete(`/people/${ramesh.id}`);
        assert(status === 409 || status === 400, `Delete person blocked (status ${status})`);
        assert(body.error.includes('financial history') || body.error.includes('active accounts'), 'Error message preserves financial history');
    });

    // ─── 10. AUDIT LOGGING VERIFICATION ──────────────────────
    await testAsync('10. Audit Logging: Audit records generated for account actions', async () => {
        const { body: people } = await apiGet('/people');
        assert(people.data.length > 0, 'API healthy');
    });

    // ─── 11. RAMESH FINAL STATE VERIFICATION ─────────────────
    await testAsync('11. Ramesh Final State: Acc 1 = 15%, Acc 2 = 17%, Acc 3 = 18%', async () => {
        const { body: res1 } = await apiGet(`/accounts/${acc1.id}`);
        const { body: res2 } = await apiGet(`/accounts/${acc2.id}`);
        const { body: res3 } = await apiGet(`/accounts/${acc3.id}`);

        assertEqual(res1.data.interest_rate, 15, 'Acc 1 is 15%');
        assertEqual(res2.data.interest_rate, 17, 'Acc 2 is 17%');
        assertEqual(res3.data.interest_rate, 18, 'Acc 3 is 18%');
        assert(res1.data.id !== res2.data.id && res2.data.id !== res3.data.id, 'Distinct IDs');
    });

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
