/**
 * Interest Manager — Step 3B Test Suite
 * Account List, Filtering, Search, Sorting, Formatting & States
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
    return r.json();
}

async function runTests() {
    console.log('\n=== Interest Manager — Step 3B Test Suite ===\n');

    // Test 1: Confirm all existing accounts appear
    await testAsync('Confirm all existing database accounts appear', async () => {
        const res = await apiGet('/accounts');
        assert(res.data && res.data.length >= 4, 'Should have at least 4 seed accounts');
    });

    // Test 2: Confirm Ramesh\'s three accounts are separate
    await testAsync('Confirm Ramesh\'s accounts are displayed as separate records', async () => {
        const { data: people } = await apiGet('/people');
        const ramesh = people.find(p => p.name === 'Ramesh');
        const res = await apiGet(`/accounts?person_id=${ramesh.id}`);
        assert(res.data.length >= 3, `Ramesh should have at least 3 accounts, got ${res.data.length}`);
        const ids = new Set(res.data.map(a => a.id));
        assertEqual(ids.size, res.data.length, 'All Ramesh accounts have distinct IDs');
    });

    // Test 3: Confirm Mahesh\'s MONEY_TAKEN account appears
    await testAsync('Confirm Mahesh\'s MONEY_TAKEN account appears', async () => {
        const { data: people } = await apiGet('/people');
        const mahesh = people.find(p => p.name === 'Mahesh');
        const res = await apiGet(`/accounts?person_id=${mahesh.id}`);
        assert(res.data.length >= 1, 'Mahesh has accounts');
        const takenAcc = res.data.find(a => a.direction === 'MONEY_TAKEN');
        assert(takenAcc, 'Mahesh has MONEY_TAKEN account');
        assertEqual(takenAcc.principal, 10000000, 'Mahesh principal is 1,00,000 in paisa');
    });

    // Test 4: Search for Ramesh
    await testAsync('Search by person name ("Ramesh")', async () => {
        const res = await apiGet('/accounts?search=Ramesh');
        assert(res.data.length >= 3, 'Search "Ramesh" returns Ramesh accounts');
        assert(res.data.every(a => a.person_name.includes('Ramesh')), 'All results belong to Ramesh');
    });

    // Test 4b: Search by Account ID
    await testAsync('Search by Account ID ("1")', async () => {
        const res = await apiGet('/accounts?search=1');
        assert(res.data.length >= 1, 'Search by ID "1" returns matching accounts');
    });

    // Test 5: Filter Money Lent
    await testAsync('Filter: Direction = MONEY_GIVEN (Money Lent)', async () => {
        const res = await apiGet('/accounts?direction=MONEY_GIVEN');
        assert(res.data.length >= 3, 'Returns MONEY_GIVEN accounts');
        assert(res.data.every(a => a.direction === 'MONEY_GIVEN'), 'All filtered accounts are MONEY_GIVEN');
    });

    // Test 6: Filter Money Taken
    await testAsync('Filter: Direction = MONEY_TAKEN (Money Taken)', async () => {
        const res = await apiGet('/accounts?direction=MONEY_TAKEN');
        assert(res.data.length >= 1, 'Returns MONEY_TAKEN accounts');
        assert(res.data.every(a => a.direction === 'MONEY_TAKEN'), 'All filtered accounts are MONEY_TAKEN');
    });

    // Test 7: Filter Active
    await testAsync('Filter: Status = ACTIVE', async () => {
        const res = await apiGet('/accounts?status=ACTIVE');
        assert(res.data.length >= 4, 'Returns ACTIVE accounts');
        assert(res.data.every(a => a.status === 'ACTIVE'), 'All filtered accounts are ACTIVE');
    });

    // Test 8: Sorting by due_date
    await testAsync('Sort by due_date ASC and DESC', async () => {
        const asc = await apiGet('/accounts?sort_by=due_date&sort_order=ASC');
        const desc = await apiGet('/accounts?sort_by=due_date&sort_order=DESC');
        assert(asc.data.length > 0 && desc.data.length > 0, 'Sorting query succeeds');
        if (asc.data.length > 1) {
            assert(asc.data[0].due_date <= asc.data[asc.data.length - 1].due_date, 'ASC due date ordered correctly');
            assert(desc.data[0].due_date >= desc.data[desc.data.length - 1].due_date, 'DESC due date ordered correctly');
        }
    });

    // Test 8b: Sorting by principal
    await testAsync('Sort by principal ASC and DESC', async () => {
        const asc = await apiGet('/accounts?sort_by=principal&sort_order=ASC');
        const desc = await apiGet('/accounts?sort_by=principal&sort_order=DESC');
        assert(asc.data[0].principal <= asc.data[asc.data.length - 1].principal, 'ASC principal ordered');
        assert(desc.data[0].principal >= desc.data[desc.data.length - 1].principal, 'DESC principal ordered');
    });

    // Test 9: Empty search returns zero results without crashing
    await testAsync('Empty search for non-existent name returns empty array', async () => {
        const res = await apiGet('/accounts?search=NonExistentPersonName123');
        assertEqual(res.data.length, 0, 'Returns empty array for unmatched search');
    });

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
