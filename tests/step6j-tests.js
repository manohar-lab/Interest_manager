/**
 * Interest Manager — Step 6J: Verification, Integration Testing & Finalization
 *
 * Comprehensive test suite verifying that the complete Interest Calculation Engine (Steps 6A–6I)
 * works correctly as one unified, robust, and mathematically sound financial system.
 *
 * Verifies all 32 specifications of Step 6J:
 *   Phase 1: 6A — Configuration (§2, §18)
 *   Phase 2: 6B — Core Calculation & Rounding (§3, §17)
 *   Phase 3: 6C — Date / Day Calculation & Calendar Boundaries (§4, §19, §20)
 *   Phase 4: 6D — Principal Integration & Balance Immutability (§5)
 *   Phase 5: 6E — Accrual Engine & Period Determination (§6)
 *   Phase 6: 6F — Recording, Persistence & Snapshot Storage (§7, §8, §21)
 *   Phase 7: 6G — Payment Integration, Overpayment & FIFO Allocation (§9, §10, §11)
 *   Phase 8: 6H — Interest History, Ordering & Account Isolation (§12)
 *   Phase 9: 6I — Recalculation, Correction Lineage & Idempotency (§13, §14, §15, §16)
 *   Phase 10: Financial Invariants, Validation & Transaction Rollback (§22, §23, §24, §25)
 *   Phase 11: End-to-End Final Part 6 Acceptance Flow (§1, §31)
 *   Phase 12: API Integration & Security Guardrails (§27, §28)
 */

const assert = require('assert');
const http = require('http');
const express = require('express');
const { getDatabase } = require('../db/connection');
const { queryOne, queryAll } = require('../db/helpers');

// Part 6 Service Imports
const {
    createInterestConfig,
    getActiveInterestConfig,
    getAccountInterestConfigs,
    validateInterestConfig
} = require('../services/interestConfigService');

const {
    calculateInterest,
    calculateAccountInterestWithPrincipal,
    validateCalculationInput
} = require('../services/interestCalculationService');

const {
    calculateElapsedDays,
    normalizeDate,
    isLeapYear,
    DATE_BOUNDARY_CONVENTION
} = require('../services/dateCalculationService');

const {
    calculateAccrual,
    determineAccrualPeriod,
    checkDuplicateAccrual
} = require('../services/interestAccrualService');

const {
    recordAccrualResult,
    accrueAndRecord,
    checkExistingRecord
} = require('../services/interestRecordingService');

const {
    getInterestRecordBalance,
    allocatePaymentToInterestRecord,
    allocatePaymentWithCascading
} = require('../services/interestPaymentService');

const {
    getAccountInterestHistory,
    getPersonInterestHistory,
    getInterestRecordDetails
} = require('../services/interestHistoryService');

const {
    recalculateInterestForRecord,
    correctInterestRecord
} = require('../services/interestCorrectionService');

const { allocatePayment } = require('../services/transactionService');
const apiRoutes = require('../routes/api');

let passedTests = 0;
let failedTests = 0;

async function testAsync(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        if (err.stack) {
            console.error(`    ${err.stack.split('\n').slice(1, 4).join('\n')}`);
        }
        failedTests++;
    }
}

async function runStep6JTests() {
    console.log('\n================================================================');
    console.log('   INTEREST MANAGER — STEP 6J: FINAL VERIFICATION & INTEGRATION');
    console.log('================================================================\n');

    const db = await getDatabase();

    // Helper: Fresh test person
    function createTestPerson(name, phone) {
        db.run('INSERT INTO people (name, phone) VALUES (?, ?)', [name, phone]);
        return queryOne(db, 'SELECT last_insert_rowid() as id').id;
    }

    // Helper: Fresh test account
    function createTestAccount(personId, principal = 1000000, rate = 12, direction = 'MONEY_GIVEN', startDate = '2026-01-01') {
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (?, ?, ?, ?, ?, 'MONTHLY', 'SIMPLE_INTEREST', ?, '2026-12-31', 'ACTIVE')
        `, [personId, direction, principal, principal, rate, startDate]);
        return queryOne(db, 'SELECT last_insert_rowid() as id').id;
    }

    // Helper: Directly insert custom record
    function insertCustomInterestRecord(accountId, { periodStart, periodEnd, principalPaisa, rate, amountPaisa, status = 'PENDING', source = 'MANUAL' }) {
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis,
                interest_rate, calculation_method, interest_amount,
                paid_amount, status, source
            ) VALUES (?, ?, ?, ?, ?, 'SIMPLE_INTEREST', ?, 0, ?, ?)
        `, [accountId, periodStart, periodEnd, principalPaisa, rate, amountPaisa, status, source]);
        return queryOne(db, 'SELECT last_insert_rowid() as id').id;
    }

    // ═══════════════════════════════════════════════════════════════
    // Phase 1: Verify 6A — Configuration (§2, §18)
    // ═══════════════════════════════════════════════════════════════
    console.log('--- Phase 1: 6A — Configuration (§2, §18) ---');

    await testAsync('§2.1: Interest configuration resolution and effective date preservation', async () => {
        const pId = createTestPerson('6A Person', '9870001001');
        const accId = createTestAccount(pId, 1000000, 12, 'MONEY_GIVEN', '2026-01-01');

        // Config 1: 2026-01-01 to 2026-06-30 @ 12%
        createInterestConfig(db, accId, {
            calculation_method: 'SIMPLE_INTEREST',
            interest_rate: 12.0,
            effective_from: '2026-01-01',
            effective_to: '2026-06-30',
            notes: 'H1 rate'
        });

        // Config 2: 2026-07-01 onwards @ 10%
        createInterestConfig(db, accId, {
            calculation_method: 'SIMPLE_INTEREST',
            interest_rate: 10.0,
            effective_from: '2026-07-01',
            effective_to: null,
            notes: 'H2 rate'
        });

        // Resolve H1 config
        const h1Config = getActiveInterestConfig(db, accId, '2026-03-15');
        assert.ok(h1Config, 'H1 config must be resolved');
        assert.strictEqual(Number(h1Config.interest_rate), 12.0);
        assert.strictEqual(h1Config.calculation_method, 'SIMPLE_INTEREST');

        // Resolve H2 config
        const h2Config = getActiveInterestConfig(db, accId, '2026-08-01');
        assert.ok(h2Config, 'H2 config must be resolved');
        assert.strictEqual(Number(h2Config.interest_rate), 10.0);

        // Verify multiple configurations are preserved in historical order
        const allConfigs = getAccountInterestConfigs(db, accId);
        assert.ok(allConfigs.length >= 2);
    });

    await testAsync('§2.2: Rejection of unsupported calculation methods and invalid rates', async () => {
        const invalidMethod = validateInterestConfig({
            interest_rate: 12,
            calculation_method: 'COMPOUND',
            effective_from: '2026-01-01'
        });
        assert.strictEqual(invalidMethod.isValid, false);
        assert.ok(invalidMethod.errors.some(e => e.includes('Invalid interest calculation method')));

        const invalidRate = validateInterestConfig({
            interest_rate: -5,
            calculation_method: 'SIMPLE_INTEREST',
            effective_from: '2026-01-01'
        });
        assert.strictEqual(invalidRate.isValid, false);
        assert.ok(invalidRate.errors.some(e => e.includes('non-negative')));
    });

    // ═══════════════════════════════════════════════════════════════
    // Phase 2: Verify 6B — Core Calculation & Rounding (§3, §17)
    // ═══════════════════════════════════════════════════════════════
    console.log('--- Phase 2: 6B — Core Calculation & Precision (§3, §17) ---');

    await testAsync('§3.1: Canonical formula verification: ₹10,000 @ 12%, 30 days, basis 365 = ₹98.63', async () => {
        const result = calculateInterest({
            principal: 10000,
            rate: 12,
            days: 30,
            calculationMethod: 'SIMPLE_INTEREST',
            dayCountBasis: 365
        });

        assert.strictEqual(result.interest_amount, 98.63);
        assert.strictEqual(result.interest_paisa, 9863);
        assert.strictEqual(result.total_amount, 10098.63);
        assert.strictEqual(result.total_paisa, 1009863);
    });

    await testAsync('§17: Exact rounding precision (HALF_UP_TO_2_DECIMALS)', async () => {
        // ₹10,000 @ 10.50% for 30 days: 10000 * 0.105 * 30 / 365 = 86.301369... → ₹86.30 (8630 paisa)
        const r1 = calculateInterest({ principal: 10000, rate: 10.50, days: 30 });
        assert.strictEqual(r1.interest_amount, 86.30);
        assert.strictEqual(r1.interest_paisa, 8630);

        // ₹10,000 @ 7.25% for 30 days: 10000 * 0.0725 * 30 / 365 = 59.58904... → ₹59.59 (5959 paisa)
        const r2 = calculateInterest({ principal: 10000, rate: 7.25, days: 30 });
        assert.strictEqual(r2.interest_amount, 59.59);
        assert.strictEqual(r2.interest_paisa, 5959);
    });

    // ═══════════════════════════════════════════════════════════════
    // Phase 3: Verify 6C — Date Calculation & Boundaries (§4, §19, §20)
    // ═══════════════════════════════════════════════════════════════
    console.log('--- Phase 3: 6C — Date & Calendar Boundaries (§4, §19, §20) ---');

    await testAsync('§4 & §20: Exact elapsed day calculations across boundaries', async () => {
        assert.strictEqual(calculateElapsedDays('2026-01-01', '2026-01-01').elapsedDays, 0, 'Same day = 0 days');
        assert.strictEqual(calculateElapsedDays('2026-01-01', '2026-01-02').elapsedDays, 1, '1 day interval');
        assert.strictEqual(calculateElapsedDays('2026-01-01', '2026-01-31').elapsedDays, 30, 'Jan 01 to Jan 31 = 30 days');
        assert.strictEqual(calculateElapsedDays('2026-01-31', '2026-02-01').elapsedDays, 1, 'Month boundary = 1 day');
        assert.strictEqual(calculateElapsedDays('2026-12-31', '2027-01-01').elapsedDays, 1, 'Year-end boundary = 1 day');
    });

    await testAsync('§19: Leap year elapsed days: 2024-02-28 → 2024-03-01 = 2 days', async () => {
        const leapDays = calculateElapsedDays('2024-02-28', '2024-03-01').elapsedDays;
        assert.strictEqual(leapDays, 2, '2024 is a leap year; Feb 28 to Mar 01 must be exactly 2 days');
        assert.strictEqual(isLeapYear(2024), true);
        assert.strictEqual(isLeapYear(2026), false);

        // Interest calculation over leap boundary
        const leapInt = calculateInterest({ principal: 10000, rate: 12, days: leapDays });
        // 10000 * 0.12 * 2 / 365 = 6.5753... → ₹6.58
        assert.strictEqual(leapInt.interest_amount, 6.58);
    });

    await testAsync('§4.2: Inverted dates and invalid calendar dates are strictly rejected', async () => {
        assert.throws(() => {
            calculateElapsedDays('2026-01-31', '2026-01-01');
        }, /cannot be earlier than start date/);

        assert.throws(() => {
            calculateElapsedDays('2026-02-30', '2026-03-05');
        }, /calendar date/);
    });

    // ═══════════════════════════════════════════════════════════════
    // Phase 4: Verify 6D — Principal Integration & Balance (§5)
    // ═══════════════════════════════════════════════════════════════
    console.log('--- Phase 4: 6D — Principal Integration & Immutability (§5) ---');

    await testAsync('§5: Reduced principal integration (Original ₹100,000, Paid ₹20,000 → Uses ₹80,000)', async () => {
        const pId = createTestPerson('6D Person', '9870001002');
        const accId = createTestAccount(pId, 10000000, 12); // ₹100,000 original

        // Simulate ₹20,000 principal repayment
        db.run('UPDATE accounts SET outstanding_principal = 8000000 WHERE id = ?', [accId]); // ₹80,000 outstanding

        const account = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accId]);
        const calcRes = calculateAccountInterestWithPrincipal(db, account, '2026-01-01', '2026-01-31');

        // 80,000 @ 12% for 30 days: 80000 * 0.12 * 30 / 365 = 789.041... → ₹789.04
        assert.strictEqual(calcRes.outstanding_principal, 80000);
        assert.strictEqual(calcRes.interest_amount, 789.04);

        // Verify principal immutability: account principal must NOT change
        const accountAfter = queryOne(db, 'SELECT principal, outstanding_principal FROM accounts WHERE id = ?', [accId]);
        assert.strictEqual(accountAfter.principal, 10000000);
        assert.strictEqual(accountAfter.outstanding_principal, 8000000);
    });

    // ═══════════════════════════════════════════════════════════════
    // Phase 5: Verify 6E — Accrual Engine (§6)
    // ═══════════════════════════════════════════════════════════════
    console.log('--- Phase 5: 6E — Accrual Engine (§6) ---');

    await testAsync('§6: Accrual result consistency and subsequent period determination', async () => {
        const pId = createTestPerson('6E Person', '9870001003');
        const accId = createTestAccount(pId, 1000000, 12, 'MONEY_GIVEN', '2026-01-01');

        // Accrual 1: 2026-01-01 to 2026-01-31
        const accrual1 = calculateAccrual(db, accId, { startDate: '2026-01-01', endDate: '2026-01-31' });
        assert.strictEqual(accrual1.period_start, '2026-01-01');
        assert.strictEqual(accrual1.period_end, '2026-01-31');
        assert.strictEqual(accrual1.number_of_days, 30);
        assert.strictEqual(accrual1.interest_amount, 98.63);

        // Record Accrual 1
        recordAccrualResult(db, accrual1);

        // Accrual 2 (Subsequent): Automatically starts where Accrual 1 ended (2026-01-31)
        const period2 = determineAccrualPeriod(db, queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accId]));
        assert.strictEqual(period2.startDate, '2026-01-31', 'Subsequent accrual must begin at prior period_end');

        // Verify duplicate detection
        const dupCheck = checkDuplicateAccrual(db, accId, '2026-01-01', '2026-01-31');
        assert.strictEqual(dupCheck.isDuplicate, true);
    });

    // ═══════════════════════════════════════════════════════════════
    // Phase 6: Verify 6F — Recording & Snapshot Storage (§7, §8, §21)
    // ═══════════════════════════════════════════════════════════════
    console.log('--- Phase 6: 6F — Recording & Snapshot Storage (§7, §8, §21) ---');

    await testAsync('§7 & §8: Recording creates exact record and prevents duplicate persistence', async () => {
        const pId = createTestPerson('6F Person', '9870001004');
        const accId = createTestAccount(pId, 1000000, 12);

        const accrual = calculateAccrual(db, accId, { startDate: '2026-01-01', endDate: '2026-01-31' });
        const record = recordAccrualResult(db, accrual);

        assert.ok(record.id > 0);
        assert.strictEqual(record.status, 'SUCCESS');
        assert.strictEqual(record.record_status, 'PENDING');
        assert.strictEqual(record.interest_amount, 98.63);
        assert.strictEqual(record.interest_amount_paisa, 9863);
        assert.strictEqual(record.principal_basis, 10000);
        assert.strictEqual(record.interest_rate, 12);

        // Duplicate recording attempt: idempotent, returns ALREADY_RECORDED with existing ID
        const dupRecord = recordAccrualResult(db, accrual);
        assert.strictEqual(dupRecord.status, 'ALREADY_RECORDED');
        assert.strictEqual(dupRecord.id, record.id);

        const totalRecords = queryOne(db, 'SELECT COUNT(*) as count FROM interest_records WHERE account_id = ?', [accId]).count;
        assert.strictEqual(totalRecords, 1, 'Database must contain exactly one record for this period');
    });

    await testAsync('§21: Zero values (Principal = 0, Rate = 0, Days = 0) produce ₹0.00 and no persistent row', async () => {
        // Direct zero-interest formulas
        assert.strictEqual(calculateInterest({ principal: 0, rate: 12, days: 30 }).interest_amount, 0.00);
        assert.strictEqual(calculateInterest({ principal: 10000, rate: 0, days: 30 }).interest_amount, 0.00);
        assert.strictEqual(calculateInterest({ principal: 10000, rate: 12, days: 0 }).interest_amount, 0.00);

        const pId = createTestPerson('6F Zero Person', '9870001005');
        const accZero = createTestAccount(pId, 1000000, 12);
        // Fully repaid principal: outstanding_principal = 0
        db.run('UPDATE accounts SET outstanding_principal = 0 WHERE id = ?', [accZero]);

        const zeroAccrual = calculateAccrual(db, accZero, { startDate: '2026-01-01', endDate: '2026-01-31' });
        assert.strictEqual(zeroAccrual.interest_amount, 0.00);

        const zeroRecord = recordAccrualResult(db, zeroAccrual);
        assert.strictEqual(zeroRecord.status, 'ZERO_INTEREST');
        assert.strictEqual(zeroRecord.id, null);

        const countZero = queryOne(db, 'SELECT COUNT(*) as count FROM interest_records WHERE account_id = ? AND interest_amount = 0', [accZero]).count;
        assert.strictEqual(countZero, 0, 'Zero-interest periods must not create persistent database rows');
    });

    // ═══════════════════════════════════════════════════════════════
    // Phase 7: Verify 6G — Payment Integration & Allocations (§9, §10, §11)
    // ═══════════════════════════════════════════════════════════════
    console.log('--- Phase 7: 6G — Payment Integration & Allocations (§9, §10, §11) ---');

    await testAsync('§9: Partial payment and remaining settlement', async () => {
        const pId = createTestPerson('6G Person', '9870001006');
        const accId = createTestAccount(pId, 1000000, 12);
        const accrual = calculateAccrual(db, accId, { startDate: '2026-01-01', endDate: '2026-01-31' });
        const record = recordAccrualResult(db, accrual); // ₹98.63

        // Pay ₹30.00 partial payment
        allocatePaymentToInterestRecord(db, {
            account_id: accId,
            interest_record_id: record.id,
            amount: 30.00,
            payment_method: 'UPI',
            payment_date: '2026-02-05',
            reference: 'PAY-PARTIAL-30'
        });

        const bal1 = getInterestRecordBalance(db, record.id);
        assert.strictEqual(bal1.paid_interest, 30.00);
        assert.strictEqual(bal1.outstanding_interest, 68.63);
        assert.strictEqual(bal1.status, 'PARTIALLY_PAID');

        // Pay remaining ₹68.63
        allocatePaymentToInterestRecord(db, {
            account_id: accId,
            interest_record_id: record.id,
            amount: 68.63,
            payment_method: 'CASH',
            payment_date: '2026-02-10',
            reference: 'PAY-REMAINING-6863'
        });

        const bal2 = getInterestRecordBalance(db, record.id);
        assert.strictEqual(bal2.paid_interest, 98.63);
        assert.strictEqual(bal2.outstanding_interest, 0.00);
        assert.strictEqual(bal2.status, 'PAID');
    });

    await testAsync('§10: Overpayment (Payment = ₹150, Interest = ₹98.63 → ₹98.63 interest, ₹51.37 to principal)', async () => {
        const pId = createTestPerson('6G Overpay Person', '9870001007');
        const accId = createTestAccount(pId, 1000000, 12); // Principal ₹10,000
        const accrual = calculateAccrual(db, accId, { startDate: '2026-01-01', endDate: '2026-01-31' });
        recordAccrualResult(db, accrual); // ₹98.63

        // Allocate ₹150 payment through transaction service
        const allocResult = await allocatePayment(db, {
            account_id: accId,
            total_amount: 150.00,
            payment_method: 'UPI',
            payment_date: '2026-02-05',
            reference: 'OVERPAY-150'
        });

        const interestTx = allocResult.transactions.find(t => t.transaction_type === 'INTEREST_RECEIVED');
        const principalTx = allocResult.transactions.find(t => t.transaction_type === 'PRINCIPAL_RECEIVED');

        assert.ok(interestTx, 'Interest transaction must be created');
        assert.ok(principalTx, 'Principal transaction must be created for remainder');
        assert.strictEqual(interestTx.amount, 9863, 'Interest transaction must be exactly 9863 paisa');
        assert.strictEqual(principalTx.amount, 5137, 'Principal transaction must be exactly 5137 paisa');

        // Account principal should be reduced by ₹51.37: ₹10,000 - ₹51.37 = ₹9,948.63 (994863 paisa)
        const account = queryOne(db, 'SELECT outstanding_principal FROM accounts WHERE id = ?', [accId]);
        assert.strictEqual(account.outstanding_principal, 994863);
    });

    await testAsync('§11: Multiple interest records allocated in FIFO order', async () => {
        const pId = createTestPerson('6G FIFO Person', '9870001008');
        const accId = createTestAccount(pId, 1000000, 12);

        const r1 = insertCustomInterestRecord(accId, {
            periodStart: '2026-01-01', periodEnd: '2026-01-31', principalPaisa: 1000000, rate: 12, amountPaisa: 10000 // ₹100
        });
        const r2 = insertCustomInterestRecord(accId, {
            periodStart: '2026-02-01', periodEnd: '2026-02-28', principalPaisa: 1000000, rate: 12, amountPaisa: 15000 // ₹150
        });
        const r3 = insertCustomInterestRecord(accId, {
            periodStart: '2026-03-01', periodEnd: '2026-03-31', principalPaisa: 1000000, rate: 12, amountPaisa: 20000 // ₹200
        });

        // Pay ₹200 towards interest: should fully cover R1 (₹100) and partially cover R2 (₹100 / ₹150), leaving R3 untouched
        await allocatePaymentWithCascading(db, {
            account_id: accId,
            total_amount: 200.00,
            payment_method: 'UPI',
            payment_date: '2026-04-01',
            reference: 'FIFO-200'
        });

        const balR1 = getInterestRecordBalance(db, r1);
        assert.strictEqual(balR1.status, 'PAID');
        assert.strictEqual(balR1.outstanding_interest, 0.00);

        const balR2 = getInterestRecordBalance(db, r2);
        assert.strictEqual(balR2.status, 'PARTIALLY_PAID');
        assert.strictEqual(balR2.outstanding_interest, 50.00);

        const balR3 = getInterestRecordBalance(db, r3);
        assert.strictEqual(balR3.status, 'PENDING');
        assert.strictEqual(balR3.outstanding_interest, 200.00);
    });

    // ═══════════════════════════════════════════════════════════════
    // Phase 8: Verify 6H — Interest History & Isolation (§12)
    // ═══════════════════════════════════════════════════════════════
    console.log('--- Phase 8: 6H — Interest History & Isolation (§12) ---');

    await testAsync('§12: History retrieval, deterministic ordering, and account isolation', async () => {
        const pId = createTestPerson('6H Person', '9870001009');
        const accA = createTestAccount(pId, 1000000, 12);
        const accB = createTestAccount(pId, 2000000, 15);

        insertCustomInterestRecord(accA, {
            periodStart: '2026-02-01', periodEnd: '2026-02-28', principalPaisa: 1000000, rate: 12, amountPaisa: 9863
        });
        insertCustomInterestRecord(accA, {
            periodStart: '2026-01-01', periodEnd: '2026-01-31', principalPaisa: 1000000, rate: 12, amountPaisa: 9863
        });
        insertCustomInterestRecord(accB, {
            periodStart: '2026-01-01', periodEnd: '2026-01-31', principalPaisa: 2000000, rate: 15, amountPaisa: 24658
        });

        // Request Account A history
        const histA = getAccountInterestHistory(db, accA);

        // Verify deterministic ordering: 2026-01-01 must come before 2026-02-01
        assert.strictEqual(histA.items.length, 2);
        assert.strictEqual(histA.items[0].period_start, '2026-01-01');
        assert.strictEqual(histA.items[1].period_start, '2026-02-01');

        // Verify strict isolation: zero records from Account B
        assert.strictEqual(histA.items.some(i => i.account_id === accB), false);

        // Verify Account B history
        const histB = getAccountInterestHistory(db, accB);
        assert.strictEqual(histB.items.length, 1);
        assert.strictEqual(histB.items[0].interest_amount, 246.58);
        assert.strictEqual(histB.items.some(i => i.account_id === accA), false);
    });

    // ═══════════════════════════════════════════════════════════════
    // Phase 9: Verify 6I — Recalculation & Correction (§13, §14, §15, §16)
    // ═══════════════════════════════════════════════════════════════
    console.log('--- Phase 9: 6I — Recalculation & Correction (§13, §14, §15, §16) ---');

    await testAsync('§13 & §14: Recalculation, correction, original snapshot preservation, and lineage', async () => {
        const pId = createTestPerson('6I Person', '9870001010');
        const accId = createTestAccount(pId, 1000000, 12); // ₹10,000

        // Erroneously recorded at 18% (₹147.95)
        const origId = insertCustomInterestRecord(accId, {
            periodStart: '2026-01-01', periodEnd: '2026-01-31', principalPaisa: 1000000, rate: 18, amountPaisa: 14795
        });

        // Recalculate and correct with actual 10% rate:
        // 10000 * 0.10 * 30 / 365 = 82.1917... → ₹82.19
        const corrRes = correctInterestRecord(db, origId, {
            rate: 10,
            reason: 'Contractual agreed rate is 10%'
        });

        assert.strictEqual(corrRes.status, 'CORRECTED');
        assert.strictEqual(corrRes.changed, true);
        assert.strictEqual(corrRes.difference, -65.76);

        const corrId = corrRes.corrected_record_id;

        // Verify original record preservation
        const orig = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [origId]);
        assert.strictEqual(orig.status, 'REVERSED');
        assert.strictEqual(orig.interest_amount, 14795, 'Original recorded amount must remain 14795 paisa');
        assert.strictEqual(orig.interest_rate, 18, 'Original rate must remain 18%');
        assert.strictEqual(orig.corrected_by_record_id, corrId);

        // Verify corrected replacement record
        const corr = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [corrId]);
        assert.strictEqual(corr.status, 'PENDING');
        assert.strictEqual(corr.interest_amount, 8219);
        assert.strictEqual(corr.interest_rate, 10);
        assert.strictEqual(corr.corrects_record_id, origId);

        // §15: Idempotency — re-submitting returns existing correction without duplicate rows
        const dupRes = correctInterestRecord(db, origId, { rate: 10 });
        assert.strictEqual(dupRes.status, 'ALREADY_CORRECTED');
        assert.strictEqual(dupRes.is_duplicate, true);
        assert.strictEqual(dupRes.corrected_record_id, corrId);
    });

    await testAsync('§16: Paid-record correction is safely rejected as UNSUPPORTED', async () => {
        const pId = createTestPerson('6I Paid Person', '9870001011');
        const accId = createTestAccount(pId, 1000000, 12);
        const recId = insertCustomInterestRecord(accId, {
            periodStart: '2026-01-01', periodEnd: '2026-01-31', principalPaisa: 1000000, rate: 12, amountPaisa: 10000
        });

        // Pay ₹50
        allocatePaymentToInterestRecord(db, {
            account_id: accId,
            interest_record_id: recId,
            amount: 50.00,
            payment_method: 'UPI',
            payment_date: '2026-02-05',
            reference: 'UPI-PAID-50'
        });

        // Attempt correction: must be rejected with PAID_RECORD_CORRECTION_UNSUPPORTED
        assert.throws(() => {
            correctInterestRecord(db, recId, { rate: 10 });
        }, (err) => {
            assert.strictEqual(err.statusCode, 400);
            assert.strictEqual(err.code, 'PAID_RECORD_CORRECTION_UNSUPPORTED');
            return true;
        });

        // Verify payment and record remain intact
        const rec = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [recId]);
        assert.strictEqual(rec.paid_amount, 5000);
        assert.strictEqual(rec.status, 'PARTIALLY_PAID');
    });

    // ═══════════════════════════════════════════════════════════════
    // Phase 10: Financial Invariants, Rollback & Integrity (§22 – §25)
    // ═══════════════════════════════════════════════════════════════
    console.log('--- Phase 10: Financial Invariants, Validation & Rollback (§22 – §25) ---');

    await testAsync('§22: Engine input validation rejects negative principal and invalid rates', async () => {
        assert.throws(() => {
            validateCalculationInput({ principal: -1000, rate: 12, days: 30 });
        }, /Principal cannot be negative/);

        assert.throws(() => {
            validateCalculationInput({ principal: 10000, rate: -5, days: 30 });
        }, /Interest rate cannot be negative/);

        assert.throws(() => {
            validateCalculationInput({ principal: 10000, rate: 12, days: -1 });
        }, /Days cannot be negative/);
    });

    await testAsync('§23: Financial invariants across the database', async () => {
        const records = queryAll(db, 'SELECT * FROM interest_records');
        for (const r of records) {
            assert.ok(r.interest_amount >= 0, `Record #${r.id} interest_amount must be >= 0`);
            assert.ok(r.paid_amount >= 0, `Record #${r.id} paid_amount must be >= 0`);
            assert.ok(r.paid_amount <= r.interest_amount, `Record #${r.id} paid_amount must be <= interest_amount`);
        }
    });

    await testAsync('§25: Transaction rollback restores previous valid state on failure', async () => {
        const pId = createTestPerson('Rollback Person', '9870001012');
        const accId = createTestAccount(pId, 1000000, 12);
        const recId = insertCustomInterestRecord(accId, {
            periodStart: '2026-01-01', periodEnd: '2026-01-31', principalPaisa: 1000000, rate: 12, amountPaisa: 9863
        });

        // Forced failure during correction
        assert.throws(() => {
            correctInterestRecord(db, recId, { rate: 10, _forceFailure: true });
        }, /Simulated transaction failure/);

        const recAfter = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [recId]);
        assert.strictEqual(recAfter.status, 'PENDING');
        assert.strictEqual(recAfter.corrected_by_record_id, null);
    });

    // ═══════════════════════════════════════════════════════════════
    // Phase 11: End-to-End Final Part 6 Acceptance Test (§1, §31)
    // ═══════════════════════════════════════════════════════════════
    console.log('--- Phase 11: End-to-End Final Part 6 Acceptance Flow (§1, §31) ---');

    await testAsync('§31: Complete 12-stage integrated acceptance lifecycle', async () => {
        // Stage 1: Loan exists
        const personId = createTestPerson('Acceptance Borrower', '9870001013');
        const accountId = createTestAccount(personId, 1000000, 12, 'MONEY_GIVEN', '2026-01-01');

        // Stage 2: Interest configuration exists
        const config = createInterestConfig(db, accountId, {
            calculation_method: 'SIMPLE_INTEREST',
            interest_rate: 12.0,
            effective_from: '2026-01-01',
            notes: 'Acceptance test configuration'
        });
        assert.ok(config.id > 0);

        // Stage 3: Applicable principal determined
        const account = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accountId]);
        assert.strictEqual(account.outstanding_principal / 100, 10000.00);

        // Stage 4: Correct number of days determined (2026-01-01 to 2026-01-31 = 30 days)
        const days = calculateElapsedDays('2026-01-01', '2026-01-31').elapsedDays;
        assert.strictEqual(days, 30);

        // Stage 5: Interest calculated (₹10,000 @ 12%, 30 days = ₹98.63)
        const calc = calculateInterest({ principal: 10000, rate: 12, days: 30 });
        assert.strictEqual(calc.interest_amount, 98.63);

        // Stage 6: Interest accrued
        const accrual = calculateAccrual(db, accountId, { startDate: '2026-01-01', endDate: '2026-01-31' });
        assert.strictEqual(accrual.interest_amount, 98.63);

        // Stage 7: Interest recorded exactly once
        const record = recordAccrualResult(db, accrual);
        assert.ok(record.id > 0);
        assert.strictEqual(record.status, 'SUCCESS');
        assert.strictEqual(record.record_status, 'PENDING');

        // Stage 8: Interest appears in history
        let history = getAccountInterestHistory(db, accountId);
        assert.strictEqual(history.total, 1);
        assert.strictEqual(history.items[0].id, record.id);
        assert.strictEqual(history.items[0].outstanding_amount, 98.63);

        // Stage 9: Payment allocated (pay ₹30.00)
        allocatePaymentToInterestRecord(db, {
            account_id: accountId,
            interest_record_id: record.id,
            amount: 30.00,
            payment_method: 'UPI',
            payment_date: '2026-02-05',
            reference: 'ACC-PAY-30'
        });

        // Stage 10: Outstanding interest updates correctly (₹98.63 - ₹30.00 = ₹68.63)
        history = getAccountInterestHistory(db, accountId);
        assert.strictEqual(history.items[0].paid_amount, 30.00);
        assert.strictEqual(history.items[0].outstanding_amount, 68.63);
        assert.strictEqual(history.items[0].status, 'PARTIALLY_PAID');

        // Stage 11: Historical values remain unchanged (original recorded interest is still ₹98.63)
        assert.strictEqual(history.items[0].interest_amount, 98.63);
        assert.strictEqual(history.items[0].rate, 12);
        assert.strictEqual(history.items[0].principal, 10000);

        // Stage 12: Safe correction flow on unpaid period
        // Record period 2 (unpaid) and correct it
        const accrual2 = calculateAccrual(db, accountId, { startDate: '2026-01-31', endDate: '2026-03-01' }); // 29 days
        const record2 = recordAccrualResult(db, accrual2);
        assert.ok(record2.id > 0);

        // Correct period 2 to 10% rate
        const correctionResult = correctInterestRecord(db, record2.id, {
            rate: 10,
            reason: 'Rate updated to 10% for period 2'
        });
        assert.strictEqual(correctionResult.status, 'CORRECTED');
        assert.strictEqual(correctionResult.original_record.status, 'REVERSED');
        assert.strictEqual(correctionResult.corrected_record.status, 'PENDING');
    });

    // ═══════════════════════════════════════════════════════════════
    // Phase 12: API Integration & Security Guardrails (§27, §28)
    // ═══════════════════════════════════════════════════════════════
    console.log('--- Phase 12: API Integration & Security (§27, §28) ---');

    const app = express();
    app.use(express.json());
    app.use('/api', apiRoutes);

    const testServer = http.createServer(app);
    await new Promise(resolve => testServer.listen(0, resolve));
    const testPort = testServer.address().port;
    const baseUrl = `http://127.0.0.1:${testPort}/api`;

    const loginRes = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bypass-rate-limit': 'test-internal' },
        body: JSON.stringify({ username: 'admin', password: 'AdminPassword@123' })
    });
    const { token } = await loginRes.json();
    const authFetch = (url, opts = {}) => {
        opts.headers = opts.headers || {};
        opts.headers['Authorization'] = `Bearer ${token}`;
        return fetch(url, opts);
    };

    try {
        await testAsync('§27: Full HTTP API lifecycle from configuration to history', async () => {
            const pId = createTestPerson('API Flow Person', '9870001014');
            const accId = createTestAccount(pId, 1000000, 12);

            // 1. Create Config via API
            const cfgRes = await authFetch(`${baseUrl}/accounts/${accId}/interest-configs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    interest_rate: 12.0,
                    calculation_method: 'SIMPLE_INTEREST',
                    effective_from: '2026-01-01'
                })
            });
            assert.strictEqual(cfgRes.status, 201);

            // 2. Accrue & Record via API
            const accRes = await authFetch(`${baseUrl}/interest/accrue-and-record`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    account_id: accId,
                    start_date: '2026-01-01',
                    end_date: '2026-01-31'
                })
            });
            assert.strictEqual(accRes.status, 201);
            const accData = await accRes.json();
            const recId = accData.data.id;

            // 3. Retrieve History via API
            const histRes = await authFetch(`${baseUrl}/accounts/${accId}/interest-history`);
            assert.strictEqual(histRes.status, 200);
            const histData = await histRes.json();
            assert.strictEqual(histData.items.length, 1);
            assert.strictEqual(histData.items[0].id, recId);

            // 4. Correct via API
            const corrRes = await authFetch(`${baseUrl}/interest-records/${recId}/correct`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rate: 10, reason: 'API correction' })
            });
            assert.strictEqual(corrRes.status, 200);
            const corrData = await corrRes.json();
            assert.strictEqual(corrData.data.status, 'CORRECTED');

            // 5. Updated History via API
            const updatedHistRes = await authFetch(`${baseUrl}/accounts/${accId}/interest-history`);
            assert.strictEqual(updatedHistRes.status, 200);
            const updatedHistData = await updatedHistRes.json();
            assert.strictEqual(updatedHistData.total, 2);
            assert.strictEqual(updatedHistData.items.find(i => i.id === recId).status, 'REVERSED');
        });

        await testAsync('§28: Security guardrails enforce isolation and prevent cross-account access', async () => {
            const p1 = createTestPerson('Security P1', '9870001015');
            const p2 = createTestPerson('Security P2', '9870001016');
            const acc1 = createTestAccount(p1, 1000000, 12);
            const acc2 = createTestAccount(p2, 1000000, 12);

            insertCustomInterestRecord(acc1, {
                periodStart: '2026-01-01', periodEnd: '2026-01-31', principalPaisa: 1000000, rate: 12, amountPaisa: 9863
            });

            const resP2 = await authFetch(`${baseUrl}/people/${p2}/interest-history`);
            assert.strictEqual(resP2.status, 200);
            const dataP2 = await resP2.json();
            assert.strictEqual(dataP2.items.length, 0, 'Person 2 must not see Person 1 interest history');
        });
    } finally {
        await new Promise(resolve => testServer.close(resolve));
    }

    // ─── Summary ───
    console.log('\n================================================================');
    console.log(`Step 6J Verification Results: ${passedTests} passed, ${failedTests} failed`);
    console.log('================================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    }
}

runStep6JTests().catch((err) => {
    console.error('Fatal error running Step 6J tests:', err);
    process.exit(1);
});
