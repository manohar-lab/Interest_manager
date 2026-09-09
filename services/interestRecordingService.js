/**
 * Interest Manager — Step 6F: Interest Recording & Persistence Service
 *
 * Takes a valid accrual result from Step 6E (or equivalent financial inputs),
 * validates it, and atomically persists it as an interest record while preserving
 * financial integrity, historical snapshot accuracy, and duplicate prevention.
 *
 * Pipeline Integration:
 *   Accrual Service (Step 6E)
 *         ↓
 *   Accrual Result DTO
 *         ↓
 *   Recording Service (Step 6F)
 *         ↓
 *   Interest Repository (Database & Audit)
 *         ↓
 *   Interest Record (Entity with Snapshot & PENDING Status)
 *
 * Guarantees:
 *   - Atomicity: Wrapped in database transactions (BEGIN TRANSACTION ... COMMIT / ROLLBACK).
 *   - Duplicate Prevention: Enforced via application check and database partial unique index.
 *   - Idempotency: Duplicate requests return the existing record without generating duplicates.
 *   - Historical Snapshot: Preserves the exact rate, principal basis, and period used during calculation.
 *   - Principal Protection: Modifies zero accounts, zero principal, zero payments, zero transactions.
 *   - Exact Monetary Precision: Stores principal basis and interest amount in exact integer paisa.
 *   - Audit Integration: Writes INTEREST_RECORDED event to audit_logs atomically.
 *   - Zero Interest Rule: Produces no persistent financial row when interest amount is ₹0.00.
 *   - NO payment logic, NO reversal/correction logic, NO background scheduler logic.
 */

const { queryOne, queryAll } = require('../db/helpers');
const { saveDatabase } = require('../db/connection');
const {
    parseCalendarDate,
    normalizeDate,
    calculateElapsedDays
} = require('./dateCalculationService');
const { calculateAccrual } = require('./interestAccrualService');

const SUPPORTED_RECORD_METHODS = Object.freeze(['SIMPLE_INTEREST', 'SIMPLE']);
const VALID_RECORD_SOURCES = Object.freeze(['MANUAL', 'AUTOMATIC']);

/**
 * Validates an accrual result before persistence.
 *
 * @param {Object} accrualResult - Result object from Step 6E
 * @returns {Object} Normalized attributes
 * @throws {Error} With statusCode 400 for validation errors
 */
function validateAccrualResult(accrualResult) {
    if (!accrualResult || typeof accrualResult !== 'object') {
        const err = new Error('Accrual result must be an object');
        err.statusCode = 400;
        throw err;
    }

    // 1. Account / Loan Reference
    const rawAccId = accrualResult.account_id !== undefined
        ? accrualResult.account_id
        : (accrualResult.accountId !== undefined ? accrualResult.accountId : accrualResult.loan_id);
    const accountId = Number(rawAccId);
    if (!rawAccId || isNaN(accountId) || accountId <= 0) {
        const err = new Error('A valid account_id is required');
        err.statusCode = 400;
        throw err;
    }

    // 2. Accrual Period
    const rawStart = accrualResult.period_start || accrualResult.accrual_start || accrualResult.start_date || accrualResult.startDate;
    const rawEnd = accrualResult.period_end || accrualResult.accrual_end || accrualResult.end_date || accrualResult.endDate;

    const periodStart = normalizeDate(rawStart);
    const periodEnd = normalizeDate(rawEnd);

    if (!periodStart || !periodEnd) {
        const err = new Error('Valid period_start and period_end are required (YYYY-MM-DD or DD/MM/YYYY)');
        err.statusCode = 400;
        throw err;
    }

    if (periodEnd < periodStart) {
        const err = new Error(`period_end (${periodEnd}) cannot be earlier than period_start (${periodStart})`);
        err.statusCode = 400;
        throw err;
    }

    // 3. Principal Basis
    const rawPrincipalPaisa = accrualResult.principal_paisa !== undefined
        ? accrualResult.principal_paisa
        : (accrualResult.principal_basis !== undefined && accrualResult.is_paisa
            ? accrualResult.principal_basis
            : undefined);

    let principalPaisa;
    let principalRupees;

    if (rawPrincipalPaisa !== undefined && rawPrincipalPaisa !== null) {
        principalPaisa = Math.round(Number(rawPrincipalPaisa));
        principalRupees = principalPaisa / 100;
    } else {
        const rawPrincipal = accrualResult.principal !== undefined
            ? accrualResult.principal
            : (accrualResult.principal_basis !== undefined ? accrualResult.principal_basis : accrualResult.outstanding_principal);
        if (rawPrincipal === undefined || rawPrincipal === null || isNaN(Number(rawPrincipal))) {
            const err = new Error('Principal is required and must be a valid numerical value');
            err.statusCode = 400;
            throw err;
        }
        principalRupees = Number(rawPrincipal);
        principalPaisa = Math.round(principalRupees * 100);
    }

    if (principalPaisa < 0) {
        const err = new Error(`Principal cannot be negative. Received: ${principalRupees}`);
        err.statusCode = 400;
        throw err;
    }

    // 4. Interest Rate
    const rawRate = accrualResult.interest_rate !== undefined
        ? accrualResult.interest_rate
        : (accrualResult.rate !== undefined ? accrualResult.rate : accrualResult.interestRate);
    if (rawRate === undefined || rawRate === null || isNaN(Number(rawRate))) {
        const err = new Error('Interest rate is required and must be a valid numerical value');
        err.statusCode = 400;
        throw err;
    }
    const interestRate = Number(rawRate);
    if (interestRate < 0) {
        const err = new Error(`Interest rate cannot be negative. Received: ${rawRate}`);
        err.statusCode = 400;
        throw err;
    }

    // 5. Calculation Method
    const rawMethod = accrualResult.calculation_method || accrualResult.method || accrualResult.calculationMethod || 'SIMPLE_INTEREST';
    const calculationMethod = String(rawMethod).trim().toUpperCase();
    if (!SUPPORTED_RECORD_METHODS.includes(calculationMethod)) {
        const err = new Error(`Unsupported calculation method: "${rawMethod}". Supported: ${SUPPORTED_RECORD_METHODS.join(', ')}`);
        err.statusCode = 400;
        throw err;
    }

    // 6. Interest Amount
    const rawAmountPaisa = accrualResult.interest_paisa !== undefined
        ? accrualResult.interest_paisa
        : (accrualResult.interest_amount !== undefined && accrualResult.is_paisa
            ? accrualResult.interest_amount
            : undefined);

    let interestAmountPaisa;
    let interestAmountRupees;

    if (rawAmountPaisa !== undefined && rawAmountPaisa !== null) {
        interestAmountPaisa = Math.round(Number(rawAmountPaisa));
        interestAmountRupees = interestAmountPaisa / 100;
    } else {
        const rawAmount = accrualResult.interest_amount !== undefined
            ? accrualResult.interest_amount
            : (accrualResult.interestAmount !== undefined ? accrualResult.interestAmount : accrualResult.amount);
        if (rawAmount === undefined || rawAmount === null || isNaN(Number(rawAmount))) {
            const err = new Error('Interest amount is required and must be a valid numerical value');
            err.statusCode = 400;
            throw err;
        }
        interestAmountRupees = Number(rawAmount);
        interestAmountPaisa = Math.round(interestAmountRupees * 100);
    }

    if (interestAmountPaisa < 0) {
        const err = new Error(`Interest amount cannot be negative. Received: ${interestAmountRupees}`);
        err.statusCode = 400;
        throw err;
    }

    // 7. Elapsed Days
    let days = accrualResult.number_of_days !== undefined
        ? accrualResult.number_of_days
        : (accrualResult.days !== undefined ? accrualResult.days : accrualResult.elapsed_days);
    if (days === undefined || days === null) {
        days = calculateElapsedDays(periodStart, periodEnd).elapsedDays;
    }

    return {
        accountId,
        periodStart,
        periodEnd,
        principalPaisa,
        principalRupees,
        interestRate,
        calculationMethod,
        interestAmountPaisa,
        interestAmountRupees,
        days
    };
}

/**
 * Checks if an active interest record already exists for the specified account and period.
 *
 * @param {Object} db - Database connection
 * @param {number} accountId - Account ID
 * @param {string} periodStart - Period start date
 * @param {string} periodEnd - Period end date
 * @returns {Object|null} Existing record or null
 */
function checkExistingRecord(db, accountId, periodStart, periodEnd) {
    if (!db) return null;
    return queryOne(db, `
        SELECT * FROM interest_records
        WHERE account_id = ? AND period_start = ? AND period_end = ? AND status != 'REVERSED'
    `, [Number(accountId), periodStart, periodEnd]);
}

/**
 * Step 6F: Main Recording Service
 *
 * Takes a validated accrual result and persists it to the database as an interest record
 * with complete transactional integrity, audit logging, and duplicate prevention.
 *
 * @param {Object} db - Database connection (required for persistence)
 * @param {Object} accrualResult - Result object from calculateAccrual (Step 6E)
 * @param {Object} [options] - Options
 * @param {string} [options.source='MANUAL'] - 'MANUAL' or 'AUTOMATIC'
 * @param {string} [options.actorId] - ID of actor/user initiating recording
 * @param {string} [options.schedulerRunId] - Associated scheduler run ID
 * @param {boolean} [options.throwOnDuplicate=false] - If true, throws error on duplicate instead of returning ALREADY_RECORDED
 * @param {boolean} [options.allowZeroInterest=false] - If true, persists zero interest records (default false: follows business rule)
 * @returns {Object} Standardized Persistence Result DTO
 */
function recordAccrualResult(db, accrualResult, options = {}) {
    if (!db) {
        const err = new Error('Database connection is required for interest recording');
        err.statusCode = 500;
        throw err;
    }

    // 1. Validate Accrual Result
    const validated = validateAccrualResult(accrualResult);
    const {
        accountId,
        periodStart,
        periodEnd,
        principalPaisa,
        principalRupees,
        interestRate,
        calculationMethod,
        interestAmountPaisa,
        interestAmountRupees,
        days
    } = validated;

    // 2. Verify Account Exists
    const account = queryOne(db, 'SELECT id, principal, outstanding_principal FROM accounts WHERE id = ?', [accountId]);
    if (!account) {
        const err = new Error(`Account #${accountId} not found`);
        err.statusCode = 404;
        throw err;
    }

    // 3. Zero Interest Business Rule Handling
    // Established rule: Zero-interest periods (e.g. zero principal, zero rate, or zero days)
    // produce no persistent financial record unless explicitly overridden.
    if (interestAmountPaisa === 0 && options.allowZeroInterest !== true) {
        return {
            status: 'ZERO_INTEREST',
            id: null,
            record_id: null,
            interest_record_id: null,
            account_id: accountId,
            loan_id: accountId,
            period_start: periodStart,
            period_end: periodEnd,
            principal: principalRupees,
            principal_basis: principalRupees,
            principal_basis_rupees: principalRupees,
            principal_basis_paisa: principalPaisa,
            interest_rate: interestRate,
            calculation_method: calculationMethod,
            number_of_days: days,
            interest_amount: 0.00,
            interest_amount_rupees: 0.00,
            interest_amount_paisa: 0,
            interest_paisa: 0,
            created: false,
            already_recorded: false,
            is_duplicate: false,
            message: 'Zero interest calculated for this period; no interest record created'
        };
    }

    // 4. Duplicate Prevention & Idempotency Check
    const existing = checkExistingRecord(db, accountId, periodStart, periodEnd);
    if (existing) {
        if (options.throwOnDuplicate === true) {
            const err = new Error(`An active interest record already exists for Account #${accountId} for period ${periodStart} to ${periodEnd}`);
            err.statusCode = 400;
            throw err;
        }
        return {
            status: 'ALREADY_RECORDED',
            id: existing.id,
            record_id: existing.id,
            interest_record_id: existing.id,
            account_id: accountId,
            loan_id: accountId,
            period_start: periodStart,
            period_end: periodEnd,
            principal: existing.principal_basis / 100,
            principal_basis: existing.principal_basis / 100,
            principal_basis_rupees: existing.principal_basis / 100,
            principal_basis_paisa: existing.principal_basis,
            interest_rate: existing.interest_rate,
            calculation_method: existing.calculation_method,
            number_of_days: days,
            interest_amount: existing.interest_amount / 100,
            interest_amount_rupees: existing.interest_amount / 100,
            interest_amount_paisa: existing.interest_amount,
            interest_paisa: existing.interest_amount,
            record_status: existing.status,
            source: existing.source,
            created_at: existing.created_at,
            created: false,
            already_recorded: true,
            is_duplicate: true,
            message: `Interest has already been recorded for Account #${accountId} for period ${periodStart} to ${periodEnd}`
        };
    }

    // 5. Source Determination
    const rawSource = options.source || accrualResult.source || 'MANUAL';
    const source = VALID_RECORD_SOURCES.includes(String(rawSource).toUpperCase())
        ? String(rawSource).toUpperCase()
        : 'MANUAL';

    const actorId = options.actorId || options.actor_id || null;
    const schedulerRunId = options.schedulerRunId || options.scheduler_run_id || null;

    // 6. Transactional Persistence with DB Constraint Protection
    let createdRecord = null;

    try {
        db.run('BEGIN TRANSACTION');

        // Re-check duplicate inside transaction lock (concurrency race defense)
        const concurrentExisting = checkExistingRecord(db, accountId, periodStart, periodEnd);
        if (concurrentExisting) {
            db.run('ROLLBACK');
            if (options.throwOnDuplicate === true) {
                const err = new Error(`An active interest record already exists for Account #${accountId} for period ${periodStart} to ${periodEnd}`);
                err.statusCode = 400;
                throw err;
            }
            return {
                status: 'ALREADY_RECORDED',
                id: concurrentExisting.id,
                record_id: concurrentExisting.id,
                interest_record_id: concurrentExisting.id,
                account_id: accountId,
                loan_id: accountId,
                period_start: periodStart,
                period_end: periodEnd,
                principal: concurrentExisting.principal_basis / 100,
                principal_basis: concurrentExisting.principal_basis / 100,
                principal_basis_rupees: concurrentExisting.principal_basis / 100,
                principal_basis_paisa: concurrentExisting.principal_basis,
                interest_rate: concurrentExisting.interest_rate,
                calculation_method: concurrentExisting.calculation_method,
                number_of_days: days,
                interest_amount: concurrentExisting.interest_amount / 100,
                interest_amount_rupees: concurrentExisting.interest_amount / 100,
                interest_amount_paisa: concurrentExisting.interest_amount,
                interest_paisa: concurrentExisting.interest_amount,
                record_status: concurrentExisting.status,
                source: concurrentExisting.source,
                created_at: concurrentExisting.created_at,
                created: false,
                already_recorded: true,
                is_duplicate: true,
                message: `Interest has already been recorded for Account #${accountId} for period ${periodStart} to ${periodEnd}`
            };
        }

        // Insert into interest_records preserving the exact historical calculation snapshot
        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis,
                interest_rate, interest_amount, paid_amount, calculation_method, status,
                source, scheduler_run_id
            ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'PENDING', ?, ?)
        `, [
            accountId,
            periodStart,
            periodEnd,
            principalPaisa,
            interestRate,
            interestAmountPaisa,
            calculationMethod,
            source,
            schedulerRunId
        ]);

        const row = queryOne(db, 'SELECT last_insert_rowid() as id');
        createdRecord = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [row.id]);

        // Audit Integration
        const auditPayload = {
            event_type: 'INTEREST_RECORDED',
            account_id: accountId,
            interest_record_id: createdRecord.id,
            source: source,
            actor_id: actorId,
            scheduler_run_id: schedulerRunId,
            period_start: periodStart,
            period_end: periodEnd,
            principal_basis: principalPaisa,
            principal_basis_rupees: principalRupees,
            interest_rate: interestRate,
            interest_amount: interestAmountPaisa,
            interest_amount_rupees: interestAmountRupees,
            calculation_method: calculationMethod,
            total_elapsed_days: days,
            recorded_at: new Date().toISOString()
        };

        db.run(`
            INSERT INTO audit_logs (entity_type, entity_id, action, new_value)
            VALUES ('INTEREST_RECORD', ?, 'INTEREST_RECORDED', ?)
        `, [createdRecord.id, JSON.stringify(auditPayload)]);

        db.run('COMMIT');
        saveDatabase();
    } catch (err) {
        try { db.run('ROLLBACK'); } catch (_) {}

        // Catch database unique constraint violations (concurrent operations defense)
        if (err.message && err.message.includes('UNIQUE constraint failed')) {
            const fallback = checkExistingRecord(db, accountId, periodStart, periodEnd);
            if (fallback) {
                if (options.throwOnDuplicate === true) {
                    const dupErr = new Error(`An active interest record already exists for Account #${accountId} for period ${periodStart} to ${periodEnd}`);
                    dupErr.statusCode = 400;
                    throw dupErr;
                }
                return {
                    status: 'ALREADY_RECORDED',
                    id: fallback.id,
                    record_id: fallback.id,
                    interest_record_id: fallback.id,
                    account_id: accountId,
                    loan_id: accountId,
                    period_start: periodStart,
                    period_end: periodEnd,
                    principal: fallback.principal_basis / 100,
                    principal_basis: fallback.principal_basis / 100,
                    principal_basis_rupees: fallback.principal_basis / 100,
                    principal_basis_paisa: fallback.principal_basis,
                    interest_rate: fallback.interest_rate,
                    calculation_method: fallback.calculation_method,
                    number_of_days: days,
                    interest_amount: fallback.interest_amount / 100,
                    interest_amount_rupees: fallback.interest_amount / 100,
                    interest_amount_paisa: fallback.interest_amount,
                    interest_paisa: fallback.interest_amount,
                    record_status: fallback.status,
                    source: fallback.source,
                    created_at: fallback.created_at,
                    created: false,
                    already_recorded: true,
                    is_duplicate: true,
                    message: `Interest has already been recorded for Account #${accountId} for period ${periodStart} to ${periodEnd}`
                };
            }
        }
        throw err;
    }

    // 7. Structured Response DTO
    return {
        status: 'SUCCESS',
        id: createdRecord.id,
        record_id: createdRecord.id,
        interest_record_id: createdRecord.id,
        account_id: accountId,
        loan_id: accountId,
        period_start: periodStart,
        period_end: periodEnd,
        principal: principalRupees,
        principal_basis: principalRupees,
        principal_basis_rupees: principalRupees,
        principal_basis_paisa: principalPaisa,
        interest_rate: interestRate,
        rate: interestRate,
        calculation_method: calculationMethod,
        number_of_days: days,
        days: days,
        interest_amount: interestAmountRupees,
        interest_amount_rupees: interestAmountRupees,
        interest_amount_paisa: interestAmountPaisa,
        interest_paisa: interestAmountPaisa,
        record_status: createdRecord.status,
        status_label: createdRecord.status,
        source: source,
        created_at: createdRecord.created_at,
        created: true,
        already_recorded: false,
        is_duplicate: false,
        is_read_only: false
    };
}

/**
 * Orchestrates Step 6E accrual calculation and Step 6F persistence in a single call.
 *
 * @param {Object} db - Database connection
 * @param {Object|number} accountOrId - Account object or ID
 * @param {Object} [options] - Calculation and recording options
 * @returns {Object} Standardized Persistence Result DTO
 */
function accrueAndRecord(db, accountOrId, options = {}) {
    // 1. Obtain calculated accrual result from Step 6E
    const accrualResult = calculateAccrual(db, accountOrId, options);

    // 2. If 6E already identified duplicate, return idempotent response directly
    if (accrualResult.is_duplicate || accrualResult.status === 'ALREADY_RECORDED') {
        return {
            status: 'ALREADY_RECORDED',
            id: accrualResult.interest_record_id,
            record_id: accrualResult.interest_record_id,
            interest_record_id: accrualResult.interest_record_id,
            account_id: accrualResult.account_id,
            loan_id: accrualResult.account_id,
            period_start: accrualResult.period_start,
            period_end: accrualResult.period_end,
            interest_amount: accrualResult.interest_amount,
            interest_amount_rupees: accrualResult.interest_amount,
            interest_amount_paisa: accrualResult.interest_paisa,
            interest_paisa: accrualResult.interest_paisa,
            created: false,
            already_recorded: true,
            is_duplicate: true,
            message: accrualResult.message
        };
    }

    // 3. Persist via Step 6F recording engine
    return recordAccrualResult(db, accrualResult, options);
}

module.exports = {
    SUPPORTED_RECORD_METHODS,
    VALID_RECORD_SOURCES,
    validateAccrualResult,
    checkExistingRecord,
    recordAccrualResult,
    recordAccrual: recordAccrualResult,
    recordInterest: recordAccrualResult,
    accrueAndRecord
};
