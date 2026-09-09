/**
 * Interest Manager — Step 6D: Principal-Balance Integration Tests
 *
 * Verifies:
 *   Test 1: Full principal — calculation receives correct full principal
 *   Test 2: Reduced principal — uses outstanding (not original) principal
 *   Test 3: Zero principal — interest = ₹0.00
 *   Test 4: Historical balance — timeline-based segmented principal calculation
 *   Test 5: Principal immutability — principal unchanged after calculation
 *   Test 6: Segmented calculation — principal changes mid-period
 *   Test 7: Negative principal rejection
 *   Test 8: 6B/6C regression — ₹10,000 @ 12%, 30 days = ₹98.63
 */

const assert = require('assert');
const { getDatabase } = require('../db/connection');
const { queryOne, queryAll } = require('../db/helpers');
const {
    calculateInterest,
    calculateAccountInterestFromConfig,
    calculateSegmentedInterest,
    calculateAccountInterestWithPrincipal
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

async function runStep6DTests() {
    console.log('\n================================================================');
    console.log('   INTEREST MANAGER — STEP 6D: PRINCIPAL-BALANCE INTEGRATION TESTS');
    console.log('================================================================\n');

    const db = await getDatabase();

    // ─── Phase 1: Full Principal (Section 13, Test 1) ───
    console.log('--- Phase 1: Full Principal ---');

    test('Test 1: Full principal ₹100,000 @ 12%, 30 days → ₹986.30', () => {
        // Account with ₹100,000 principal (stored as paisa = 10,000,000)
        const mockAccount = {
            id: 901,
            person_id: 1,
            principal: 10000000,
            outstanding_principal: 10000000,
            interest_rate: 12,
            calculation_method: 'SIMPLE_INTEREST',
            direction: 'MONEY_GIVEN'
        };

        const result = calculateAccountInterestWithPrincipal(db, mockAccount, '2026-01-01', '2026-01-31');

        assert.strictEqual(result.principal, 100000);
        assert.strictEqual(result.days, 30);
        // 100000 * 0.12 * 30 / 365 = 986.30136... → 986.30
        assert.strictEqual(result.interest_amount, 986.30);
        assert.strictEqual(result.account_id, 901);
        assert.strictEqual(result.is_segmented, false);
        assert.strictEqual(result.is_read_only, true);
    });

    // ─── Phase 2: Reduced Principal (Section 13, Test 2) ───
    console.log('\n--- Phase 2: Reduced Principal ---');

    test('Test 2: Reduced principal — original ₹100,000, paid ₹20,000, uses outstanding ₹80,000', () => {
        const mockAccount = {
            id: 902,
            person_id: 1,
            principal: 10000000,          // Original = ₹100,000
            outstanding_principal: 8000000, // Outstanding = ₹80,000
            interest_rate: 12,
            calculation_method: 'SIMPLE_INTEREST',
            direction: 'MONEY_GIVEN'
        };

        const result = calculateAccountInterestWithPrincipal(db, mockAccount, '2026-01-01', '2026-01-31');

        // Must use outstanding ₹80,000, NOT original ₹100,000
        assert.strictEqual(result.principal, 80000);
        assert.strictEqual(result.outstanding_principal, 80000);
        assert.strictEqual(result.original_principal, 100000);
        assert.strictEqual(result.days, 30);
        // 80000 * 0.12 * 30 / 365 = 789.04109... → 789.04
        assert.strictEqual(result.interest_amount, 789.04);
        assert.strictEqual(result.is_segmented, false);
    });

    // ─── Phase 3: Zero Principal (Section 13, Test 3) ───
    console.log('\n--- Phase 3: Zero Principal ---');

    test('Test 3: Zero outstanding principal → interest = ₹0.00', () => {
        const mockAccount = {
            id: 903,
            person_id: 1,
            principal: 10000000,
            outstanding_principal: 0,  // Zero outstanding
            interest_rate: 12,
            calculation_method: 'SIMPLE_INTEREST',
            direction: 'MONEY_GIVEN'
        };

        const result = calculateAccountInterestWithPrincipal(db, mockAccount, '2026-01-01', '2026-01-31');

        assert.strictEqual(result.principal, 0);
        assert.strictEqual(result.interest_amount, 0.00);
        assert.strictEqual(result.interest_paisa, 0);
    });

    // ─── Phase 4: Historical Balance via Timeline (Section 13, Test 4) ───
    console.log('\n--- Phase 4: Historical Balance (Segmented Timeline) ---');

    test('Test 4: Segmented timeline with supplied transactions', () => {
        // ₹10,000 principal, with ₹2,000 repayment on Jan 15
        // Segment 1: Jan 1 → Jan 15 (14 days) at ₹10,000
        // Segment 2: Jan 15 → Jan 31 (16 days) at ₹8,000
        const mockAccount = {
            id: 904,
            person_id: 1,
            principal: 1000000,  // ₹10,000 in paisa
            outstanding_principal: 800000,
            interest_rate: 12,
            calculation_method: 'SIMPLE_INTEREST',
            direction: 'MONEY_GIVEN',
            start_date: '2025-01-01'
        };

        const transactions = [
            {
                id: 1,
                account_id: 904,
                transaction_type: 'PRINCIPAL_RECEIVED',
                amount: 200000,  // ₹2,000 in paisa
                transaction_date: '2026-01-15'
            }
        ];

        const result = calculateAccountInterestWithPrincipal(
            db, mockAccount, '2026-01-01', '2026-01-31',
            { useTimeline: true, transactions }
        );

        assert.strictEqual(result.is_segmented, true);
        assert.strictEqual(result.is_read_only, true);
        assert(result.segments.length >= 2, 'Should have at least 2 segments');

        // buildPrincipalTimeline stores principal in paisa. Segments report both
        // principal_paisa (integer) and principal (rupees = paisa / 100).
        // Account principal 1000000 paisa = ₹10,000
        const seg1 = result.segments[0];
        assert.strictEqual(seg1.principal_paisa, 1000000, 'Segment 1 principal_paisa = 1,000,000');
        assert.strictEqual(seg1.principal, 10000, 'Segment 1 principal = ₹10,000');

        // After ₹2,000 repayment (200000 paisa), remaining = 800000 paisa = ₹8,000
        const seg2 = result.segments[1];
        assert.strictEqual(seg2.principal_paisa, 800000, 'Segment 2 principal_paisa = 800,000');
        assert.strictEqual(seg2.principal, 8000, 'Segment 2 principal = ₹8,000');

        // Total days
        assert.strictEqual(result.total_days, 30);

        // Total interest should be sum with single final rounding
        assert(result.total_interest_amount > 0, 'Total interest must be positive');
    });

    // ─── Phase 5: Principal Immutability (Section 13, Test 5) ───
    console.log('\n--- Phase 5: Principal Immutability ---');

    test('Test 5: Calculation does NOT modify principal or any database state', async () => {
        // Snapshot before
        const accountsBefore = queryAll(db, 'SELECT id, principal, outstanding_principal FROM accounts ORDER BY id');
        const txCountBefore = queryOne(db, 'SELECT COUNT(*) as c FROM transactions').c;
        const irCountBefore = queryOne(db, 'SELECT COUNT(*) as c FROM interest_records').c;
        const auditCountBefore = queryOne(db, 'SELECT COUNT(*) as c FROM audit_logs').c;

        // Perform many calculations
        for (const acc of accountsBefore) {
            if (acc.principal > 0) {
                calculateAccountInterestWithPrincipal(db, acc.id, '2026-01-01', '2026-01-31');
            }
        }

        // Also test with mock object
        const mockAccount = {
            id: 905,
            person_id: 1,
            principal: 5000000,
            outstanding_principal: 3000000,
            interest_rate: 12,
            calculation_method: 'SIMPLE_INTEREST',
            direction: 'MONEY_GIVEN'
        };
        calculateAccountInterestWithPrincipal(db, mockAccount, '2026-01-01', '2026-01-31');

        // Snapshot after
        const accountsAfter = queryAll(db, 'SELECT id, principal, outstanding_principal FROM accounts ORDER BY id');
        const txCountAfter = queryOne(db, 'SELECT COUNT(*) as c FROM transactions').c;
        const irCountAfter = queryOne(db, 'SELECT COUNT(*) as c FROM interest_records').c;
        const auditCountAfter = queryOne(db, 'SELECT COUNT(*) as c FROM audit_logs').c;

        assert.deepStrictEqual(accountsAfter, accountsBefore, 'Accounts table must not be mutated');
        assert.strictEqual(txCountAfter, txCountBefore, 'Transactions must not be mutated');
        assert.strictEqual(irCountAfter, irCountBefore, 'Interest records must not be mutated');
        assert.strictEqual(auditCountAfter, auditCountBefore, 'Audit logs must not be mutated');
    });

    // ─── Phase 6: Segmented Calculation with Direct Segments (Section 14) ───
    console.log('\n--- Phase 6: Segmented Calculation ---');

    test('Test 6: calculateSegmentedInterest with 3 segments and changing principal', () => {
        // Scenario from spec Section 5:
        //   01-Jan → 10-Jan (9 days): Principal = ₹100,000
        //   10-Jan → 20-Jan (10 days): Principal = ₹80,000
        //   20-Jan → 31-Jan (11 days): Principal = ₹60,000
        const segments = [
            { start_date: '2026-01-01', end_date: '2026-01-10', elapsed_days: 9,  principal_paisa: 10000000 },
            { start_date: '2026-01-10', end_date: '2026-01-20', elapsed_days: 10, principal_paisa: 8000000 },
            { start_date: '2026-01-20', end_date: '2026-01-31', elapsed_days: 11, principal_paisa: 6000000 }
        ];

        const result = calculateSegmentedInterest(segments, 12, 'SIMPLE');

        assert.strictEqual(result.segments.length, 3);
        assert.strictEqual(result.total_days, 30);
        assert.strictEqual(result.rate, 12);
        assert.strictEqual(result.rate_decimal, 0.12);
        assert.strictEqual(result.method, 'SIMPLE');

        // Segment 1: 100000 * 0.12 * 9 / 365 = 295.890... → 295.89
        assert.strictEqual(result.segments[0].principal, 100000);
        assert.strictEqual(result.segments[0].elapsed_days, 9);
        assert.strictEqual(result.segments[0].interest_amount, 295.89);

        // Segment 2: 80000 * 0.12 * 10 / 365 = 263.013... → 263.01
        assert.strictEqual(result.segments[1].principal, 80000);
        assert.strictEqual(result.segments[1].elapsed_days, 10);
        assert.strictEqual(result.segments[1].interest_amount, 263.01);

        // Segment 3: 60000 * 0.12 * 11 / 365 = 216.986... → 216.99
        assert.strictEqual(result.segments[2].principal, 60000);
        assert.strictEqual(result.segments[2].elapsed_days, 11);
        assert.strictEqual(result.segments[2].interest_amount, 216.99);

        // Total: 295.890... + 263.013... + 216.986... = 775.890...
        // Final rounding: 77589.04... → 77589 → 775.89
        assert.strictEqual(result.total_interest_amount, 775.89);
        assert.strictEqual(result.total_interest_paisa, 77589);
        assert.strictEqual(result.rounding_convention, 'HALF_UP_TO_2_DECIMALS');
    });

    // ─── Phase 7: Negative Principal Rejection (Section 10) ───
    console.log('\n--- Phase 7: Negative Principal Rejection ---');

    test('Test 7: Negative outstanding principal → validation error', () => {
        const mockAccount = {
            id: 906,
            person_id: 1,
            principal: 10000000,
            outstanding_principal: -500000,
            interest_rate: 12,
            calculation_method: 'SIMPLE_INTEREST',
            direction: 'MONEY_GIVEN'
        };

        assert.throws(() => {
            calculateAccountInterestWithPrincipal(db, mockAccount, '2026-01-01', '2026-01-31');
        }, /negative/i);
    });

    // ─── Phase 8: Regression with 6B and 6C (Section 15) ───
    console.log('\n--- Phase 8: 6B/6C Regression ---');

    test('Test 8: ₹10,000 @ 12%, 2026-01-01 → 2026-01-31 = 30 days → ₹98.63', () => {
        const mockAccount = {
            id: 907,
            person_id: 1,
            principal: 1000000,
            outstanding_principal: 1000000,
            interest_rate: 12,
            calculation_method: 'SIMPLE_INTEREST',
            direction: 'MONEY_GIVEN'
        };

        const result = calculateAccountInterestWithPrincipal(db, mockAccount, '2026-01-01', '2026-01-31');

        assert.strictEqual(result.days, 30);
        assert.strictEqual(result.interest_amount, 98.63);
        assert.strictEqual(result.interest_paisa, 9863);
        assert.strictEqual(result.principal, 10000);
        assert.strictEqual(result.rate, 12);
        assert.strictEqual(result.day_count_basis, 365);
        assert.strictEqual(result.is_read_only, true);
    });

    test('Test 8b: Direct calculateInterest baseline still works unchanged', () => {
        const result = calculateInterest({
            principal: 10000,
            interest_rate: 12,
            days: 30,
            calculation_method: 'SIMPLE'
        });

        assert.strictEqual(result.interest_amount, 98.63);
        assert.strictEqual(result.days, 30);
    });

    // ─── Phase 9: Config override via 6A (Section 11) ───
    console.log('\n--- Phase 9: Interest Config Override ---');

    test('Test 9: Config override uses config rate instead of account rate', () => {
        const mockAccount = {
            id: 908,
            person_id: 1,
            principal: 1000000,
            outstanding_principal: 1000000,
            interest_rate: 12,
            calculation_method: 'SIMPLE_INTEREST',
            direction: 'MONEY_GIVEN'
        };

        const configOverride = {
            id: 1,
            interest_rate: 10,
            calculation_method: 'SIMPLE'
        };

        const result = calculateAccountInterestWithPrincipal(
            db, mockAccount, '2026-01-01', '2026-01-31',
            { config: configOverride }
        );

        // Should use config rate 10%, not account rate 12%
        assert.strictEqual(result.rate, 10);
        // 100 * 0.10 * 30 / 365 = 8.219... → 8.22
        // (principal is 1000000 paisa = 100 * 100 paisa, but /100 = 100 rupees)
        // Wait, 1000000 paisa = ₹10,000. So 10000 * 0.10 * 30 / 365 = 82.19...
        // No: outstanding_principal = 1000000 paisa -> principalRupees = 10000
        // 10000 * 0.10 * 30 / 365 = 82.191780... → 82.19
        assert.strictEqual(result.interest_amount, 82.19);
    });

    // ─── Summary ───
    console.log('\n================================================================');
    console.log(`Step 6D Test Results: ${passedTests} passed, ${failedTests} failed`);
    console.log('================================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    }
}

runStep6DTests().catch(err => {
    console.error('Test runner fatal error:', err);
    process.exit(1);
});
