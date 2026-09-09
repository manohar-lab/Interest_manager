/**
 * Interest Manager — Step 6H: Interest History Tests
 *
 * Verifies:
 *   Test 1: Retrieve one record (Interest = ₹98.63 → history contains exactly that record with all required fields)
 *   Test 2: Multiple records (Interest #1 = ₹100, #2 = ₹150, #3 = ₹200 → all 3 returned)
 *   Test 3: Chronological ordering (Records with different periods → period_start ASC, id ASC deterministic)
 *   Test 4: Historical snapshot (Rate = 12% unchanged even if current loan rate changes to 10%)
 *   Test 5: Partial payment (Interest = ₹98.63, Paid = ₹30.00 → Outstanding = ₹68.63)
 *   Test 6: Full payment (Interest = ₹98.63, Paid = ₹98.63 → Outstanding = ₹0.00, Status = PAID)
 *   Test 7: Account isolation (Account A query returns only Account A records, never Account B)
 *   Test 8: Person isolation (Person A query returns only Person A records, never Person B)
 *   Test 9: Reversed history (Reversed record remains visible with status: 'REVERSED', outstanding = 0)
 *   Test 10: Read-only behavior (Zero database rows created or modified across accounts, records, transactions)
 *   Test 11: Payment allocation links (Allocations array exposes transaction_id, payment_id, allocated_amount)
 *   Test 12: Status and date range filtering (status, from, to filters work accurately)
 *   Test 13: Pagination (limit and offset)
 *   Test 14: Single interest record details (getInterestRecordDetails with 404 validation)
 */

const assert = require('assert');
const { getDatabase } = require('../db/connection');
const { queryOne, queryAll } = require('../db/helpers');
const { calculateAccrual } = require('../services/interestAccrualService');
const { recordAccrualResult } = require('../services/interestRecordingService');
const { allocatePaymentToInterestRecord } = require('../services/interestPaymentService');
const {
    formatHistoryItem,
    getAccountInterestHistory,
    getPersonInterestHistory,
    getInterestHistory,
    getInterestRecordDetails
} = require('../services/interestHistoryService');

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

async function runStep6HTests() {
    console.log('\n================================================================');
    console.log('   INTEREST MANAGER — STEP 6H: INTEREST HISTORY TESTS');
    console.log('================================================================\n');

    const db = await getDatabase();

    // Helper to create a fresh person
    function createTestPerson(name, phone) {
        db.run('INSERT INTO people (name, phone) VALUES (?, ?)', [name, phone]);
        return queryOne(db, 'SELECT last_insert_rowid() as id').id;
    }

    // Helper to create a fresh account
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

    // Helper to record interest
    function recordTestInterest(accountId, startDate = '2026-01-01', endDate = '2026-01-31') {
        const accrual = calculateAccrual(db, accountId, { startDate, endDate });
        return recordAccrualResult(db, accrual);
    }

    // Helper to directly insert custom interest records (for custom test amounts)
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

    // ─── Test 1: Retrieve One Record ───
    console.log('--- Test 1: Single Record Retrieval ---');
    await testAsync('Test 1 — Retrieve one record (Interest = ₹98.63)', async () => {
        const pId = createTestPerson('History Person 1', '9990001001');
        const accId = createTestAccount(pId, 1000000, 12, 'MONEY_GIVEN', '2026-01-01'); // ₹10,000 @ 12%
        const recorded = recordTestInterest(accId, '2026-01-01', '2026-01-31'); // 30 days = ₹98.63

        const history = getAccountInterestHistory(db, accId);

        assert.strictEqual(history.account_id, accId);
        assert.strictEqual(history.total, 1);
        assert.strictEqual(history.count, 1);
        assert.strictEqual(history.items.length, 1);

        const item = history.items[0];
        assert.strictEqual(item.id, recorded.id);
        assert.strictEqual(item.interest_record_id, recorded.id);
        assert.strictEqual(item.account_id, accId);
        assert.strictEqual(item.loan_id, accId);
        assert.strictEqual(item.period_start, '2026-01-01');
        assert.strictEqual(item.period_end, '2026-01-31');
        assert.strictEqual(item.principal, 10000);
        assert.strictEqual(item.rate, 12);
        assert.strictEqual(item.days, 30);
        assert.strictEqual(item.interest_amount, 98.63);
        assert.strictEqual(item.paid_amount, 0.00);
        assert.strictEqual(item.outstanding_amount, 98.63);
        assert.strictEqual(item.status, 'PENDING');
        assert.strictEqual(item.source, 'MANUAL');
        assert.ok(item.created_at, 'created_at must be populated');

        // Summary checks
        assert.strictEqual(history.summary.total_records, 1);
        assert.strictEqual(history.summary.total_recorded, 98.63);
        assert.strictEqual(history.summary.total_paid, 0.00);
        assert.strictEqual(history.summary.total_outstanding, 98.63);
    });

    // ─── Test 2: Multiple Records ───
    console.log('--- Test 2: Multiple Records ---');
    await testAsync('Test 2 — Multiple records (₹100, ₹150, ₹200 → all 3 returned)', async () => {
        const pId = createTestPerson('History Person 2', '9990001002');
        const accId = createTestAccount(pId, 1000000, 12);

        insertCustomInterestRecord(accId, {
            periodStart: '2026-01-01',
            periodEnd: '2026-01-31',
            principalPaisa: 1000000,
            rate: 12,
            amountPaisa: 10000 // ₹100.00
        });

        insertCustomInterestRecord(accId, {
            periodStart: '2026-02-01',
            periodEnd: '2026-02-28',
            principalPaisa: 1000000,
            rate: 12,
            amountPaisa: 15000 // ₹150.00
        });

        insertCustomInterestRecord(accId, {
            periodStart: '2026-03-01',
            periodEnd: '2026-03-31',
            principalPaisa: 1000000,
            rate: 12,
            amountPaisa: 20000 // ₹200.00
        });

        const history = getAccountInterestHistory(db, accId);
        assert.strictEqual(history.total, 3);
        assert.strictEqual(history.items.length, 3);
        assert.strictEqual(history.items[0].interest_amount, 100.00);
        assert.strictEqual(history.items[1].interest_amount, 150.00);
        assert.strictEqual(history.items[2].interest_amount, 200.00);

        assert.strictEqual(history.summary.total_recorded, 450.00);
        assert.strictEqual(history.summary.total_outstanding, 450.00);
    });

    // ─── Test 3: Chronological Ordering ───
    console.log('--- Test 3: Chronological Ordering ---');
    await testAsync('Test 3 — Chronological ordering (period_start ASC deterministic)', async () => {
        const pId = createTestPerson('History Person 3', '9990001003');
        const accId = createTestAccount(pId, 1000000, 12);

        // Insert in non-chronological order: March, then January, then February
        insertCustomInterestRecord(accId, {
            periodStart: '2026-03-01',
            periodEnd: '2026-03-31',
            principalPaisa: 1000000,
            rate: 12,
            amountPaisa: 20000
        });
        insertCustomInterestRecord(accId, {
            periodStart: '2026-01-01',
            periodEnd: '2026-01-31',
            principalPaisa: 1000000,
            rate: 12,
            amountPaisa: 10000
        });
        insertCustomInterestRecord(accId, {
            periodStart: '2026-02-01',
            periodEnd: '2026-02-28',
            principalPaisa: 1000000,
            rate: 12,
            amountPaisa: 15000
        });

        const historyAsc = getAccountInterestHistory(db, accId, { order: 'ASC' });
        assert.strictEqual(historyAsc.items[0].period_start, '2026-01-01');
        assert.strictEqual(historyAsc.items[1].period_start, '2026-02-01');
        assert.strictEqual(historyAsc.items[2].period_start, '2026-03-01');

        // Test DESC order
        const historyDesc = getAccountInterestHistory(db, accId, { order: 'DESC' });
        assert.strictEqual(historyDesc.items[0].period_start, '2026-03-01');
        assert.strictEqual(historyDesc.items[1].period_start, '2026-02-01');
        assert.strictEqual(historyDesc.items[2].period_start, '2026-01-01');
    });

    // ─── Test 4: Historical Snapshot ───
    console.log('--- Test 4: Historical Snapshot ---');
    await testAsync('Test 4 — Historical snapshot (Recorded rate = 12%, Current rate = 10% → reports 12%)', async () => {
        const pId = createTestPerson('History Person 4', '9990001004');
        const accId = createTestAccount(pId, 1000000, 12); // Initial rate 12%

        // Record interest at 12%
        const recorded = recordTestInterest(accId, '2026-01-01', '2026-01-31');

        // Now mutate current account rate to 10%
        db.run('UPDATE accounts SET interest_rate = 10 WHERE id = ?', [accId]);

        // Retrieve history
        const history = getAccountInterestHistory(db, accId);
        const item = history.items.find(i => i.id === recorded.id);

        assert.strictEqual(item.rate, 12, 'History must report snapshotted 12%, not the changed 10%');
        assert.strictEqual(item.interest_rate, 12);
        assert.strictEqual(item.interest_amount, 98.63);

        // Current account info should report the current 10%
        assert.strictEqual(history.account.interest_rate, 10);
    });

    // ─── Test 5: Partial Payment ───
    console.log('--- Test 5: Partial Payment ---');
    await testAsync('Test 5 — Partial payment (Interest = ₹98.63, Paid = ₹30.00 → Outstanding = ₹68.63)', async () => {
        const pId = createTestPerson('History Person 5', '9990001005');
        const accId = createTestAccount(pId, 1000000, 12);
        const recorded = recordTestInterest(accId, '2026-01-01', '2026-01-31'); // ₹98.63

        // Allocate ₹30.00
        allocatePaymentToInterestRecord(db, {
            account_id: accId,
            interest_record_id: recorded.id,
            amount: 30.00,
            payment_method: 'UPI',
            payment_date: '2026-02-05',
            reference: 'UPI-PARTIAL-30'
        });

        const history = getAccountInterestHistory(db, accId);
        const item = history.items[0];

        assert.strictEqual(item.interest_amount, 98.63);
        assert.strictEqual(item.paid_amount, 30.00);
        assert.strictEqual(item.outstanding_amount, 68.63);
        assert.strictEqual(item.status, 'PARTIALLY_PAID');

        // Summary
        assert.strictEqual(history.summary.total_recorded, 98.63);
        assert.strictEqual(history.summary.total_paid, 30.00);
        assert.strictEqual(history.summary.total_outstanding, 68.63);
    });

    // ─── Test 6: Full Payment ───
    console.log('--- Test 6: Full Payment ---');
    await testAsync('Test 6 — Full payment (Interest = ₹98.63, Paid = ₹98.63 → Outstanding = ₹0.00)', async () => {
        const pId = createTestPerson('History Person 6', '9990001006');
        const accId = createTestAccount(pId, 1000000, 12);
        const recorded = recordTestInterest(accId, '2026-01-01', '2026-01-31'); // ₹98.63

        // Allocate full ₹98.63
        allocatePaymentToInterestRecord(db, {
            account_id: accId,
            interest_record_id: recorded.id,
            amount: 98.63,
            payment_method: 'CASH',
            payment_date: '2026-02-10',
            reference: 'CASH-FULL-9863'
        });

        const history = getAccountInterestHistory(db, accId);
        const item = history.items[0];

        assert.strictEqual(item.interest_amount, 98.63);
        assert.strictEqual(item.paid_amount, 98.63);
        assert.strictEqual(item.outstanding_amount, 0.00);
        assert.strictEqual(item.status, 'PAID');

        assert.strictEqual(history.summary.total_paid, 98.63);
        assert.strictEqual(history.summary.total_outstanding, 0.00);
    });

    // ─── Test 7: Account Isolation ───
    console.log('--- Test 7: Account Isolation ---');
    await testAsync('Test 7 — Account isolation (Account A records isolated from Account B)', async () => {
        const pId = createTestPerson('History Person 7', '9990001007');
        const accA = createTestAccount(pId, 1000000, 12);
        const accB = createTestAccount(pId, 2000000, 15);

        const recA = recordTestInterest(accA, '2026-01-01', '2026-01-31');
        const recB = recordTestInterest(accB, '2026-01-01', '2026-01-31');

        const histA = getAccountInterestHistory(db, accA);
        const histB = getAccountInterestHistory(db, accB);

        assert.strictEqual(histA.items.length, 1);
        assert.strictEqual(histA.items[0].id, recA.id);
        assert.strictEqual(histA.items[0].account_id, accA);

        assert.strictEqual(histB.items.length, 1);
        assert.strictEqual(histB.items[0].id, recB.id);
        assert.strictEqual(histB.items[0].account_id, accB);

        // Account A history must contain ZERO records belonging to Account B
        assert.strictEqual(histA.items.some(i => i.account_id === accB), false);
        assert.strictEqual(histB.items.some(i => i.account_id === accA), false);
    });

    // ─── Test 8: Person Isolation ───
    console.log('--- Test 8: Person Isolation ---');
    await testAsync('Test 8 — Person isolation (Person A history contains only Person A records)', async () => {
        const pA = createTestPerson('Person A Isolation', '9990001008');
        const pB = createTestPerson('Person B Isolation', '9990001009');

        const accA1 = createTestAccount(pA, 1000000, 12);
        const accA2 = createTestAccount(pA, 1500000, 10);
        const accB1 = createTestAccount(pB, 2000000, 18);

        recordTestInterest(accA1, '2026-01-01', '2026-01-31');
        recordTestInterest(accA2, '2026-01-01', '2026-01-31');
        recordTestInterest(accB1, '2026-01-01', '2026-01-31');

        const histPA = getPersonInterestHistory(db, pA);
        const histPB = getPersonInterestHistory(db, pB);

        assert.strictEqual(histPA.person_id, pA);
        assert.strictEqual(histPA.items.length, 2);
        assert.strictEqual(histPA.items.every(i => i.person_id === pA), true);
        assert.strictEqual(histPA.items.some(i => i.account_id === accB1), false);

        assert.strictEqual(histPB.person_id, pB);
        assert.strictEqual(histPB.items.length, 1);
        assert.strictEqual(histPB.items[0].account_id, accB1);
        assert.strictEqual(histPB.items[0].person_id, pB);
    });

    // ─── Test 9: Reversed History ───
    console.log('--- Test 9: Reversed History ---');
    await testAsync('Test 9 — Reversed history (REVERSED status preserved, remains visible)', async () => {
        const pId = createTestPerson('History Person 9', '9990001010');
        const accId = createTestAccount(pId, 1000000, 12);

        const recId = insertCustomInterestRecord(accId, {
            periodStart: '2026-01-01',
            periodEnd: '2026-01-31',
            principalPaisa: 1000000,
            rate: 12,
            amountPaisa: 9863,
            status: 'REVERSED'
        });

        // Add a reversal reason
        db.run(`
            UPDATE interest_records
            SET reversal_reason = 'Incorrect rate applied',
                reversed_at = '2026-02-02T10:00:00Z'
            WHERE id = ?
        `, [recId]);

        const history = getAccountInterestHistory(db, accId);
        assert.strictEqual(history.items.length, 1);

        const item = history.items[0];
        assert.strictEqual(item.id, recId);
        assert.strictEqual(item.status, 'REVERSED');
        assert.strictEqual(item.interest_amount, 98.63);
        assert.strictEqual(item.outstanding_amount, 0.00, 'Reversed record outstanding must be 0');
        assert.strictEqual(item.reversal_reason, 'Incorrect rate applied');
        assert.strictEqual(item.reversed_at, '2026-02-02T10:00:00Z');

        // Summary should count the record in total_records, but active outstanding is 0
        assert.strictEqual(history.summary.total_records, 1);
        assert.strictEqual(history.summary.total_outstanding, 0.00);
    });

    // ─── Test 10: Read-Only Behavior ───
    console.log('--- Test 10: Read-Only Behavior ---');
    await testAsync('Test 10 — Read-only behavior (zero database changes during history reads)', async () => {
        const pId = createTestPerson('History Person 10', '9990001011');
        const accId = createTestAccount(pId, 1000000, 12);
        const rec = recordTestInterest(accId, '2026-01-01', '2026-01-31');

        // Snapshot database state
        const countBefore = queryOne(db, `
            SELECT
                (SELECT COUNT(*) FROM interest_records) as int_count,
                (SELECT COUNT(*) FROM transactions) as tx_count,
                (SELECT COUNT(*) FROM interest_allocations) as alloc_count,
                (SELECT COUNT(*) FROM audit_logs) as audit_count
        `);
        const accBefore = queryOne(db, 'SELECT principal, outstanding_principal FROM accounts WHERE id = ?', [accId]);

        // Execute history queries repeatedly
        for (let i = 0; i < 5; i++) {
            getAccountInterestHistory(db, accId);
            getPersonInterestHistory(db, pId);
            getInterestHistory(db, { account_id: accId });
            getInterestRecordDetails(db, rec.id);
        }

        // Verify exact database state after reads
        const countAfter = queryOne(db, `
            SELECT
                (SELECT COUNT(*) FROM interest_records) as int_count,
                (SELECT COUNT(*) FROM transactions) as tx_count,
                (SELECT COUNT(*) FROM interest_allocations) as alloc_count,
                (SELECT COUNT(*) FROM audit_logs) as audit_count
        `);
        const accAfter = queryOne(db, 'SELECT principal, outstanding_principal FROM accounts WHERE id = ?', [accId]);

        assert.strictEqual(countAfter.int_count, countBefore.int_count, 'Interest record count must remain identical');
        assert.strictEqual(countAfter.tx_count, countBefore.tx_count, 'Transaction count must remain identical');
        assert.strictEqual(countAfter.alloc_count, countBefore.alloc_count, 'Allocation count must remain identical');
        assert.strictEqual(countAfter.audit_count, countBefore.audit_count, 'Audit log count must remain identical');
        assert.strictEqual(accAfter.principal, accBefore.principal, 'Account principal must remain identical');
        assert.strictEqual(accAfter.outstanding_principal, accBefore.outstanding_principal, 'Outstanding principal must remain identical');
    });

    // ─── Test 11: Payment Allocation Links ───
    console.log('--- Test 11: Payment Allocation Links ---');
    await testAsync('Test 11 — Payment allocation links exposed in history items', async () => {
        const pId = createTestPerson('History Person 11', '9990001012');
        const accId = createTestAccount(pId, 1000000, 12);
        const rec = recordTestInterest(accId, '2026-01-01', '2026-01-31');

        allocatePaymentToInterestRecord(db, {
            account_id: accId,
            interest_record_id: rec.id,
            amount: 25.00,
            payment_method: 'UPI',
            payment_date: '2026-02-05',
            reference: 'UPI/INT/001',
            notes: 'First installment'
        });

        allocatePaymentToInterestRecord(db, {
            account_id: accId,
            interest_record_id: rec.id,
            amount: 35.00,
            payment_method: 'BANK_TRANSFER',
            payment_date: '2026-02-15',
            reference: 'NEFT/INT/002',
            notes: 'Second installment'
        });

        const history = getAccountInterestHistory(db, accId);
        const item = history.items[0];

        assert.strictEqual(item.allocations.length, 2);
        assert.strictEqual(item.allocations[0].allocated_amount, 25.00);
        assert.strictEqual(item.allocations[0].payment_method, 'UPI');
        assert.strictEqual(item.allocations[0].reference, 'UPI/INT/001');

        assert.strictEqual(item.allocations[1].allocated_amount, 35.00);
        assert.strictEqual(item.allocations[1].payment_method, 'BANK_TRANSFER');
        assert.strictEqual(item.allocations[1].reference, 'NEFT/INT/002');

        assert.strictEqual(item.paid_amount, 60.00);
        assert.strictEqual(item.outstanding_amount, 38.63);
    });

    // ─── Test 12: Status & Date Range Filtering ───
    console.log('--- Test 12: Status & Date Filtering ---');
    await testAsync('Test 12 — Filters for status and date range', async () => {
        const pId = createTestPerson('History Person 12', '9990001013');
        const accId = createTestAccount(pId, 1000000, 12);

        const r1 = insertCustomInterestRecord(accId, {
            periodStart: '2026-01-01',
            periodEnd: '2026-01-31',
            principalPaisa: 1000000,
            rate: 12,
            amountPaisa: 10000,
            status: 'PAID'
        });

        const r2 = insertCustomInterestRecord(accId, {
            periodStart: '2026-02-01',
            periodEnd: '2026-02-28',
            principalPaisa: 1000000,
            rate: 12,
            amountPaisa: 10000,
            status: 'PENDING'
        });

        const r3 = insertCustomInterestRecord(accId, {
            periodStart: '2026-03-01',
            periodEnd: '2026-03-31',
            principalPaisa: 1000000,
            rate: 12,
            amountPaisa: 10000,
            status: 'REVERSED'
        });

        // Filter by status = 'PAID'
        const paidOnly = getAccountInterestHistory(db, accId, { status: 'PAID' });
        assert.strictEqual(paidOnly.items.length, 1);
        assert.strictEqual(paidOnly.items[0].id, r1);

        // Filter by status = 'PENDING'
        const pendingOnly = getAccountInterestHistory(db, accId, { status: 'PENDING' });
        assert.strictEqual(pendingOnly.items.length, 1);
        assert.strictEqual(pendingOnly.items[0].id, r2);

        // Filter by date range (from 2026-02-01 to 2026-03-31)
        const dateFiltered = getAccountInterestHistory(db, accId, { from: '2026-02-01', to: '2026-03-31' });
        assert.strictEqual(dateFiltered.items.length, 2);
        assert.strictEqual(dateFiltered.items[0].id, r2);
        assert.strictEqual(dateFiltered.items[1].id, r3);
    });

    // ─── Test 13: Pagination ───
    console.log('--- Test 13: Pagination ---');
    await testAsync('Test 13 — Pagination (limit and offset)', async () => {
        const pId = createTestPerson('History Person 13', '9990001014');
        const accId = createTestAccount(pId, 1000000, 12);

        for (let i = 1; i <= 5; i++) {
            const m = String(i).padStart(2, '0');
            insertCustomInterestRecord(accId, {
                periodStart: `2026-${m}-01`,
                periodEnd: `2026-${m}-28`,
                principalPaisa: 1000000,
                rate: 12,
                amountPaisa: 10000
            });
        }

        const page1 = getAccountInterestHistory(db, accId, { limit: 2, offset: 0 });
        assert.strictEqual(page1.total, 5);
        assert.strictEqual(page1.count, 2);
        assert.strictEqual(page1.items[0].period_start, '2026-01-01');
        assert.strictEqual(page1.items[1].period_start, '2026-02-01');

        const page2 = getAccountInterestHistory(db, accId, { limit: 2, offset: 2 });
        assert.strictEqual(page2.count, 2);
        assert.strictEqual(page2.items[0].period_start, '2026-03-01');
        assert.strictEqual(page2.items[1].period_start, '2026-04-01');

        const page3 = getAccountInterestHistory(db, accId, { limit: 2, offset: 4 });
        assert.strictEqual(page3.count, 1);
        assert.strictEqual(page3.items[0].period_start, '2026-05-01');
    });

    // ─── Test 14: Single Record Detail ───
    console.log('--- Test 14: Single Record Detail ---');
    await testAsync('Test 14 — Single record details & not-found error handling', async () => {
        const pId = createTestPerson('History Person 14', '9990001015');
        const accId = createTestAccount(pId, 1000000, 12);
        const rec = recordTestInterest(accId, '2026-01-01', '2026-01-31');

        const detail = getInterestRecordDetails(db, rec.id);
        assert.strictEqual(detail.id, rec.id);
        assert.strictEqual(detail.account_id, accId);
        assert.strictEqual(detail.interest_amount, 98.63);
        assert.strictEqual(detail.person_name, 'History Person 14');

        // Non-existent record throws 404
        assert.throws(() => {
            getInterestRecordDetails(db, 999999);
        }, /not found/);
    });

    // ─── Tests 15–19: API Endpoints Integration ───
    console.log('--- Tests 15–19: API Endpoints Integration ---');
    const http = require('http');
    const express = require('express');
    const apiRoutes = require('../routes/api');

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
        await testAsync('Test 15 — API: GET /accounts/:id/interest-history', async () => {
            const pId = createTestPerson('API Person 15', '9990001016');
            const accId = createTestAccount(pId, 1000000, 12);
            recordTestInterest(accId, '2026-01-01', '2026-01-31');

            const res = await authFetch(`${baseUrl}/accounts/${accId}/interest-history`);
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.account_id, accId);
            assert.strictEqual(data.items.length, 1);
            assert.strictEqual(data.items[0].interest_amount, 98.63);
            assert.strictEqual(data.summary.total_records, 1);
        });

        await testAsync('Test 16 — API: GET /loans/:id/interest (conceptual endpoint alias)', async () => {
            const pId = createTestPerson('API Person 16', '9990001017');
            const accId = createTestAccount(pId, 1000000, 12);
            recordTestInterest(accId, '2026-01-01', '2026-01-31');

            const res = await authFetch(`${baseUrl}/loans/${accId}/interest`);
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.account_id, accId);
            assert.strictEqual(data.items.length, 1);
            assert.strictEqual(data.items[0].interest_amount, 98.63);
        });

        await testAsync('Test 17 — API: GET /people/:id/interest-history', async () => {
            const pId = createTestPerson('API Person 17', '9990001018');
            const accId = createTestAccount(pId, 1000000, 12);
            recordTestInterest(accId, '2026-01-01', '2026-01-31');

            const res = await authFetch(`${baseUrl}/people/${pId}/interest-history`);
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.person_id, pId);
            assert.strictEqual(data.items.length, 1);
            assert.strictEqual(data.items[0].interest_amount, 98.63);
        });

        await testAsync('Test 18 — API: GET /interest-history (with query filter)', async () => {
            const pId = createTestPerson('API Person 18', '9990001019');
            const accId = createTestAccount(pId, 1000000, 12);
            recordTestInterest(accId, '2026-01-01', '2026-01-31');

            const res = await authFetch(`${baseUrl}/interest-history?account_id=${accId}&status=PENDING`);
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.items.length, 1);
            assert.strictEqual(data.items[0].account_id, accId);
        });

        await testAsync('Test 19 — API: GET /interest-records/:id/history-detail', async () => {
            const pId = createTestPerson('API Person 19', '9990001020');
            const accId = createTestAccount(pId, 1000000, 12);
            const rec = recordTestInterest(accId, '2026-01-01', '2026-01-31');

            const res = await authFetch(`${baseUrl}/interest-records/${rec.id}/history-detail`);
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.data.id, rec.id);
            assert.strictEqual(data.data.interest_amount, 98.63);
            assert.strictEqual(data.data.account_id, accId);
        });
    } finally {
        await new Promise(resolve => testServer.close(resolve));
    }

    // ─── Summary ───
    console.log('\n================================================================');
    console.log(`Step 6H Test Results: ${passedTests} passed, ${failedTests} failed`);
    console.log('================================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    }
}

runStep6HTests().catch((err) => {
    console.error('Fatal error running Step 6H tests:', err);
    process.exit(1);
});
