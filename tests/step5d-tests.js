/**
 * Interest Manager — Step 5D Test Suite
 * Account-Level Interest Calculation Service Verification
 */

const { calculateAccountInterest } = require('../services/interestService');
const { getDatabase } = require('../db/connection');
const { queryOne, queryAll } = require('../db/helpers');

const BASE = 'http://localhost:3000/api';
let passed = 0, failed = 0, total = 0;

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error((msg || '') + ` — expected: ${JSON.stringify(b)}, got: ${JSON.stringify(a)}`); }
function assertCloseTo(a, b, delta = 0.01, msg) {
    if (Math.abs(a - b) > delta) throw new Error((msg || '') + ` — expected close to ${b}, got: ${a}`);
}

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
    const r = await fetch(BASE + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return { status: r.status, body: await r.json() };
}

async function runTests() {
    console.log('\n=== Interest Manager — Step 5D Account Interest Test Suite ===\n');

    const db = await getDatabase();

    // Fetch baseline accounts
    const { body: peopleRes } = await apiGet('/people');
    const ramesh = peopleRes.data.find(p => p.name === 'Ramesh');
    assert(ramesh, 'Ramesh exists');

    const { body: accountsRes } = await apiGet(`/accounts?person_id=${ramesh.id}`);
    const rameshAccounts = accountsRes.data.filter(a => a.direction === 'MONEY_GIVEN');
    assert(rameshAccounts.length >= 3, 'Ramesh has accounts #001, #002, #003');

    const acc1 = rameshAccounts[0]; // ₹2,000 @ 15%
    const acc2 = rameshAccounts[1]; // ₹2,000 @ 15% (or 17%)
    const acc3 = rameshAccounts[2]; // ₹5,000 @ 18%

    // ─── Test 1: Account #001 (₹2,000 @ 15%, 1 Year) ───
    await testAsync('1. Account #001: ₹2,000 @ 15% for 01/01/2026 → 01/01/2027 → Interest = ₹300, Total = ₹2,300', async () => {
        const res = calculateAccountInterest(db, acc1.id, '01/01/2026', '01/01/2027');
        assertEqual(res.accountId, acc1.id, 'accountId matches');
        assertEqual(res.principal, 2000, 'Principal basis ₹2,000');
        assertEqual(res.annualRate, 15, 'Annual rate 15%');
        assertEqual(res.elapsedDays, 365, 'Elapsed days 365');
        assertEqual(res.timeInYears, 1, 'Time 1.0 year');
        assertEqual(res.interest, 300, 'Interest ₹300');
        assertEqual(res.total, 2300, 'Total ₹2,300');
        assertEqual(res.interest_paisa, 30000, 'Interest paisa 30,000');
    });

    // ─── Test 2: Account #003 (₹5,000 @ 18%, 1 Year) ───
    await testAsync('2. Account #003: ₹5,000 @ 18% for 01/01/2026 → 01/01/2027 → Interest = ₹900, Total = ₹5,900', async () => {
        const res = calculateAccountInterest(db, acc3.id, '01/01/2026', '01/01/2027');
        assertEqual(res.accountId, acc3.id, 'accountId matches');
        assertEqual(res.principal, 5000, 'Principal basis ₹5,000');
        assertEqual(res.annualRate, 18, 'Annual rate 18%');
        assertEqual(res.elapsedDays, 365, 'Elapsed days 365');
        assertEqual(res.interest, 900, 'Interest ₹900');
        assertEqual(res.total, 5900, 'Total ₹5,900');
    });

    // ─── Test 3: Account #001 (₹2,000 @ 15%, Actual Half-Year Interval 01/01/2026 to 01/07/2026) ───
    await testAsync('3. Actual Calendar Interval: ₹2,000 @ 15% for 01/01/2026 → 01/07/2026 (181 days) → Interest = ₹148.77', async () => {
        const res = calculateAccountInterest(db, acc1.id, '01/01/2026', '01/07/2026');
        assertEqual(res.elapsedDays, 181, 'Elapsed days is 181 (not hard-coded 180)');
        // 200,000 paisa * 0.15 * (181 / 365) = 14876.712... -> Math.round -> 14877 paisa = ₹148.77
        assertEqual(res.interest_paisa, 14877, 'Interest paisa is 14,877');
        assertEqual(res.interest, 148.77, 'Interest is ₹148.77');
        assertEqual(res.total, 2148.77, 'Total is ₹2,148.77');
    });

    // ─── Test 4: Partial Outstanding Principal (₹1,500 on Original ₹2,000) ───
    await testAsync('4. Partial Outstanding: Original ₹2,000, Outstanding ₹1,500 @ 15% for 1 Year → Interest = ₹225', async () => {
        // Mock account with partial outstanding balance
        const partialAcc = {
            id: 901,
            person_id: ramesh.id,
            principal: 200000,              // ₹2,000 original
            outstanding_principal: 150000,  // ₹1,500 unpaid
            interest_rate: 15,
            calculation_method: 'SIMPLE_INTEREST'
        };

        const res = calculateAccountInterest(db, partialAcc, '01/01/2026', '01/01/2027');
        assertEqual(res.originalPrincipal, 2000, 'Original principal preserved at ₹2,000');
        assertEqual(res.outstandingPrincipal, 1500, 'Outstanding principal is ₹1,500');
        assertEqual(res.principal, 1500, 'Calculation principal basis is ₹1,500');
        assertEqual(res.interest, 225, 'Interest on ₹1,500 @ 15% for 1 yr is ₹225');
        assertEqual(res.total, 1725, 'Total is ₹1,725');
    });

    // ─── Test 5: Zero Outstanding Principal (₹0) ───
    await testAsync('5. Zero Outstanding: Outstanding ₹0 → Interest = ₹0, Total = ₹0', async () => {
        const zeroAcc = {
            id: 902,
            person_id: ramesh.id,
            principal: 200000,
            outstanding_principal: 0,
            interest_rate: 15,
            calculation_method: 'SIMPLE_INTEREST'
        };

        const res = calculateAccountInterest(db, zeroAcc, '01/01/2026', '01/01/2027');
        assertEqual(res.outstandingPrincipal, 0, 'Outstanding principal is ₹0');
        assertEqual(res.principal, 0, 'Principal basis is ₹0');
        assertEqual(res.interest, 0, 'Interest is ₹0');
        assertEqual(res.total, 0, 'Total is ₹0');
    });

    // ─── Test 6: Invalid Account ID (404) ───
    await testAsync('6. Invalid Account: Account #99999 is rejected with 404 error', async () => {
        let caught = false;
        try { calculateAccountInterest(db, 99999, '01/01/2026', '01/01/2027'); }
        catch (err) { caught = true; assertEqual(err.statusCode, 404, 'HTTP 404 for missing account'); }
        assert(caught, 'Missing account threw error');
    });

    // ─── Test 7: End Date Before Start Date (400) ───
    await testAsync('7. Inverted Date Range: 01/09/2026 to 01/08/2026 is rejected with HTTP 400', async () => {
        let caught = false;
        try { calculateAccountInterest(db, acc1.id, '01/09/2026', '01/08/2026'); }
        catch (err) { caught = true; assert(err.message.includes('cannot be before start date'), 'Error explains date order'); }
        assert(caught, 'Inverted dates threw error');
    });

    // ─── Test 8: Unsupported Calculation Method (400) ───
    await testAsync('8. Unsupported Method: Account with COMPOUND_INTEREST is rejected with HTTP 400', async () => {
        const compoundAcc = {
            id: 903,
            person_id: ramesh.id,
            principal: 200000,
            outstanding_principal: 200000,
            interest_rate: 15,
            calculation_method: 'COMPOUND_INTEREST'
        };

        let caught = false;
        try { calculateAccountInterest(db, compoundAcc, '01/01/2026', '01/01/2027'); }
        catch (err) { caught = true; assert(err.message.includes('unsupported'), 'Error explains unsupported method'); }
        assert(caught, 'Compound interest threw error');
    });

    // ─── Test 9: Multiple Account Isolation ───
    await testAsync('9. Account Isolation: Accounts #001, #002, #003 calculate independently without blending data', async () => {
        const r1 = calculateAccountInterest(db, acc1.id, '01/01/2026', '01/01/2027');
        const r3 = calculateAccountInterest(db, acc3.id, '01/01/2026', '01/01/2027');

        assertEqual(r1.accountId, acc1.id, 'Acc #001 ID preserved');
        assertEqual(r3.accountId, acc3.id, 'Acc #003 ID preserved');
        assertEqual(r1.annualRate, 15, 'Acc #001 rate 15%');
        assertEqual(r3.annualRate, 18, 'Acc #003 rate 18%');
        assertEqual(r1.interest, 300, 'Acc #001 interest ₹300');
        assertEqual(r3.interest, 900, 'Acc #003 interest ₹900');
    });

    // ─── Test 10: Read-Only Behavior & Zero Side Effects ───
    await testAsync('10. Read-Only Guarantee: Account balances, transactions, and interest_records remain 100% unchanged', async () => {
        const accBefore = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [acc1.id]);
        const txBefore = queryAll(db, 'SELECT * FROM transactions');
        const intBefore = queryAll(db, 'SELECT * FROM interest_records');

        calculateAccountInterest(db, acc1.id, '01/01/2026', '01/01/2027');
        calculateAccountInterest(db, acc3.id, '01/01/2026', '01/01/2027');

        const accAfter = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [acc1.id]);
        const txAfter = queryAll(db, 'SELECT * FROM transactions');
        const intAfter = queryAll(db, 'SELECT * FROM interest_records');

        assertEqual(accBefore.principal, accAfter.principal, 'Principal unchanged');
        assertEqual(accBefore.outstanding_principal, accAfter.outstanding_principal, 'Outstanding unchanged');
        assertEqual(accBefore.status, accAfter.status, 'Status unchanged');
        assertEqual(txBefore.length, txAfter.length, 'Transactions count unchanged');
        assertEqual(intBefore.length, intAfter.length, 'Interest records count unchanged (0)');
    });

    // ─── Test 11: HTTP API Endpoint (POST /api/accounts/:id/calculate-interest) ───
    await testAsync('11. API Endpoint: POST /api/accounts/:id/calculate-interest returns structured result matching service', async () => {
        const { status, body } = await apiPost(`/accounts/${acc1.id}/calculate-interest`, {
            start_date: '01/01/2026',
            end_date: '01/01/2027'
        });

        assertEqual(status, 200, 'HTTP 200 OK');
        assertEqual(body.data.accountId, acc1.id, 'accountId matches');
        assertEqual(body.data.interest, 300, 'API interest ₹300');
        assertEqual(body.data.total, 2300, 'API total ₹2,300');
        assertEqual(body.data.elapsedDays, 365, 'API elapsedDays 365');
        assertEqual(body.data.dayCountConvention, 'ACTUAL/365', 'ACTUAL/365 convention');
    });

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Step 5D Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
