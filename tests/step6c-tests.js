/**
 * Interest Manager — Step 6C: Date & Day Calculation Unit Tests
 *
 * Verifies the centralized dateCalculationService.js:
 *   1. Same-day period → 0 days
 *   2. One-day period → 1 day
 *   3. January period → 30 days
 *   4. Month boundary crossing → correct day count
 *   5. Year boundary crossing → correct day count
 *   6. Leap year (Feb 28 → Mar 1 in 2024) → 2 days
 *   7. Reversed date range → validation error
 *   8. Determinism → same inputs always produce same output
 *   9. Input validation → missing/invalid dates rejected
 *  10. Regression with 6B → ₹10,000 @ 12% for 30 days = ₹98.63
 */

const assert = require('assert');
const {
    parseCalendarDate,
    normalizeDate,
    calculateElapsedDays,
    getElapsedDays,
    isLeapYear,
    spansLeapDay,
    DATE_BOUNDARY_CONVENTION
} = require('../services/dateCalculationService');

// Import 6B to verify the integration path
const {
    calculateInterest
} = require('../services/interestCalculationService');

let passedTests = 0;
let failedTests = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        failedTests++;
    }
}

function runStep6CTests() {
    console.log('\n================================================================');
    console.log('   INTEREST MANAGER — STEP 6C: DATE & DAY CALCULATION TESTS');
    console.log('================================================================\n');

    // ─── Phase 1: Core Elapsed Day Tests (Section 14, Tests 1–6) ───
    console.log('--- Phase 1: Core Elapsed Day Calculations ---');

    test('Test 1 — Same day: 2026-01-01 → 2026-01-01 = 0 days', () => {
        const result = calculateElapsedDays('2026-01-01', '2026-01-01');
        assert.strictEqual(result.elapsedDays, 0);
        assert.strictEqual(result.startDateIso, '2026-01-01');
        assert.strictEqual(result.endDateIso, '2026-01-01');
    });

    test('Test 2 — One day: 2026-01-01 → 2026-01-02 = 1 day', () => {
        const result = calculateElapsedDays('2026-01-01', '2026-01-02');
        assert.strictEqual(result.elapsedDays, 1);
    });

    test('Test 3 — January: 2026-01-01 → 2026-01-31 = 30 days', () => {
        const result = calculateElapsedDays('2026-01-01', '2026-01-31');
        assert.strictEqual(result.elapsedDays, 30);
    });

    test('Test 4 — Month boundary: 2026-01-31 → 2026-02-01 = 1 day', () => {
        const result = calculateElapsedDays('2026-01-31', '2026-02-01');
        assert.strictEqual(result.elapsedDays, 1);
    });

    test('Test 5 — Year boundary: 2026-12-31 → 2027-01-01 = 1 day', () => {
        const result = calculateElapsedDays('2026-12-31', '2027-01-01');
        assert.strictEqual(result.elapsedDays, 1);
    });

    test('Test 6 — Leap year: 2024-02-28 → 2024-03-01 = 2 days', () => {
        const result = calculateElapsedDays('2024-02-28', '2024-03-01');
        assert.strictEqual(result.elapsedDays, 2);
    });

    // ─── Phase 2: Reversed Range & Validation (Section 14, Test 7) ───
    console.log('\n--- Phase 2: Invalid Range & Input Validation ---');

    test('Test 7 — Invalid range: end < start → validation error', () => {
        assert.throws(() => {
            calculateElapsedDays('2026-02-01', '2026-01-31');
        }, /End date .* cannot be earlier than start date/);
    });

    test('Test 7b — Missing start date → validation error', () => {
        assert.throws(() => {
            calculateElapsedDays(null, '2026-01-31');
        }, /Start date is required/);
    });

    test('Test 7c — Missing end date → validation error', () => {
        assert.throws(() => {
            calculateElapsedDays('2026-01-01', undefined);
        }, /End date is required/);
    });

    test('Test 7d — Invalid date format → validation error', () => {
        assert.throws(() => {
            calculateElapsedDays('01-01-2026', '2026-01-31');
        }, /is invalid/);
    });

    test('Test 7e — Impossible calendar date (Feb 30) → validation error', () => {
        assert.throws(() => {
            calculateElapsedDays('2026-02-30', '2026-03-01');
        }, /impossible calendar date/);
    });

    // ─── Phase 3: Determinism (Section 14, Test 8) ───
    console.log('\n--- Phase 3: Deterministic Behavior ---');

    test('Test 8 — Determinism: same inputs → same day count (100 iterations)', () => {
        for (let i = 0; i < 100; i++) {
            const result = calculateElapsedDays('2026-01-01', '2026-01-31');
            assert.strictEqual(result.elapsedDays, 30, `Failed on iteration ${i}`);
        }

        // Also verify with getElapsedDays convenience function
        const days1 = getElapsedDays('2026-01-01', '2026-01-31');
        const days2 = getElapsedDays('2026-01-01', '2026-01-31');
        assert.strictEqual(days1, days2);
        assert.strictEqual(days1, 30);
    });

    // ─── Phase 4: Extended Calendar Scenarios ───
    console.log('\n--- Phase 4: Extended Calendar Scenarios ---');

    test('Full year: 2026-01-01 → 2027-01-01 = 365 days (non-leap year)', () => {
        const result = calculateElapsedDays('2026-01-01', '2027-01-01');
        assert.strictEqual(result.elapsedDays, 365);
    });

    test('Full leap year: 2024-01-01 → 2025-01-01 = 366 days', () => {
        const result = calculateElapsedDays('2024-01-01', '2025-01-01');
        assert.strictEqual(result.elapsedDays, 366);
    });

    test('Non-leap Feb: 2026-02-28 → 2026-03-01 = 1 day (no Feb 29)', () => {
        const result = calculateElapsedDays('2026-02-28', '2026-03-01');
        assert.strictEqual(result.elapsedDays, 1);
    });

    test('Full February non-leap: 2026-02-01 → 2026-03-01 = 28 days', () => {
        const result = calculateElapsedDays('2026-02-01', '2026-03-01');
        assert.strictEqual(result.elapsedDays, 28);
    });

    test('Full February leap: 2024-02-01 → 2024-03-01 = 29 days', () => {
        const result = calculateElapsedDays('2024-02-01', '2024-03-01');
        assert.strictEqual(result.elapsedDays, 29);
    });

    test('DD/MM/YYYY format: 01/01/2026 → 31/01/2026 = 30 days', () => {
        const result = calculateElapsedDays('01/01/2026', '31/01/2026');
        assert.strictEqual(result.elapsedDays, 30);
        assert.strictEqual(result.startDateIso, '2026-01-01');
        assert.strictEqual(result.endDateIso, '2026-01-31');
    });

    // ─── Phase 5: Helper Functions ───
    console.log('\n--- Phase 5: Helper Functions ---');

    test('parseCalendarDate: YYYY-MM-DD returns structured result', () => {
        const result = parseCalendarDate('2026-03-15', 'Test date');
        assert.strictEqual(result.year, 2026);
        assert.strictEqual(result.month, 3);
        assert.strictEqual(result.day, 15);
        assert.strictEqual(result.isoString, '2026-03-15');
        assert.strictEqual(typeof result.utcTimestamp, 'number');
    });

    test('normalizeDate: valid date → YYYY-MM-DD, invalid → null', () => {
        assert.strictEqual(normalizeDate('15/03/2026'), '2026-03-15');
        assert.strictEqual(normalizeDate('2026-03-15'), '2026-03-15');
        assert.strictEqual(normalizeDate('invalid'), null);
        assert.strictEqual(normalizeDate(null), null);
    });

    test('isLeapYear: correctly identifies leap and non-leap years', () => {
        assert.strictEqual(isLeapYear(2024), true);
        assert.strictEqual(isLeapYear(2000), true);   // divisible by 400
        assert.strictEqual(isLeapYear(1900), false);   // divisible by 100 but not 400
        assert.strictEqual(isLeapYear(2026), false);
        assert.strictEqual(isLeapYear(2025), false);
    });

    test('spansLeapDay: detects Feb 29 within period', () => {
        assert.strictEqual(spansLeapDay('2024-02-28', '2024-03-01'), true);
        assert.strictEqual(spansLeapDay('2024-01-01', '2024-03-01'), true);
        assert.strictEqual(spansLeapDay('2026-02-28', '2026-03-01'), false);  // not a leap year
        assert.strictEqual(spansLeapDay('2024-03-01', '2024-04-01'), false);  // after Feb 29
    });

    test('getElapsedDays: convenience returns integer directly', () => {
        const days = getElapsedDays('2026-01-01', '2026-01-31');
        assert.strictEqual(typeof days, 'number');
        assert.strictEqual(days, 30);
    });

    test('DATE_BOUNDARY_CONVENTION: exported constant is correct', () => {
        assert.strictEqual(DATE_BOUNDARY_CONVENTION, 'INCLUSIVE_START_EXCLUSIVE_END');
    });

    // ─── Phase 6: Regression with 6B (Section 15) ───
    console.log('\n--- Phase 6: Regression with Step 6B ---');

    test('6B regression: ₹10,000 @ 12% from 2026-01-01 to 2026-01-31 = 30 days → ₹98.63', () => {
        // Verify 6B's calculateInterest obtains its days from 6C's date utility
        const result = calculateInterest({
            principal: 10000,
            interest_rate: 12,
            start_date: '2026-01-01',
            end_date: '2026-01-31',
            calculation_method: 'SIMPLE'
        });

        assert.strictEqual(result.days, 30, 'Day count must come from 6C date utility');
        assert.strictEqual(result.interest_amount, 98.63, 'Interest formula unchanged at ₹98.63');
        assert.strictEqual(result.start_date, '2026-01-01');
        assert.strictEqual(result.end_date, '2026-01-31');
        assert.strictEqual(result.day_count_basis, 365);
        assert.strictEqual(result.boundary_convention, 'INCLUSIVE_START_EXCLUSIVE_END');
    });

    test('6B regression: leap year period 2024-02-01 to 2024-03-01 = 29 days', () => {
        const result = calculateInterest({
            principal: 10000,
            interest_rate: 12,
            start_date: '2024-02-01',
            end_date: '2024-03-01',
            calculation_method: 'SIMPLE'
        });

        assert.strictEqual(result.days, 29, 'Must correctly count 29 days in leap Feb');
        // 10000 * 0.12 * 29 / 365 = 95.342465... → 95.34
        assert.strictEqual(result.interest_amount, 95.34);
    });

    test('6B regression: same-day period produces 0 days and ₹0.00', () => {
        const result = calculateInterest({
            principal: 10000,
            interest_rate: 12,
            start_date: '2026-05-15',
            end_date: '2026-05-15',
            calculation_method: 'SIMPLE'
        });

        assert.strictEqual(result.days, 0);
        assert.strictEqual(result.interest_amount, 0.00);
    });

    // ─── Summary ───
    console.log('\n================================================================');
    console.log(`Step 6C Test Results: ${passedTests} passed, ${failedTests} failed`);
    console.log('================================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    }
}

runStep6CTests();
