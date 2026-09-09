/**
 * Interest Manager — Step 6E: Interest Accrual Service
 *
 * Responsible for determining and calculating an interest accrual period for an account.
 *
 * Orchestration Pipeline:
 *   Loan / Account
 *         ↓
 *   Interest Configuration (Step 6A)
 *         ↓
 *   Accrual Period Determination (First vs Subsequent, Frequency, Boundaries)
 *         ↓
 *   Applicable Principal Integration (Step 6D)
 *         ↓
 *   Day Calculator (Step 6C)
 *         ↓
 *   Interest Calculator (Step 6B)
 *         ↓
 *   Accrual Result DTO
 *
 * Guarantees:
 *   - Pure calculation and orchestration: NO database mutations, NO financial side effects.
 *   - NO scheduler logic (cron, background workers, intervals).
 *   - NO persistence of interest records (belongs to Step 6F).
 *   - NO payment records, principal modification, loan balance changes, or audit logs.
 *   - Respects INCLUSIVE_START_EXCLUSIVE_END date boundary convention from Step 6C.
 *   - Reuses 6A (config), 6B (formula), 6C (dates), 6D (principal balance) without duplication.
 */

const { queryOne, queryAll } = require('../db/helpers');
const {
    parseCalendarDate,
    normalizeDate,
    calculateElapsedDays,
    addDays,
    addMonths,
    addYears,
    DATE_BOUNDARY_CONVENTION
} = require('./dateCalculationService');
const { getActiveInterestConfig } = require('./interestConfigService');
const { calculateAccountInterestWithPrincipal } = require('./interestCalculationService');

/**
 * Retrieves the end date of the last active interest accrual for an account.
 * Used to establish subsequent accrual start boundaries.
 *
 * @param {Object} db - Database connection
 * @param {number|string} accountId - Account ID
 * @returns {string|null} ISO date string (YYYY-MM-DD) or null if no previous accrual
 */
function getLastAccrualEndDate(db, accountId) {
    if (!db) return null;
    const accId = Number(accountId);
    if (!accId || isNaN(accId) || accId <= 0) return null;

    const row = queryOne(db, `
        SELECT MAX(period_end) as last_end
        FROM interest_records
        WHERE account_id = ? AND status != 'REVERSED'
    `, [accId]);

    return row && row.last_end ? normalizeDate(row.last_end) : null;
}

/**
 * Checks whether an active interest record already exists for the specified account and period.
 *
 * @param {Object} db - Database connection
 * @param {number|string} accountId - Account ID
 * @param {string} startDate - Period start date
 * @param {string} endDate - Period end date
 * @returns {Object} { isDuplicate: boolean, existingRecord: Object|null }
 */
function checkDuplicateAccrual(db, accountId, startDate, endDate) {
    if (!db) return { isDuplicate: false, existingRecord: null };
    const accId = Number(accountId);
    const startIso = normalizeDate(startDate);
    const endIso = normalizeDate(endDate);

    if (!accId || !startIso || !endIso) {
        return { isDuplicate: false, existingRecord: null };
    }

    const existingRecord = queryOne(db, `
        SELECT * FROM interest_records
        WHERE account_id = ? AND period_start = ? AND period_end = ? AND status != 'REVERSED'
    `, [accId, startIso, endIso]);

    return {
        isDuplicate: Boolean(existingRecord),
        existingRecord: existingRecord || null
    };
}

/**
 * Determines the applicable accrual period for an account.
 *
 * Rules:
 *   - First accrual: Begins explicitly at account.start_date.
 *   - Subsequent accrual: Begins at the end date of the previous active accrual.
 *   - Period end: Computed using the account's interest_frequency (DAILY, WEEKLY, MONTHLY, YEARLY)
 *     or explicitly provided via options.endDate.
 *   - Date boundaries: Follows Step 6C convention [start_date, end_date)
 *     (start inclusive, end exclusive).
 *
 * @param {Object} db - Database connection (optional if explicit dates or mock account provided)
 * @param {Object|number} accountOrId - Account object or ID
 * @param {Object} [options] - Options
 * @param {string} [options.startDate] - Explicit start date override
 * @param {string} [options.endDate] - Explicit end date override
 * @param {string} [options.frequency] - Frequency override
 * @returns {Object} { startDate, endDate, days, source, isFirstAccrual }
 */
function determineAccrualPeriod(db, accountOrId, options = {}) {
    let account = accountOrId;
    if (accountOrId && typeof accountOrId !== 'object') {
        if (!db) {
            const err = new Error('Database connection is required to load account by ID');
            err.statusCode = 500;
            throw err;
        }
        account = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [Number(accountOrId)]);
        if (!account) {
            const err = new Error(`Account #${accountOrId} not found`);
            err.statusCode = 404;
            throw err;
        }
    }

    let startDate = null;
    let source = null;
    let isFirstAccrual = false;

    // 1. Determine Period Start Date
    if (options.startDate) {
        startDate = normalizeDate(options.startDate);
        if (!startDate) {
            const err = new Error(`Invalid startDate format: "${options.startDate}". Expected YYYY-MM-DD or DD/MM/YYYY.`);
            err.statusCode = 400;
            throw err;
        }
        source = 'EXPLICIT';
        isFirstAccrual = false;
    } else {
        const lastEnd = db && account.id ? getLastAccrualEndDate(db, account.id) : null;
        if (lastEnd) {
            startDate = lastEnd;
            source = 'PREVIOUS_ACCRUAL_END';
            isFirstAccrual = false;
        } else {
            if (!account.start_date) {
                const err = new Error(`Account #${account.id || 'unknown'} has no start_date configured`);
                err.statusCode = 400;
                throw err;
            }
            startDate = normalizeDate(account.start_date);
            if (!startDate) {
                const err = new Error(`Account #${account.id || 'unknown'} has invalid start_date: "${account.start_date}"`);
                err.statusCode = 400;
                throw err;
            }
            source = 'ACCOUNT_START_DATE';
            isFirstAccrual = true;
        }
    }

    // 2. Determine Period End Date
    let endDate = null;
    if (options.endDate) {
        endDate = normalizeDate(options.endDate);
        if (!endDate) {
            const err = new Error(`Invalid endDate format: "${options.endDate}". Expected YYYY-MM-DD or DD/MM/YYYY.`);
            err.statusCode = 400;
            throw err;
        }
    } else {
        const frequency = options.frequency || account.interest_frequency || 'MONTHLY';
        switch (frequency.toUpperCase()) {
            case 'DAILY':
                endDate = addDays(startDate, 1);
                break;
            case 'WEEKLY':
                endDate = addDays(startDate, 7);
                break;
            case 'MONTHLY':
                endDate = addMonths(startDate, 1);
                break;
            case 'YEARLY':
                endDate = addYears(startDate, 1);
                break;
            default: {
                const err = new Error(`Unsupported interest frequency: "${frequency}"`);
                err.statusCode = 400;
                throw err;
            }
        }
    }

    // 3. Calculate Elapsed Days using Step 6C Day Calculator (strictly [start, end))
    const dateRange = calculateElapsedDays(startDate, endDate);

    return {
        startDate: dateRange.startDateIso,
        endDate: dateRange.endDateIso,
        days: dateRange.elapsedDays,
        source: source,
        isFirstAccrual: isFirstAccrual
    };
}

/**
 * Resolves the interest configuration applicable to an accrual period.
 *
 * Rules:
 *   1. If explicit options.config is provided, uses it.
 *   2. If db is provided and account has configurations in account_interest_configs,
 *      resolves active config as of periodStart using Step 6A rules.
 *   3. Fallback: Uses account's interest_rate and calculation_method.
 *
 * @param {Object} db - Database connection
 * @param {Object} account - Account object
 * @param {string} periodStart - Start date of the accrual period
 * @param {Object} [options] - Options
 * @returns {Object} Applicable configuration object
 */
function resolveApplicableConfig(db, account, periodStart, options = {}) {
    if (options.config && typeof options.config === 'object') {
        return {
            ...options.config,
            interest_rate: Number(options.config.interest_rate),
            calculation_method: options.config.calculation_method || 'SIMPLE_INTEREST',
            source: 'EXPLICIT_OVERRIDE'
        };
    }

    if (db && account.id) {
        const activeConfig = getActiveInterestConfig(db, account.id, periodStart);
        if (activeConfig) {
            return {
                ...activeConfig,
                interest_rate: Number(activeConfig.interest_rate),
                calculation_method: activeConfig.calculation_method || 'SIMPLE_INTEREST',
                source: 'ACCOUNT_INTEREST_CONFIGS'
            };
        }
    }

    return {
        id: null,
        account_id: account.id ? Number(account.id) : null,
        interest_rate: Number(account.interest_rate),
        calculation_method: account.calculation_method || 'SIMPLE_INTEREST',
        effective_from: account.start_date || null,
        effective_to: null,
        source: 'ACCOUNT_DEFAULT'
    };
}

/**
 * Step 6E: Main Interest Accrual Service
 *
 * Calculates the interest accrual for an account and period by orchestrating:
 *   - Account / Loan retrieval
 *   - Configuration resolution (6A)
 *   - Period determination (First / Subsequent / Frequency / Explicit)
 *   - Duplicate detection (Existing active records)
 *   - Applicable principal balance (6D)
 *   - Elapsed days calculation (6C)
 *   - Interest formula calculation (6B)
 *
 * Returns a structured AccrualResult DTO.
 *
 * Read-only guarantee:
 *   - Performs ZERO database writes.
 *   - Creates NO interest records, payments, or audit rows.
 *   - Modifies NO balances or account states.
 *
 * @param {Object} db - Database connection (optional if full mock account provided)
 * @param {Object|number} accountOrId - Account object or ID
 * @param {Object} [options] - Options
 * @param {string} [options.startDate] - Explicit start date
 * @param {string} [options.endDate] - Explicit end date
 * @param {Object} [options.config] - Explicit interest configuration override
 * @param {boolean} [options.useTimeline=false] - Whether to use segmented timeline for principal
 * @param {Array} [options.transactions] - Transaction overrides for timeline
 * @param {boolean} [options.checkDuplicates=true] - Whether to check for existing active records
 * @returns {Object} Structured AccrualResult DTO
 */
function calculateAccrual(db, accountOrId, options = {}) {
    // 1. Account resolution
    let account = null;
    if (accountOrId && typeof accountOrId === 'object') {
        account = accountOrId;
    } else if (accountOrId && !isNaN(Number(accountOrId))) {
        if (!db) {
            const err = new Error('Database connection is required to load account by ID');
            err.statusCode = 500;
            throw err;
        }
        account = queryOne(db, `
            SELECT a.*, p.name as person_name
            FROM accounts a
            LEFT JOIN people p ON a.person_id = p.id
            WHERE a.id = ?
        `, [Number(accountOrId)]);

        if (!account) {
            const err = new Error(`Account #${accountOrId} not found`);
            err.statusCode = 404;
            throw err;
        }
    } else {
        const err = new Error('A valid account ID or account object is required');
        err.statusCode = 400;
        throw err;
    }

    // 2. Accrual period determination
    const periodInfo = determineAccrualPeriod(db, account, options);
    const { startDate, endDate, days } = periodInfo;

    // 3. Duplicate detection (where supported by existing data model)
    const checkDup = options.checkDuplicates !== false;
    if (checkDup && db && account.id) {
        const dupCheck = checkDuplicateAccrual(db, account.id, startDate, endDate);
        if (dupCheck.isDuplicate) {
            const existing = dupCheck.existingRecord;
            return {
                status: 'ALREADY_RECORDED',
                account_id: Number(account.id),
                loan_id: Number(account.id),
                person_id: account.person_id ? Number(account.person_id) : undefined,
                period_start: startDate,
                period_end: endDate,
                start_date: startDate,
                end_date: endDate,
                interest_record_id: existing.id,
                interest_amount: existing.interest_amount / 100,
                interest_paisa: existing.interest_amount,
                is_duplicate: true,
                already_recorded: true,
                is_accrued: true,
                message: `Interest has already been recorded for Account #${account.id} for period ${startDate} to ${endDate}`
            };
        }
    }

    // 4. Configuration resolution (Step 6A)
    const resolvedConfig = resolveApplicableConfig(db, account, startDate, options);

    // 5. Principal and calculation orchestration (Step 6D -> 6C -> 6B)
    const calcResult = calculateAccountInterestWithPrincipal(db, account, startDate, endDate, {
        config: resolvedConfig,
        useTimeline: options.useTimeline === true,
        transactions: options.transactions,
        day_count_basis: options.day_count_basis
    });

    // 6. Build structured AccrualResult DTO
    const interestAmount = calcResult.interest_amount !== undefined ? calcResult.interest_amount : calcResult.total_interest_amount;
    const interestPaisa = calcResult.interest_paisa !== undefined ? calcResult.interest_paisa : calcResult.total_interest_paisa;
    const principalRupees = calcResult.principal !== undefined ? calcResult.principal : calcResult.opening_principal;
    const principalPaisa = calcResult.principal_paisa !== undefined ? calcResult.principal_paisa : calcResult.opening_principal_paisa;

    let status = 'SUCCESS';
    if (days === 0) {
        status = 'ZERO_DAYS';
    } else if (interestAmount === 0) {
        status = 'ZERO_INTEREST';
    }

    return {
        status: status,
        account_id: Number(account.id),
        loan_id: Number(account.id),
        person_id: account.person_id ? Number(account.person_id) : undefined,
        person_name: account.person_name || null,
        period_start: startDate,
        period_end: endDate,
        accrual_start: startDate,
        accrual_end: endDate,
        start_date: startDate,
        end_date: endDate,
        principal: principalRupees,
        principal_paisa: principalPaisa,
        outstanding_principal: calcResult.outstanding_principal !== undefined ? calcResult.outstanding_principal : principalRupees,
        outstanding_principal_paisa: calcResult.outstanding_principal_paisa !== undefined ? calcResult.outstanding_principal_paisa : principalPaisa,
        interest_rate: calcResult.rate,
        rate: calcResult.rate,
        calculation_method: calcResult.calculation_method || calcResult.method,
        method: calcResult.calculation_method || calcResult.method,
        number_of_days: days,
        days: days,
        elapsed_days: days,
        interest_amount: interestAmount,
        interest_paisa: interestPaisa,
        total_amount: calcResult.total_amount,
        total_paisa: calcResult.total_paisa,
        unrounded_interest: calcResult.unrounded_interest !== undefined ? calcResult.unrounded_interest : calcResult.unrounded_total_interest,
        day_count_basis: calcResult.day_count_basis,
        day_count_convention: calcResult.day_count_convention,
        boundary_convention: calcResult.boundary_convention || DATE_BOUNDARY_CONVENTION,
        rounding_convention: calcResult.rounding_convention,
        config_id: resolvedConfig && resolvedConfig.id ? Number(resolvedConfig.id) : null,
        config_source: resolvedConfig ? resolvedConfig.source : 'ACCOUNT_DEFAULT',
        period_source: periodInfo.source,
        is_first_accrual: periodInfo.isFirstAccrual,
        is_duplicate: false,
        already_recorded: false,
        is_segmented: calcResult.is_segmented || false,
        segments: calcResult.segments || null,
        is_accrued: false,
        is_read_only: true
    };
}

module.exports = {
    determineAccrualPeriod,
    getLastAccrualEndDate,
    checkDuplicateAccrual,
    resolveApplicableConfig,
    calculateAccrual,
    calculateAccountAccrual: calculateAccrual
};
