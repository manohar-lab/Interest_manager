/**
 * Interest Manager — Step 2 Test Suite
 * People Management: 12 required test cases
 */

const path = require('path');
const fs = require('fs');

// ─── Test Runner ─────────────────────────────────────────────
let passed = 0;
let failed = 0;
let total = 0;

function test(name, fn) {
    total++;
    try {
        fn();
        passed++;
        console.log(`  ✅ Test ${total}: ${name}`);
    } catch (err) {
        failed++;
        console.log(`  ❌ Test ${total}: ${name}`);
        console.log(`      Error: ${err.message}`);
    }
}

async function testAsync(name, fn) {
    total++;
    try {
        await fn();
        passed++;
        console.log(`  ✅ Test ${total}: ${name}`);
    } catch (err) {
        failed++;
        console.log(`  ❌ Test ${total}: ${name}`);
        console.log(`      Error: ${err.message}`);
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(
            (message || 'Assertion failed') +
            ` — expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`
        );
    }
}

// ─── API Helpers ─────────────────────────────────────────────
const BASE = 'http://localhost:3000/api';

async function apiGet(url) {
    const res = await fetch(BASE + url);
    return res.json();
}

async function apiPost(url, data) {
    const res = await fetch(BASE + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return { status: res.status, body: await res.json() };
}

async function apiPut(url, data) {
    const res = await fetch(BASE + url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return { status: res.status, body: await res.json() };
}

async function apiDelete(url) {
    const res = await fetch(BASE + url, { method: 'DELETE' });
    return { status: res.status, body: await res.json() };
}

// ─── Main ────────────────────────────────────────────────────
async function runTests() {
    console.log('\n=== Interest Manager — Step 2 Test Suite ===\n');

    // ─── Test 1: Existing People ─────────────────────────────
    await testAsync('Existing people (Ramesh & Mahesh) appear correctly', async () => {
        const { data } = await apiGet('/people');
        assert(data.length >= 2, 'At least 2 people should exist');
        const ramesh = data.find(p => p.name === 'Ramesh');
        const mahesh = data.find(p => p.name === 'Mahesh');
        assert(ramesh, 'Ramesh should exist');
        assert(mahesh, 'Mahesh should exist');
        assert(ramesh.account_count === 3, `Ramesh should have 3 accounts, has ${ramesh.account_count}`);
        assert(mahesh.account_count === 1, `Mahesh should have 1 account, has ${mahesh.account_count}`);
    });

    // ─── Test 2: Category / Direction ────────────────────────
    await testAsync('Ramesh=Money Given To, Mahesh=Money Taken From', async () => {
        const { data } = await apiGet('/people');
        const ramesh = data.find(p => p.name === 'Ramesh');
        const mahesh = data.find(p => p.name === 'Mahesh');
        assert(ramesh.directions.includes('MONEY_GIVEN'), 'Ramesh should have MONEY_GIVEN direction');
        assert(mahesh.directions.includes('MONEY_TAKEN'), 'Mahesh should have MONEY_TAKEN direction');

        // Category filter
        const { data: givenPeople } = await apiGet('/people?category=MONEY_GIVEN');
        const { data: takenPeople } = await apiGet('/people?category=MONEY_TAKEN');
        assert(givenPeople.some(p => p.name === 'Ramesh'), 'Ramesh should appear in MONEY_GIVEN category');
        assert(takenPeople.some(p => p.name === 'Mahesh'), 'Mahesh should appear in MONEY_TAKEN category');
    });

    // ─── Test 3: Add Person ──────────────────────────────────
    await testAsync('Add Person (Suresh with phone 9999999999)', async () => {
        const { status, body } = await apiPost('/people', {
            name: 'Suresh',
            phone: '9999999999',
            notes: 'Test person from Step 2'
        });
        assertEqual(status, 201, 'Create status');
        assert(body.data, 'Response should contain data');
        assertEqual(body.data.name, 'Suresh', 'Name');
        assertEqual(body.data.phone, '9999999999', 'Phone');

        // Verify in listing
        const { data } = await apiGet('/people');
        const suresh = data.find(p => p.name === 'Suresh');
        assert(suresh, 'Suresh should appear in people list');
    });

    // ─── Test 4: Edit Person ─────────────────────────────────
    await testAsync('Edit Person (change Suresh phone number)', async () => {
        // Find Suresh
        const { data: all } = await apiGet('/people');
        const suresh = all.find(p => p.name === 'Suresh');
        assert(suresh, 'Suresh should exist');

        const { status, body } = await apiPut(`/people/${suresh.id}`, {
            name: 'Suresh',
            phone: '8888888888',
            notes: 'Phone changed in test'
        });
        assertEqual(status, 200, 'Update status');
        assertEqual(body.data.phone, '8888888888', 'Updated phone');

        // Verify original accounts not affected
        const { data: rameshDetail } = await apiGet('/people/1');
        assertEqual(rameshDetail.account_count, 3, 'Ramesh accounts unchanged after editing Suresh');
    });

    // ─── Test 5: Search by name ──────────────────────────────
    await testAsync('Search by name (Ramesh) and phone (9999)', async () => {
        // Name search
        const { data: nameResults } = await apiGet('/people?search=Ramesh');
        assert(nameResults.some(p => p.name === 'Ramesh'), 'Name search should find Ramesh');

        // Case insensitive
        const { data: caseResults } = await apiGet('/people?search=ramesh');
        assert(caseResults.some(p => p.name === 'Ramesh'), 'Case insensitive search should find Ramesh');

        // Phone search (partial)
        const { data: phoneResults } = await apiGet('/people?search=8888');
        assert(phoneResults.some(p => p.name === 'Suresh'), 'Phone search should find Suresh (8888888888)');
    });

    // ─── Test 6: Profile ─────────────────────────────────────
    await testAsync('Person profile loads with account count', async () => {
        const { data: ramesh } = await apiGet('/people/1');
        assertEqual(ramesh.name, 'Ramesh', 'Name');
        assertEqual(ramesh.account_count, 3, 'Account count');
        assertEqual(ramesh.given_count, 3, 'Given count');
        assertEqual(ramesh.taken_count, 0, 'Taken count');
        assert(ramesh.accounts.length === 3, 'Should return 3 account objects');
        assert(ramesh.directions.includes('MONEY_GIVEN'), 'Directions should include MONEY_GIVEN');
    });

    // ─── Test 7: Multiple accounts remain separate ───────────
    await testAsync('Ramesh 3 accounts remain separate (not merged)', async () => {
        const { data: ramesh } = await apiGet('/people/1');
        const accounts = ramesh.accounts;
        assertEqual(accounts.length, 3, 'Exactly 3 accounts');

        // Verify distinct values
        const principals = accounts.map(a => a.principal);
        const rates = accounts.map(a => a.interest_rate);
        const starts = accounts.map(a => a.start_date);

        // At least 2 different principals (200000 and 500000)
        assert(new Set(principals).size >= 2, 'Accounts should have different principals');
        // At least 2 different rates (15 and 18)
        assert(new Set(rates).size >= 2, 'Accounts should have different rates');
        // All 3 different start dates
        assertEqual(new Set(starts).size, 3, 'All accounts should have different start dates');
    });

    // ─── Test 8: Empty search ────────────────────────────────
    await testAsync('Search for nonexistent name returns empty', async () => {
        const { data } = await apiGet('/people?search=ZZZZNONEXISTENT');
        assertEqual(data.length, 0, 'No results for nonexistent search');
    });

    // ─── Test 9: Validation (empty name rejected) ────────────
    await testAsync('Validation: empty name is rejected', async () => {
        const { status: s1 } = await apiPost('/people', { name: '' });
        assertEqual(s1, 400, 'Empty name should be 400');

        const { status: s2 } = await apiPost('/people', { name: '   ' });
        assertEqual(s2, 400, 'Whitespace-only name should be 400');

        const { status: s3 } = await apiPost('/people', {});
        assertEqual(s3, 400, 'Missing name should be 400');
    });

    // ─── Test 10: Duplicate submission prevention ────────────
    await testAsync('Duplicate submission: rapid creates only create expected records', async () => {
        const beforeRes = await apiGet('/people');
        const beforeCount = beforeRes.data.length;

        // Rapid fire
        await apiPost('/people', { name: 'DuplicateTest1' });
        await apiPost('/people', { name: 'DuplicateTest2' });

        const afterRes = await apiGet('/people');
        assertEqual(afterRes.data.length, beforeCount + 2, 'Exactly 2 new people added');

        // Clean up
        const dup1 = afterRes.data.find(p => p.name === 'DuplicateTest1');
        const dup2 = afterRes.data.find(p => p.name === 'DuplicateTest2');
        if (dup1) await apiDelete(`/people/${dup1.id}`);
        if (dup2) await apiDelete(`/people/${dup2.id}`);
    });

    // ─── Test 11: UI files exist for responsive design ───────
    test('Responsive UI: CSS contains mobile-first breakpoints', () => {
        const cssPath = path.join(__dirname, '..', 'public', 'css', 'styles.css');
        const css = fs.readFileSync(cssPath, 'utf-8');
        assert(css.includes('min-width: 768px'), 'Tablet breakpoint exists');
        assert(css.includes('min-width: 1024px'), 'Desktop breakpoint exists');
        assert(css.includes('.search-input'), 'Search input styles exist');
        assert(css.includes('.category-tab'), 'Category tab styles exist');
        assert(css.includes('.modal-overlay'), 'Modal styles exist');
        assert(css.includes('.form-input'), 'Form input styles exist');
        assert(css.includes('.toast'), 'Toast notification styles exist');
        assert(css.includes('.profile-'), 'Profile styles exist');
    });

    // ─── Test 12: Delete protection for financial history ────
    await testAsync('Delete protection: cannot delete person with financial records', async () => {
        // Try to delete Ramesh (has 3 accounts)
        const { status, body } = await apiDelete('/people/1');
        assertEqual(status, 409, 'Should return 409 Conflict');
        assert(body.error.includes('financial history'), 'Error message should mention financial history');

        // Verify Ramesh still exists
        const { data: ramesh } = await apiGet('/people/1');
        assertEqual(ramesh.name, 'Ramesh', 'Ramesh should still exist');
        assertEqual(ramesh.account_count, 3, 'Ramesh accounts should be intact');
    });

    // ─── Cleanup: remove test person Suresh ──────────────────
    const { data: final } = await apiGet('/people');
    const suresh = final.find(p => p.name === 'Suresh');
    if (suresh) {
        await apiDelete(`/people/${suresh.id}`);
        console.log('\n  🧹 Cleaned up test person (Suresh)');
    }

    // ─── Summary ─────────────────────────────────────────────
    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => {
    console.error('  ✗ Test suite crashed:', err.message);
    process.exit(1);
});
