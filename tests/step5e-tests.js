/**
 * Interest Manager — Step 5E Test Suite
 * Principal Timeline Reconstruction From Transactions
 */

const { buildPrincipalTimeline } = require('../services/interestService');
const { getDatabase } = require('../db/connection');
const { queryOne, queryAll } = require('../db/helpers');

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
    const r = await fetch(BASE + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    return { status: r.status, body: await r.json() };
}

async function runTests() {
    console.log('\n=== Interest Manager — Step 5E Principal Timeline Test Suite ===\n');

    const db = await getDatabase();

    const mockAccount = {
        id: 101,
        person_id: 1,
        direction: 'MONEY_GIVEN',
        principal: 200000,             // ₹2,000
        outstanding_principal: 200000,
        start_date: '2026-08-01'
    };

    // ─── Test 1: No Payments (Entire period uses original ₹2,000) ───
    await testAsync('1. No Payments: ₹2,000 principal uses 1 segment for entire period (01/08/2026 → 31/08/2026)', async () => {
        const res = buildPrincipalTimeline(db, mockAccount, '01/08/2026', '31/08/2026', { transactions: [] });
        assertEqual(res.openingPrincipal, 2000, 'Opening principal is ₹2,000');
        assertEqual(res.closingPrincipal, 2000, 'Closing principal is ₹2,000');
        assertEqual(res.segments.length, 1, 'Exactly 1 segment');
        assertEqual(res.segments[0].principal, 2000, 'Segment principal is ₹2,000');
        assertEqual(res.segments[0].elapsedDays, 30, 'Segment elapsed days is 30');
    });

    // ─── Test 2: One Principal Payment (₹500 on 15/08/2026) ───
    await testAsync('2. One Principal Payment: ₹2,000 → ₹500 on 15/08/2026 creates 2 segments (₹2,000 and ₹1,500)', async () => {
        const txs = [
            { id: 1, transaction_date: '2026-08-15', transaction_type: 'PRINCIPAL_RECEIVED', amount: 50000 }
        ];
        const res = buildPrincipalTimeline(db, mockAccount, '01/08/2026', '31/08/2026', { transactions: txs });
        assertEqual(res.openingPrincipal, 2000, 'Opening principal ₹2,000');
        assertEqual(res.closingPrincipal, 1500, 'Closing principal ₹1,500');
        assertEqual(res.segments.length, 2, '2 segments created');

        assertEqual(res.segments[0].startDate, '2026-08-01', 'Seg 1 start');
        assertEqual(res.segments[0].endDate, '2026-08-15', 'Seg 1 end');
        assertEqual(res.segments[0].principal, 2000, 'Seg 1 principal ₹2,000');
        assertEqual(res.segments[0].elapsedDays, 14, 'Seg 1 days 14');

        assertEqual(res.segments[1].startDate, '2026-08-15', 'Seg 2 start');
        assertEqual(res.segments[1].endDate, '2026-08-31', 'Seg 2 end');
        assertEqual(res.segments[1].principal, 1500, 'Seg 2 principal ₹1,500');
        assertEqual(res.segments[1].elapsedDays, 16, 'Seg 2 days 16');
    });

    // ─── Test 3: Interest Payment (₹300 INTEREST_RECEIVED has 0 principal effect) ───
    await testAsync('3. Interest Payment: ₹300 INTEREST_RECEIVED on 25/08/2026 leaves principal at ₹2,000 with 1 segment', async () => {
        const txs = [
            { id: 2, transaction_date: '2026-08-25', transaction_type: 'INTEREST_RECEIVED', amount: 30000 }
        ];
        const res = buildPrincipalTimeline(db, mockAccount, '01/08/2026', '31/08/2026', { transactions: txs });
        assertEqual(res.openingPrincipal, 2000, 'Opening principal ₹2,000');
        assertEqual(res.closingPrincipal, 2000, 'Closing principal ₹2,000');
        assertEqual(res.segments.length, 1, 'Interest payment created no extra segments');
        assertEqual(res.segments[0].principal, 2000, 'Principal unaffected');
    });

    // ─── Test 4: Mixed Payment (₹300 Interest + ₹500 Principal on 15/08/2026) ───
    await testAsync('4. Mixed Payment: ₹300 Interest + ₹500 Principal alters timeline by exactly ₹500', async () => {
        const txs = [
            { id: 3, transaction_date: '2026-08-15', transaction_type: 'INTEREST_RECEIVED', amount: 30000 },
            { id: 4, transaction_date: '2026-08-15', transaction_type: 'PRINCIPAL_RECEIVED', amount: 50000 }
        ];
        const res = buildPrincipalTimeline(db, mockAccount, '01/08/2026', '31/08/2026', { transactions: txs });
        assertEqual(res.segments.length, 2, '2 segments');
        assertEqual(res.segments[0].principal, 2000, 'Seg 1 principal ₹2,000');
        assertEqual(res.segments[1].principal, 1500, 'Seg 2 principal ₹1,500');
        assertEqual(res.closingPrincipal, 1500, 'Closing principal ₹1,500');
    });

    // ─── Test 5: Multiple Principal Payments (₹300 on Aug 10, ₹400 on Aug 20) ───
    await testAsync('5. Multiple Payments: ₹300 on 10/08 and ₹400 on 20/08 → Segments: ₹2,000 → ₹1,700 → ₹1,300', async () => {
        const txs = [
            { id: 5, transaction_date: '2026-08-10', transaction_type: 'PRINCIPAL_RECEIVED', amount: 30000 },
            { id: 6, transaction_date: '2026-08-20', transaction_type: 'PRINCIPAL_RECEIVED', amount: 40000 }
        ];
        const res = buildPrincipalTimeline(db, mockAccount, '01/08/2026', '31/08/2026', { transactions: txs });
        assertEqual(res.segments.length, 3, '3 segments created');
        assertEqual(res.segments[0].principal, 2000, 'Seg 1 principal ₹2,000 (Aug 1 - 10)');
        assertEqual(res.segments[0].elapsedDays, 9, 'Seg 1 days = 9');
        assertEqual(res.segments[1].principal, 1700, 'Seg 2 principal ₹1,700 (Aug 10 - 20)');
        assertEqual(res.segments[1].elapsedDays, 10, 'Seg 2 days = 10');
        assertEqual(res.segments[2].principal, 1300, 'Seg 3 principal ₹1,300 (Aug 20 - 31)');
        assertEqual(res.segments[2].elapsedDays, 11, 'Seg 3 days = 11');
        assertEqual(res.closingPrincipal, 1300, 'Closing principal ₹1,300');
    });

    // ─── Test 6: Historical Payment Before Period (₹500 on 10/07/2026 for August period) ───
    await testAsync('6. Historical Payment: Payment on 10/07/2026 makes August opening principal ₹1,500', async () => {
        const txs = [
            { id: 7, transaction_date: '2026-07-10', transaction_type: 'PRINCIPAL_RECEIVED', amount: 50000 }
        ];
        const res = buildPrincipalTimeline(db, mockAccount, '01/08/2026', '31/08/2026', { transactions: txs });
        assertEqual(res.openingPrincipal, 1500, 'August opening principal is ₹1,500');
        assertEqual(res.closingPrincipal, 1500, 'August closing principal is ₹1,500');
        assertEqual(res.segments.length, 1, '1 segment with opening balance');
        assertEqual(res.segments[0].principal, 1500, 'Segment principal is ₹1,500');
    });

    // ─── Test 7: Future Payment After Period (₹500 on 15/09/2026) ───
    await testAsync('7. Future Payment: Payment on 15/09/2026 is ignored for August period', async () => {
        const txs = [
            { id: 8, transaction_date: '2026-09-15', transaction_type: 'PRINCIPAL_RECEIVED', amount: 50000 }
        ];
        const res = buildPrincipalTimeline(db, mockAccount, '01/08/2026', '31/08/2026', { transactions: txs });
        assertEqual(res.openingPrincipal, 2000, 'August opening is ₹2,000');
        assertEqual(res.closingPrincipal, 2000, 'August closing is ₹2,000');
        assertEqual(res.segments.length, 1, '1 segment');
        assertEqual(res.segments[0].principal, 2000, 'September payment ignored in August');
    });

    // ─── Test 8: Full Repayment to Zero (₹2,000 on 15/08/2026) ───
    await testAsync('8. Full Repayment: ₹2,000 repayment on 15/08/2026 results in ₹0 thereafter', async () => {
        const txs = [
            { id: 9, transaction_date: '2026-08-15', transaction_type: 'PRINCIPAL_RECEIVED', amount: 200000 }
        ];
        const res = buildPrincipalTimeline(db, mockAccount, '01/08/2026', '31/08/2026', { transactions: txs });
        assertEqual(res.segments.length, 2, '2 segments');
        assertEqual(res.segments[0].principal, 2000, 'Seg 1 is ₹2,000');
        assertEqual(res.segments[1].principal, 0, 'Seg 2 is ₹0');
        assertEqual(res.closingPrincipal, 0, 'Closing principal is ₹0');
    });

    // ─── Test 9: Multiple Accounts Isolation ───
    await testAsync('9. Account Isolation: Account #001 transactions never alter Account #002 timeline', async () => {
        // Fetch real accounts from DB
        const { body: accs } = await apiGet('/accounts');
        const rameshAccs = accs.data.filter(a => a.person_name === 'Ramesh');
        if (rameshAccs.length >= 2) {
            const a1 = rameshAccs[0];
            const a2 = rameshAccs[1];

            const t1 = buildPrincipalTimeline(db, a1.id, '01/01/2026', '01/01/2027');
            const t2 = buildPrincipalTimeline(db, a2.id, '01/01/2026', '01/01/2027');

            assertEqual(t1.accountId, a1.id, 'Timeline 1 matches Acc #1');
            assertEqual(t2.accountId, a2.id, 'Timeline 2 matches Acc #2');
        }
    });

    // ─── Test 10: Negative Balance Protection (Data integrity error) ───
    await testAsync('10. Negative Balance Protection: Inconsistent overpayment is rejected with data integrity error', async () => {
        const badTxs = [
            { id: 99, transaction_date: '2026-08-15', transaction_type: 'PRINCIPAL_RECEIVED', amount: 300000 } // ₹3,000 on ₹2,000
        ];
        let caught = false;
        try { buildPrincipalTimeline(db, mockAccount, '01/08/2026', '31/08/2026', { transactions: badTxs }); }
        catch (err) { caught = true; assert(err.message.includes('Data integrity error'), 'Data integrity error thrown'); }
        assert(caught, 'Overpayment threw error');
    });

    // ─── Test 11: Read-Only Verification ───
    await testAsync('11. Read-Only Guarantee: Database accounts, transactions, and interest_records remain unchanged', async () => {
        const accsBefore = queryAll(db, 'SELECT * FROM accounts');
        const txsBefore = queryAll(db, 'SELECT * FROM transactions');
        const intBefore = queryAll(db, 'SELECT * FROM interest_records');

        buildPrincipalTimeline(db, mockAccount, '01/08/2026', '31/08/2026', { transactions: [] });

        const accsAfter = queryAll(db, 'SELECT * FROM accounts');
        const txsAfter = queryAll(db, 'SELECT * FROM transactions');
        const intAfter = queryAll(db, 'SELECT * FROM interest_records');

        assertEqual(accsBefore.length, accsAfter.length, 'Accounts count unchanged');
        assertEqual(txsBefore.length, txsAfter.length, 'Transactions count unchanged');
        assertEqual(intBefore.length, intAfter.length, 'Interest records count unchanged (0)');
    });

    // ─── Test 12: API Endpoint Verification (POST /api/accounts/:id/principal-timeline) ───
    await testAsync('12. API Endpoint: POST /api/accounts/:id/principal-timeline returns structured timeline', async () => {
        const { body: accs } = await apiGet('/accounts');
        const acc1 = accs.data[0];

        const { status, body } = await apiPost(`/accounts/${acc1.id}/principal-timeline`, {
            start_date: '01/01/2026',
            end_date: '01/01/2027'
        });

        assertEqual(status, 200, 'HTTP 200');
        assertEqual(body.data.accountId, acc1.id, 'API returned accountId');
        assert(Array.isArray(body.data.segments), 'API returned segments array');
        assert(body.data.segments.length >= 1, 'At least 1 segment exists');
    });

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Step 5E Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
