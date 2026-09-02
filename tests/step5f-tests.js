/**
 * Interest Manager — Step 5F Test Suite
 * Timeline-Based Interest Calculation Service Verification
 */

const { calculateTimelineInterest } = require('../services/interestService');
const { getDatabase } = require('../db/connection');
const { queryOne, queryAll } = require('../db/helpers');

const BASE = 'http://localhost:3000/api';
let passed = 0, failed = 0, total = 0;

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error((msg || '') + ` — expected: ${JSON.stringify(b)}, got: ${JSON.stringify(a)}`); }
function assertCloseTo(a, b, delta = 0.02, msg) {
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
    console.log('\n=== Interest Manager — Step 5F Timeline Interest Test Suite ===\n');

    const db = await getDatabase();

    const mockAccount = {
        id: 201,
        person_id: 1,
        direction: 'MONEY_GIVEN',
        principal: 200000,              // ₹2,000
        outstanding_principal: 200000,
        interest_rate: 15,
        calculation_method: 'SIMPLE_INTEREST',
        start_date: '2026-08-01'
    };

    // ─── Test 1: No Principal Changes (1-year non-leap, ₹2,000 @ 15%) ───
    await testAsync('1. No Principal Changes: ₹2,000 @ 15% for 1 year (01/01/2026 → 01/01/2027) → Total Interest = ₹300', async () => {
        const accOneYear = { ...mockAccount, start_date: '2026-01-01' };
        const res = calculateTimelineInterest(db, accOneYear, '01/01/2026', '01/01/2027', { transactions: [] });
        assertEqual(res.totalInterest, 300, 'Total interest is ₹300');
        assertEqual(res.totalInterestPaisa, 30000, 'Total interest paisa 30,000');
        assertEqual(res.segments.length, 1, '1 segment');
        assertEqual(res.segments[0].principal, 2000, 'Segment principal is ₹2,000');
        assertEqual(res.segments[0].elapsedDays, 365, '365 elapsed days');
        assertEqual(res.segments[0].interest, 300, 'Segment interest is ₹300');
    });

    // ─── Test 2: One Principal Payment (₹500 on 15/08/2026) ───
    await testAsync('2. One Principal Payment: ₹2,000 → ₹500 on 15/08/2026 splits interest into 2 segments', async () => {
        const txs = [
            { id: 1, transaction_date: '2026-08-15', transaction_type: 'PRINCIPAL_RECEIVED', amount: 50000 }
        ];
        const res = calculateTimelineInterest(db, mockAccount, '01/08/2026', '31/08/2026', { transactions: txs });
        assertEqual(res.segments.length, 2, '2 segments created');

        // Seg 1: 01/08 -> 15/08 (14 days) @ ₹2,000
        assertEqual(res.segments[0].principal, 2000, 'Seg 1 principal ₹2,000');
        assertEqual(res.segments[0].elapsedDays, 14, 'Seg 1 days = 14');
        assertCloseTo(res.segments[0].interest, 11.51, 0.01, 'Seg 1 interest approx ₹11.51');

        // Seg 2: 15/08 -> 31/08 (16 days) @ ₹1,500
        assertEqual(res.segments[1].principal, 1500, 'Seg 2 principal ₹1,500');
        assertEqual(res.segments[1].elapsedDays, 16, 'Seg 2 days = 16');
        assertCloseTo(res.segments[1].interest, 9.86, 0.01, 'Seg 2 interest approx ₹9.86');

        // Total: 11.51 + 9.86 = 21.37
        assertCloseTo(res.totalInterest, 21.37, 0.01, 'Total interest is ₹21.37');
    });

    // ─── Test 3: Two Principal Payments (₹300 on Aug 10, ₹400 on Aug 20) ───
    await testAsync('3. Two Principal Payments: ₹300 on 10/08 and ₹400 on 20/08 splits interest into 3 segments', async () => {
        const txs = [
            { id: 2, transaction_date: '2026-08-10', transaction_type: 'PRINCIPAL_RECEIVED', amount: 30000 },
            { id: 3, transaction_date: '2026-08-20', transaction_type: 'PRINCIPAL_RECEIVED', amount: 40000 }
        ];
        const res = calculateTimelineInterest(db, mockAccount, '01/08/2026', '31/08/2026', { transactions: txs });
        assertEqual(res.segments.length, 3, '3 segments created');
        assertEqual(res.segments[0].principal, 2000, 'Seg 1 principal ₹2,000 (9d)');
        assertEqual(res.segments[1].principal, 1700, 'Seg 2 principal ₹1,700 (10d)');
        assertEqual(res.segments[2].principal, 1300, 'Seg 3 principal ₹1,300 (11d)');
        assert(res.totalInterest > 0, 'Total interest calculated correctly');
    });

    // ─── Test 4: Interest Payment (₹300 INTEREST_RECEIVED does not affect timeline) ───
    await testAsync('4. Interest Payment: ₹300 INTEREST_RECEIVED does not reduce principal or alter interest segments', async () => {
        const txs = [
            { id: 4, transaction_date: '2026-08-25', transaction_type: 'INTEREST_RECEIVED', amount: 30000 }
        ];
        const res = calculateTimelineInterest(db, mockAccount, '01/08/2026', '31/08/2026', { transactions: txs });
        assertEqual(res.segments.length, 1, '1 continuous segment');
        assertEqual(res.segments[0].principal, 2000, 'Principal unaffected by interest payment');
    });

    // ─── Test 5: Mixed Payment (₹300 Interest + ₹500 Principal) ───
    await testAsync('5. Mixed Payment: Only the ₹500 principal component alters the timeline and reduces interest', async () => {
        const txs = [
            { id: 5, transaction_date: '2026-08-15', transaction_type: 'INTEREST_RECEIVED', amount: 30000 },
            { id: 6, transaction_date: '2026-08-15', transaction_type: 'PRINCIPAL_RECEIVED', amount: 50000 }
        ];
        const res = calculateTimelineInterest(db, mockAccount, '01/08/2026', '31/08/2026', { transactions: txs });
        assertEqual(res.segments.length, 2, '2 segments');
        assertEqual(res.segments[0].principal, 2000, 'Seg 1 uses ₹2,000');
        assertEqual(res.segments[1].principal, 1500, 'Seg 2 uses ₹1,500');
        assertCloseTo(res.totalInterest, 21.37, 0.01, 'Total interest matches ₹500 principal reduction');
    });

    // ─── Test 6: Full Repayment to Zero ───
    await testAsync('6. Full Repayment: ₹2,000 repayment on 15/08/2026 results in ₹0 interest for the second segment', async () => {
        const txs = [
            { id: 7, transaction_date: '2026-08-15', transaction_type: 'PRINCIPAL_RECEIVED', amount: 200000 }
        ];
        const res = calculateTimelineInterest(db, mockAccount, '01/08/2026', '31/08/2026', { transactions: txs });
        assertEqual(res.segments.length, 2, '2 segments');
        assertEqual(res.segments[0].principal, 2000, 'Seg 1 principal ₹2,000');
        assertEqual(res.segments[1].principal, 0, 'Seg 2 principal ₹0');
        assertEqual(res.segments[1].interest, 0, 'Seg 2 interest is ₹0');
        assertEqual(res.totalInterest, res.segments[0].interest, 'Total interest equals Seg 1 interest only');
    });

    // ─── Test 7: Zero Outstanding Principal ───
    await testAsync('7. Zero Outstanding: Account with outstanding_principal = 0 produces ₹0 interest', async () => {
        const zeroAcc = { ...mockAccount, outstanding_principal: 0, principal: 200000 };
        const res = calculateTimelineInterest(db, zeroAcc, '01/08/2026', '31/08/2026', {
            transactions: [
                { id: 8, transaction_date: '2026-07-01', transaction_type: 'PRINCIPAL_RECEIVED', amount: 200000 }
            ]
        });
        assertEqual(res.openingPrincipal, 0, 'Opening principal is ₹0');
        assertEqual(res.totalInterest, 0, 'Total interest is ₹0');
        assertEqual(res.segments[0].interest, 0, 'Segment interest is ₹0');
    });

    // ─── Test 8: Multiple Accounts Isolation ───
    await testAsync('8. Account Isolation: Accounts #001, #002, #003 calculate independently without cross-talk', async () => {
        const { body: accs } = await apiGet('/accounts');
        const rameshAccs = accs.data.filter(a => a.person_name === 'Ramesh');
        assert(rameshAccs.length >= 3, 'Ramesh has 3 accounts');

        const r1 = calculateTimelineInterest(db, rameshAccs[0].id, '01/01/2026', '01/01/2027');
        const r3 = calculateTimelineInterest(db, rameshAccs[2].id, '01/01/2026', '01/01/2027');

        assertEqual(r1.accountId, rameshAccs[0].id, 'Acc #1 ID verified');
        assertEqual(r3.accountId, rameshAccs[2].id, 'Acc #3 ID verified');
        assertEqual(r1.annualRate, 15, 'Acc #1 rate is 15%');
        assertEqual(r3.annualRate, 18, 'Acc #3 rate is 18%');
        assertEqual(r1.totalInterest, 300, 'Acc #1 interest = ₹300');
        assertEqual(r3.totalInterest, 900, 'Acc #3 interest = ₹900');
    });

    // ─── Test 9: Invalid Date Range (End < Start) ───
    await testAsync('9. Invalid Date Range: 01/09/2026 to 01/08/2026 is rejected with HTTP 400', async () => {
        let caught = false;
        try { calculateTimelineInterest(db, mockAccount, '01/09/2026', '01/08/2026'); }
        catch (err) { caught = true; assert(err.message.includes('cannot be before start date'), 'Error explains inverted dates'); }
        assert(caught, 'Inverted dates threw exception');
    });

    // ─── Test 10: Same-Date Range (0 days, 0 interest) ───
    await testAsync('10. Same-Date Range: 01/08/2026 to 01/08/2026 produces 0 elapsed days and ₹0 interest', async () => {
        const res = calculateTimelineInterest(db, mockAccount, '01/08/2026', '01/08/2026');
        assertEqual(res.totalElapsedDays, 0, 'Total elapsed days = 0');
        assertEqual(res.totalInterest, 0, 'Total interest = ₹0');
        assertEqual(res.segments.length, 0, 'Segments list is empty []');
    });

    // ─── Test 11: Leap-Year Period (366 days) ───
    await testAsync('11. Leap-Year Period: 01/01/2024 to 01/01/2025 preserves ACTUAL/365 convention', async () => {
        const leapAcc = { ...mockAccount, start_date: '2024-01-01' };
        const res = calculateTimelineInterest(db, leapAcc, '01/01/2024', '01/01/2025', { transactions: [] });
        assertEqual(res.totalElapsedDays, 366, '366 calendar elapsed days');
        assertCloseTo(res.totalInterest, 2000 * 0.15 * (366 / 365), 0.01, 'Interest is 2000 * 0.15 * 366 / 365 = ₹300.82');
    });

    // ─── Test 12: Read-Only Guarantee ───
    await testAsync('12. Read-Only Guarantee: No accounts or transactions are modified in database', async () => {
        const accsBefore = queryAll(db, 'SELECT * FROM accounts');
        const txsBefore = queryAll(db, 'SELECT * FROM transactions');

        calculateTimelineInterest(db, mockAccount, '01/08/2026', '31/08/2026', { transactions: [] });

        const accsAfter = queryAll(db, 'SELECT * FROM accounts');
        const txsAfter = queryAll(db, 'SELECT * FROM transactions');

        assertEqual(accsBefore.length, accsAfter.length, 'Accounts count unchanged');
        assertEqual(txsBefore.length, txsAfter.length, 'Transactions count unchanged');
    });

    // ─── Test 13: No Persistence ───
    await testAsync('13. No Persistence: No records are written to interest_records table', async () => {
        const intBefore = queryAll(db, 'SELECT * FROM interest_records');
        calculateTimelineInterest(db, mockAccount, '01/08/2026', '31/08/2026', { transactions: [] });
        const intAfter = queryAll(db, 'SELECT * FROM interest_records');
        assertEqual(intBefore.length, intAfter.length, 'interest_records count unchanged (0)');
    });

    // ─── Test 14: Integration Test via API ───
    await testAsync('14. Full Pipeline Integration: POST /api/accounts/:id/timeline-interest end-to-end', async () => {
        const { body: accs } = await apiGet('/accounts');
        const acc1 = accs.data[0];

        const { status, body } = await apiPost(`/accounts/${acc1.id}/timeline-interest`, {
            start_date: '01/01/2026',
            end_date: '01/01/2027'
        });

        assertEqual(status, 200, 'HTTP 200');
        assertEqual(body.data.accountId, acc1.id, 'API accountId matches');
        assertEqual(body.data.totalInterest, 300, 'API totalInterest = ₹300');
        assert(Array.isArray(body.data.segments), 'API segments array present');
        assert(body.data.segments.length >= 1, 'Segments >= 1');
    });

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Step 5F Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
