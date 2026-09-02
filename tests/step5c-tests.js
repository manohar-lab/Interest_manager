/**
 * Interest Manager — Step 5C Test Suite
 * Date-to-Time Conversion & ACTUAL/365 Convention Verification
 */

const {
    calculateElapsedDays,
    calculateTimeFraction,
    calculateTimeBetweenDates,
    calculateSimpleInterestByDates
} = require('../services/interestService');

const BASE = 'http://localhost:3000/api';
let passed = 0, failed = 0, total = 0;

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error((msg || '') + ` — expected: ${JSON.stringify(b)}, got: ${JSON.stringify(a)}`); }
function assertCloseTo(a, b, delta = 0.000001, msg) {
    if (Math.abs(a - b) > delta) throw new Error((msg || '') + ` — expected close to ${b}, got: ${a}`);
}

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

async function runTests() {
    console.log('\n=== Interest Manager — Step 5C Date-to-Time Engine Test Suite ===\n');

    // ─── Test 1: Same Date (0 days, 0 time) ───
    await testAsync('1. Same Date: 01/08/2026 to 01/08/2026 → elapsedDays = 0, time = 0', async () => {
        const days = calculateElapsedDays('01/08/2026', '01/08/2026');
        const time = calculateTimeFraction('01/08/2026', '01/08/2026');
        assertEqual(days, 0, 'Elapsed days = 0');
        assertEqual(time, 0, 'Time fraction = 0');

        const details = calculateTimeBetweenDates('2026-08-01', '2026-08-01');
        assertEqual(details.elapsed_days, 0, 'Details elapsed_days = 0');
        assertEqual(details.time_fraction, 0, 'Details time_fraction = 0');
    });

    // ─── Test 2: Known 30-Day Interval (01/08/2026 to 31/08/2026) ───
    await testAsync('2. 30-Day Interval: 01/08/2026 to 31/08/2026 → elapsedDays = 30, time = 30/365', async () => {
        const days = calculateElapsedDays('01/08/2026', '31/08/2026');
        const time = calculateTimeFraction('01/08/2026', '31/08/2026');
        assertEqual(days, 30, 'August 1 to August 31 (inclusive-exclusive) is exactly 30 days');
        assertCloseTo(time, 30 / 365, 0.0000001, 'Time is 30/365');
    });

    // ─── Test 3: Known 90-Day Interval (01/01/2026 to 01/04/2026) ───
    await testAsync('3. 90-Day Interval (Q1 non-leap): 01/01/2026 to 01/04/2026 → elapsedDays = 90 (31+28+31), time = 90/365', async () => {
        const days = calculateElapsedDays('01/01/2026', '01/04/2026');
        const time = calculateTimeFraction('01/01/2026', '01/04/2026');
        // Jan: 31, Feb: 28, Mar: 31 = 90 days
        assertEqual(days, 90, 'Jan 1 to Apr 1 in 2026 is exactly 90 days');
        assertCloseTo(time, 90 / 365, 0.0000001, 'Time is 90/365');
    });

    // ─── Test 4: One-Year Non-Leap Interval (01/01/2026 to 01/01/2027) ───
    await testAsync('4. One-Year Non-Leap: 01/01/2026 to 01/01/2027 → elapsedDays = 365, time = 1.0', async () => {
        const days = calculateElapsedDays('01/01/2026', '01/01/2027');
        const time = calculateTimeFraction('01/01/2026', '01/01/2027');
        assertEqual(days, 365, 'One non-leap calendar year is 365 days');
        assertEqual(time, 1, 'Time is exactly 1.0');
    });

    // ─── Test 5: Leap-Year Interval (01/01/2024 to 01/01/2025) ───
    await testAsync('5. Leap-Year Interval: 01/01/2024 to 01/01/2025 → elapsedDays = 366, time = 366/365', async () => {
        const days = calculateElapsedDays('01/01/2024', '01/01/2025');
        const time = calculateTimeFraction('01/01/2024', '01/01/2025');
        assertEqual(days, 366, 'Leap year 2024 has 366 days');
        assertCloseTo(time, 366 / 365, 0.0000001, 'Time is 366/365 (1.0027397...)');

        const details = calculateTimeBetweenDates('2024-01-01', '2025-01-01');
        assertEqual(details.spans_leap_year_feb29, true, 'Marked spans_leap_year_feb29 = true');
    });

    // ─── Test 6: Inverted Range (End < Start) ───
    await testAsync('6. Inverted Range: 01/09/2026 to 01/08/2026 is rejected with validation error (HTTP 400)', async () => {
        let caught = false;
        try { calculateElapsedDays('01/09/2026', '01/08/2026'); }
        catch (err) { caught = true; assert(err.message.includes('cannot be before start date'), 'Error explains inverted range'); }
        assert(caught, 'Inverted range threw exception');
    });

    // ─── Test 7: Invalid Calendar Dates (e.g. Feb 31, April 31) ───
    await testAsync('7. Impossible Calendar Dates: "31/02/2026" and "2026-04-31" are rejected', async () => {
        let caughtFeb = false;
        try { calculateElapsedDays('31/02/2026', '01/03/2026'); }
        catch (err) { caughtFeb = true; assert(err.message.includes('impossible calendar date'), 'Feb 31 rejected'); }
        assert(caughtFeb, 'Feb 31 threw exception');

        let caughtApr = false;
        try { calculateElapsedDays('2026-04-31', '2026-05-01'); }
        catch (err) { caughtApr = true; assert(err.message.includes('impossible calendar date'), 'Apr 31 rejected'); }
        assert(caughtApr, 'Apr 31 threw exception');
    });

    // ─── Test 8: Missing Dates ───
    await testAsync('8. Missing Dates: null, undefined, empty strings are rejected', async () => {
        let caught1 = false;
        try { calculateElapsedDays(null, '01/01/2027'); }
        catch (err) { caught1 = true; assert(err.message.includes('required'), 'Null start date rejected'); }
        assert(caught1, 'Null start date threw exception');

        let caught2 = false;
        try { calculateElapsedDays('01/01/2026', ''); }
        catch (err) { caught2 = true; assert(err.message.includes('required'), 'Empty end date rejected'); }
        assert(caught2, 'Empty end date threw exception');
    });

    // ─── Test 9: 6 Months Actual Interval (01/01/2026 to 01/07/2026) ───
    await testAsync('9. 6-Month Actual Interval: 01/01/2026 to 01/07/2026 → elapsedDays = 181 (not hardcoded 180 or 0.5)', async () => {
        const days = calculateElapsedDays('01/01/2026', '01/07/2026');
        const time = calculateTimeFraction('01/01/2026', '01/07/2026');
        // Jan:31 + Feb:28 + Mar:31 + Apr:30 + May:31 + Jun:30 = 181 days
        assertEqual(days, 181, 'Jan 1 to Jul 1 is exactly 181 calendar days');
        assertCloseTo(time, 181 / 365, 0.0000001, 'Time is 181/365');
    });

    // ─── Test 10: Integration with Step 5B Engine ───
    await testAsync('10. Integration with Step 5B: ₹2,000 @ 15% for 01/01/2026 to 01/01/2027 → Interest = ₹300, Total = ₹2,300', async () => {
        const res = calculateSimpleInterestByDates(2000, 15, '01/01/2026', '01/01/2027');
        assertEqual(res.principal, 2000, 'Principal ₹2,000');
        assertEqual(res.rate, 15, 'Rate 15%');
        assertEqual(res.time, 1, 'Time fraction 1.0');
        assertEqual(res.interest, 300, 'Interest is ₹300');
        assertEqual(res.total, 2300, 'Total is ₹2,300');
        assertEqual(res.period.elapsed_days, 365, 'Elapsed days is 365');
        assertEqual(res.period.day_count_convention, 'ACTUAL/365', 'Convention ACTUAL/365');
    });

    // ─── Test 11: Zero Database Persistence ───
    await testAsync('11. No DB Persistence: Date conversion and interest by dates create 0 database records', async () => {
        const { queryAll } = require('../db/helpers');
        const { getDatabase } = require('../db/connection');
        const db = await getDatabase();

        const before = queryAll(db, 'SELECT * FROM interest_records');
        calculateTimeBetweenDates('2026-01-01', '2026-06-01');
        calculateSimpleInterestByDates(2000, 15, '2026-01-01', '2026-06-01');
        const after = queryAll(db, 'SELECT * FROM interest_records');

        assertEqual(before.length, after.length, 'No records created in interest_records');
    });

    // ─── Test 12: API Endpoints (POST /interest/calculate-time & /calculate-by-dates) ───
    await testAsync('12. API Endpoints: Verify POST /api/interest/calculate-time and POST /api/interest/calculate-by-dates', async () => {
        const { status: sTime, body: bTime } = await apiPost('/interest/calculate-time', {
            start_date: '01/01/2026',
            end_date: '01/01/2027'
        });
        assertEqual(sTime, 200, 'calculate-time HTTP 200');
        assertEqual(bTime.data.elapsed_days, 365, 'API elapsed_days = 365');
        assertEqual(bTime.data.time_fraction, 1, 'API time_fraction = 1');

        const { status: sInt, body: bInt } = await apiPost('/interest/calculate-by-dates', {
            principal: 2000,
            rate: 15,
            start_date: '01/01/2026',
            end_date: '01/01/2027'
        });
        assertEqual(sInt, 200, 'calculate-by-dates HTTP 200');
        assertEqual(bInt.data.interest, 300, 'API interest = ₹300');
        assertEqual(bInt.data.total, 2300, 'API total = ₹2,300');
    });

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Step 5C Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
