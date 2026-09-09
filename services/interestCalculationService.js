/**
 * Interest Manager — Step 6B: Core Interest Calculation Service
 *
 * Implements the core mathematical calculation engine for interest.
 *
 * Formula:
 * Simple Interest:
 *   Interest = Principal × Annual Rate × Elapsed Days / Day-Count Basis
 *
 * Where:
 *   - Principal: Financial principal in monetary units (Rupees, with paisa precision).
 *   - Annual Rate: Stored as nominal percentage (e.g., 12 for 12%, 10.5 for 10.5%, 7.25 for 7.25%).
 *     Converted to mathematical multiplier: Rate_Decimal = Rate / 100 (e.g., 12% -> 0.12).
 *   - Elapsed Days: Calendar days elapsed between start_date and end_date using
 *     the established banking convention [start_date, end_date) (start date inclusive,
 *     end date exclusive), or explicitly supplied integer day count.
 *   - Day-Count Basis: Default 365 days (ACTUAL/365 convention).
 *   - Monetary Rounding: Unrounded interest is computed in full floating-point precision,
 *     then rounded half-up to 2 decimal places (exact integer paisa: 1 Rupee = 100 Paisa).
 */

const SUPPORTED_CALCULATION_METHODS = Object.freeze([
    'SIMPLE_INTEREST',
    'SIMPLE'
]);

const DEFAULT_DAY_COUNT_BASIS = 365;
const DAY_COUNT_CONVENTION = 'ACTUAL/365';
const {
    parseCalendarDate,
    calculateElapsedDays,
    DATE_BOUNDARY_CONVENTION
} = require('./dateCalculationService');

/**
 * Validates financial inputs for interest calculation.
 *
 * @param {Object} input - Calculation parameters
 * @returns {Object} Normalized, validated parameters
 */
function validateCalculationInput(input) {
    if (!input || typeof input !== 'object') {
        const err = new Error('Calculation input must be an object');
        err.statusCode = 400;
        throw err;
    }

    // 1. Principal Validation
    const rawPrincipal = input.principal !== undefined ? input.principal : input.principal_amount;
    if (rawPrincipal === undefined || rawPrincipal === null || rawPrincipal === '' || isNaN(Number(rawPrincipal))) {
        const err = new Error('Principal is required and must be a valid numerical value');
        err.statusCode = 400;
        throw err;
    }
    const principal = Number(rawPrincipal);
    if (principal < 0) {
        const err = new Error(`Principal cannot be negative. Received: ${rawPrincipal}`);
        err.statusCode = 400;
        throw err;
    }

    // 2. Interest Rate Validation
    const rawRate = input.interest_rate !== undefined ? input.interest_rate : (input.rate !== undefined ? input.rate : input.interestRate);
    if (rawRate === undefined || rawRate === null || rawRate === '' || isNaN(Number(rawRate))) {
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

    // 3. Calculation Method Validation
    const rawMethod = input.calculation_method || input.method || input.calculationMethod || 'SIMPLE_INTEREST';
    const methodStr = String(rawMethod).trim().toUpperCase();
    if (!SUPPORTED_CALCULATION_METHODS.includes(methodStr)) {
        const err = new Error(`Unsupported calculation method: "${rawMethod}". Supported methods are: ${SUPPORTED_CALCULATION_METHODS.join(', ')}`);
        err.statusCode = 400;
        throw err;
    }

    // 4. Elapsed Days / Date Range Validation
    let elapsedDays = null;
    let startDateIso = null;
    let endDateIso = null;

    const rawDays = input.days !== undefined ? input.days : input.elapsed_days;
    const rawStart = input.start_date || input.startDate;
    const rawEnd = input.end_date || input.endDate;

    if (rawDays !== undefined && rawDays !== null && rawDays !== '') {
        const parsedDays = Number(rawDays);
        if (isNaN(parsedDays) || parsedDays < 0) {
            const err = new Error(`Days cannot be negative or non-numeric. Received: ${rawDays}`);
            err.statusCode = 400;
            throw err;
        }
        elapsedDays = Math.floor(parsedDays);
        if (rawStart) {
            startDateIso = parseCalendarDate(rawStart, 'Start date').isoString;
        }
        if (rawEnd) {
            endDateIso = parseCalendarDate(rawEnd, 'End date').isoString;
        }
    } else if (rawStart && rawEnd) {
        const dateRange = calculateElapsedDays(rawStart, rawEnd);
        elapsedDays = dateRange.elapsedDays;
        startDateIso = dateRange.startDateIso;
        endDateIso = dateRange.endDateIso;
    } else {
        const err = new Error('Either "days" or valid "start_date" and "end_date" must be provided');
        err.statusCode = 400;
        throw err;
    }

    // 5. Day Count Basis Validation
    let dayCountBasis = DEFAULT_DAY_COUNT_BASIS;
    const rawBasis = input.day_count_basis || input.dayCountBasis;
    if (rawBasis !== undefined && rawBasis !== null && rawBasis !== '') {
        const parsedBasis = Number(rawBasis);
        if (isNaN(parsedBasis) || parsedBasis <= 0) {
            const err = new Error(`Day-count basis must be a positive number. Received: ${rawBasis}`);
            err.statusCode = 400;
            throw err;
        }
        dayCountBasis = parsedBasis;
    }

    return {
        principal,
        interestRate,
        calculationMethod: methodStr,
        elapsedDays,
        startDate: startDateIso,
        endDate: endDateIso,
        dayCountBasis
    };
}

/**
 * Calculates interest deterministically without database side effects.
 *
 * Implements:
 *   Interest = Principal × Rate × Days / Day-Count Basis
 *
 * @param {Object} input - Calculation parameters
 * @param {number|string} input.principal - Financial principal in Rupees
 * @param {number|string} input.interest_rate - Annual rate percentage (e.g. 12 for 12%)
 * @param {string} [input.calculation_method='SIMPLE_INTEREST'] - 'SIMPLE' or 'SIMPLE_INTEREST'
 * @param {number} [input.days] - Number of elapsed days
 * @param {string} [input.start_date] - Start date (YYYY-MM-DD or DD/MM/YYYY)
 * @param {string} [input.end_date] - End date (YYYY-MM-DD or DD/MM/YYYY)
 * @param {number} [input.day_count_basis=365] - Denominator basis (365)
 * @returns {Object} Structured CalculationResult DTO
 */
function calculateInterest(input) {
    const validated = validateCalculationInput(input);
    const {
        principal,
        interestRate,
        calculationMethod,
        elapsedDays,
        startDate,
        endDate,
        dayCountBasis
    } = validated;

    // Convert nominal rate percentage to decimal multiplier: e.g. 12% -> 0.12
    const rateDecimal = interestRate / 100;

    // Calculate unrounded mathematical interest
    let unroundedInterest = 0;
    let interestAmount = 0;
    let interestPaisa = 0;

    if (principal > 0 && interestRate > 0 && elapsedDays > 0) {
        unroundedInterest = (principal * rateDecimal * elapsedDays) / dayCountBasis;

        // Apply financial precision & monetary rounding:
        // Full floating precision during calculation, then round half-up to exact integer paisa
        const rawPaisa = unroundedInterest * 100;
        interestPaisa = Math.round(rawPaisa + Number.EPSILON);
        interestAmount = interestPaisa / 100;
    }

    const principalPaisa = Math.round((principal + Number.EPSILON) * 100);
    const totalPaisa = principalPaisa + interestPaisa;
    const totalAmount = totalPaisa / 100;

    return {
        principal: Number(principal.toFixed(2)),
        principal_paisa: principalPaisa,
        rate: interestRate,
        rate_decimal: rateDecimal,
        method: calculationMethod,
        calculation_method: calculationMethod,
        days: elapsedDays,
        elapsed_days: elapsedDays,
        day_count_basis: dayCountBasis,
        day_count_convention: DAY_COUNT_CONVENTION,
        boundary_convention: DATE_BOUNDARY_CONVENTION,
        start_date: startDate,
        end_date: endDate,
        unrounded_interest: unroundedInterest,
        interest_amount: interestAmount,
        interest_paisa: interestPaisa,
        total_amount: totalAmount,
        total_paisa: totalPaisa,
        rounding_convention: 'HALF_UP_TO_2_DECIMALS'
    };
}

/**
 * Convenience helper to calculate interest from an account entity and its active interest configuration.
 * Pure in-memory calculation; does NOT mutate database, accounts, transactions, or ledgers.
 *
 * @param {Object} account - Account record from database
 * @param {Object} config - Interest config record from account_interest_configs
 * @param {string} startDate - Period start date
 * @param {string} endDate - Period end date
 * @param {Object} [options] - Additional calculation options
 * @returns {Object} Structured CalculationResult DTO
 */
function calculateAccountInterestFromConfig(account, config, startDate, endDate, options = {}) {
    if (!account || typeof account !== 'object') {
        const err = new Error('A valid account object is required');
        err.statusCode = 400;
        throw err;
    }
    if (!config || typeof config !== 'object') {
        const err = new Error('A valid interest configuration object is required');
        err.statusCode = 400;
        throw err;
    }

    // Determine principal: account principal is stored in paisa
    const principalPaisa = account.outstanding_principal !== undefined && account.outstanding_principal !== null
        ? Number(account.outstanding_principal)
        : Number(account.principal);

    const principalRupees = principalPaisa / 100;
    const rate = Number(config.interest_rate);
    const method = config.calculation_method || 'SIMPLE_INTEREST';

    const result = calculateInterest({
        principal: principalRupees,
        interest_rate: rate,
        calculation_method: method,
        start_date: startDate,
        end_date: endDate,
        ...options
    });

    return {
        account_id: account.id ? Number(account.id) : undefined,
        config_id: config.id ? Number(config.id) : undefined,
        ...result
    };
}

/**
 * Calculates interest across multiple principal-balance segments.
 *
 * When principal changes during a period (e.g. partial repayments),
 * interest must be calculated for each constant-principal segment and
 * then summed. This function accumulates unrounded interest across all
 * segments and applies a single final monetary rounding pass (half-up
 * to nearest paisa) to the total, following the established precision
 * policy.
 *
 * Each segment is { principal_paisa, start_date, end_date, elapsed_days }.
 * These segments come from the existing buildPrincipalTimeline (Step 5E)
 * in interestService.js — this function does NOT duplicate that logic.
 *
 * Read-only: does NOT modify accounts, principal, transactions, or any database state.
 *
 * @param {Array} segments - Array of principal-balance segments from buildPrincipalTimeline
 * @param {number} interestRate - Annual nominal percentage (e.g. 12 for 12%)
 * @param {string} [calculationMethod='SIMPLE_INTEREST'] - Calculation method
 * @param {Object} [options] - Additional options
 * @returns {Object} Combined calculation result with per-segment breakdown
 */
function calculateSegmentedInterest(segments, interestRate, calculationMethod = 'SIMPLE_INTEREST', options = {}) {
    if (!Array.isArray(segments)) {
        const err = new Error('Segments must be an array');
        err.statusCode = 400;
        throw err;
    }

    const rate = Number(interestRate);
    if (isNaN(rate) || rate < 0) {
        const err = new Error(`Interest rate cannot be negative or non-numeric. Received: ${interestRate}`);
        err.statusCode = 400;
        throw err;
    }

    const method = String(calculationMethod || 'SIMPLE_INTEREST').trim().toUpperCase();
    if (!SUPPORTED_CALCULATION_METHODS.includes(method)) {
        const err = new Error(`Unsupported calculation method: "${calculationMethod}". Supported: ${SUPPORTED_CALCULATION_METHODS.join(', ')}`);
        err.statusCode = 400;
        throw err;
    }

    const rateDecimal = rate / 100;
    const dayCountBasis = options.day_count_basis || DEFAULT_DAY_COUNT_BASIS;

    let totalUnroundedInterest = 0;
    let totalDays = 0;
    const calculatedSegments = [];

    for (const seg of segments) {
        const segPrincipalPaisa = Number(seg.principal_paisa || 0);
        const segPrincipalRupees = segPrincipalPaisa / 100;
        const segDays = Number(seg.elapsed_days || seg.elapsedDays || 0);

        let segUnroundedInterest = 0;
        let segInterestPaisa = 0;
        let segInterestRupees = 0;

        if (segPrincipalPaisa > 0 && rate > 0 && segDays > 0) {
            // Calculate in Rupees for consistency with 6B formula:
            // Interest = Principal × Rate_Decimal × Days / Day_Count_Basis
            segUnroundedInterest = (segPrincipalRupees * rateDecimal * segDays) / dayCountBasis;
            totalUnroundedInterest += segUnroundedInterest;

            // Per-segment rounding for reporting purposes only
            const rawPaisa = segUnroundedInterest * 100;
            segInterestPaisa = Math.round(rawPaisa + Number.EPSILON);
            segInterestRupees = segInterestPaisa / 100;
        }

        totalDays += segDays;

        calculatedSegments.push({
            start_date: seg.start_date || seg.startDate,
            end_date: seg.end_date || seg.endDate,
            elapsed_days: segDays,
            principal: segPrincipalRupees,
            principal_paisa: segPrincipalPaisa,
            rate: rate,
            rate_decimal: rateDecimal,
            unrounded_interest: segUnroundedInterest,
            interest_amount: segInterestRupees,
            interest_paisa: segInterestPaisa
        });
    }

    // Final monetary rounding on the total (single rounding pass)
    const totalInterestPaisa = Math.round(totalUnroundedInterest * 100 + Number.EPSILON);
    const totalInterestAmount = totalInterestPaisa / 100;

    return {
        rate: rate,
        rate_decimal: rateDecimal,
        method: method,
        calculation_method: method,
        total_days: totalDays,
        day_count_basis: dayCountBasis,
        day_count_convention: DAY_COUNT_CONVENTION,
        boundary_convention: DATE_BOUNDARY_CONVENTION,
        unrounded_total_interest: totalUnroundedInterest,
        total_interest_amount: totalInterestAmount,
        total_interest_paisa: totalInterestPaisa,
        rounding_convention: 'HALF_UP_TO_2_DECIMALS',
        segments: calculatedSegments
    };
}

/**
 * Step 6D: Principal-Balance Integration Service
 *
 * High-level integration entry point that obtains the applicable principal
 * from the existing balance logic and passes it to the 6B calculation engine.
 *
 * Flow:
 *   Account ID → Balance Service → Applicable Principal → Date/Day Calculator → Interest Calculator → Result
 *
 * Supports two modes:
 *   1. CURRENT principal: Uses account.outstanding_principal for the current period.
 *   2. HISTORICAL/SEGMENTED principal: Uses buildPrincipalTimeline (Step 5E) from
 *      interestService.js to reconstruct principal segments from dated transactions.
 *
 * Read-only guarantee:
 *   - Does NOT modify accounts, principal, outstanding_principal, transactions, or balances.
 *   - Does NOT create interest records, payments, audit entries, or any database rows.
 *   - Only consumes the applicable principal.
 *
 * @param {Object} db - Database connection (sql.js)
 * @param {number|Object} accountOrId - Account ID or account record
 * @param {string} startDate - Period start date (YYYY-MM-DD or DD/MM/YYYY)
 * @param {string} endDate - Period end date (YYYY-MM-DD or DD/MM/YYYY)
 * @param {Object} [options] - Options
 * @param {Object} [options.config] - Interest configuration override (from 6A)
 * @param {boolean} [options.useTimeline=false] - If true, uses buildPrincipalTimeline for segmented calculation
 * @param {Array} [options.transactions] - Optional transaction overrides for timeline
 * @returns {Object} Structured calculation result
 */
function calculateAccountInterestWithPrincipal(db, accountOrId, startDate, endDate, options = {}) {
    const { queryOne, queryAll } = require('../db/helpers');

    // 1. Load account
    let account = null;
    if (accountOrId && typeof accountOrId === 'object' && accountOrId.id) {
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

    // 2. Determine rate and method from config or account
    let rate, method;
    if (options.config && typeof options.config === 'object') {
        rate = Number(options.config.interest_rate);
        method = options.config.calculation_method || 'SIMPLE_INTEREST';
    } else {
        rate = Number(account.interest_rate);
        method = account.calculation_method || 'SIMPLE_INTEREST';
    }

    if (isNaN(rate) || rate < 0) {
        const err = new Error(`Account #${account.id} has invalid interest rate: ${account.interest_rate}`);
        err.statusCode = 400;
        throw err;
    }

    // 3. Validate dates using 6C
    const dateRange = calculateElapsedDays(startDate, endDate);

    // 4. Branch: segmented timeline vs current outstanding principal
    if (options.useTimeline === true) {
        // Use the existing buildPrincipalTimeline from interestService.js (Step 5E)
        const { buildPrincipalTimeline } = require('./interestService');
        const timeline = buildPrincipalTimeline(db, account, startDate, endDate, {
            transactions: options.transactions
        });

        const segResult = calculateSegmentedInterest(timeline.segments, rate, method, {
            day_count_basis: options.day_count_basis || DEFAULT_DAY_COUNT_BASIS
        });

        return {
            account_id: Number(account.id),
            person_id: Number(account.person_id),
            person_name: account.person_name || null,
            original_principal: timeline.original_principal,
            original_principal_paisa: timeline.original_principal_paisa,
            opening_principal: timeline.opening_principal,
            opening_principal_paisa: timeline.opening_principal_paisa,
            closing_principal: timeline.closing_principal,
            closing_principal_paisa: timeline.closing_principal_paisa,
            start_date: dateRange.startDateIso,
            end_date: dateRange.endDateIso,
            total_days: segResult.total_days,
            ...segResult,
            is_segmented: true,
            is_read_only: true
        };
    } else {
        // Use current outstanding principal (or original principal if outstanding not set)
        const principalPaisa = (account.outstanding_principal !== undefined && account.outstanding_principal !== null)
            ? Number(account.outstanding_principal)
            : Number(account.principal);

        // Validate principal
        if (principalPaisa < 0) {
            const err = new Error(`Account #${account.id} has negative outstanding principal: ${principalPaisa / 100}`);
            err.statusCode = 400;
            throw err;
        }

        const principalRupees = principalPaisa / 100;

        const result = calculateInterest({
            principal: principalRupees,
            interest_rate: rate,
            calculation_method: method,
            start_date: startDate,
            end_date: endDate,
            day_count_basis: options.day_count_basis || DEFAULT_DAY_COUNT_BASIS
        });

        return {
            account_id: Number(account.id),
            person_id: Number(account.person_id),
            person_name: account.person_name || null,
            original_principal: Number(account.principal) / 100,
            original_principal_paisa: Number(account.principal),
            outstanding_principal: principalRupees,
            outstanding_principal_paisa: principalPaisa,
            ...result,
            is_segmented: false,
            is_read_only: true
        };
    }
}

module.exports = {
    SUPPORTED_CALCULATION_METHODS,
    DEFAULT_DAY_COUNT_BASIS,
    DAY_COUNT_CONVENTION,
    DATE_BOUNDARY_CONVENTION,
    parseCalendarDate,
    calculateElapsedDays,
    validateCalculationInput,
    calculateInterest,
    calculateAccountInterestFromConfig,
    calculateSegmentedInterest,
    calculateAccountInterestWithPrincipal
};

