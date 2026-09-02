/**
 * Interest Manager — Step 3C Test Suite
 * Account Detail Page
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

async function runTests() {
    console.log('\n=== Interest Manager — Step 3C Test Suite ===\n');

    // Load Ramesh & Mahesh IDs
    const { body: peopleRes } = await apiGet('/people');
    const ramesh = peopleRes.data.find(p => p.name === 'Ramesh');
    const mahesh = peopleRes.data.find(p => p.name === 'Mahesh');

    const { body: rameshAccs } = await apiGet(`/accounts?person_id=${ramesh.id}`);
    const { body: maheshAccs } = await apiGet(`/accounts?person_id=${mahesh.id}`);

    assert(rameshAccs.data.length >= 3, 'Ramesh has 3+ accounts');
    assert(maheshAccs.data.length >= 1, 'Mahesh has 1+ account');

    const acc1 = rameshAccs.data[0];
    const acc2 = rameshAccs.data[1];
    const acc3 = rameshAccs.data[2];
    const maheshAcc = maheshAccs.data[0];

    // Test 1: Open Account #1
    await testAsync('Open Ramesh Account #1 details', async () => {
        const { status, body } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(status, 200, 'HTTP status');
        assertEqual(body.data.id, acc1.id, 'Account ID');
        assertEqual(body.data.person_name, 'Ramesh', 'Person name');
        assertEqual(body.data.direction, 'MONEY_GIVEN', 'Direction');
        assertEqual(body.data.principal, 200000, 'Original principal (2000 INR)');
        assertEqual(body.data.outstanding_principal, 200000, 'Outstanding principal (2000 INR)');
        assertEqual(body.data.interest_rate, 15, 'Rate');
        assertEqual(body.data.interest_frequency, 'MONTHLY', 'Frequency');
        assertEqual(body.data.calculation_method, 'SIMPLE_INTEREST', 'Method');
        assertEqual(body.data.start_date, '2026-08-01', 'Start date');
        assertEqual(body.data.due_date, '2026-09-01', 'Due date');
        assertEqual(body.data.status, 'ACTIVE', 'Status');
    });

    // Test 2: Open Account #2
    await testAsync('Open Ramesh Account #2 details', async () => {
        const { status, body } = await apiGet(`/accounts/${acc2.id}`);
        assertEqual(status, 200, 'HTTP status');
        assertEqual(body.data.id, acc2.id, 'Account ID');
        assertEqual(body.data.start_date, '2026-09-01', 'Start date');
    });

    // Test 3: Open Account #3
    await testAsync('Open Ramesh Account #3 details', async () => {
        const { status, body } = await apiGet(`/accounts/${acc3.id}`);
        assertEqual(status, 200, 'HTTP status');
        assertEqual(body.data.id, acc3.id, 'Account ID');
        assertEqual(body.data.principal, 500000, 'Principal 5000 INR');
        assertEqual(body.data.interest_rate, 18, 'Rate 18%');
    });

    // Test 4: Open Mahesh account
    await testAsync('Open Mahesh MONEY_TAKEN account details', async () => {
        const { status, body } = await apiGet(`/accounts/${maheshAcc.id}`);
        assertEqual(status, 200, 'HTTP status');
        assertEqual(body.data.person_name, 'Mahesh', 'Person name');
        assertEqual(body.data.direction, 'MONEY_TAKEN', 'Direction');
        assertEqual(body.data.principal, 10000000, 'Principal 1,00,000 INR');
        assertEqual(body.data.interest_rate, 10, 'Rate 10%');
    });

    // Test 5: Original vs Outstanding principal separation
    await testAsync('Verify principal and outstanding_principal are separate fields', async () => {
        const { body } = await apiGet(`/accounts/${acc1.id}`);
        assert(body.data.hasOwnProperty('principal'), 'Has principal');
        assert(body.data.hasOwnProperty('outstanding_principal'), 'Has outstanding_principal');
    });

    // Test 6: Invalid Account ID (404)
    await testAsync('Open non-existent account ID returns 404', async () => {
        const { status, body } = await apiGet('/accounts/999999');
        assertEqual(status, 404, '404 status');
        assert(body.error.toLowerCase().includes('not found'), 'Error message says Not Found');
    });

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
