/**
 * Interest Manager — Step 5A Test Suite
 * Interest Calculation Foundation & Validation Verification
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
    console.log('\n=== Interest Manager — Step 5A Interest Foundation Test Suite ===\n');

    // Fetch baseline data
    const { body: peopleRes } = await apiGet('/people');
    const ramesh = peopleRes.data.find(p => p.name === 'Ramesh');
    assert(ramesh, 'Ramesh exists in DB');

    // Create Test Fixture Account A
    // Account A: Principal: ₹2,000, Outstanding: ₹2,000, Rate: 15%, Frequency: MONTHLY, Method: SIMPLE_INTEREST, Start: 01/08/2026, Due: 01/09/2026
    const { body: accARes } = await apiPost('/accounts', {
        person_id: ramesh.id,
        principal: 2000,
        interest_rate: 15,
        interest_frequency: 'MONTHLY',
        calculation_method: 'SIMPLE_INTEREST',
        direction: 'MONEY_GIVEN',
        start_date: '01/08/2026',
        due_date: '01/09/2026',
        notes: 'Fixture Account A (Step 5A)'
    });
    const accA = accARes.data;
    assert(accA && accA.id, 'Account A fixture created');

    // Create Test Fixture Account B
    // Account B: Principal: ₹5,000, Outstanding: ₹5,000, Rate: 18%, Frequency: MONTHLY, Method: SIMPLE_INTEREST, Start: 10/09/2026, Due: 10/10/2026
    const { body: accBRes } = await apiPost('/accounts', {
        person_id: ramesh.id,
        principal: 5000,
        interest_rate: 18,
        interest_frequency: 'MONTHLY',
        calculation_method: 'SIMPLE_INTEREST',
        direction: 'MONEY_GIVEN',
        start_date: '10/09/2026',
        due_date: '10/10/2026',
        notes: 'Fixture Account B (Step 5A)'
    });
    const accB = accBRes.data;
    assert(accB && accB.id, 'Account B fixture created');

    // ─── Test 1: Verify SIMPLE_INTEREST is recognized ───
    await testAsync('1. Calculation Method: Verify SIMPLE_INTEREST is recognized and active in foundation config', async () => {
        const { status, body } = await apiGet('/interest/foundation');
        assertEqual(status, 200, 'HTTP 200');
        assert(body.data.supported_calculation_methods.includes('SIMPLE_INTEREST'), 'SIMPLE_INTEREST recognized');
        assertEqual(body.data.supported_calculation_methods.length, 1, 'Only SIMPLE_INTEREST active');
    });

    // ─── Test 2: Verify DAILY, WEEKLY, MONTHLY, YEARLY are recognized ───
    await testAsync('2. Frequencies: Verify DAILY, WEEKLY, MONTHLY, YEARLY are structurally supported', async () => {
        const { body } = await apiGet('/interest/foundation');
        const freqs = body.data.supported_frequencies;
        assert(freqs.includes('DAILY'), 'DAILY recognized');
        assert(freqs.includes('WEEKLY'), 'WEEKLY recognized');
        assert(freqs.includes('MONTHLY'), 'MONTHLY recognized');
        assert(freqs.includes('YEARLY'), 'YEARLY recognized');
    });

    // ─── Test 3: Verify invalid frequency is rejected ───
    await testAsync('3. Frequency Validation: Invalid frequency is rejected by validation engine', async () => {
        const res = await apiPost('/interest/validate', {
            account_id: accA.id,
            period: { start_date: '01/08/2026', end_date: '31/08/2026' },
            calculation_method: 'SIMPLE_INTEREST'
        });
        assertEqual(res.status, 200, 'Valid frequency passes');

        // Test with mocked invalid frequency via direct service validation
        const { validateCalculationInput } = require('../services/interestService');
        let caught = false;
        try {
            validateCalculationInput(
                { id: 99, principal: 200000, outstanding_principal: 200000, interest_rate: 15, interest_frequency: 'HOURLY', calculation_method: 'SIMPLE_INTEREST' },
                { start_date: '2026-08-01', end_date: '2026-08-31' }
            );
        } catch (e) {
            caught = true;
            assert(e.message.includes('invalid'), 'Error indicates invalid frequency');
        }
        assert(caught, 'Invalid frequency was rejected');
    });

    // ─── Test 4: Verify invalid calculation method is rejected ───
    await testAsync('4. Method Validation: Invalid calculation method (e.g. COMPOUND_INTEREST) is rejected', async () => {
        const res = await apiPost('/interest/validate', {
            account_id: accA.id,
            period: { start_date: '01/08/2026', end_date: '31/08/2026' },
            calculation_method: 'COMPOUND_INTEREST'
        });
        assertEqual(res.status, 400, 'HTTP 400 for unsupported calculation method');
        assert(res.body.error.includes('unsupported'), 'Error explains unsupported method');
    });

    // ─── Test 5: Verify invalid account is rejected ───
    await testAsync('5. Account Validation: Non-existent account or invalid account parameters are rejected', async () => {
        const res404 = await apiPost('/interest/validate', {
            account_id: 99999,
            period: { start_date: '01/08/2026', end_date: '31/08/2026' }
        });
        assertEqual(res404.status, 404, 'HTTP 404 for missing account');

        const { validateCalculationInput } = require('../services/interestService');
        let caught = false;
        try {
            validateCalculationInput(
                { id: 1, principal: 0, outstanding_principal: 0, interest_rate: 15, interest_frequency: 'MONTHLY' },
                { start_date: '2026-08-01', end_date: '2026-08-31' }
            );
        } catch (e) {
            caught = true;
            assert(e.message.includes('principal'), 'Principal <= 0 rejected');
        }
        assert(caught, 'Zero principal rejected');
    });

    // ─── Test 6: Verify invalid calculation period is rejected ───
    await testAsync('6. Period Validation: End date before start date or invalid dates are rejected (HTTP 400)', async () => {
        // End date before start date
        const resInverted = await apiPost('/interest/validate', {
            account_id: accA.id,
            period: { start_date: '01/09/2026', end_date: '01/08/2026' }
        });
        assertEqual(resInverted.status, 400, 'HTTP 400 for inverted period');
        assert(resInverted.body.error.includes('cannot be before start_date'), 'Error message explains date ordering');

        // Invalid date string
        const resBadDate = await apiPost('/interest/validate', {
            account_id: accA.id,
            period: { start_date: 'not-a-date', end_date: '01/09/2026' }
        });
        assertEqual(resBadDate.status, 400, 'HTTP 400 for malformed date');
    });

    // ─── Test 7: Verify rate representation is documented ───
    await testAsync('7. Rate Representation: Verify 15 means 15% (0.15 decimal multiplier), not 1500%', async () => {
        const { RATE_REPRESENTATION } = require('../services/interestService');
        assertEqual(RATE_REPRESENTATION.toDecimal(15), 0.15, '15 converted to decimal is 0.15');
        assertEqual(RATE_REPRESENTATION.toPercentageString(15), '15%', '15 formatted as 15%');
        assertEqual(RATE_REPRESENTATION.toDecimal(18.5), 0.185, '18.5 converted to decimal is 0.185');

        const { body } = await apiGet('/interest/foundation');
        assertEqual(body.data.rate_representation.type, 'NOMINAL_PERCENTAGE', 'Documented as NOMINAL_PERCENTAGE');
    });

    // ─── Test 8: Verify original and outstanding principal remain unchanged ───
    await testAsync('8. Principal Preservation: Validating interest calculation does NOT modify account balances', async () => {
        const { body: aBefore } = await apiGet(`/accounts/${accA.id}`);

        await apiPost('/interest/validate', {
            account_id: accA.id,
            period: { start_date: '01/08/2026', end_date: '31/08/2026' },
            principal_basis: 'ORIGINAL'
        });

        await apiPost('/interest/validate', {
            account_id: accA.id,
            period: { start_date: '01/08/2026', end_date: '31/08/2026' },
            principal_basis: 'OUTSTANDING'
        });

        const { body: aAfter } = await apiGet(`/accounts/${accA.id}`);
        assertEqual(aAfter.data.principal, aBefore.data.principal, 'Original principal unchanged');
        assertEqual(aAfter.data.outstanding_principal, aBefore.data.outstanding_principal, 'Outstanding principal unchanged');
    });

    // ─── Test 9: Verify Account #001 and Account #002 can be passed independently ───
    await testAsync('9. Account Isolation: Account A and Account B are validated independently with distinct parameters', async () => {
        const { body: valA } = await apiPost('/interest/validate', {
            account_id: accA.id,
            period: { start_date: '01/08/2026', end_date: '01/09/2026' }
        });
        assertEqual(valA.data.account_id, accA.id, 'Account A ID confirmed');
        assertEqual(valA.data.interest_rate, 15, 'Account A rate is 15%');
        assertEqual(valA.data.principal_basis.amount_paisa, 200000, 'Account A principal is ₹2,000');

        const { body: valB } = await apiPost('/interest/validate', {
            account_id: accB.id,
            period: { start_date: '10/09/2026', end_date: '10/10/2026' }
        });
        assertEqual(valB.data.account_id, accB.id, 'Account B ID confirmed');
        assertEqual(valB.data.interest_rate, 18, 'Account B rate is 18%');
        assertEqual(valB.data.principal_basis.amount_paisa, 500000, 'Account B principal is ₹5,000');
    });

    // ─── Test 10: Verify no automatic interest records are created ───
    await testAsync('10. No Automatic Accrual: Foundation validation leaves interest_records table empty (0 records)', async () => {
        const { queryAll } = require('../db/helpers');
        const { getDatabase } = require('../db/connection');
        const db = await getDatabase();

        const records = queryAll(db, 'SELECT * FROM interest_records');
        assertEqual(records.length, 0, 'No automatic interest records exist in database');
    });

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Step 5A Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
