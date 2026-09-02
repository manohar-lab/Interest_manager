/**
 * Interest Manager — Step 3 Test Suite
 * Accounts / Loans Management: 12 required tests
 */

const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0, total = 0;

function assert(condition, msg) { if (!condition) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error((msg || '') + ` — expected: ${JSON.stringify(b)}, got: ${JSON.stringify(a)}`); }

async function testAsync(name, fn) {
    total++;
    try { await fn(); passed++; console.log(`  ✅ Test ${total}: ${name}`); }
    catch (err) { failed++; console.log(`  ❌ Test ${total}: ${name}`); console.log(`      Error: ${err.message}`); }
}
function test(name, fn) {
    total++;
    try { fn(); passed++; console.log(`  ✅ Test ${total}: ${name}`); }
    catch (err) { failed++; console.log(`  ❌ Test ${total}: ${name}`); console.log(`      Error: ${err.message}`); }
}

const BASE = 'http://localhost:3000/api';

async function apiGet(url) { const r = await fetch(BASE + url); return r.json(); }
async function apiPost(url, data) {
    const r = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: r.status, body: await r.json() };
}
async function apiPut(url, data) {
    const r = await fetch(BASE + url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: r.status, body: await r.json() };
}

// Track IDs of test-created accounts for cleanup
const createdIds = [];

async function runTests() {
    console.log('\n=== Interest Manager — Step 3 Test Suite ===\n');

    // Get Ramesh's ID (person_id = 1 from seed)
    const { data: people } = await apiGet('/people');
    const ramesh = people.find(p => p.name === 'Ramesh');
    const mahesh = people.find(p => p.name === 'Mahesh');
    assert(ramesh, 'Ramesh must exist'); assert(mahesh, 'Mahesh must exist');

    // ─── Test 1: Create MONEY_GIVEN account ──────────────────
    await testAsync('Create MONEY_GIVEN — Ramesh ₹2,000 @ 15% monthly', async () => {
        const { status, body } = await apiPost('/accounts', {
            person_id: ramesh.id,
            direction: 'MONEY_GIVEN',
            principal: 2000,
            interest_rate: 15,
            interest_frequency: 'MONTHLY',
            calculation_method: 'SIMPLE_INTEREST',
            start_date: '2026-08-01',
            due_date: '2026-09-01',
            notes: 'Test Account A'
        });
        assertEqual(status, 201, 'Create status');
        assert(body.data.id, 'Should have an ID');
        assertEqual(body.data.direction, 'MONEY_GIVEN', 'Direction');
        assertEqual(body.data.principal, 200000, 'Principal in paisa');
        assertEqual(body.data.outstanding_principal, 200000, 'Outstanding = Principal');
        assertEqual(body.data.interest_rate, 15, 'Interest rate');
        assertEqual(body.data.status, 'ACTIVE', 'Default status');
        createdIds.push(body.data.id);
    });

    // ─── Test 2: Create second account (NEW unique ID) ───────
    await testAsync('Create 2nd account — Ramesh ₹2,000 @ 15% different dates', async () => {
        const { status, body } = await apiPost('/accounts', {
            person_id: ramesh.id,
            direction: 'MONEY_GIVEN',
            principal: 2000,
            interest_rate: 15,
            interest_frequency: 'MONTHLY',
            calculation_method: 'SIMPLE_INTEREST',
            start_date: '2026-09-01',
            due_date: '2026-10-01',
            notes: 'Test Account B'
        });
        assertEqual(status, 201, 'Create status');
        assert(body.data.id !== createdIds[0], `ID ${body.data.id} must differ from ${createdIds[0]}`);
        createdIds.push(body.data.id);
    });

    // ─── Test 3: Create different-rate account ───────────────
    await testAsync('Create 3rd account — Ramesh ₹5,000 @ 18% different rate', async () => {
        const { status, body } = await apiPost('/accounts', {
            person_id: ramesh.id,
            direction: 'MONEY_GIVEN',
            principal: 5000,
            interest_rate: 18,
            interest_frequency: 'MONTHLY',
            calculation_method: 'SIMPLE_INTEREST',
            start_date: '2026-09-10',
            due_date: '2026-10-10',
            notes: 'Test Account C'
        });
        assertEqual(status, 201, 'Create status');
        assert(body.data.id !== createdIds[0] && body.data.id !== createdIds[1], 'Unique ID');
        assertEqual(body.data.principal, 500000, 'Principal 5000 in paisa');
        assertEqual(body.data.interest_rate, 18, 'Rate 18');
        createdIds.push(body.data.id);
    });

    // ─── Test 4: Account independence (edit B, verify A & C) ─
    await testAsync('Account independence — edit Account B rate to 17%, A & C unchanged', async () => {
        const accBId = createdIds[1];
        const { status } = await apiPut(`/accounts/${accBId}`, { interest_rate: 17 });
        assertEqual(status, 200, 'Update status');

        // Verify A unchanged
        const { data: accA } = await apiGet(`/accounts/${createdIds[0]}`);
        assertEqual(accA.interest_rate, 15, 'Account A rate still 15');
        assertEqual(accA.principal, 200000, 'Account A principal unchanged');

        // Verify B changed
        const { data: accB } = await apiGet(`/accounts/${accBId}`);
        assertEqual(accB.interest_rate, 17, 'Account B rate changed to 17');

        // Verify C unchanged
        const { data: accC } = await apiGet(`/accounts/${createdIds[2]}`);
        assertEqual(accC.interest_rate, 18, 'Account C rate still 18');
        assertEqual(accC.principal, 500000, 'Account C principal unchanged');
    });

    // ─── Test 5: Original principal vs outstanding principal ─
    await testAsync('Original principal and outstanding principal stored separately', async () => {
        const { data: accA } = await apiGet(`/accounts/${createdIds[0]}`);
        assertEqual(accA.principal, 200000, 'Original principal = 200000 paisa');
        assertEqual(accA.outstanding_principal, 200000, 'Outstanding = 200000 paisa');
        // They should be separate fields
        assert(accA.hasOwnProperty('principal'), 'Has principal field');
        assert(accA.hasOwnProperty('outstanding_principal'), 'Has outstanding_principal field');
    });

    // ─── Test 6: MONEY_TAKEN (Mahesh) ────────────────────────
    await testAsync('MONEY_TAKEN — Mahesh ₹1,00,000 account exists', async () => {
        const { data: maheshData } = await apiGet(`/people/${mahesh.id}`);
        assert(maheshData.accounts.length >= 1, 'Mahesh has at least 1 account');
        const takenAcc = maheshData.accounts.find(a => a.direction === 'MONEY_TAKEN');
        assert(takenAcc, 'Mahesh has a MONEY_TAKEN account');
        assertEqual(takenAcc.principal, 10000000, 'Principal = ₹1,00,000 in paisa');
        assertEqual(takenAcc.direction, 'MONEY_TAKEN', 'Direction is MONEY_TAKEN');
    });

    // ─── Test 7: Invalid principal (0 and negative) ──────────
    await testAsync('Validation: principal ≤ 0 rejected', async () => {
        const { status: s1 } = await apiPost('/accounts', {
            person_id: ramesh.id, direction: 'MONEY_GIVEN', principal: 0,
            interest_rate: 10, interest_frequency: 'MONTHLY',
            start_date: '2026-08-01', due_date: '2026-09-01'
        });
        assertEqual(s1, 400, 'Zero principal rejected');

        const { status: s2 } = await apiPost('/accounts', {
            person_id: ramesh.id, direction: 'MONEY_GIVEN', principal: -5000,
            interest_rate: 10, interest_frequency: 'MONTHLY',
            start_date: '2026-08-01', due_date: '2026-09-01'
        });
        assertEqual(s2, 400, 'Negative principal rejected');
    });

    // ─── Test 8: Invalid interest rate ───────────────────────
    await testAsync('Validation: negative interest rate rejected', async () => {
        const { status } = await apiPost('/accounts', {
            person_id: ramesh.id, direction: 'MONEY_GIVEN', principal: 1000,
            interest_rate: -5, interest_frequency: 'MONTHLY',
            start_date: '2026-08-01', due_date: '2026-09-01'
        });
        assertEqual(status, 400, 'Negative rate rejected');
    });

    // ─── Test 9: Invalid dates (due before start) ────────────
    await testAsync('Validation: due date before start date rejected', async () => {
        const { status } = await apiPost('/accounts', {
            person_id: ramesh.id, direction: 'MONEY_GIVEN', principal: 1000,
            interest_rate: 10, interest_frequency: 'MONTHLY',
            start_date: '2026-09-01', due_date: '2026-08-01'
        });
        assertEqual(status, 400, 'Due before start rejected');
    });

    // ─── Test 10: Duplicate submission (rapid-fire creates correct count) ─
    await testAsync('Duplicate submission: rapid creates produce expected records', async () => {
        const beforeRes = await apiGet('/accounts');
        const beforeCount = beforeRes.data.length;

        const [r1, r2] = await Promise.all([
            apiPost('/accounts', {
                person_id: ramesh.id, direction: 'MONEY_GIVEN', principal: 100,
                interest_rate: 1, interest_frequency: 'MONTHLY',
                start_date: '2026-01-01', due_date: '2026-02-01', notes: 'dup-test-1'
            }),
            apiPost('/accounts', {
                person_id: ramesh.id, direction: 'MONEY_GIVEN', principal: 200,
                interest_rate: 2, interest_frequency: 'MONTHLY',
                start_date: '2026-01-01', due_date: '2026-02-01', notes: 'dup-test-2'
            })
        ]);
        assertEqual(r1.status, 201, 'First rapid create');
        assertEqual(r2.status, 201, 'Second rapid create');

        const afterRes = await apiGet('/accounts');
        assertEqual(afterRes.data.length, beforeCount + 2, 'Exactly 2 more accounts');

        // Track for cleanup
        if (r1.body.data) createdIds.push(r1.body.data.id);
        if (r2.body.data) createdIds.push(r2.body.data.id);
    });

    // ─── Test 11: Person profile shows 3+ separate accounts ─
    await testAsync('Person profile: Ramesh has 3+ separate accounts displayed', async () => {
        const { data: rameshData } = await apiGet(`/people/${ramesh.id}`);
        assert(rameshData.accounts.length >= 3, `Ramesh should have 3+ accounts, has ${rameshData.accounts.length}`);

        // Verify they are separate (different IDs)
        const ids = rameshData.accounts.map(a => a.id);
        assertEqual(new Set(ids).size, ids.length, 'All account IDs are unique');

        // Verify at least 2 different principals exist
        const principals = new Set(rameshData.accounts.map(a => a.principal));
        assert(principals.size >= 2, 'Multiple different principals exist');
    });

    // ─── Test 12: Database integrity (edit one doesn't affect others) ─
    await testAsync('Database integrity: editing one account does not affect others', async () => {
        // Snapshot all Ramesh's accounts
        const { data: before } = await apiGet(`/people/${ramesh.id}`);
        const accFirst = before.accounts[0];
        const accLast = before.accounts[before.accounts.length - 1];

        // Edit the first account's notes
        await apiPut(`/accounts/${accFirst.id}`, { notes: 'integrity-test-edit' });

        // Verify last account unchanged
        const { data: afterLast } = await apiGet(`/accounts/${accLast.id}`);
        assertEqual(afterLast.principal, accLast.principal, 'Last account principal unchanged');
        assertEqual(afterLast.interest_rate, accLast.interest_rate, 'Last account rate unchanged');
        assertEqual(afterLast.start_date, accLast.start_date, 'Last account start date unchanged');

        // Verify first account only changed notes
        const { data: afterFirst } = await apiGet(`/accounts/${accFirst.id}`);
        assertEqual(afterFirst.principal, accFirst.principal, 'Edited account principal unchanged');
    });

    // ─── Additional: Verify filters work ─────────────────────
    await testAsync('BONUS: Account filters work (direction, status)', async () => {
        const { data: givenAccs } = await apiGet('/accounts?direction=MONEY_GIVEN');
        assert(givenAccs.length > 0, 'MONEY_GIVEN filter returns results');
        assert(givenAccs.every(a => a.direction === 'MONEY_GIVEN'), 'All results are MONEY_GIVEN');

        const { data: takenAccs } = await apiGet('/accounts?direction=MONEY_TAKEN');
        assert(takenAccs.length > 0, 'MONEY_TAKEN filter returns results');
        assert(takenAccs.every(a => a.direction === 'MONEY_TAKEN'), 'All results are MONEY_TAKEN');

        const { data: activeAccs } = await apiGet('/accounts?status=ACTIVE');
        assert(activeAccs.every(a => a.status === 'ACTIVE'), 'Status filter works');
    });

    // ─── Additional: Decimal rates work ──────────────────────
    await testAsync('BONUS: Decimal interest rates (12.5%) work', async () => {
        const { status, body } = await apiPost('/accounts', {
            person_id: ramesh.id, direction: 'MONEY_GIVEN', principal: 1000,
            interest_rate: 12.5, interest_frequency: 'MONTHLY',
            start_date: '2026-01-01', due_date: '2026-02-01', notes: 'decimal-rate-test'
        });
        assertEqual(status, 201, 'Created with decimal rate');
        assertEqual(body.data.interest_rate, 12.5, 'Rate stored as 12.5');
        createdIds.push(body.data.id);
    });

    // ─── Additional: CSS has Step 3 components ───────────────
    test('BONUS: CSS has Step 3 components', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf-8');
        assert(css.includes('.filter-bar'), 'Filter bar styles');
        assert(css.includes('.radio-card'), 'Radio card styles');
        assert(css.includes('.preview-card'), 'Preview card styles');
        assert(css.includes('.account-detail-'), 'Account detail styles');
        assert(css.includes('.form-row'), 'Form row layout');
    });

    // ─── Cleanup test accounts ───────────────────────────────
    // Note: We don't delete because API doesn't have account delete endpoint
    // and accounts have no delete route intentionally (financial records)

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✗ Crash:', err.message); process.exit(1); });
