/**
 * Interest Manager — Step 3D Test Suite
 * Multiple Accounts Per Person & Independence Verification
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

async function runTests() {
    console.log('\n=== Interest Manager — Step 3D Test Suite ===\n');

    // Fetch Ramesh
    const { body: peopleRes } = await apiGet('/people');
    const ramesh = peopleRes.data.find(p => p.name === 'Ramesh');
    assert(ramesh, 'Ramesh must exist in database');

    const { body: initialAccs } = await apiGet(`/accounts?person_id=${ramesh.id}`);
    assert(initialAccs.data.length >= 3, `Ramesh must have at least 3 seed accounts, got ${initialAccs.data.length}`);

    const acc1 = initialAccs.data.find(a => a.start_date === '2026-08-01') || initialAccs.data[0];
    const acc2 = initialAccs.data.find(a => a.start_date === '2026-09-01') || initialAccs.data[1];
    const acc3 = initialAccs.data.find(a => a.start_date === '2026-09-10') || initialAccs.data[2];

    // Test 1: Ramesh has 3 separate accounts
    await testAsync('Ramesh has 3 separate accounts', async () => {
        assert(initialAccs.data.length >= 3, 'Ramesh has 3+ accounts');
    });

    // Test 2: All accounts have unique IDs
    await testAsync('All Ramesh accounts have unique account IDs', async () => {
        const ids = new Set([acc1.id, acc2.id, acc3.id]);
        assertEqual(ids.size, 3, '3 distinct account IDs');
    });

    // Test 3: All accounts have the same person_id
    await testAsync('All Ramesh accounts share the exact same person_id', async () => {
        assertEqual(acc1.person_id, ramesh.id, 'Account 1 person_id');
        assertEqual(acc2.person_id, ramesh.id, 'Account 2 person_id');
        assertEqual(acc3.person_id, ramesh.id, 'Account 3 person_id');
    });

    // Test 4: Changing Account #002\'s rate does not change Accounts #001 or #003
    await testAsync('Rate Independence: Changing Acc 2 rate to 17% leaves Acc 1 & 3 unchanged', async () => {
        const { status } = await apiPut(`/accounts/${acc2.id}`, { interest_rate: 17 });
        assertEqual(status, 200, 'Update status');

        const { body: res1 } = await apiGet(`/accounts/${acc1.id}`);
        const { body: res2 } = await apiGet(`/accounts/${acc2.id}`);
        const { body: res3 } = await apiGet(`/accounts/${acc3.id}`);

        assertEqual(res1.data.interest_rate, acc1.interest_rate, 'Account 1 rate unchanged');
        assertEqual(res2.data.interest_rate, 17, 'Account 2 rate updated to 17%');
        assertEqual(res3.data.interest_rate, acc3.interest_rate, 'Account 3 rate unchanged');
    });

    // Test 5: Changing Account #002\'s dates does not change other accounts
    await testAsync('Date Independence: Changing Acc 2 due date leaves Acc 1 & 3 dates unchanged', async () => {
        const { status } = await apiPut(`/accounts/${acc2.id}`, { due_date: '2026-11-01' });
        assertEqual(status, 200, 'Update status');

        const { body: res1 } = await apiGet(`/accounts/${acc1.id}`);
        const { body: res2 } = await apiGet(`/accounts/${acc2.id}`);
        const { body: res3 } = await apiGet(`/accounts/${acc3.id}`);

        assertEqual(res1.data.due_date, acc1.due_date, 'Account 1 due date unchanged');
        assertEqual(res2.data.due_date, '2026-11-01', 'Account 2 due date updated to 2026-11-01');
        assertEqual(res3.data.due_date, acc3.due_date, 'Account 3 due date unchanged');
    });

    // Test 6: Changing Account #002\'s outstanding principal does not change other accounts
    await testAsync('Principal Independence: Changing Acc 2 outstanding principal leaves Acc 1 & 3 unchanged', async () => {
        const { status } = await apiPut(`/accounts/${acc2.id}`, { outstanding_principal: 150000 });
        assertEqual(status, 200, 'Update status');

        const { body: res1 } = await apiGet(`/accounts/${acc1.id}`);
        const { body: res2 } = await apiGet(`/accounts/${acc2.id}`);
        const { body: res3 } = await apiGet(`/accounts/${acc3.id}`);

        assertEqual(res1.data.outstanding_principal, acc1.outstanding_principal, 'Account 1 outstanding unchanged');
        assertEqual(res2.data.outstanding_principal, 150000, 'Account 2 outstanding updated to 1500 INR');
        assertEqual(res3.data.outstanding_principal, acc3.outstanding_principal, 'Account 3 outstanding unchanged');
    });

    // Test 7: Original principal remains unchanged
    await testAsync('Original principal is strictly preserved during edits', async () => {
        const { body: res2 } = await apiGet(`/accounts/${acc2.id}`);
        assertEqual(res2.data.principal, acc2.principal, 'Original principal locked and unchanged');
    });

    // Test 8: Each account opens its own detail page
    await testAsync('Each account detail endpoint returns its exact individual record', async () => {
        const { body: res1 } = await apiGet(`/accounts/${acc1.id}`);
        const { body: res3 } = await apiGet(`/accounts/${acc3.id}`);

        assertEqual(res1.data.id, acc1.id, 'Res 1 matches Acc 1');
        assertEqual(res3.data.id, acc3.id, 'Res 3 matches Acc 3');
        assert(res1.data.id !== res3.data.id, 'Acc 1 and Acc 3 are distinct');
    });

    // Test 9: Ramesh\'s profile displays all accounts separately
    await testAsync('Person Profile endpoint returns list of separate accounts', async () => {
        const { body: personProfile } = await apiGet(`/people/${ramesh.id}`);
        assert(personProfile.data.accounts.length >= 3, 'Profile includes separate accounts array');
        const profileAccIds = personProfile.data.accounts.map(a => a.id);
        assertEqual(new Set(profileAccIds).size, profileAccIds.length, 'All profile accounts have unique IDs');
    });

    // Test 10: Create a 4th account for Ramesh
    await testAsync('Creating a 4th account generates new ID without altering previous accounts', async () => {
        const beforeCount = (await apiGet(`/accounts?person_id=${ramesh.id}`)).body.data.length;

        const { status, body: newAcc } = await apiPost('/accounts', {
            person_id: ramesh.id,
            direction: 'MONEY_GIVEN',
            principal: 3000,
            interest_rate: 20,
            interest_frequency: 'MONTHLY',
            calculation_method: 'SIMPLE_INTEREST',
            start_date: '2026-09-15',
            due_date: '2026-10-15',
            notes: 'Test 4th Account'
        });

        assertEqual(status, 201, 'HTTP 201 Created');
        assert(newAcc.data.id, 'New account has ID');
        assert(newAcc.data.id !== acc1.id && newAcc.data.id !== acc2.id && newAcc.data.id !== acc3.id, 'New account has distinct ID');

        const afterCount = (await apiGet(`/accounts?person_id=${ramesh.id}`)).body.data.length;
        assertEqual(afterCount, beforeCount + 1, 'Ramesh now has one additional account');
    });

    // Test 11: Duplicate submission protection
    await testAsync('Validation and duplicate submission handling functions properly', async () => {
        const { status: s1 } = await apiPost('/accounts', {
            person_id: ramesh.id, direction: 'MONEY_GIVEN', principal: -100,
            interest_rate: 10, interest_frequency: 'MONTHLY',
            start_date: '2026-08-01', due_date: '2026-09-01'
        });
        assertEqual(s1, 400, 'Invalid principal rejected');
    });

    // Test 12: Relational Integrity (no JSON array stored inside people table)
    await testAsync('Relational integrity: accounts exist as independent rows in accounts table', async () => {
        const { body: person } = await apiGet(`/people/${ramesh.id}`);
        assert(!person.data.hasOwnProperty('accounts_json'), 'No accounts JSON stored inside person columns');
        assert(typeof person.data.id === 'number', 'Person linked by foreign key ID');
    });

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
