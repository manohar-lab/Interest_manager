/**
 * Interest Manager — Step 5G Test Suite
 * Interest Calculation Preview UI & Integration Verification
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
    console.log('\n=== Interest Manager — Step 5G Calculation Preview Test Suite ===\n');

    const db = await getDatabase();

    // Fetch accounts
    const { body: accsRes } = await apiGet('/accounts');
    const accounts = accsRes.data || [];
    assert(accounts.length >= 3, 'At least 3 accounts exist in database');

    const acc1 = accounts.find(a => a.person_name === 'Ramesh' && a.interest_rate === 15);
    const acc3 = accounts.find(a => a.person_name === 'Ramesh' && a.interest_rate === 18);
    assert(acc1, 'Account #001 (Ramesh @ 15%) exists');
    assert(acc3, 'Account #003 (Ramesh @ 18%) exists');

    // ─── Test 1: Date Validation (Inverted Range) ───
    await testAsync('1. Date Validation: End date before start date returns HTTP 400', async () => {
        const { status, body } = await apiPost(`/accounts/${acc1.id}/timeline-interest`, {
            start_date: '2026-09-01',
            end_date: '2026-08-01'
        });
        assertEqual(status, 400, 'HTTP 400 for inverted dates');
        assert(body.error.includes('cannot be before start date'), 'Error explains inverted dates');
    });

    // ─── Test 2: Calculate Interest Preview (Account #001: 1 Year) ───
    await testAsync('2. Calculate Interest: ₹2,000 @ 15% for 1 year produces ₹300 preview', async () => {
        const { status, body } = await apiPost(`/accounts/${acc1.id}/timeline-interest`, {
            start_date: '2026-01-01',
            end_date: '2027-01-01'
        });
        assertEqual(status, 200, 'HTTP 200 OK');
        assertEqual(body.data.accountId, acc1.id, 'accountId matches');
        assertEqual(body.data.annualRate, 15, 'annualRate is 15%');
        assertEqual(body.data.totalElapsedDays, 365, '365 elapsed days');
        assertEqual(body.data.totalInterest, 300, 'Total interest is ₹300');
        assertEqual(body.data.segments.length, 1, '1 continuous segment');
        assertEqual(body.data.segments[0].principal, 2000, 'Principal is ₹2,000');
        assertEqual(body.data.segments[0].interest, 300, 'Segment interest is ₹300');
    });

    // ─── Test 3: Segment Breakdown with Payments ───
    await testAsync('3. Segment Breakdown: Multiple principal segments are returned with formulas and interest', async () => {
        // Evaluate with in-memory transaction injection simulating payment of ₹500 on 15/08/2026
        const txs = [
            { id: 91, transaction_date: '2026-08-15', transaction_type: 'PRINCIPAL_RECEIVED', amount: 50000 }
        ];
        const res = calculateTimelineInterest(db, acc1.id, '2026-08-01', '2026-08-31', { transactions: txs });
        assertEqual(res.segments.length, 2, '2 segments returned');

        const s1 = res.segments[0];
        const s2 = res.segments[1];

        assertEqual(s1.principal, 2000, 'Seg 1 principal ₹2,000');
        assertEqual(s1.elapsedDays, 14, 'Seg 1 days 14');
        assertCloseTo(s1.interest, 11.51, 0.01, 'Seg 1 interest ₹11.51');

        assertEqual(s2.principal, 1500, 'Seg 2 principal ₹1,500');
        assertEqual(s2.elapsedDays, 16, 'Seg 2 days 16');
        assertCloseTo(s2.interest, 9.86, 0.01, 'Seg 2 interest ₹9.86');

        assertCloseTo(res.totalInterest, 21.37, 0.01, 'Total interest ₹21.37');
    });

    // ─── Test 4: Interest Payment Does Not Alter Preview ───
    await testAsync('4. Interest Payment Immunity: INTEREST_RECEIVED does not alter principal segments or interest', async () => {
        const txs = [
            { id: 92, transaction_date: '2026-08-25', transaction_type: 'INTEREST_RECEIVED', amount: 30000 }
        ];
        const res = calculateTimelineInterest(db, acc1.id, '2026-08-01', '2026-08-31', { transactions: txs });
        assertEqual(res.segments.length, 1, '1 segment');
        assertEqual(res.segments[0].principal, 2000, 'Principal remains ₹2,000');
    });

    // ─── Test 5: Mixed Payment Effect ───
    await testAsync('5. Mixed Payment Effect: Only principal portion affects segments', async () => {
        const txs = [
            { id: 93, transaction_date: '2026-08-15', transaction_type: 'INTEREST_RECEIVED', amount: 30000 },
            { id: 94, transaction_date: '2026-08-15', transaction_type: 'PRINCIPAL_RECEIVED', amount: 50000 }
        ];
        const res = calculateTimelineInterest(db, acc1.id, '2026-08-01', '2026-08-31', { transactions: txs });
        assertEqual(res.segments.length, 2, '2 segments');
        assertEqual(res.segments[0].principal, 2000, 'Before payment: ₹2,000');
        assertEqual(res.segments[1].principal, 1500, 'After payment: ₹1,500');
    });

    // ─── Test 6: Full Repayment (Zero Interest on Later Segment) ───
    await testAsync('6. Full Repayment: Second segment has ₹0 principal and ₹0 interest', async () => {
        const txs = [
            { id: 95, transaction_date: '2026-08-15', transaction_type: 'PRINCIPAL_RECEIVED', amount: 200000 }
        ];
        const res = calculateTimelineInterest(db, acc1.id, '2026-08-01', '2026-08-31', { transactions: txs });
        assertEqual(res.segments.length, 2, '2 segments');
        assertEqual(res.segments[1].principal, 0, 'Seg 2 principal ₹0');
        assertEqual(res.segments[1].interest, 0, 'Seg 2 interest ₹0');
    });

    // ─── Test 7: Zero Interest for Same-Date Range ───
    await testAsync('7. Zero Interest Case: Same-date period (0 days) returns ₹0 total interest', async () => {
        const { status, body } = await apiPost(`/accounts/${acc1.id}/timeline-interest`, {
            start_date: '2026-08-01',
            end_date: '2026-08-01'
        });
        assertEqual(status, 200, 'HTTP 200 OK');
        assertEqual(body.data.totalElapsedDays, 0, '0 elapsed days');
        assertEqual(body.data.totalInterest, 0, '₹0 total interest');
        assertEqual(body.data.segments.length, 0, 'Empty segments array');
    });

    // ─── Test 8: Multiple Account Isolation ───
    await testAsync('8. Account Isolation: Account #001 and #003 previews never blend rates or balances', async () => {
        const { body: r1 } = await apiPost(`/accounts/${acc1.id}/timeline-interest`, {
            start_date: '2026-01-01',
            end_date: '2027-01-01'
        });
        const { body: r3 } = await apiPost(`/accounts/${acc3.id}/timeline-interest`, {
            start_date: '2026-01-01',
            end_date: '2027-01-01'
        });

        assertEqual(r1.data.accountId, acc1.id, 'Acc #1 ID preserved');
        assertEqual(r3.data.accountId, acc3.id, 'Acc #3 ID preserved');
        assertEqual(r1.data.annualRate, 15, 'Acc #1 rate 15%');
        assertEqual(r3.data.annualRate, 18, 'Acc #3 rate 18%');
        assertEqual(r1.data.totalInterest, 300, 'Acc #1 interest ₹300');
        assertEqual(r3.data.totalInterest, 900, 'Acc #3 interest ₹900');
    });

    // ─── Test 9: Read-Only Guarantee (No Database Changes) ───
    await testAsync('9. Read-Only Guarantee: Account balances and transactions remain 100% unchanged', async () => {
        const accBefore = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [acc1.id]);
        const txBefore = queryAll(db, 'SELECT * FROM transactions');
        const intBefore = queryAll(db, 'SELECT * FROM interest_records');

        await apiPost(`/accounts/${acc1.id}/timeline-interest`, {
            start_date: '2026-01-01',
            end_date: '2027-01-01'
        });

        const accAfter = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [acc1.id]);
        const txAfter = queryAll(db, 'SELECT * FROM transactions');
        const intAfter = queryAll(db, 'SELECT * FROM interest_records');

        assertEqual(accBefore.principal, accAfter.principal, 'Principal unchanged');
        assertEqual(accBefore.outstanding_principal, accAfter.outstanding_principal, 'Outstanding principal unchanged');
        assertEqual(accBefore.status, accAfter.status, 'Status unchanged');
        assertEqual(txBefore.length, txAfter.length, 'Transaction count unchanged');
        assertEqual(intBefore.length, intAfter.length, 'Interest records count unchanged (0)');
    });

    // ─── Test 10: Non-Existent Account Error ───
    await testAsync('10. Account Not Found: Missing account ID returns HTTP 404', async () => {
        const { status, body } = await apiPost('/accounts/99999/timeline-interest', {
            start_date: '2026-01-01',
            end_date: '2027-01-01'
        });
        assertEqual(status, 404, 'HTTP 404 for missing account');
        assert(body.error.includes('not found'), 'Error explains account not found');
    });

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Step 5G Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
