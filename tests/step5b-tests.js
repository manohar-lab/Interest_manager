/**
 * Interest Manager — Step 5B Test Suite
 * Simple Interest Calculation Engine Verification
 */

const { calculateSimpleInterest } = require('../services/interestService');
const BASE = 'http://localhost:3000/api';
let passed = 0, failed = 0, total = 0;

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error((msg || '') + ` — expected: ${JSON.stringify(b)}, got: ${JSON.stringify(a)}`); }

async function testAsync(name, fn) {
    total++;
    try { await fn(); passed++; console.log(`  ✅ Test ${total}: ${name}`); }
    catch (err) { failed++; console.log(`  ❌ Test ${total}: ${name}`); console.log(`      Error: ${err.message}`); }
}

async function apiPost(url, data) {
    const r = await fetch(BASE + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return { status: r.status, body: await r.json() };
}
async function apiGet(url) {
    const r = await fetch(BASE + url);
    return { status: r.status, body: await r.json() };
}

async function runTests() {
    console.log('\n=== Interest Manager — Step 5B Simple Interest Engine Test Suite ===\n');

    // ─── Test 1: Test Case 1 — Basic Annual Calculation ───
    await testAsync('1. Test Case 1 (Basic): ₹2,000 @ 15% for 1 year → Interest = ₹300, Total = ₹2,300', async () => {
        const res = calculateSimpleInterest(2000, 15, 1);
        assertEqual(res.principal, 2000, 'Principal ₹2,000');
        assertEqual(res.rate, 15, 'Rate 15%');
        assertEqual(res.time, 1, 'Time 1 year');
        assertEqual(res.interest, 300, 'Interest ₹300');
        assertEqual(res.total, 2300, 'Total ₹2,300');
        assertEqual(res.interest_paisa, 30000, 'Interest paisa 30,000');
        assertEqual(res.total_paisa, 230000, 'Total paisa 230,000');
    });

    // ─── Test 2: Test Case 2 — Half Year Calculation ───
    await testAsync('2. Test Case 2 (Half Year): ₹2,000 @ 15% for 0.5 year → Interest = ₹150, Total = ₹2,150', async () => {
        const res = calculateSimpleInterest(2000, 15, 0.5);
        assertEqual(res.principal, 2000, 'Principal ₹2,000');
        assertEqual(res.interest, 150, 'Interest ₹150');
        assertEqual(res.total, 2150, 'Total ₹2,150');
        assertEqual(res.interest_paisa, 15000, 'Interest paisa 15,000');
    });

    // ─── Test 3: Test Case 3 — Three Months Calculation ───
    await testAsync('3. Test Case 3 (Three Months): ₹2,000 @ 15% for 0.25 year → Interest = ₹75, Total = ₹2,075', async () => {
        const res = calculateSimpleInterest(2000, 15, 0.25);
        assertEqual(res.principal, 2000, 'Principal ₹2,000');
        assertEqual(res.interest, 75, 'Interest ₹75');
        assertEqual(res.total, 2075, 'Total ₹2,075');
        assertEqual(res.interest_paisa, 7500, 'Interest paisa 7,500');
    });

    // ─── Test 4: Test Case 4 — Zero Time Calculation ───
    await testAsync('4. Test Case 4 (Zero Time): ₹2,000 @ 15% for 0 year → Interest = ₹0, Total = ₹2,000', async () => {
        const res = calculateSimpleInterest(2000, 15, 0);
        assertEqual(res.principal, 2000, 'Principal ₹2,000');
        assertEqual(res.interest, 0, 'Interest ₹0');
        assertEqual(res.total, 2000, 'Total ₹2,000');
        assertEqual(res.interest_paisa, 0, 'Interest paisa 0');
    });

    // ─── Test 5: Test Case 5 — Different Principal ───
    await testAsync('5. Test Case 5 (Different Principal): ₹5,000 @ 18% for 1 year → Interest = ₹900, Total = ₹5,900', async () => {
        const res = calculateSimpleInterest(5000, 18, 1);
        assertEqual(res.principal, 5000, 'Principal ₹5,000');
        assertEqual(res.interest, 900, 'Interest ₹900');
        assertEqual(res.total, 5900, 'Total ₹5,900');
        assertEqual(res.interest_paisa, 90000, 'Interest paisa 90,000');
    });

    // ─── Test 6: Test Case 6 — Different Rate ───
    await testAsync('6. Test Case 6 (Different Rate): ₹10,000 @ 10% for 1 year → Interest = ₹1,000, Total = ₹11,000', async () => {
        const res = calculateSimpleInterest(10000, 10, 1);
        assertEqual(res.principal, 10000, 'Principal ₹10,000');
        assertEqual(res.interest, 1000, 'Interest ₹1,000');
        assertEqual(res.total, 11000, 'Total ₹11,000');
    });

    // ─── Test 7: Test Case 7 — Decimal Rate ───
    await testAsync('7. Test Case 7 (Decimal Rate): ₹2,000 @ 15.5% for 1 year → Interest = ₹310, Total = ₹2,310', async () => {
        const res = calculateSimpleInterest(2000, 15.5, 1);
        assertEqual(res.rate, 15.5, 'Rate 15.5%');
        assertEqual(res.interest, 310, 'Interest ₹310');
        assertEqual(res.total, 2310, 'Total ₹2,310');
        assertEqual(res.interest_paisa, 31000, 'Interest paisa 31,000');
    });

    // ─── Test 8: Test Case 8 — Decimal Principal ───
    await testAsync('8. Test Case 8 (Decimal Principal): ₹2,500.50 @ 12% for 1 year → Interest = ₹300.06, Total = ₹2,800.56', async () => {
        const res = calculateSimpleInterest(2500.50, 12, 1);
        assertEqual(res.principal, 2500.5, 'Principal ₹2,500.50');
        assertEqual(res.interest, 300.06, 'Interest ₹300.06');
        assertEqual(res.total, 2800.56, 'Total ₹2,800.56');
        assertEqual(res.principal_paisa, 250050, 'Principal paisa 250,050');
        assertEqual(res.interest_paisa, 30006, 'Interest paisa 30,006');
    });

    // ─── Test 9: Test Case 9 — Invalid Principal (Zero) ───
    await testAsync('9. Test Case 9 (Zero Principal): Principal = ₹0 is rejected with validation error', async () => {
        let caught = false;
        try { calculateSimpleInterest(0, 15, 1); }
        catch (err) { caught = true; assert(err.message.includes('greater than zero'), 'Error explains zero principal'); }
        assert(caught, 'Zero principal threw exception');
    });

    // ─── Test 10: Test Case 10 — Negative Principal ───
    await testAsync('10. Test Case 10 (Negative Principal): Principal = -₹2,000 is rejected with validation error', async () => {
        let caught = false;
        try { calculateSimpleInterest(-2000, 15, 1); }
        catch (err) { caught = true; assert(err.message.includes('greater than zero'), 'Error explains negative principal'); }
        assert(caught, 'Negative principal threw exception');
    });

    // ─── Test 11: Test Case 11 — Negative Rate ───
    await testAsync('11. Test Case 11 (Negative Rate): Rate = -5% is rejected with validation error', async () => {
        let caught = false;
        try { calculateSimpleInterest(2000, -5, 1); }
        catch (err) { caught = true; assert(err.message.includes('negative'), 'Error explains negative rate'); }
        assert(caught, 'Negative rate threw exception');
    });

    // ─── Test 12: Test Case 12 — Negative Time ───
    await testAsync('12. Test Case 12 (Negative Time): Time = -1 is rejected with validation error', async () => {
        let caught = false;
        try { calculateSimpleInterest(2000, 15, -1); }
        catch (err) { caught = true; assert(err.message.includes('negative'), 'Error explains negative time'); }
        assert(caught, 'Negative time threw exception');
    });

    // ─── Test 13: Pure Function & Determinism ───
    await testAsync('13. Pure Function: Multiple invocations with identical parameters yield identical outputs without side effects', async () => {
        const r1 = calculateSimpleInterest(2000, 15, 1);
        const r2 = calculateSimpleInterest(2000, 15, 1);
        const r3 = calculateSimpleInterest(2000, 15, 1);
        assertEqual(JSON.stringify(r1), JSON.stringify(r2), 'r1 === r2');
        assertEqual(JSON.stringify(r2), JSON.stringify(r3), 'r2 === r3');
    });

    // ─── Test 14: Account Independence ───
    await testAsync('14. Account Independence: Account #001 (₹2,000 @ 15%) and Account #003 (₹5,000 @ 18%) remain strictly independent', async () => {
        const acc1Result = calculateSimpleInterest(2000, 15, 1);
        const acc3Result = calculateSimpleInterest(5000, 18, 1);

        assertEqual(acc1Result.interest, 300, 'Account #001 interest = ₹300');
        assertEqual(acc3Result.interest, 900, 'Account #003 interest = ₹900');
        assert(acc1Result.interest !== acc3Result.interest, 'Calculations are independent');
    });

    // ─── Test 15: No Database Persistence ───
    await testAsync('15. No DB Persistence: Calling calculateSimpleInterest does NOT create any database records', async () => {
        const { queryAll } = require('../db/helpers');
        const { getDatabase } = require('../db/connection');
        const db = await getDatabase();

        const recordsBefore = queryAll(db, 'SELECT * FROM interest_records');
        calculateSimpleInterest(2000, 15, 1);
        calculateSimpleInterest(5000, 18, 0.5);
        const recordsAfter = queryAll(db, 'SELECT * FROM interest_records');

        assertEqual(recordsBefore.length, recordsAfter.length, 'No database records created');
    });

    // ─── Test 16: API Endpoint Verification ───
    await testAsync('16. API Endpoint: POST /api/interest/calculate returns structured calculation matching pure function', async () => {
        const { status, body } = await apiPost('/interest/calculate', {
            principal: 2000,
            rate: 15,
            time: 1
        });
        assertEqual(status, 200, 'HTTP 200 OK');
        assertEqual(body.data.interest, 300, 'API returned interest ₹300');
        assertEqual(body.data.total, 2300, 'API returned total ₹2,300');
    });

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Step 5B Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
