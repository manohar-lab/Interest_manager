/**
 * Interest Manager — Step 6I: Interest Recalculation & Correction Service
 *
 * Provides recalculation and correction capabilities for interest records without
 * silently rewriting historical financial data.
 *
 * Core Financial Rules:
 *   - Historical Snapshot Immutability: Never directly overwrite recorded interest
 *     amounts (e.g. ₹100 → ₹80 in-place is prohibited).
 *   - Lineage & Replacement: Creates a new corrected record linked to the original
 *     via `corrects_record_id` and `corrected_by_record_id`.
 *   - Re-calculation via Established Engines:
 *       Determines applicable inputs → Step 6C (Days) → Step 6D (Principal) → Step 6B (Interest Formula).
 *       Zero duplicated calculation logic.
 *   - Zero Difference Rule: If recalculation yields identical interest to the original,
 *     returns a no-change result without creating redundant records.
 *   - Payment Safety: If an interest record has associated payments (paid_amount > 0),
 *     correction is safely rejected as UNSUPPORTED in Step 6I to protect payment
 *     allocations and avoid inventing ad-hoc refunds before the adjustment engine.
 *   - Idempotency: Repeating the exact same correction returns the existing corrected
 *     record rather than creating duplicates.
 *   - Atomic Transactions: All state changes (original reversal, new record insertion,
 *     linkage, audit log) are wrapped in BEGIN ... COMMIT / ROLLBACK.
 *   - Full Audit Logging: Writes INTEREST_CORRECTED event to audit_logs.
 */

const { queryOne, queryAll } = require('../db/helpers');
const { saveDatabase } = require('../db/connection');
const {
    calculateElapsedDays,
    normalizeDate
} = require('./dateCalculationService');
const {
    calculateInterest,
    DEFAULT_DAY_COUNT_BASIS
} = require('./interestCalculationService');
const { getActiveInterestConfig } = require('./interestConfigService');

/**
 * Recalculates interest for an existing record using the Step 6B/6C/6D engine.
 * Pure read-only operation: performs zero database writes.
 *
 * @param {Object} db - SQLite database connection
 * @param {number|string} recordId - Interest record ID
 * @param {Object} [options] - Optional overrides for recalculation:
 *   - startDate / period_start: Override start date
 *   - endDate / period_end: Override end date
 *   - rate / interest_rate: Override interest rate
 *   - principal / principal_basis: Override principal (in rupees)
 *   - calculation_method: Override method ('SIMPLE_INTEREST' or 'SIMPLE')
 * @returns {Object} Structured recalculation descriptor
 */
function recalculateInterestForRecord(db, recordId, options = {}) {
    if (!db) {
        const err = new Error('Database connection is required');
        err.statusCode = 500;
        throw err;
    }

    const recId = Number(recordId);
    if (!recId || isNaN(recId) || recId <= 0) {
        const err = new Error('A valid interest record ID is required');
        err.statusCode = 400;
        throw err;
    }

    const originalRecord = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [recId]);
    if (!originalRecord) {
        const err = new Error(`Interest record #${recId} not found`);
        err.statusCode = 404;
        throw err;
    }

    const account = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [originalRecord.account_id]);
    if (!account) {
        const err = new Error(`Account #${originalRecord.account_id} not found`);
        err.statusCode = 404;
        throw err;
    }

    // 1. Determine applicable period
    const rawStart = options.startDate || options.period_start || originalRecord.period_start;
    const rawEnd = options.endDate || options.period_end || originalRecord.period_end;
    const periodStart = normalizeDate(rawStart);
    const periodEnd = normalizeDate(rawEnd);

    if (!periodStart || !periodEnd) {
        const err = new Error('Valid calculation period start and end dates are required');
        err.statusCode = 400;
        throw err;
    }

    // Step 6C: Elapsed Days
    const dayInfo = calculateElapsedDays(periodStart, periodEnd);
    const days = dayInfo.elapsedDays;

    // 2. Determine applicable interest rate (Step 6A resolution unless overridden)
    let rate = Number(originalRecord.interest_rate);
    const rawOverrideRate = options.rate !== undefined ? options.rate : options.interest_rate;

    if (rawOverrideRate !== undefined && rawOverrideRate !== null && !isNaN(Number(rawOverrideRate))) {
        rate = Number(rawOverrideRate);
    } else {
        // Resolve historical config for the start date of this period
        try {
            const histConfig = getActiveInterestConfig(db, originalRecord.account_id, { asOfDate: periodStart });
            if (histConfig && histConfig.interest_rate !== undefined) {
                rate = Number(histConfig.interest_rate);
            }
        } catch (_) {
            rate = Number(originalRecord.interest_rate);
        }
    }

    // 3. Determine applicable principal (Step 6D integration unless overridden)
    let principalRupees;
    let principalPaisa;
    const rawOverridePrincipal = options.principal !== undefined ? options.principal : options.principal_basis;

    if (rawOverridePrincipal !== undefined && rawOverridePrincipal !== null && !isNaN(Number(rawOverridePrincipal))) {
        principalRupees = Number(rawOverridePrincipal);
        principalPaisa = Math.round(principalRupees * 100);
    } else {
        principalPaisa = Number(originalRecord.principal_basis);
        principalRupees = principalPaisa / 100;
    }

    // 4. Determine calculation method
    const calculationMethod = options.calculation_method || originalRecord.calculation_method || 'SIMPLE_INTEREST';

    // Step 6B: Core formula execution
    const calcResult = calculateInterest({
        principal: principalRupees,
        rate: rate,
        days: days,
        calculationMethod: calculationMethod,
        dayCountBasis: options.dayCountBasis || DEFAULT_DAY_COUNT_BASIS
    });

    const origAmountPaisa = Number(originalRecord.interest_amount);
    const newAmountPaisa = calcResult.interest_paisa !== undefined ? Number(calcResult.interest_paisa) : Number(calcResult.interestAmountPaisa);
    const newAmountRupees = calcResult.interest_amount !== undefined ? Number(calcResult.interest_amount) : Number(calcResult.interestAmount);
    const differencePaisa = newAmountPaisa - origAmountPaisa;
    const differenceRupees = differencePaisa / 100;

    return {
        original_record_id: originalRecord.id,
        account_id: originalRecord.account_id,
        period_start: periodStart,
        period_end: periodEnd,
        days: days,
        principal: principalRupees,
        principal_basis_paisa: principalPaisa,
        interest_rate: rate,
        calculation_method: calculationMethod,
        calculated_interest: newAmountRupees,
        calculated_interest_paisa: newAmountPaisa,
        original_interest: origAmountPaisa / 100,
        original_interest_paisa: origAmountPaisa,
        difference: differenceRupees,
        difference_paisa: differencePaisa,
        is_changed: differencePaisa !== 0,
        original_record: originalRecord
    };
}

/**
 * Corrects an existing interest record by establishing a replacement record
 * and linking the historical lineage atomically.
 *
 * @param {Object} db - SQLite database connection
 * @param {number|string} recordId - Interest record ID to correct
 * @param {Object} [options] - Options & overrides:
 *   - rate / interest_rate: Corrected rate
 *   - principal / principal_basis: Corrected principal
 *   - startDate / endDate: Corrected dates
 *   - reason: Reason for correction
 *   - actor_id / actorId: Identity of authorizing actor
 *   - is_authorized: Authorization flag (defaults to true)
 *   - force: Force creation even if difference is 0
 * @returns {Object} Structured correction result DTO
 */
function correctInterestRecord(db, recordId, options = {}) {
    if (!db) {
        const err = new Error('Database connection is required');
        err.statusCode = 500;
        throw err;
    }

    const recId = Number(recordId);
    if (!recId || isNaN(recId) || recId <= 0) {
        const err = new Error('A valid interest record ID is required');
        err.statusCode = 400;
        throw err;
    }

    // 1. Fetch original record
    const originalRecord = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [recId]);
    if (!originalRecord) {
        const err = new Error(`Interest record #${recId} not found`);
        err.statusCode = 404;
        throw err;
    }

    // 2. Authorization check (Section 13)
    if (options.is_authorized === false) {
        const err = new Error('Unauthorized: actor lacks permission to correct interest records');
        err.statusCode = 403;
        throw err;
    }
    const actorId = options.actor_id || options.actorId || 'API_USER';

    // 3. Payment Protection (Section 9, 10, Test 9)
    // If an interest record has associated payments (paid_amount > 0), correcting it
    // without a formalized refund/credit engine would violate payment allocations.
    if (Number(originalRecord.paid_amount || 0) > 0) {
        const err = new Error('Correction of interest records with existing payment allocations (paid_amount > 0) is not supported in Step 6I and requires the financial adjustment/refund mechanism of a later part');
        err.statusCode = 400;
        err.code = 'PAID_RECORD_CORRECTION_UNSUPPORTED';
        throw err;
    }

    // 4. Idempotency & Eligibility Checks (Section 12, 15)
    if (originalRecord.status === 'REVERSED') {
        if (originalRecord.corrected_by_record_id) {
            // Already corrected — return existing correction idempotently
            const existingCorrected = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [originalRecord.corrected_by_record_id]);
            if (existingCorrected) {
                return {
                    status: 'ALREADY_CORRECTED',
                    is_duplicate: true,
                    changed: false,
                    original_record_id: originalRecord.id,
                    corrected_record_id: existingCorrected.id,
                    original_record: originalRecord,
                    corrected_record: existingCorrected,
                    difference: (existingCorrected.interest_amount - originalRecord.interest_amount) / 100,
                    difference_paisa: existingCorrected.interest_amount - originalRecord.interest_amount,
                    message: `Interest record #${recId} has already been corrected by record #${existingCorrected.id}`
                };
            }
        }
        const err = new Error(`Interest record #${recId} is already reversed and cannot be corrected`);
        err.statusCode = 400;
        throw err;
    }

    // 5. Re-calculation (Section 3, 4)
    const recalc = recalculateInterestForRecord(db, recId, options);

    // 6. Zero difference check (Section 11, Test 1)
    if (recalc.difference_paisa === 0 && !options.force) {
        return {
            status: 'NO_CHANGE',
            changed: false,
            is_duplicate: false,
            original_record_id: originalRecord.id,
            original_amount: originalRecord.interest_amount / 100,
            original_amount_paisa: originalRecord.interest_amount,
            correct_amount: recalc.calculated_interest,
            correct_amount_paisa: recalc.calculated_interest_paisa,
            difference: 0,
            difference_paisa: 0,
            original_record: originalRecord,
            message: 'Calculated interest matches existing record; no correction needed'
        };
    }

    // 7. Atomic Transaction Execution (Section 14)
    let newRecordId = null;
    let newRecord = null;
    let updatedOriginal = null;
    const reason = options.reason || 'Recalculation and correction';
    const reversedAt = new Date().toISOString();

    try {
        db.run('BEGIN TRANSACTION');

        // Test hook to verify transactional rollback
        if (options._forceFailure) {
            throw new Error('Simulated transaction failure for rollback verification');
        }

        // Step A: Mark original record as REVERSED (preserves all original amounts & historical snapshots)
        db.run(`
            UPDATE interest_records
            SET status = 'REVERSED',
                reversal_reason = ?,
                reversed_at = ?,
                reversal_actor_id = ?,
                reversal_source = 'CORRECTION'
            WHERE id = ? AND status != 'REVERSED'
        `, [reason, reversedAt, actorId, originalRecord.id]);

        // Step B: Insert corrected replacement record
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis,
                interest_rate, calculation_method, interest_amount,
                paid_amount, status, source, scheduler_run_id, corrects_record_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'PENDING', 'CORRECTION', NULL, ?)
        `, [
            originalRecord.account_id,
            recalc.period_start,
            recalc.period_end,
            recalc.principal_basis_paisa,
            recalc.interest_rate,
            recalc.calculation_method,
            recalc.calculated_interest_paisa,
            originalRecord.id
        ]);

        const lastIdRow = queryOne(db, 'SELECT last_insert_rowid() as id');
        newRecordId = lastIdRow.id;

        // Step C: Link original record to new corrected record
        db.run(`
            UPDATE interest_records
            SET corrected_by_record_id = ?
            WHERE id = ?
        `, [newRecordId, originalRecord.id]);

        // Step D: Write audit log (Section 16)
        const auditPayload = {
            event_type: 'INTEREST_CORRECTED',
            account_id: originalRecord.account_id,
            original_record_id: originalRecord.id,
            corrected_record_id: newRecordId,
            old_amount: originalRecord.interest_amount / 100,
            old_amount_paisa: originalRecord.interest_amount,
            new_amount: recalc.calculated_interest,
            new_amount_paisa: recalc.calculated_interest_paisa,
            difference: recalc.difference,
            difference_paisa: recalc.difference_paisa,
            old_rate: originalRecord.interest_rate,
            new_rate: recalc.interest_rate,
            old_principal: originalRecord.principal_basis / 100,
            new_principal: recalc.principal,
            reason: reason,
            actor_id: actorId,
            timestamp: reversedAt
        };

        db.run(`
            INSERT INTO audit_logs (entity_type, entity_id, action, new_value)
            VALUES ('INTEREST_RECORD', ?, 'INTEREST_CORRECTED', ?)
        `, [newRecordId, JSON.stringify(auditPayload)]);

        db.run('COMMIT');
    } catch (err) {
        try { db.run('ROLLBACK'); } catch (_) {}
        throw err;
    }

    saveDatabase();

    updatedOriginal = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [originalRecord.id]);
    newRecord = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [newRecordId]);

    return {
        status: 'CORRECTED',
        changed: true,
        is_duplicate: false,
        original_record_id: originalRecord.id,
        corrected_record_id: newRecordId,
        original_record: updatedOriginal,
        corrected_record: newRecord,
        difference: recalc.difference,
        difference_paisa: recalc.difference_paisa,
        recalculation: {
            principal: recalc.principal,
            principal_basis_paisa: recalc.principal_basis_paisa,
            rate: recalc.interest_rate,
            days: recalc.days,
            calculation_method: recalc.calculation_method,
            calculated_interest: recalc.calculated_interest,
            calculated_interest_paisa: recalc.calculated_interest_paisa
        },
        audit: {
            action: 'INTEREST_CORRECTED',
            actor_id: actorId,
            reason: reason,
            timestamp: reversedAt
        }
    };
}

module.exports = {
    recalculateInterestForRecord,
    correctInterestRecord
};
