/**
 * Interest Manager — Step 6F: Interest Recording & Persistence Tests
 *
 * Verifies:
 *   Test 1: Record normal interest (₹10,000, 12%, 30 days → 1 record, ₹98.63 / 9,863 paisa)
 *   Test 2: Historical snapshot (Record @ 12%, change config to 10%, record preserves 12%)
 *   Test 3: Duplicate period (Record twice → 1 active financial record, idempotent handling)
 *   Test 4: Principal protection (Principal and outstanding principal untouched before and after)
 *   Test 5: Zero interest (Principal = ₹0 → business rule respected, no persistent record)
 *   Test 6: Persistence failure (Transaction rollback, no partial financial state)
 *   Test 7: Audit integration (INTEREST_RECORDED event created with exact payload)
 *   Test 8: Database constraint test (idx_interest_records_active_period enforces uniqueness)
 *   Test 9: Monetary precision (Stores exact integer paisa in SQLite)
 *   Test 10: Step 6E → 6F full pipeline orchestration (accrueAndRecord)
 */

const assert = require('assert');
const { getDatabase } = require('../db/connection');
const { queryOne, queryAll } = require('../db/helpers');
const { calculateAccrual } = require('../services/interestAccrualService');
const { createInterestConfig, updateInterestConfig } = require('../services/interestConfigService');
const {
    recordAccrualResult,
    accrueAndRecord,
    validateAccrualResult,
    checkExistingRecord
} = require('../services/interestRecordingService');

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

async function runStep6FTests() {
    console.log('\n================================================================');
    console.log('   INTEREST MANAGER — STEP 6F: RECORDING & PERSISTENCE TESTS');
    console.log('================================================================\n');

    const db = await getDatabase();

    // ─── Test 1: Record Normal Interest (Section 18, Test 1) ───
    console.log('--- Phase 1: Core Recording & Persistence ---');

    await testAsync('Test 1: Record normal interest (₹10,000, 12%, 30 days → 1 record, ₹98.63)', async () => {
        // Create account
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')
        `);
        const accId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // 1. Calculate accrual using Step 6E
        const accrualResult = calculateAccrual(db, accId, {
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        });

        assert.strictEqual(accrualResult.interest_amount, 98.63);
        assert.strictEqual(accrualResult.is_accrued, false, 'Accrual alone must not persist');

        // 2. Persist using Step 6F
        const recordResult = recordAccrualResult(db, accrualResult, { source: 'MANUAL' });

        assert.strictEqual(recordResult.status, 'SUCCESS');
        assert(recordResult.id > 0, 'Must return positive record ID');
        assert.strictEqual(recordResult.account_id, accId);
        assert.strictEqual(recordResult.principal_basis, 10000);
        assert.strictEqual(recordResult.principal_basis_paisa, 1000000);
        assert.strictEqual(recordResult.interest_rate, 12);
        assert.strictEqual(recordResult.interest_amount, 98.63);
        assert.strictEqual(recordResult.interest_amount_paisa, 9863);
        assert.strictEqual(recordResult.period_start, '2026-01-01');
        assert.strictEqual(recordResult.period_end, '2026-01-31');
        assert.strictEqual(recordResult.record_status, 'PENDING');
        assert.strictEqual(recordResult.source, 'MANUAL');

        // 3. Verify in database
        const dbRecord = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [recordResult.id]);
        assert(dbRecord !== null, 'Record must exist in DB');
        assert.strictEqual(dbRecord.account_id, accId);
        assert.strictEqual(dbRecord.principal_basis, 1000000);
        assert.strictEqual(dbRecord.interest_amount, 9863);
        assert.strictEqual(dbRecord.interest_rate, 12);
        assert.strictEqual(dbRecord.status, 'PENDING');
        assert.strictEqual(dbRecord.paid_amount, 0);
    });

    // ─── Test 2: Historical Snapshot (Section 18, Test 2) ───
    console.log('\n--- Phase 2: Historical Snapshot Integrity ---');

    await testAsync('Test 2: Historical snapshot preserves original calculation rate', async () => {
        // Create account with 12% rate
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')
        `);
        const accId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Record interest at 12%
        const accrual = calculateAccrual(db, accId, {
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        });
        const recorded = recordAccrualResult(db, accrual);

        assert.strictEqual(recorded.interest_rate, 12);

        // Now modify the account rate to 10%
        db.run('UPDATE accounts SET interest_rate = 10 WHERE id = ?', [accId]);

        // Also create a new interest config at 10%
        createInterestConfig(db, accId, {
            interest_rate: 10,
            calculation_method: 'SIMPLE_INTEREST',
            effective_from: '2026-02-01',
            notes: 'Rate reduced to 10%'
        });

        // Verify the persisted historical record is completely unchanged
        const historicalRecord = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [recorded.id]);
        assert.strictEqual(historicalRecord.interest_rate, 12, 'Historical rate must remain 12%');
        assert.strictEqual(historicalRecord.interest_amount, 9863, 'Historical amount must remain ₹98.63');
        assert.strictEqual(historicalRecord.principal_basis, 1000000, 'Historical principal basis must remain ₹10,000');
    });

    // ─── Test 3: Duplicate Period & Idempotency (Section 18, Test 3) ───
    console.log('\n--- Phase 3: Duplicate Prevention & Idempotency ---');

    await testAsync('Test 3: Duplicate recording is prevented idempotently', async () => {
        // Create account
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')
        `);
        const accId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const accrual = calculateAccrual(db, accId, {
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        });

        // Request 1: creates record
        const rec1 = recordAccrualResult(db, accrual);
        assert.strictEqual(rec1.status, 'SUCCESS');
        assert.strictEqual(rec1.created, true);

        // Request 2: duplicate request for exact same account and period
        const rec2 = recordAccrualResult(db, accrual);
        assert.strictEqual(rec2.status, 'ALREADY_RECORDED');
        assert.strictEqual(rec2.is_duplicate, true);
        assert.strictEqual(rec2.already_recorded, true);
        assert.strictEqual(rec2.created, false);
        assert.strictEqual(rec2.id, rec1.id, 'Must reference the already-existing record ID');

        // Verify exactly one record exists in database
        const rows = queryAll(db, `
            SELECT * FROM interest_records
            WHERE account_id = ? AND period_start = '2026-01-01' AND period_end = '2026-01-31'
        `, [accId]);
        assert.strictEqual(rows.length, 1, 'Exactly one record must exist in DB');

        // Also verify throwOnDuplicate option when strict rejection is requested
        assert.throws(() => {
            recordAccrualResult(db, accrual, { throwOnDuplicate: true });
        }, (err) => {
            return err.statusCode === 400 && err.message.includes('already exists');
        });
    });

    // ─── Test 4: Principal Protection (Section 18, Test 4) ───
    console.log('\n--- Phase 4: Financial Isolation & Safety ---');

    await testAsync('Test 4: Recording interest does NOT modify principal', async () => {
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (1, 'MONEY_GIVEN', 5000000, 4500000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')
        `);
        const accId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const accBefore = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accId]);
        const txCountBefore = queryOne(db, 'SELECT COUNT(*) as cnt FROM transactions WHERE account_id = ?', [accId]).cnt;

        // Record interest
        const accrual = calculateAccrual(db, accId, {
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        });
        recordAccrualResult(db, accrual);

        const accAfter = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accId]);
        const txCountAfter = queryOne(db, 'SELECT COUNT(*) as cnt FROM transactions WHERE account_id = ?', [accId]).cnt;

        // Invariant: principal and outstanding principal are 100% untouched
        assert.strictEqual(accAfter.principal, accBefore.principal, 'Principal must be untouched');
        assert.strictEqual(accAfter.outstanding_principal, accBefore.outstanding_principal, 'Outstanding principal must be untouched');
        assert.strictEqual(txCountAfter, txCountBefore, 'Zero transaction rows created');
    });

    // ─── Test 5: Zero Interest Business Rule (Section 18, Test 5) ───
    await testAsync('Test 5: Zero interest produces ₹0.00 and no persistent DB row', async () => {
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (1, 'MONEY_GIVEN', 1000000, 0, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')
        `);
        const accId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const accrual = calculateAccrual(db, accId, {
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        });
        assert.strictEqual(accrual.interest_amount, 0.00);

        const recordResult = recordAccrualResult(db, accrual);

        assert.strictEqual(recordResult.status, 'ZERO_INTEREST');
        assert.strictEqual(recordResult.interest_amount, 0.00);
        assert.strictEqual(recordResult.created, false);
        assert.strictEqual(recordResult.id, null);

        // Confirm 0 rows in interest_records
        const dbRows = queryAll(db, 'SELECT * FROM interest_records WHERE account_id = ?', [accId]);
        assert.strictEqual(dbRows.length, 0, 'Zero interest records must be persisted');
    });

    // ─── Test 6: Persistence Failure & Rollback (Section 18, Test 6) ───
    console.log('\n--- Phase 5: Transactional Integrity & Audit ---');

    await testAsync('Test 6: Persistence failure rolls back cleanly with zero partial state', async () => {
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')
        `);
        const accId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const countRecordsBefore = queryOne(db, 'SELECT COUNT(*) as cnt FROM interest_records').cnt;
        const countAuditsBefore = queryOne(db, 'SELECT COUNT(*) as cnt FROM audit_logs').cnt;

        // Mock a DB error during transaction by temporarily corrupting db.run
        const originalRun = db.run;
        let failTriggered = false;

        db.run = function (sql, params) {
            if (typeof sql === 'string' && sql.includes('INSERT INTO audit_logs')) {
                failTriggered = true;
                throw new Error('Simulated audit table failure during transaction');
            }
            return originalRun.apply(this, arguments);
        };

        const accrual = calculateAccrual(db, accId, {
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        });

        assert.throws(() => {
            recordAccrualResult(db, accrual);
        }, (err) => {
            return err.message.includes('Simulated audit table failure');
        });

        // Restore db.run
        db.run = originalRun;
        assert.strictEqual(failTriggered, true);

        // Invariant: zero partial rows created (rollback verified)
        const countRecordsAfter = queryOne(db, 'SELECT COUNT(*) as cnt FROM interest_records').cnt;
        const countAuditsAfter = queryOne(db, 'SELECT COUNT(*) as cnt FROM audit_logs').cnt;

        assert.strictEqual(countRecordsAfter, countRecordsBefore, 'Interest records must roll back');
        assert.strictEqual(countAuditsAfter, countAuditsBefore, 'Audit logs must roll back');
    });

    // ─── Test 7: Audit Event Integration (Section 18, Test 7) ───
    await testAsync('Test 7: Audit event INTEREST_RECORDED is created with exact payload', async () => {
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')
        `);
        const accId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        const accrual = calculateAccrual(db, accId, {
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        });

        const recorded = recordAccrualResult(db, accrual, {
            source: 'AUTOMATIC',
            actorId: 'SCHEDULER_JOB_42'
        });

        // Retrieve the audit log
        const audit = queryOne(db, `
            SELECT * FROM audit_logs
            WHERE entity_type = 'INTEREST_RECORD' AND entity_id = ?
            ORDER BY id DESC LIMIT 1
        `, [recorded.id]);

        assert(audit !== null, 'Audit log row must exist');
        assert.strictEqual(audit.action, 'INTEREST_RECORDED');

        const payload = JSON.parse(audit.new_value);
        assert.strictEqual(payload.event_type, 'INTEREST_RECORDED');
        assert.strictEqual(payload.account_id, accId);
        assert.strictEqual(payload.interest_record_id, recorded.id);
        assert.strictEqual(payload.source, 'AUTOMATIC');
        assert.strictEqual(payload.actor_id, 'SCHEDULER_JOB_42');
        assert.strictEqual(payload.period_start, '2026-01-01');
        assert.strictEqual(payload.period_end, '2026-01-31');
        assert.strictEqual(payload.principal_basis, 1000000);
        assert.strictEqual(payload.interest_amount, 9863);
        assert.strictEqual(payload.interest_rate, 12);
        assert.strictEqual(payload.calculation_method, 'SIMPLE_INTEREST');
    });

    // ─── Test 8: Database Constraint Direct Verification (Section 19) ───
    console.log('\n--- Phase 6: Database Constraints & Pipeline ---');

    await testAsync('Test 8: Database partial unique index idx_interest_records_active_period enforces uniqueness', async () => {
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (1, 'MONEY_GIVEN', 1000000, 1000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')
        `);
        const accId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Raw insert 1
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis,
                interest_rate, interest_amount, calculation_method, status
            ) VALUES (?, '2026-03-01', '2026-03-31', 1000000, 12, 9863, 'SIMPLE_INTEREST', 'PENDING')
        `, [accId]);

        // Raw insert 2: same account + period with active status -> MUST trigger SQLite UNIQUE constraint
        assert.throws(() => {
            db.run(`
                INSERT INTO interest_records (
                    account_id, period_start, period_end, principal_basis,
                    interest_rate, interest_amount, calculation_method, status
                ) VALUES (?, '2026-03-01', '2026-03-31', 1000000, 12, 9863, 'SIMPLE_INTEREST', 'PENDING')
            `, [accId]);
        }, (err) => {
            return err.message.includes('UNIQUE constraint failed');
        });
    });

    // ─── Test 9: Exact Monetary Precision (Section 14) ───
    await testAsync('Test 9: Exact integer paisa precision stored in SQLite', async () => {
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (1, 'MONEY_GIVEN', 8000000, 8000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')
        `);
        const accId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Principal = ₹80,000, Rate = 12%, 30 days -> ₹789.04 = 78,904 paisa
        const accrual = calculateAccrual(db, accId, {
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        });

        const recorded = recordAccrualResult(db, accrual);
        assert.strictEqual(recorded.interest_amount, 789.04);
        assert.strictEqual(recorded.interest_amount_paisa, 78904);

        const row = queryOne(db, 'SELECT interest_amount, principal_basis FROM interest_records WHERE id = ?', [recorded.id]);
        assert.strictEqual(row.interest_amount, 78904, 'Stored value must be exact integer 78904 paisa');
        assert.strictEqual(row.principal_basis, 8000000, 'Stored principal basis must be exact integer 8000000 paisa');
    });

    // ─── Test 10: Step 6E → 6F End-to-End Orchestration (accrueAndRecord) ───
    await testAsync('Test 10: accrueAndRecord orchestrates 6E accrual and 6F persistence', async () => {
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (1, 'MONEY_GIVEN', 2000000, 2000000, 12, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-12-31', 'ACTIVE')
        `);
        const accId = queryOne(db, 'SELECT last_insert_rowid() as id').id;

        // Automatically determine period, calculate interest, and record
        const res = accrueAndRecord(db, accId);

        assert.strictEqual(res.status, 'SUCCESS');
        assert.strictEqual(res.period_start, '2026-01-01');
        assert.strictEqual(res.period_end, '2026-02-01');
        assert.strictEqual(res.created, true);
        // ₹20,000 @ 12%, 31 days (Jan 1 to Feb 1) = 203.8356... → ₹203.84
        assert.strictEqual(res.interest_amount, 203.84);
        assert.strictEqual(res.interest_amount_paisa, 20384);

        // Calling accrueAndRecord again with same parameters returns ALREADY_RECORDED idempotently
        const resDup = accrueAndRecord(db, accId, {
            startDate: '2026-01-01',
            endDate: '2026-02-01'
        });
        assert.strictEqual(resDup.status, 'ALREADY_RECORDED');
        assert.strictEqual(resDup.already_recorded, true);
        assert.strictEqual(resDup.id, res.id);
    });

    // ─── Summary ───
    console.log('\n================================================================');
    console.log(`Step 6F Test Results: ${passedTests} passed, ${failedTests} failed`);
    console.log('================================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    }
}

runStep6FTests().catch((err) => {
    console.error('Fatal error running Step 6F tests:', err);
    process.exit(1);
});
