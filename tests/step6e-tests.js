/**
 * Interest Manager — Step 6E: Interest Accrual Tests
 *
 * Verifies:
 *   Test 1: Normal accrual (Principal = ₹10,000, Rate = 12%, Period = 30 days → ₹98.63)
 *   Test 2: Reduced principal (Principal = ₹80,000, Rate = 12%, Period = 30 days → ₹789.04)
 *   Test 3: Zero principal (Principal = ₹0 → ₹0.00)
 *   Test 4: Zero rate (Rate = 0% → ₹0.00)
 *   Test 5: Invalid period (end < start → validation error)
 *   Test 6: Historical configuration (resolves correct rate based on effective dates)
 *   Test 7: Subsequent period (next period begins at end of previous accrual)
 *   Test 8: Duplicate period (detected as already recorded)
 *   Test 9: Zero-day period (start === end → 0 days, ₹0.00)
 *   Test 10: First accrual period determination from account.start_date
 *   Test 11: Frequency period determination (MONTHLY, WEEKLY, DAILY, YEARLY)
 *   Test 12: Regression with 6B, 6C, 6D orchestration
 */

const assert = require('assert');
const { getDatabase } = require('../db/connection');
const { queryOne, queryAll } = require('../db/helpers');
const {
    calculateAccrual,
    determineAccrualPeriod,
    checkDuplicateAccrual,
    resolveApplicableConfig,
    getLastAccrualEndDate
} = require('../services/interestAccrualService');
const { createInterestConfig } = require('../services/interestConfigService');

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

async function testAsync(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        failedTests++;
    }
}

async function runStep6ETests() {
    console.log('\n================================================================');
    console.log('   INTEREST MANAGER — STEP 6E: INTEREST ACCRUAL TESTS');
    console.log('================================================================\n');

    const db = await getDatabase();

    // ─── Test 1: Normal Accrual (Section 17, Test 1) ───
    console.log('--- Phase 1: Core Mathematical Orchestration ---');

    test('Test 1: Normal accrual (Principal = ₹10,000, Rate = 12%, Period = 30 days → ₹98.63)', () => {
        const mockAccount = {
            id: 1001,
            person_id: 1,
            principal: 1000000,           // ₹10,000 in paisa
            outstanding_principal: 1000000,
            interest_rate: 12,
            calculation_method: 'SIMPLE_INTEREST',
            start_date: '2026-01-01',
            direction: 'MONEY_GIVEN'
        };

        const result = calculateAccrual(null, mockAccount, {
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        });

        assert.strictEqual(result.status, 'SUCCESS');
        assert.strictEqual(result.principal, 10000);
        assert.strictEqual(result.interest_rate, 12);
        assert.strictEqual(result.number_of_days, 30);
        // 10,000 * 0.12 * 30 / 365 = 98.630136... → 98.63
        assert.strictEqual(result.interest_amount, 98.63);
        assert.strictEqual(result.interest_paisa, 9863);
        assert.strictEqual(result.period_start, '2026-01-01');
        assert.strictEqual(result.period_end, '2026-01-31');
        assert.strictEqual(result.is_duplicate, false);
        assert.strictEqual(result.is_accrued, false);
        assert.strictEqual(result.is_read_only, true);
    });

    // ─── Test 2: Reduced Principal (Section 17, Test 2) ───
    test('Test 2: Reduced principal (Principal = ₹80,000, Rate = 12%, Period = 30 days → ₹789.04)', () => {
        const mockAccount = {
            id: 1002,
            person_id: 1,
            principal: 10000000,          // Original ₹100,000
            outstanding_principal: 8000000, // Outstanding ₹80,000
            interest_rate: 12,
            calculation_method: 'SIMPLE_INTEREST',
            start_date: '2026-01-01',
            direction: 'MONEY_GIVEN'
        };

        const result = calculateAccrual(null, mockAccount, {
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        });

        assert.strictEqual(result.status, 'SUCCESS');
        assert.strictEqual(result.principal, 80000);
        assert.strictEqual(result.outstanding_principal, 80000);
        assert.strictEqual(result.interest_rate, 12);
        assert.strictEqual(result.number_of_days, 30);
        // 80,000 * 0.12 * 30 / 365 = 789.04109... → 789.04
        assert.strictEqual(result.interest_amount, 789.04);
        assert.strictEqual(result.interest_paisa, 78904);
    });

    // ─── Test 3: Zero Principal (Section 17, Test 3) ───
    test('Test 3: Zero principal → interest amount ₹0.00', () => {
        const mockAccount = {
            id: 1003,
            person_id: 1,
            principal: 1000000,
            outstanding_principal: 0,
            interest_rate: 12,
            calculation_method: 'SIMPLE_INTEREST',
            start_date: '2026-01-01',
            direction: 'MONEY_GIVEN'
        };

        const result = calculateAccrual(null, mockAccount, {
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        });

        assert.strictEqual(result.status, 'ZERO_INTEREST');
        assert.strictEqual(result.principal, 0);
        assert.strictEqual(result.interest_amount, 0.00);
        assert.strictEqual(result.interest_paisa, 0);
    });

    // ─── Test 4: Zero Rate (Section 17, Test 4) ───
    test('Test 4: Zero rate → interest amount ₹0.00', () => {
        const mockAccount = {
            id: 1004,
            person_id: 1,
            principal: 1000000,
            outstanding_principal: 1000000,
            interest_rate: 0,
            calculation_method: 'SIMPLE_INTEREST',
            start_date: '2026-01-01',
            direction: 'MONEY_GIVEN'
        };

        const result = calculateAccrual(null, mockAccount, {
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        });

        assert.strictEqual(result.status, 'ZERO_INTEREST');
        assert.strictEqual(result.interest_rate, 0);
        assert.strictEqual(result.interest_amount, 0.00);
        assert.strictEqual(result.interest_paisa, 0);
    });

    // ─── Test 5: Invalid Period (Section 17, Test 5) ───
    test('Test 5: Invalid period (end < start) → domain validation error', () => {
        const mockAccount = {
            id: 1005,
            person_id: 1,
            principal: 1000000,
            outstanding_principal: 1000000,
            interest_rate: 12,
            calculation_method: 'SIMPLE_INTEREST',
            start_date: '2026-01-01',
            direction: 'MONEY_GIVEN'
        };

        assert.throws(() => {
            calculateAccrual(null, mockAccount, {
                startDate: '2026-01-31',
                endDate: '2026-01-01'
            });
        }, (err) => {
            return err.statusCode === 400 && err.message.includes('cannot be earlier than start date');
        });
    });

    // ─── Test 6: Historical Configuration (Section 17, Test 6) ───
    console.log('\n--- Phase 2: Configuration & Database Integration ---');

    await testAsync('Test 6: Historical configuration resolved by effective date', async () => {
        // Create test account in DB
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2025-01-01', '2027-01-01', 'ACTIVE')
        `);
        const accId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Create historical config 1: 10% effective 2025-01-01 to 2025-12-31
        createInterestConfig(db, accId, {
            interest_rate: 10,
            calculation_method: 'SIMPLE_INTEREST',
            effective_from: '2025-01-01',
            effective_to: '2025-12-31',
            notes: 'Historical 2025 rate'
        });

        // Create config 2: 15% effective 2026-01-01 onwards
        createInterestConfig(db, accId, {
            interest_rate: 15,
            calculation_method: 'SIMPLE_INTEREST',
            effective_from: '2026-01-01',
            effective_to: null,
            notes: '2026 revised rate'
        });

        // Accrual for a 2025 historical period (30 days) -> Should pick 10% rate
        const histResult = calculateAccrual(db, accId, {
            startDate: '2025-06-01',
            endDate: '2025-07-01'
        });

        assert.strictEqual(histResult.interest_rate, 10, 'Should resolve historical 10% config');
        assert.strictEqual(histResult.number_of_days, 30);
        // 10,000 * 0.10 * 30 / 365 = 82.19178... → 82.19
        assert.strictEqual(histResult.interest_amount, 82.19);
        assert.strictEqual(histResult.config_source, 'ACCOUNT_INTEREST_CONFIGS');

        // Accrual for a 2026 period (30 days) -> Should pick 15% rate
        const currResult = calculateAccrual(db, accId, {
            startDate: '2026-06-01',
            endDate: '2026-07-01'
        });

        assert.strictEqual(currResult.interest_rate, 15, 'Should resolve active 15% config');
        assert.strictEqual(currResult.number_of_days, 30);
        // 10,000 * 0.15 * 30 / 365 = 123.2876... → 123.29
        assert.strictEqual(currResult.interest_amount, 123.29);
    });

    // ─── Test 7: Subsequent Period Determination (Section 17, Test 7) ───
    await testAsync('Test 7: Subsequent period determination after existing accrual', async () => {
        // Create an account
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')
        `);
        const accId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Verify first period determination
        const firstPeriod = determineAccrualPeriod(db, accId);
        assert.strictEqual(firstPeriod.startDate, '2026-01-01');
        assert.strictEqual(firstPeriod.endDate, '2026-02-01');
        assert.strictEqual(firstPeriod.source, 'ACCOUNT_START_DATE');
        assert.strictEqual(firstPeriod.isFirstAccrual, true);

        // Simulate an existing recorded interest for Jan (2026-01-01 to 2026-02-01)
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis,
                interest_rate, interest_amount, calculation_method, status
            ) VALUES (?, '2026-01-01', '2026-02-01', 1000000, 12, 10192, 'SIMPLE_INTEREST', 'PENDING')
        `, [accId]);

        // Subsequent period determination
        const nextPeriod = determineAccrualPeriod(db, accId);

        // Next period MUST begin at previous accrual's end date: 2026-02-01
        assert.strictEqual(nextPeriod.startDate, '2026-02-01', 'Next accrual must start at last_end');
        assert.strictEqual(nextPeriod.endDate, '2026-03-01');
        assert.strictEqual(nextPeriod.source, 'PREVIOUS_ACCRUAL_END');
        assert.strictEqual(nextPeriod.isFirstAccrual, false);
        // 2026 is non-leap year: Feb 1 to Mar 1 = 28 days
        assert.strictEqual(nextPeriod.days, 28);

        // Calculate accrual for subsequent period without supplying explicit dates
        const subsequentResult = calculateAccrual(db, accId);
        assert.strictEqual(subsequentResult.period_start, '2026-02-01');
        assert.strictEqual(subsequentResult.period_end, '2026-03-01');
        assert.strictEqual(subsequentResult.number_of_days, 28);
        assert.strictEqual(subsequentResult.period_source, 'PREVIOUS_ACCRUAL_END');
        assert.strictEqual(subsequentResult.is_first_accrual, false);
    });

    // ─── Test 8: Duplicate Period Detection (Section 17, Test 8) ───
    await testAsync('Test 8: Duplicate period detection returns ALREADY_RECORDED', async () => {
        // Create an account with an existing active interest record
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')
        `);
        const accId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis,
                interest_rate, interest_amount, calculation_method, status
            ) VALUES (?, '2026-01-01', '2026-01-31', 1000000, 12, 9863, 'SIMPLE_INTEREST', 'PENDING')
        `, [accId]);

        // Request an already-accrued period
        const dupResult = calculateAccrual(db, accId, {
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        });

        assert.strictEqual(dupResult.status, 'ALREADY_RECORDED');
        assert.strictEqual(dupResult.is_duplicate, true);
        assert.strictEqual(dupResult.already_recorded, true);
        assert.strictEqual(dupResult.period_start, '2026-01-01');
        assert.strictEqual(dupResult.period_end, '2026-01-31');
        assert.strictEqual(dupResult.interest_amount, 98.63);
    });

    // ─── Test 9: Zero-day Period ───
    console.log('\n--- Phase 3: Boundary & Frequency Scenarios ---');

    test('Test 9: Zero-day period (start === end) → 0 days, ₹0.00', () => {
        const mockAccount = {
            id: 1009,
            person_id: 1,
            principal: 1000000,
            outstanding_principal: 1000000,
            interest_rate: 12,
            calculation_method: 'SIMPLE_INTEREST',
            start_date: '2026-01-01',
            direction: 'MONEY_GIVEN'
        };

        const result = calculateAccrual(null, mockAccount, {
            startDate: '2026-01-01',
            endDate: '2026-01-01'
        });

        assert.strictEqual(result.status, 'ZERO_DAYS');
        assert.strictEqual(result.number_of_days, 0);
        assert.strictEqual(result.interest_amount, 0.00);
        assert.strictEqual(result.interest_paisa, 0);
    });

    // ─── Test 10: Frequencies (DAILY, WEEKLY, MONTHLY, YEARLY) ───
    test('Test 10: Frequency-based period determination', () => {
        const dailyAcc = { id: 1, start_date: '2026-01-01', interest_frequency: 'DAILY' };
        const pDaily = determineAccrualPeriod(null, dailyAcc);
        assert.strictEqual(pDaily.startDate, '2026-01-01');
        assert.strictEqual(pDaily.endDate, '2026-01-02');
        assert.strictEqual(pDaily.days, 1);

        const weeklyAcc = { id: 2, start_date: '2026-01-01', interest_frequency: 'WEEKLY' };
        const pWeekly = determineAccrualPeriod(null, weeklyAcc);
        assert.strictEqual(pWeekly.startDate, '2026-01-01');
        assert.strictEqual(pWeekly.endDate, '2026-01-08');
        assert.strictEqual(pWeekly.days, 7);

        const yearlyAcc = { id: 3, start_date: '2026-01-01', interest_frequency: 'YEARLY' };
        const pYearly = determineAccrualPeriod(null, yearlyAcc);
        assert.strictEqual(pYearly.startDate, '2026-01-01');
        assert.strictEqual(pYearly.endDate, '2027-01-01');
        assert.strictEqual(pYearly.days, 365);
    });

    // ─── Test 11: Regression with 6B, 6C, 6D ───
    console.log('\n--- Phase 4: Integration & Regression ---');

    test('Test 11: 6B/6C/6D integration and DTO structure confirmation', () => {
        const mockAccount = {
            id: 1011,
            person_id: 1,
            principal: 1000000,
            outstanding_principal: 1000000,
            interest_rate: 12,
            calculation_method: 'SIMPLE_INTEREST',
            start_date: '2026-01-01',
            direction: 'MONEY_GIVEN'
        };

        const result = calculateAccrual(null, mockAccount, {
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        });

        // Verify required DTO fields
        assert(result.account_id !== undefined, 'account_id required');
        assert(result.period_start !== undefined, 'period_start required');
        assert(result.period_end !== undefined, 'period_end required');
        assert(result.principal !== undefined, 'principal required');
        assert(result.interest_rate !== undefined, 'interest_rate required');
        assert(result.calculation_method !== undefined, 'calculation_method required');
        assert(result.number_of_days !== undefined, 'number_of_days required');
        assert(result.interest_amount !== undefined, 'interest_amount required');

        // Verify no financial side effects
        assert.strictEqual(result.is_read_only, true);
        assert.strictEqual(result.is_accrued, false);
    });

    // ─── Test 12: Principal Changes (6D Segmentation Integration) ───
    test('Test 12: Principal changes mid-period via 6D timeline segmentation', () => {
        const mockAccount = {
            id: 1012,
            person_id: 1,
            principal: 1000000,  // ₹10,000
            outstanding_principal: 800000, // ₹8,000
            interest_rate: 12,
            calculation_method: 'SIMPLE_INTEREST',
            direction: 'MONEY_GIVEN',
            start_date: '2025-01-01'
        };

        const transactions = [
            {
                id: 1,
                account_id: 1012,
                transaction_type: 'PRINCIPAL_RECEIVED',
                amount: 200000, // ₹2,000 repaid on Jan 15
                transaction_date: '2026-01-15'
            }
        ];

        const result = calculateAccrual(db, mockAccount, {
            startDate: '2026-01-01',
            endDate: '2026-01-31',
            useTimeline: true,
            transactions
        });

        assert.strictEqual(result.is_segmented, true);
        assert.strictEqual(result.number_of_days, 30);
        assert(result.segments.length >= 2, 'Should contain segments');
        // Segment 1: 14 days @ ₹10,000 = 46.03
        // Segment 2: 16 days @ ₹8,000 = 42.08
        // Total = ₹88.11
        assert.strictEqual(result.interest_amount, 88.11);
    });

    // ─── Summary ───
    console.log('\n================================================================');
    console.log(`Step 6E Test Results: ${passedTests} passed, ${failedTests} failed`);
    console.log('================================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    }
}

runStep6ETests().catch((err) => {
    console.error('Fatal error running Step 6E tests:', err);
    process.exit(1);
});
