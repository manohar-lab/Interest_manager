/**
 * Interest Manager — Step 6G: Interest Payment Integration Tests
 *
 * Verifies:
 *   Test 1: Partial interest payment (Interest = ₹98.63, Payment = ₹30.00 → Paid = ₹30.00, Outstanding = ₹68.63)
 *   Test 2: Full interest payment (Interest = ₹98.63, Payment = ₹98.63 → Paid = ₹98.63, Outstanding = ₹0.00, Status = PAID)
 *   Test 3: Overpayment (Interest = ₹98.63, Payment = ₹150.00 → Interest allocation = ₹98.63, Remaining payment = ₹51.37 to principal)
 *   Test 4: Principal protection (Before payment = ₹10,000, After interest payment = ₹10,000)
 *   Test 5: Multiple interest records (Interest #1 = ₹100, Interest #2 = ₹150 → allocated in FIFO order)
 *   Test 6: Duplicate request (Submit same payment operation twice → no double allocation)
 *   Test 7: Already settled (Payment against settled record with Outstanding = ₹0 → rejected)
 *   Test 8: Wrong account (Payment for Account A allocated to Interest of Account B → rejected)
 *   Test 9: Reversed record (Payment against REVERSED record → rejected)
 *   Test 10: Financial immutability (Original interest_amount, principal_basis, interest_rate remain untouched)
 *   Test 11: Audit integration (PAYMENT_ALLOCATED event written to audit logs)
 *   Test 12: Junction table tracking (interest_allocations correctly links transaction and interest record)
 */

const assert = require('assert');
const { getDatabase } = require('../db/connection');
const { queryOne, queryAll } = require('../db/helpers');
const { calculateAccrual } = require('../services/interestAccrualService');
const { recordAccrualResult } = require('../services/interestRecordingService');
const {
    getInterestRecordBalance,
    allocatePaymentToInterestRecord,
    allocatePaymentWithCascading
} = require('../services/interestPaymentService');
const { allocatePayment } = require('../services/transactionService');

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
        failedTests++;
    }
}

async function runStep6GTests() {
    console.log('\n================================================================');
    console.log('   INTEREST MANAGER — STEP 6G: PAYMENT INTEGRATION TESTS');
    console.log('================================================================\n');

    const db = await getDatabase();

    // Helper to create fresh test account
    function createTestAccount(principal = 1000000, rate = 12, direction = 'MONEY_GIVEN') {
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (1, ?, ?, ?, ?, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')
        `, [direction, principal, principal, rate]);
        return queryOne(db, 'SELECT last_insert_rowid() as id').id;
    }

    // Helper to record interest
    function recordTestInterest(accountId, startDate = '2026-01-01', endDate = '2026-01-31') {
        const accrual = calculateAccrual(db, accountId, { startDate, endDate });
        return recordAccrualResult(db, accrual);
    }

    // ─── Phase 1: Partial & Full Payments (Section 20, Tests 1 & 2) ───
    console.log('--- Phase 1: Partial & Full Settlement ---');

    await testAsync('Test 1: Partial interest payment (Interest = ₹98.63, Payment = ₹30.00 → Paid = ₹30.00, Outstanding = ₹68.63)', async () => {
        const accId = createTestAccount(1000000, 12); // ₹10,000 @ 12%
        const recorded = recordTestInterest(accId, '2026-01-01', '2026-01-31'); // ₹98.63

        // Verify balance before payment
        const balBefore = getInterestRecordBalance(db, recorded.id);
        assert.strictEqual(balBefore.recorded_interest, 98.63);
        assert.strictEqual(balBefore.paid_interest, 0.00);
        assert.strictEqual(balBefore.outstanding_interest, 98.63);
        assert.strictEqual(balBefore.status, 'PENDING');

        // Pay ₹30.00 towards interest
        const allocRes = await allocatePayment(db, {
            account_id: accId,
            total_amount: 30.00,
            interest_amount: 30.00,
            principal_amount: 0.00,
            payment_method: 'UPI',
            payment_date: '2026-02-05',
            reference: 'UPI/INT-PARTIAL'
        });

        assert.strictEqual(allocRes.isDuplicate, false);

        // Verify balance after payment
        const balAfter = getInterestRecordBalance(db, recorded.id);
        assert.strictEqual(balAfter.recorded_interest, 98.63, 'Original recorded interest must remain ₹98.63');
        assert.strictEqual(balAfter.paid_interest, 30.00, 'Paid interest must be ₹30.00');
        assert.strictEqual(balAfter.outstanding_interest, 68.63, 'Outstanding interest must be ₹68.63');
        assert.strictEqual(balAfter.status, 'PARTIALLY_PAID', 'Status must transition to PARTIALLY_PAID');
    });

    await testAsync('Test 2: Full interest payment (Interest = ₹98.63, Payment = ₹98.63 → Paid = ₹98.63, Outstanding = ₹0.00, Status = PAID)', async () => {
        const accId = createTestAccount(1000000, 12);
        const recorded = recordTestInterest(accId, '2026-01-01', '2026-01-31');

        // Pay exact ₹98.63
        await allocatePayment(db, {
            account_id: accId,
            total_amount: 98.63,
            interest_amount: 98.63,
            principal_amount: 0.00,
            payment_method: 'BANK_TRANSFER',
            payment_date: '2026-02-05',
            reference: 'BANK/INT-FULL'
        });

        const balAfter = getInterestRecordBalance(db, recorded.id);
        assert.strictEqual(balAfter.recorded_interest, 98.63);
        assert.strictEqual(balAfter.paid_interest, 98.63);
        assert.strictEqual(balAfter.outstanding_interest, 0.00);
        assert.strictEqual(balAfter.status, 'PAID', 'Status must transition to PAID');
        assert.strictEqual(balAfter.is_settled, true);
    });

    // ─── Phase 2: Overpayment & Principal Protection (Section 20, Tests 3 & 4) ───
    console.log('\n--- Phase 2: Overpayment & Principal Invariants ---');

    await testAsync('Test 3: Overpayment (Interest = ₹98.63, Payment = ₹150.00 → Interest = ₹98.63, Remaining ₹51.37 to principal)', async () => {
        const accId = createTestAccount(1000000, 12); // ₹10,000 principal
        const recorded = recordTestInterest(accId, '2026-01-01', '2026-01-31'); // ₹98.63 interest

        // Make an overpayment of ₹150.00 via allocatePaymentWithCascading
        const payRes = await allocatePaymentWithCascading(db, {
            account_id: accId,
            total_amount: 150.00,
            payment_method: 'CASH',
            payment_date: '2026-02-05',
            reference: 'CASH/OVERPAY'
        });

        // 1. Interest must be capped at outstanding ₹98.63
        const balAfter = getInterestRecordBalance(db, recorded.id);
        assert.strictEqual(balAfter.paid_interest, 98.63);
        assert.strictEqual(balAfter.outstanding_interest, 0.00);
        assert.strictEqual(balAfter.status, 'PAID');

        // 2. Remaining ₹51.37 must pay down principal
        const accAfter = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accId]);
        // 10,000 - 51.37 = 9,948.63 (994,863 paisa)
        assert.strictEqual(accAfter.outstanding_principal, 994863, 'Remaining ₹51.37 must reduce principal');

        // 3. Transactions created
        const txs = queryAll(db, 'SELECT * FROM transactions WHERE account_id = ? ORDER BY id ASC', [accId]);
        const intTx = txs.find(t => t.transaction_type === 'INTEREST_RECEIVED');
        const prinTx = txs.find(t => t.transaction_type === 'PRINCIPAL_RECEIVED');

        assert(intTx !== undefined, 'INTEREST_RECEIVED transaction must exist');
        assert.strictEqual(intTx.amount, 9863, 'Interest transaction must be ₹98.63 (9863 paisa)');

        assert(prinTx !== undefined, 'PRINCIPAL_RECEIVED transaction must exist');
        assert.strictEqual(prinTx.amount, 5137, 'Principal transaction must be ₹51.37 (5137 paisa)');
    });

    await testAsync('Test 4: Principal protection (Principal remains untouched during pure interest payment)', async () => {
        const accId = createTestAccount(1000000, 12);
        recordTestInterest(accId, '2026-01-01', '2026-01-31');

        const accBefore = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accId]);

        // Pay ₹30.00 interest only
        await allocatePayment(db, {
            account_id: accId,
            total_amount: 30.00,
            interest_amount: 30.00,
            principal_amount: 0.00,
            payment_method: 'UPI',
            payment_date: '2026-02-05'
        });

        const accAfter = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accId]);

        // Principal must be 100% identical before and after
        assert.strictEqual(accAfter.principal, accBefore.principal);
        assert.strictEqual(accAfter.outstanding_principal, accBefore.outstanding_principal);
    });

    // ─── Phase 3: Multiple Records & FIFO Ordering (Section 20, Test 5) ───
    console.log('\n--- Phase 3: Multiple Records & Allocation Order ---');

    await testAsync('Test 5: Multiple interest records allocated in FIFO order (period_start ASC, id ASC)', async () => {
        const accId = createTestAccount(1000000, 12);

        // Record 1: Jan period (say ₹100 = 10,000 paisa)
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis,
                interest_rate, interest_amount, calculation_method, status
            ) VALUES (?, '2026-01-01', '2026-02-01', 1000000, 12, 10000, 'SIMPLE_INTEREST', 'PENDING')
        `, [accId]);
        const rec1Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Record 2: Feb period (say ₹150 = 15,000 paisa)
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis,
                interest_rate, interest_amount, calculation_method, status
            ) VALUES (?, '2026-02-01', '2026-03-01', 1000000, 12, 15000, 'SIMPLE_INTEREST', 'PENDING')
        `, [accId]);
        const rec2Id = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Process a payment of ₹160.00 towards interest
        await allocatePayment(db, {
            account_id: accId,
            total_amount: 160.00,
            interest_amount: 160.00,
            principal_amount: 0.00,
            payment_method: 'BANK_TRANSFER',
            payment_date: '2026-03-05'
        });

        // Record 1 (earliest) must be fully paid (₹100)
        const bal1 = getInterestRecordBalance(db, rec1Id);
        assert.strictEqual(bal1.paid_interest, 100.00);
        assert.strictEqual(bal1.outstanding_interest, 0.00);
        assert.strictEqual(bal1.status, 'PAID');

        // Record 2 must receive remaining ₹60.00
        const bal2 = getInterestRecordBalance(db, rec2Id);
        assert.strictEqual(bal2.paid_interest, 60.00);
        assert.strictEqual(bal2.outstanding_interest, 90.00);
        assert.strictEqual(bal2.status, 'PARTIALLY_PAID');

        // Verify interest_allocations rows
        const allocs = queryAll(db, 'SELECT * FROM interest_allocations WHERE account_id = ? ORDER BY id ASC', [accId]);
        assert.strictEqual(allocs.length, 2);
        assert.strictEqual(allocs[0].interest_record_id, rec1Id);
        assert.strictEqual(allocs[0].amount, 10000); // ₹100
        assert.strictEqual(allocs[1].interest_record_id, rec2Id);
        assert.strictEqual(allocs[1].amount, 6000);  // ₹60
    });

    // ─── Phase 4: Idempotency & Validation Guardrails (Section 20, Tests 6 to 9) ───
    console.log('\n--- Phase 4: Idempotency & Validation Guardrails ---');

    await testAsync('Test 6: Idempotency prevents double allocation on repeated requests', async () => {
        const accId = createTestAccount(1000000, 12);
        const recorded = recordTestInterest(accId, '2026-01-01', '2026-01-31');

        const key = 'IDEM-PAY-TEST-' + Date.now();
        const payload = {
            account_id: accId,
            total_amount: 30.00,
            interest_amount: 30.00,
            principal_amount: 0.00,
            payment_method: 'UPI',
            payment_date: '2026-02-05',
            idempotency_key: key
        };

        // First call
        const res1 = await allocatePayment(db, payload, key);
        assert.strictEqual(res1.isDuplicate, false);

        // Second call with same key
        const res2 = await allocatePayment(db, payload, key);
        assert.strictEqual(res2.isDuplicate, true);

        // Check DB: exactly ₹30.00 paid, NOT ₹60.00
        const bal = getInterestRecordBalance(db, recorded.id);
        assert.strictEqual(bal.paid_interest, 30.00, 'Must NOT double allocate');
        assert.strictEqual(bal.outstanding_interest, 68.63);

        const txCount = queryOne(db, 'SELECT COUNT(*) as cnt FROM transactions WHERE account_id = ?', [accId]).cnt;
        assert.strictEqual(txCount, 1, 'Only 1 transaction must exist');
    });

    await testAsync('Test 7: Attempting payment against fully settled interest record is rejected', async () => {
        const accId = createTestAccount(1000000, 12);
        const recorded = recordTestInterest(accId, '2026-01-01', '2026-01-31');

        // Pay full interest
        await allocatePayment(db, {
            account_id: accId,
            total_amount: 98.63,
            interest_amount: 98.63,
            principal_amount: 0.00,
            payment_method: 'CASH',
            payment_date: '2026-02-05'
        });

        // Attempt second payment towards interest
        await assert.rejects(async () => {
            await allocatePayment(db, {
                account_id: accId,
                total_amount: 10.00,
                interest_amount: 10.00,
                principal_amount: 0.00,
                payment_method: 'CASH',
                payment_date: '2026-02-06'
            });
        }, (err) => {
            return err.statusCode === 400 && err.message.includes('₹0 outstanding interest');
        });

        // Balance must remain 0 and never become negative
        const bal = getInterestRecordBalance(db, recorded.id);
        assert.strictEqual(bal.outstanding_interest, 0.00);
    });

    await testAsync('Test 8: Wrong account allocation is rejected with no state change', async () => {
        const accA = createTestAccount(1000000, 12);
        const accB = createTestAccount(1000000, 12);

        // Interest on Account B
        const recB = recordTestInterest(accB, '2026-01-01', '2026-01-31');

        // Try to allocate payment from Account A to Interest Record of Account B
        await assert.rejects(async () => {
            await allocatePayment(db, {
                account_id: accA,
                interest_record_id: recB.id,
                total_amount: 50.00,
                interest_amount: 50.00,
                principal_amount: 0.00,
                payment_method: 'CASH',
                payment_date: '2026-02-05'
            });
        }, (err) => {
            return err.statusCode === 400 && err.message.includes('not Account #' + accA);
        });

        // Zero changes on Record B
        const balB = getInterestRecordBalance(db, recB.id);
        assert.strictEqual(balB.paid_interest, 0.00);
        assert.strictEqual(balB.outstanding_interest, 98.63);
    });

    await testAsync('Test 9: Payment allocation against REVERSED interest record is rejected', async () => {
        const accId = createTestAccount(1000000, 12);

        // Insert a reversed record directly
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis,
                interest_rate, interest_amount, calculation_method, status, reversal_reason
            ) VALUES (?, '2026-01-01', '2026-01-31', 1000000, 12, 9863, 'SIMPLE_INTEREST', 'REVERSED', 'Calculation error')
        `, [accId]);
        const revId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Try to allocate to reversed record directly
        assert.throws(() => {
            allocatePaymentToInterestRecord(db, {
                account_id: accId,
                interest_record_id: revId,
                amount: 50.00
            });
        }, (err) => {
            return err.statusCode === 400 && err.message.includes('reversed');
        });
    });

    // ─── Phase 5: Immutability & Audit Integration (Section 20, Tests 10 to 12) ───
    console.log('\n--- Phase 5: Financial Immutability & Audit Integration ---');

    await testAsync('Test 10: Financial immutability preserves calculation parameters upon payment', async () => {
        const accId = createTestAccount(1000000, 12);
        const recorded = recordTestInterest(accId, '2026-01-01', '2026-01-31');

        await allocatePayment(db, {
            account_id: accId,
            total_amount: 40.00,
            interest_amount: 40.00,
            principal_amount: 0.00,
            payment_method: 'UPI',
            payment_date: '2026-02-05'
        });

        const row = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [recorded.id]);
        assert.strictEqual(row.interest_amount, 9863, 'interest_amount must never change');
        assert.strictEqual(row.principal_basis, 1000000, 'principal_basis must never change');
        assert.strictEqual(row.interest_rate, 12, 'interest_rate must never change');
        assert.strictEqual(row.period_start, '2026-01-01', 'period_start must never change');
        assert.strictEqual(row.period_end, '2026-01-31', 'period_end must never change');
        assert.strictEqual(row.paid_amount, 4000, 'paid_amount updated to 4000 paisa');
    });

    await testAsync('Test 11: Audit log records PAYMENT_ALLOCATION event linking payment, transaction, and account', async () => {
        const accId = createTestAccount(1000000, 12);
        recordTestInterest(accId, '2026-01-01', '2026-01-31');

        const payRes = await allocatePayment(db, {
            account_id: accId,
            total_amount: 30.00,
            interest_amount: 30.00,
            principal_amount: 0.00,
            payment_method: 'CASH',
            payment_date: '2026-02-05'
        });

        const audit = queryOne(db, `
            SELECT * FROM audit_logs
            WHERE entity_type = 'PAYMENT_ALLOCATION' AND entity_id = ?
            ORDER BY id DESC LIMIT 1
        `, [accId]);

        assert(audit !== null, 'Payment allocation audit row must exist');
        const payload = JSON.parse(audit.new_value);
        assert.strictEqual(payload.payment_id, payRes.payment_id);
        assert.strictEqual(payload.interest_amount, 3000); // 3000 paisa
        assert.strictEqual(payload.total_amount, 3000);
    });

    await testAsync('Test 12: allocatePaymentToInterestRecord direct helper works with existing transaction', async () => {
        const accId = createTestAccount(1000000, 12);
        const recorded = recordTestInterest(accId, '2026-01-01', '2026-01-31');

        // Direct allocation of ₹50.00
        const res = allocatePaymentToInterestRecord(db, {
            account_id: accId,
            interest_record_id: recorded.id,
            amount: 50.00,
            payment_method: 'UPI',
            payment_date: '2026-02-05',
            reference: 'DIRECT-ALLOC-50'
        });

        assert.strictEqual(res.status, 'SUCCESS');
        assert.strictEqual(res.allocated_amount, 50.00);
        assert.strictEqual(res.paid_interest, 50.00);
        assert.strictEqual(res.outstanding_interest, 48.63);
        assert.strictEqual(res.new_status, 'PARTIALLY_PAID');
    });

    // ─── Summary ───
    console.log('\n================================================================');
    console.log(`Step 6G Test Results: ${passedTests} passed, ${failedTests} failed`);
    console.log('================================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    }
    process.exit(0);
}

runStep6GTests().catch((err) => {
    console.error('Fatal error running Step 6G tests:', err);
    process.exit(1);
});
