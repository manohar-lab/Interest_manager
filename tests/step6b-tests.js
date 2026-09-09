/**
 * Interest Manager — Step 6B: Interest Calculation Core Unit Tests
 *
 * Verifies:
 * 1. Simple interest formula correctness for specified test cases:
 *    - Principal ₹10,000, Rate 12%, Days 30 -> ₹98.63
 *    - Principal ₹20,000, Rate 12%, Days 30 -> ₹197.26
 *    - Principal ₹5,000, Rate 12%, Days 30 -> ₹49.32
 *    - Principal ₹10,000, Rate 0%, Days 30 -> ₹0.00
 *    - Principal ₹0, Rate 12%, Days 30 -> ₹0.00
 * 2. Rate precision & conversion (e.g. 12% -> 0.12, 10.5% -> 0.105, 7.25% -> 0.0725)
 * 3. Final monetary rounding (half-up to 2 decimals / exact integer paisa)
 * 4. Validation of invalid negative values (negative principal, negative rate, negative days)
 * 5. Method validation: supported (SIMPLE, SIMPLE_INTEREST) vs unsupported (COMPOUND)
 * 6. Date range calculation under [start, end) convention and same-day period (0 days -> ₹0.00)
 * 7. Deterministic behavior (repeated calls return identical result)
 * 8. Structured result object integrity
 * 9. Financial safety & zero database side-effects
 */

const assert = require('assert');
const { getDatabase } = require('../db/connection');
const { queryOne, queryAll } = require('../db/helpers');
const {
    calculateInterest,
    calculateAccountInterestFromConfig,
    calculateElapsedDays,
    parseCalendarDate,
    SUPPORTED_CALCULATION_METHODS
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

async function runStep6BTests() {
    console.log('\n================================================================');
    console.log('   INTEREST MANAGER — STEP 6B: CORE CALCULATION ENGINE TESTS');
    console.log('================================================================\n');

    const db = await getDatabase();

    // ─── Phase 1: Core Formula Tests (Section 17 Requirements) ───
    console.log('--- Phase 1: Core Formula Unit Tests ---');

    test('Test 1: Principal = ₹10,000, Rate = 12%, Days = 30 produces ₹98.63', () => {
        const result = calculateInterest({
            principal: 10000,
            interest_rate: 12,
            days: 30,
            calculation_method: 'SIMPLE'
        });

        assert.strictEqual(result.interest_amount, 98.63, 'Interest amount must equal exactly 98.63');
        assert.strictEqual(result.interest_paisa, 9863, 'Interest paisa must equal 9863');
        assert.strictEqual(result.principal, 10000);
        assert.strictEqual(result.rate, 12);
        assert.strictEqual(result.rate_decimal, 0.12);
        assert.strictEqual(result.days, 30);
        assert.strictEqual(result.day_count_basis, 365);
        assert.strictEqual(result.total_amount, 10098.63);
        // Verify unrounded mathematical value (98.630136986...)
        assert(result.unrounded_interest > 98.63 && result.unrounded_interest < 98.631);
    });

    test('Test 2: Principal = ₹20,000, Rate = 12%, Days = 30 produces ₹197.26', () => {
        const result = calculateInterest({
            principal: 20000,
            interest_rate: 12,
            days: 30,
            calculation_method: 'SIMPLE'
        });

        assert.strictEqual(result.interest_amount, 197.26, 'Interest amount must equal exactly 197.26');
        assert.strictEqual(result.interest_paisa, 19726);
        assert.strictEqual(result.total_amount, 20197.26);
    });

    test('Test 3: Principal = ₹5,000, Rate = 12%, Days = 30 produces ₹49.32', () => {
        const result = calculateInterest({
            principal: 5000,
            interest_rate: 12,
            days: 30,
            calculation_method: 'SIMPLE'
        });

        assert.strictEqual(result.interest_amount, 49.32, 'Interest amount must equal exactly 49.32');
        assert.strictEqual(result.interest_paisa, 4932);
        assert.strictEqual(result.total_amount, 5049.32);
    });

    test('Test 4: Principal = ₹10,000, Rate = 0%, Days = 30 produces ₹0.00', () => {
        const result = calculateInterest({
            principal: 10000,
            interest_rate: 0,
            days: 30,
            calculation_method: 'SIMPLE'
        });

        assert.strictEqual(result.interest_amount, 0.00);
        assert.strictEqual(result.interest_paisa, 0);
        assert.strictEqual(result.total_amount, 10000.00);
    });

    test('Test 5: Principal = ₹0, Rate = 12%, Days = 30 produces ₹0.00', () => {
        const result = calculateInterest({
            principal: 0,
            interest_rate: 12,
            days: 30,
            calculation_method: 'SIMPLE'
        });

        assert.strictEqual(result.interest_amount, 0.00);
        assert.strictEqual(result.interest_paisa, 0);
        assert.strictEqual(result.total_amount, 0.00);
    });

    // ─── Phase 2: Validation of Invalid Inputs (Section 11) ───
    console.log('\n--- Phase 2: Input Validation ---');

    test('Test 6: Rejects negative principal with validation error', () => {
        assert.throws(() => {
            calculateInterest({
                principal: -10000,
                interest_rate: 12,
                days: 30
            });
        }, /Principal cannot be negative/);
    });

    test('Test 6b: Rejects negative interest rate with validation error', () => {
        assert.throws(() => {
            calculateInterest({
                principal: 10000,
                interest_rate: -5,
                days: 30
            });
        }, /Interest rate cannot be negative/);
    });

    test('Test 6c: Rejects negative days with validation error', () => {
        assert.throws(() => {
            calculateInterest({
                principal: 10000,
                interest_rate: 12,
                days: -10
            });
        }, /Days cannot be negative/);
    });

    test('Test 6d: Rejects missing principal or rate with validation error', () => {
        assert.throws(() => {
            calculateInterest({
                interest_rate: 12,
                days: 30
            });
        }, /Principal is required/);

        assert.throws(() => {
            calculateInterest({
                principal: 10000,
                days: 30
            });
        }, /Interest rate is required/);
    });

    // ─── Phase 3: Deterministic Behavior (Section 15) ───
    console.log('\n--- Phase 3: Deterministic Behavior ---');

    test('Test 7: Identical inputs repeatedly return identical results', () => {
        const input = {
            principal: 10000,
            interest_rate: 12,
            days: 30,
            calculation_method: 'SIMPLE'
        };

        const result1 = calculateInterest(input);
        const result2 = calculateInterest(input);
        const result3 = calculateInterest(input);

        assert.deepStrictEqual(result1, result2);
        assert.deepStrictEqual(result2, result3);
        assert.strictEqual(result1.interest_amount, 98.63);
    });

    // ─── Phase 4: Precision & Fractional Rates (Section 6, 8, 18) ───
    console.log('\n--- Phase 4: Precision & Fractional Rates ---');

    test('Test 8: Fractional rate 10.50% precision & rounding (₹86.30)', () => {
        // 10000 * 0.105 * 30 / 365 = 86.30136986... -> 86.30
        const result = calculateInterest({
            principal: 10000,
            interest_rate: 10.50,
            days: 30
        });

        assert.strictEqual(result.rate_decimal, 0.105);
        assert.strictEqual(result.interest_amount, 86.30);
        assert.strictEqual(result.interest_paisa, 8630);
        assert.strictEqual(result.total_amount, 10086.30);
    });

    test('Test 8b: Fractional rate 7.25% precision & rounding (₹59.59)', () => {
        // 10000 * 0.0725 * 30 / 365 = 59.58904109... -> 59.59
        const result = calculateInterest({
            principal: 10000,
            interest_rate: 7.25,
            days: 30
        });

        assert.strictEqual(result.rate_decimal, 0.0725);
        assert.strictEqual(result.interest_amount, 59.59);
        assert.strictEqual(result.interest_paisa, 5959);
        assert.strictEqual(result.total_amount, 10059.59);
    });

    // ─── Phase 5: Method Validation (Section 19) ───
    console.log('\n--- Phase 5: Calculation Method Validation ---');

    test('Test 9: Accepts SIMPLE and SIMPLE_INTEREST calculation methods', () => {
        const resSimple = calculateInterest({
            principal: 10000,
            interest_rate: 12,
            days: 30,
            calculation_method: 'SIMPLE'
        });
        assert.strictEqual(resSimple.interest_amount, 98.63);
        assert.strictEqual(resSimple.method, 'SIMPLE');

        const resSimpleInt = calculateInterest({
            principal: 10000,
            interest_rate: 12,
            days: 30,
            calculation_method: 'SIMPLE_INTEREST'
        });
        assert.strictEqual(resSimpleInt.interest_amount, 98.63);
        assert.strictEqual(resSimpleInt.method, 'SIMPLE_INTEREST');
    });

    test('Test 9b: Rejects unsupported calculation method (COMPOUND) with clear error', () => {
        assert.throws(() => {
            calculateInterest({
                principal: 10000,
                interest_rate: 12,
                days: 30,
                calculation_method: 'COMPOUND'
            });
        }, /Unsupported calculation method: "COMPOUND"/);
    });

    // ─── Phase 6: Date Range & Same-Day Period (Section 12, 13) ───
    console.log('\n--- Phase 6: Date Range & Elapsed Days ---');

    test('Test 10: Date range 2026-01-01 to 2026-01-31 computes 30 elapsed days under [start, end) convention', () => {
        const result = calculateInterest({
            principal: 10000,
            interest_rate: 12,
            start_date: '2026-01-01',
            end_date: '2026-01-31',
            calculation_method: 'SIMPLE'
        });

        assert.strictEqual(result.days, 30);
        assert.strictEqual(result.start_date, '2026-01-01');
        assert.strictEqual(result.end_date, '2026-01-31');
        assert.strictEqual(result.interest_amount, 98.63);
    });

    test('Test 11: Same-day period (start_date === end_date) produces 0 days and ₹0.00 interest', () => {
        const result = calculateInterest({
            principal: 10000,
            interest_rate: 12,
            start_date: '2026-05-15',
            end_date: '2026-05-15',
            calculation_method: 'SIMPLE'
        });

        assert.strictEqual(result.days, 0);
        assert.strictEqual(result.interest_amount, 0.00);
        assert.strictEqual(result.interest_paisa, 0);
        assert.strictEqual(result.total_amount, 10000.00);
    });

    test('Test 12: Rejects end_date earlier than start_date', () => {
        assert.throws(() => {
            calculateInterest({
                principal: 10000,
                interest_rate: 12,
                start_date: '2026-06-01',
                end_date: '2026-05-01'
            });
        }, /End date .* cannot be earlier than start date/);
    });

    test('Test 12b: Rejects invalid calendar dates (e.g. Feb 30)', () => {
        assert.throws(() => {
            calculateInterest({
                principal: 10000,
                interest_rate: 12,
                start_date: '2026-02-30',
                end_date: '2026-03-30'
            });
        }, /impossible calendar date/);
    });

    // ─── Phase 7: Structured Result DTO (Section 14) ───
    console.log('\n--- Phase 7: Structured Result Object ---');

    test('Test 13: Result object exposes all required fields', () => {
        const result = calculateInterest({
            principal: 10000,
            interest_rate: 12,
            days: 30,
            calculation_method: 'SIMPLE'
        });

        assert('principal' in result);
        assert('rate' in result);
        assert('rate_decimal' in result);
        assert('method' in result);
        assert('days' in result);
        assert('day_count_basis' in result);
        assert('day_count_convention' in result);
        assert('unrounded_interest' in result);
        assert('interest_amount' in result);
        assert('interest_paisa' in result);
        assert('total_amount' in result);
        assert('total_paisa' in result);
        assert('rounding_convention' in result);

        assert.strictEqual(result.day_count_basis, 365);
        assert.strictEqual(result.day_count_convention, 'ACTUAL/365');
        assert.strictEqual(result.rounding_convention, 'HALF_UP_TO_2_DECIMALS');
    });

    // ─── Phase 8: Financial Safety & No DB Side Effects (Section 16) ───
    console.log('\n--- Phase 8: Financial Safety & Zero DB Mutation ---');

    test('Test 14: Pure calculation creates NO records and causes NO database mutations', () => {
        const initialAccounts = queryAll(db, 'SELECT id, principal, outstanding_principal FROM accounts');
        const initialTx = queryOne(db, 'SELECT COUNT(*) as c FROM transactions').c;
        const initialInterest = queryOne(db, 'SELECT COUNT(*) as c FROM interest_records').c;
        const initialAudit = queryOne(db, 'SELECT COUNT(*) as c FROM audit_logs').c;

        // Perform multiple calculations
        for (let i = 0; i < 50; i++) {
            calculateInterest({
                principal: 10000 + i * 100,
                interest_rate: 12,
                days: 30,
                calculation_method: 'SIMPLE'
            });
        }

        // Test helper with account and config mock
        const mockAccount = { id: 1, principal: 1000000, outstanding_principal: 1000000 };
        const mockConfig = { id: 1, interest_rate: 12, calculation_method: 'SIMPLE' };
        const accResult = calculateAccountInterestFromConfig(mockAccount, mockConfig, '2026-01-01', '2026-01-31');
        assert.strictEqual(accResult.interest_amount, 98.63);

        const finalAccounts = queryAll(db, 'SELECT id, principal, outstanding_principal FROM accounts');
        const finalTx = queryOne(db, 'SELECT COUNT(*) as c FROM transactions').c;
        const finalInterest = queryOne(db, 'SELECT COUNT(*) as c FROM interest_records').c;
        const finalAudit = queryOne(db, 'SELECT COUNT(*) as c FROM audit_logs').c;

        assert.deepStrictEqual(finalAccounts, initialAccounts, 'Accounts table must not be mutated');
        assert.strictEqual(finalTx, initialTx, 'Transactions table must not be mutated');
        assert.strictEqual(finalInterest, initialInterest, 'Interest records table must not be mutated');
        assert.strictEqual(finalAudit, initialAudit, 'Audit logs table must not be mutated');
    });

    console.log('\n================================================================');
    console.log(`Step 6B Test Results: ${passedTests} passed, ${failedTests} failed`);
    console.log('================================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    }
}

runStep6BTests().catch(err => {
    console.error('Test runner fatal error:', err);
    process.exit(1);
});
