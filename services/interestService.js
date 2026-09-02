/**
 * Interest Manager — Step 5A: Interest Calculation Foundation
 *
 * Provides the foundational interface, validation, architectural constants,
 * rate representation rules, precision policies, and period boundary conventions
 * for interest calculations across accounts.
 *
 * NOTE FOR STEP 5A:
 * - This service establishes interfaces, data structures, and validation rules ONLY.
 * - Actual mathematical formulas and accrual engines are NOT executed in this step (reserved for Step 5B+).
 * - Automatic background calculation and automatic record generation are explicitly disabled.
 */

const { queryOne, queryAll } = require('../db/helpers');
const { saveDatabase } = require('../db/connection');

// ─── 1. Supported Calculation Methods ────────────────────────
const SUPPORTED_CALCULATION_METHODS = Object.freeze([
    'SIMPLE_INTEREST'
]);

// ─── 2. Supported Interest Frequencies ───────────────────────
const SUPPORTED_FREQUENCIES = Object.freeze([
    'DAILY',
    'WEEKLY',
    'MONTHLY',
    'YEARLY'
]);

// ─── 3. Supported Principal Basis Options ────────────────────
const SUPPORTED_PRINCIPAL_BASIS = Object.freeze([
    'ORIGINAL',      // Uses original principal (account.principal)
    'OUTSTANDING'    // Uses current unpaid principal (account.outstanding_principal)
]);

// ─── 4. Architectural Policies & Standards Documentation ────
/**
 * RATE REPRESENTATION POLICY:
 * In Interest Manager, interest rates are stored and represented as nominal percentages.
 * - Database value `15` represents `15%` (0.15 in mathematical decimal calculations).
 * - Database value `18.5` represents `18.5%` (0.185 in mathematical decimal calculations).
 * - Rates MUST NOT be interpreted as 1500% or 0.15%.
 */
const RATE_REPRESENTATION = Object.freeze({
    type: 'NOMINAL_PERCENTAGE',
    example: 'A database value of 15 represents 15% per annum/period (decimal multiplier: 0.15)',
    toDecimal: (rate) => Number(rate) / 100,
    toPercentageString: (rate) => `${Number(rate)}%`
});

/**
 * MONEY PRECISION & ROUNDING POLICY:
 * In Interest Manager:
 * - Stored monetary values use exact integer paisa (1 Rupee = 100 Paisa).
 * - Intermediate fractional calculations maintain 64-bit floating-point precision.
 * - Final monetary persistence rounds to nearest integer paisa using Math.round (half-up).
 * - Binary floating-point inaccuracy is prevented by storing all persisted amounts as integer paisa.
 */
const PRECISION_POLICY = Object.freeze({
    storageUnit: 'PAISA_INTEGER',
    displayUnit: 'RUPEES_DECIMAL',
    multiplier: 100,
    roundingStrategy: 'HALF_UP_TO_NEAREST_PAISA',
    roundToPaisa: (val) => Math.round(Number(val))
});

/**
 * DATE BOUNDARY CONVENTION:
 * In Interest Manager, calculation periods use the standard banking convention:
 * - Convention: INCLUSIVE_START_EXCLUSIVE_END [start_date, end_date)
 * - Start Date is included in the period.
 * - End Date is excluded from the period (acts as the boundary cutoff).
 * - Example: Period 2026-08-01 to 2026-09-01 covers 31 days (August 1 through August 31).
 * - Single-day period for date D: start = D, end = D + 1 day.
 */
const DATE_BOUNDARY_CONVENTION = Object.freeze({
    type: 'INCLUSIVE_START_EXCLUSIVE_END',
    description: 'Start date is inclusive [start, and end date is exclusive ,end)',
    format: 'YYYY-MM-DD'
});

// ─── 5. Date Parsing, Validation & Day-Count Helpers (Step 5C) ───
const SUPPORTED_DAY_COUNT_CONVENTIONS = Object.freeze([
    'ACTUAL_365'
]);

/**
 * Strict calendar date parser that verifies actual calendar validity.
 * Guards against impossible dates like Feb 31 or April 31.
 *
 * @param {string} d - Date in YYYY-MM-DD or DD/MM/YYYY
 * @param {string} [fieldName='Date'] - Name for error message
 * @returns {Object} { year, month, day, isoString, utcTimestamp }
 */
function parseCalendarDate(d, fieldName = 'Date') {
    if (d === undefined || d === null || d === '' || (typeof d !== 'string' && typeof d !== 'number')) {
        const err = new Error(`${fieldName} is required`);
        err.statusCode = 400;
        throw err;
    }

    const str = String(d).trim();
    let year, month, day;

    if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
        const parts = str.split('/');
        day = Number(parts[0]);
        month = Number(parts[1]);
        year = Number(parts[2]);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        const parts = str.split('-');
        year = Number(parts[0]);
        month = Number(parts[1]);
        day = Number(parts[2]);
    } else {
        const err = new Error(`${fieldName} "${str}" is invalid. Expected format YYYY-MM-DD or DD/MM/YYYY.`);
        err.statusCode = 400;
        throw err;
    }

    // Verify month range
    if (month < 1 || month > 12) {
        const err = new Error(`${fieldName} "${str}" has invalid month ${month}`);
        err.statusCode = 400;
        throw err;
    }

    // Create UTC date object
    const utcDate = new Date(Date.UTC(year, month - 1, day));

    // Verify calendar consistency (guards against Feb 30, April 31, etc.)
    if (
        utcDate.getUTCFullYear() !== year ||
        utcDate.getUTCMonth() !== month - 1 ||
        utcDate.getUTCDate() !== day
    ) {
        const err = new Error(`${fieldName} "${str}" is an impossible calendar date`);
        err.statusCode = 400;
        throw err;
    }

    const isoString = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return {
        year,
        month,
        day,
        isoString,
        utcTimestamp: utcDate.getTime()
    };
}

function normalizeDate(d) {
    try {
        const parsed = parseCalendarDate(d);
        return parsed.isoString;
    } catch (e) {
        return null;
    }
}

/**
 * Calculates the exact number of elapsed calendar days between two dates.
 * Follows the Step 5A boundary convention: [startDate, endDate)
 * Start date is inclusive; End date is exclusive.
 *
 * @param {string} startDate - Start date (YYYY-MM-DD or DD/MM/YYYY)
 * @param {string} endDate   - End date (YYYY-MM-DD or DD/MM/YYYY)
 * @returns {number} Exact integer number of elapsed days
 */
function calculateElapsedDays(startDate, endDate) {
    const start = parseCalendarDate(startDate, 'Start date');
    const end = parseCalendarDate(endDate, 'End date');

    if (end.utcTimestamp < start.utcTimestamp) {
        const err = new Error(`End date (${end.isoString}) cannot be before start date (${start.isoString})`);
        err.statusCode = 400;
        throw err;
    }

    const diffMs = end.utcTimestamp - start.utcTimestamp;
    const elapsedDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    return elapsedDays;
}

/**
 * Calculates the time fraction (in years) between two dates using ACTUAL/365 convention.
 *
 * Formula:
 *   Time = Elapsed Days / 365
 *
 * @param {string} startDate - Start date (YYYY-MM-DD or DD/MM/YYYY)
 * @param {string} endDate   - End date (YYYY-MM-DD or DD/MM/YYYY)
 * @param {string} [basis='ACTUAL_365'] - Day-count convention
 * @returns {number} Fractional year
 */
function calculateTimeFraction(startDate, endDate, basis = 'ACTUAL_365') {
    const convention = (basis || 'ACTUAL_365').toUpperCase().replace('/', '_');
    if (!SUPPORTED_DAY_COUNT_CONVENTIONS.includes(convention)) {
        const err = new Error(`Day-count convention "${basis}" is unsupported. Supported: ${SUPPORTED_DAY_COUNT_CONVENTIONS.join(', ')}`);
        err.statusCode = 400;
        throw err;
    }

    const elapsedDays = calculateElapsedDays(startDate, endDate);
    const denominator = 365;
    return elapsedDays / denominator;
}

/**
 * Detailed structured date-to-time calculation descriptor.
 *
 * @param {string} startDate
 * @param {string} endDate
 * @param {string} [basis='ACTUAL_365']
 * @returns {Object} Structured details
 */
function calculateTimeBetweenDates(startDate, endDate, basis = 'ACTUAL_365') {
    const start = parseCalendarDate(startDate, 'Start date');
    const end = parseCalendarDate(endDate, 'End date');

    if (end.utcTimestamp < start.utcTimestamp) {
        const err = new Error(`End date (${end.isoString}) cannot be before start date (${start.isoString})`);
        err.statusCode = 400;
        throw err;
    }

    const convention = (basis || 'ACTUAL_365').toUpperCase().replace('/', '_');
    if (!SUPPORTED_DAY_COUNT_CONVENTIONS.includes(convention)) {
        const err = new Error(`Day-count convention "${basis}" is unsupported. Supported: ${SUPPORTED_DAY_COUNT_CONVENTIONS.join(', ')}`);
        err.statusCode = 400;
        throw err;
    }

    const diffMs = end.utcTimestamp - start.utcTimestamp;
    const elapsedDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    const denominator = 365;
    const timeFraction = elapsedDays / denominator;

    // Check if period spans a leap year February 29
    let spansLeap = false;
    for (let y = start.year; y <= end.year; y++) {
        const isLeapYear = (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
        if (isLeapYear) {
            const feb29 = new Date(Date.UTC(y, 1, 29)).getTime();
            if (feb29 >= start.utcTimestamp && feb29 < end.utcTimestamp) {
                spansLeap = true;
                break;
            }
        }
    }

    return {
        start_date: start.isoString,
        end_date: end.isoString,
        elapsed_days: elapsedDays,
        time_fraction: timeFraction,
        day_count_convention: 'ACTUAL/365',
        boundary_convention: DATE_BOUNDARY_CONVENTION.type,
        denominator,
        spans_leap_year_feb29: spansLeap
    };
}

/**
 * Integration helper: Converts dates to time fraction and invokes calculateSimpleInterest (Step 5C).
 *
 * @param {number|string} principal
 * @param {number|string} annualRate
 * @param {string} startDate
 * @param {string} endDate
 * @param {Object} [options]
 * @returns {Object} Structured interest calculation with date period metadata
 */
function calculateSimpleInterestByDates(principal, annualRate, startDate, endDate, options = {}) {
    const timeDetails = calculateTimeBetweenDates(startDate, endDate, options.dayCountConvention || 'ACTUAL_365');
    const interestDetails = calculateSimpleInterest(principal, annualRate, timeDetails.time_fraction, options);

    return {
        ...interestDetails,
        period: {
            start_date: timeDetails.start_date,
            end_date: timeDetails.end_date,
            elapsed_days: timeDetails.elapsed_days,
            day_count_convention: timeDetails.day_count_convention,
            boundary_convention: timeDetails.boundary_convention
        }
    };
}

/**
 * Account-Level Interest Calculation Service (Step 5D)
 *
 * Calculates simple interest for one specific account over a specified date range.
 *
 * Steps:
 * 1. Load account (if ID passed) or use provided account record.
 * 2. Validate account (principal > 0, rate >= 0, SIMPLE_INTEREST method).
 * 3. Determine principal basis: uses current `outstanding_principal`.
 * 4. Read account's `interest_rate`.
 * 5. Calculate elapsed calendar days using Step 5C.
 * 6. Convert elapsed days to year fraction using Step 5C ACTUAL/365 convention.
 * 7. Pass values to Step 5B Simple Interest Engine.
 * 8. Return structured calculation result.
 *
 * Read-Only Guarantee:
 * - Does NOT modify account, principal, outstanding_principal, or transactions.
 * - Does NOT create rows in `interest_records`.
 *
 * @param {Object} db - Database connection
 * @param {number|Object} accountOrId - Account ID or account record
 * @param {string} startDate - Start date (YYYY-MM-DD or DD/MM/YYYY)
 * @param {string} endDate   - End date (YYYY-MM-DD or DD/MM/YYYY)
 * @param {Object} [options] - Options { dayCountConvention }
 * @returns {Object} Structured calculation descriptor
 */
function calculateAccountInterest(db, accountOrId, startDate, endDate, options = {}) {
    let account = null;

    // 1. Load account
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

    // 2. Validate account
    const method = (account.calculation_method || 'SIMPLE_INTEREST').toUpperCase();
    if (!SUPPORTED_CALCULATION_METHODS.includes(method)) {
        const err = new Error(`Account #${account.id} uses unsupported calculation method "${account.calculation_method}". Active methods: ${SUPPORTED_CALCULATION_METHODS.join(', ')}`);
        err.statusCode = 400;
        throw err;
    }

    if (account.interest_rate === undefined || account.interest_rate === null || isNaN(Number(account.interest_rate)) || Number(account.interest_rate) < 0) {
        const err = new Error(`Account #${account.id} has invalid interest rate: ${account.interest_rate}`);
        err.statusCode = 400;
        throw err;
    }

    if (account.principal === undefined || account.principal === null || Number(account.principal) <= 0) {
        const err = new Error(`Account #${account.id} has invalid original principal: ${account.principal}`);
        err.statusCode = 400;
        throw err;
    }

    // 3. Date range calculation (Step 5C)
    const timeDetails = calculateTimeBetweenDates(startDate, endDate, options.dayCountConvention || 'ACTUAL_365');

    // 4. Principal basis: use current outstanding_principal
    const outstandingPaisa = Number(account.outstanding_principal || 0);
    const originalPaisa = Number(account.principal);
    const rateNum = Number(account.interest_rate);

    let interestResult;
    if (outstandingPaisa <= 0) {
        // Zero outstanding principal produces zero interest
        interestResult = {
            principal: 0,
            principal_paisa: 0,
            rate: rateNum,
            rate_decimal: rateNum / 100,
            time: timeDetails.time_fraction,
            interest: 0,
            interest_paisa: 0,
            total: 0,
            total_paisa: 0,
            calculation_method: method,
            precision_policy: PRECISION_POLICY.roundingStrategy
        };
    } else {
        // Pass outstanding principal (in paisa) to Step 5B calculation engine
        interestResult = calculateSimpleInterest(outstandingPaisa, rateNum, timeDetails.time_fraction, { isPaisa: true });
    }

    return {
        accountId: Number(account.id),
        account_id: Number(account.id),
        personId: Number(account.person_id),
        person_id: Number(account.person_id),
        personName: account.person_name || null,
        person_name: account.person_name || null,
        principal: interestResult.principal,
        principal_paisa: interestResult.principal_paisa,
        originalPrincipal: originalPaisa / 100,
        original_principal: originalPaisa / 100,
        original_principal_paisa: originalPaisa,
        outstandingPrincipal: outstandingPaisa / 100,
        outstanding_principal: outstandingPaisa / 100,
        outstanding_principal_paisa: outstandingPaisa,
        annualRate: rateNum,
        annual_rate: rateNum,
        ratePercentage: `${rateNum}%`,
        rate_percentage: `${rateNum}%`,
        calculationMethod: method,
        calculation_method: method,
        startDate: timeDetails.start_date,
        start_date: timeDetails.start_date,
        endDate: timeDetails.end_date,
        end_date: timeDetails.end_date,
        elapsedDays: timeDetails.elapsed_days,
        elapsed_days: timeDetails.elapsed_days,
        timeInYears: timeDetails.time_fraction,
        time_in_years: timeDetails.time_fraction,
        dayCountConvention: timeDetails.day_count_convention,
        day_count_convention: timeDetails.day_count_convention,
        boundaryConvention: timeDetails.boundary_convention,
        boundary_convention: timeDetails.boundary_convention,
        interest: interestResult.interest,
        interest_paisa: interestResult.interest_paisa,
        total: interestResult.total,
        total_paisa: interestResult.total_paisa,
        precisionPolicy: PRECISION_POLICY.roundingStrategy,
        precision_policy: PRECISION_POLICY.roundingStrategy,
        isReadOnly: true
    };
}

// ─── 6. Validation Logic (Foundation) ────────────────────────
/**
 * Validates account and period parameters for interest calculations.
 *
 * @param {Object} account - Account record from database
 * @param {Object} period  - Calculation period { start_date, end_date }
 * @param {Object} options - Options { principalBasis, calculationMethod }
 * @returns {Object} { isValid: true, errors: [] } or throws Error if invalid
 */
function validateCalculationInput(account, period, options = {}) {
    const errors = [];

    // 1. Account object validation
    if (!account || typeof account !== 'object') {
        errors.push('A valid account object is required');
        const err = new Error(errors.join('. '));
        err.statusCode = 400;
        err.errors = errors;
        throw err;
    }

    if (!account.id || isNaN(Number(account.id))) {
        errors.push('Account must have a valid numerical ID');
    }

    // 2. Principal validation
    if (account.principal === undefined || account.principal === null || Number(account.principal) <= 0) {
        errors.push('Account original principal must be greater than zero');
    }

    if (account.outstanding_principal === undefined || account.outstanding_principal === null || Number(account.outstanding_principal) < 0) {
        errors.push('Account outstanding principal cannot be negative');
    }

    // 3. Interest Rate validation
    if (account.interest_rate === undefined || account.interest_rate === null || isNaN(Number(account.interest_rate)) || Number(account.interest_rate) < 0) {
        errors.push('Account interest rate must be zero or greater');
    }

    // 4. Frequency validation
    const freq = (account.interest_frequency || '').toUpperCase();
    if (!SUPPORTED_FREQUENCIES.includes(freq)) {
        errors.push(`Interest frequency "${account.interest_frequency}" is invalid. Supported: ${SUPPORTED_FREQUENCIES.join(', ')}`);
    }

    // 5. Calculation Method validation
    const method = (options.calculationMethod || account.calculation_method || 'SIMPLE_INTEREST').toUpperCase();
    if (!SUPPORTED_CALCULATION_METHODS.includes(method)) {
        errors.push(`Calculation method "${method}" is unsupported. Active methods: ${SUPPORTED_CALCULATION_METHODS.join(', ')}`);
    }

    // 6. Principal Basis validation
    const basis = (options.principalBasis || 'OUTSTANDING').toUpperCase();
    if (!SUPPORTED_PRINCIPAL_BASIS.includes(basis)) {
        errors.push(`Principal basis "${basis}" is invalid. Supported: ${SUPPORTED_PRINCIPAL_BASIS.join(', ')}`);
    }

    // 7. Period validation
    if (!period || typeof period !== 'object') {
        errors.push('A calculation period object with start_date and end_date is required');
    } else {
        const startNorm = normalizeDate(period.start_date);
        const endNorm = normalizeDate(period.end_date);

        if (!startNorm) {
            errors.push('Period start_date is required and must be in YYYY-MM-DD or DD/MM/YYYY format');
        }
        if (!endNorm) {
            errors.push('Period end_date is required and must be in YYYY-MM-DD or DD/MM/YYYY format');
        }

        if (startNorm && endNorm) {
            if (endNorm < startNorm) {
                errors.push(`Period end_date (${endNorm}) cannot be before start_date (${startNorm})`);
            }
        }
    }

    if (errors.length > 0) {
        const err = new Error(errors.join('. '));
        err.statusCode = 400;
        err.errors = errors;
        throw err;
    }

    return { isValid: true, errors: [] };
}

// ─── 7. Calculation Preparation Interface (Foundation Only) ─
/**
 * Prepares an interest calculation context by validating inputs,
 * resolving the principal basis, and structuring the calculation parameters.
 *
 * @param {Object} account - Account object from database
 * @param {Object} period  - { start_date, end_date }
 * @param {Object} options - { principalBasis: 'OUTSTANDING'|'ORIGINAL', calculationMethod: 'SIMPLE_INTEREST' }
 * @returns {Object} Structured preparation descriptor
 */
function prepareInterestCalculation(account, period, options = {}) {
    // Validate inputs
    validateCalculationInput(account, period, options);

    const startNorm = normalizeDate(period.start_date);
    const endNorm = normalizeDate(period.end_date);
    const basisType = (options.principalBasis || 'OUTSTANDING').toUpperCase();
    const method = (options.calculationMethod || account.calculation_method || 'SIMPLE_INTEREST').toUpperCase();
    const freq = (account.interest_frequency || 'MONTHLY').toUpperCase();

    // Resolve principal basis amount
    const basisAmountPaisa = basisType === 'ORIGINAL'
        ? Number(account.principal)
        : Number(account.outstanding_principal);

    return {
        ready: true,
        account_id: Number(account.id),
        person_id: Number(account.person_id),
        calculation_method: method,
        interest_frequency: freq,
        interest_rate: Number(account.interest_rate),
        rate_representation: {
            nominal_percentage: `${account.interest_rate}%`,
            decimal_multiplier: Number(account.interest_rate) / 100
        },
        period: {
            start_date: startNorm,
            end_date: endNorm,
            convention: DATE_BOUNDARY_CONVENTION.type
        },
        principal_basis: {
            type: basisType,
            amount_paisa: basisAmountPaisa,
            amount_rupees: basisAmountPaisa / 100
        },
        account_snapshot: {
            original_principal: Number(account.principal),
            outstanding_principal: Number(account.outstanding_principal)
        },
        status: 'FOUNDATION_READY',
        message: 'Calculation context validated successfully. Formulas will execute in Step 5B.'
    };
}

/**
 * Foundation Service Endpoint: calculateInterest
 */
function calculateInterest(account, period, options = {}) {
    const prepared = prepareInterestCalculation(account, period, options);
    return {
        ...prepared,
        calculated: false,
        interest_amount_paisa: null,
        interest_amount_rupees: null,
        note: 'Step 5A Foundation only. Interest calculations and accrual are deferred to Step 5B.'
    };
}

/**
 * Core Simple Interest Calculation Engine (Step 5B)
 *
 * Formula:
 *   Interest = Principal × (annualRate / 100) × time
 *   Total = Principal + Interest
 *
 * @param {number|string} principal  - Monetary principal in Rupees (or Paisa if options.isPaisa is true)
 * @param {number|string} annualRate - Nominal annual percentage (e.g. 15 for 15%)
 * @param {number|string} time       - Time as fraction of a year (e.g. 1 for 1 yr, 0.5 for 6 mo, 0.25 for 3 mo, 0 for 0)
 * @param {Object} [options]         - { isPaisa: boolean }
 * @returns {Object} Structured result: { principal, principal_paisa, rate, rate_decimal, time, interest, interest_paisa, total, total_paisa, calculation_method, precision_policy }
 */
function calculateSimpleInterest(principal, annualRate, time, options = {}) {
    const isPaisaInput = options.isPaisa === true;

    // 1. Principal Validation
    if (principal === undefined || principal === null || principal === '' || isNaN(Number(principal))) {
        const err = new Error('Principal must be a valid numerical value');
        err.statusCode = 400;
        throw err;
    }

    const pNum = Number(principal);
    if (pNum <= 0) {
        const err = new Error(`Principal must be greater than zero. Received: ${principal}`);
        err.statusCode = 400;
        throw err;
    }

    // 2. Interest Rate Validation
    if (annualRate === undefined || annualRate === null || annualRate === '' || isNaN(Number(annualRate))) {
        const err = new Error('Interest rate must be a valid numerical value');
        err.statusCode = 400;
        throw err;
    }

    const rNum = Number(annualRate);
    if (rNum < 0) {
        const err = new Error(`Interest rate cannot be negative. Received: ${annualRate}`);
        err.statusCode = 400;
        throw err;
    }

    // 3. Time Validation
    if (time === undefined || time === null || time === '' || isNaN(Number(time))) {
        const err = new Error('Time must be a valid numerical value');
        err.statusCode = 400;
        throw err;
    }

    const tNum = Number(time);
    if (tNum < 0) {
        const err = new Error(`Time cannot be negative. Received: ${time}`);
        err.statusCode = 400;
        throw err;
    }

    // Convert principal to exact integer paisa
    const principalPaisa = isPaisaInput ? Math.round(pNum) : Math.round(pNum * 100);
    const principalRupees = principalPaisa / 100;

    // Canonical simple interest calculation:
    // Interest = Principal × (Rate / 100) × Time
    const rateDecimal = rNum / 100;
    const rawInterestPaisa = principalPaisa * rateDecimal * tNum;
    const interestPaisa = Math.round(rawInterestPaisa);
    const interestRupees = interestPaisa / 100;

    const totalPaisa = principalPaisa + interestPaisa;
    const totalRupees = totalPaisa / 100;

    return {
        principal: principalRupees,
        principal_paisa: principalPaisa,
        rate: rNum,
        rate_decimal: rateDecimal,
        time: tNum,
        interest: interestRupees,
        interest_paisa: interestPaisa,
        total: totalRupees,
        total_paisa: totalPaisa,
        calculation_method: 'SIMPLE_INTEREST',
        precision_policy: PRECISION_POLICY.roundingStrategy
    };
}

/**
 * Principal Timeline Builder (Step 5E)
 *
 * Reconstructs the account's principal balance across time periods based on historical transactions.
 *
 * Rules:
 * 1. Operates on a single specific account.
 * 2. Starting principal comes from `account.principal`.
 * 3. Historical principal transactions before `startDate` establish the opening principal at `startDate`.
 * 4. In-period principal transactions (`startDate <= date < endDate`) split the period into constant-principal segments.
 * 5. Interest payments (`INTEREST_RECEIVED`, `INTEREST_PAID`) have 0 effect on principal and do NOT create timeline segments.
 * 6. Mixed payments only affect principal by the `PRINCIPAL_RECEIVED` portion.
 * 7. Future transactions (`date >= endDate`) are ignored.
 * 8. Reaching 0 principal keeps subsequent segments at ₹0 (never negative).
 * 9. Defensive check prevents negative principal balances.
 * 10. Read-only: does not modify accounts, transactions, or insert into interest_records.
 *
 * @param {Object} db - Database connection
 * @param {number|Object} accountOrId - Account ID or account object
 * @param {string} startDate - Calculation period start (YYYY-MM-DD or DD/MM/YYYY)
 * @param {string} endDate   - Calculation period end (YYYY-MM-DD or DD/MM/YYYY)
 * @param {Object} [options] - Optional overrides { transactions: Array }
 * @returns {Object} Structured timeline descriptor
 */
function buildPrincipalTimeline(db, accountOrId, startDate, endDate, options = {}) {
    let account = null;

    // 1. Load account
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

    // 2. Parse and validate period dates
    const startParsed = parseCalendarDate(startDate, 'Start date');
    const endParsed = parseCalendarDate(endDate, 'End date');

    if (endParsed.utcTimestamp < startParsed.utcTimestamp) {
        const err = new Error(`End date (${endParsed.isoString}) cannot be before start date (${startParsed.isoString})`);
        err.statusCode = 400;
        throw err;
    }

    const startIso = startParsed.isoString;
    const endIso = endParsed.isoString;
    const originalPrincipalPaisa = Number(account.principal);
    const accountStartIso = normalizeDate(account.start_date);

    // 3. Load transactions (from options.transactions if provided, or from DB)
    let rawTransactions = [];
    if (Array.isArray(options.transactions)) {
        rawTransactions = options.transactions;
    } else if (db && account.id) {
        rawTransactions = queryAll(db, `
            SELECT * FROM transactions
            WHERE account_id = ?
            ORDER BY transaction_date ASC, id ASC
        `, [Number(account.id)]);
    }

    // 4. Normalize transaction dates and determine principal effects
    const normalizedTxs = [];
    for (const tx of rawTransactions) {
        const txDateNorm = normalizeDate(tx.transaction_date);
        if (!txDateNorm) continue;

        let principalEffectPaisa = 0;
        const txType = tx.transaction_type;
        const txAmtPaisa = Number(tx.amount); // already in integer paisa in DB

        if (account.direction === 'MONEY_GIVEN') {
            if (txType === 'PRINCIPAL_RECEIVED') {
                // Borrower repaying money lent reduces user's principal exposure
                principalEffectPaisa = -txAmtPaisa;
            } else if (txType === 'MONEY_LENT') {
                // Initial money lent is already captured in account.principal
                // Subsequent additional loans after start_date increase principal
                if (accountStartIso && txDateNorm > accountStartIso) {
                    principalEffectPaisa = txAmtPaisa;
                }
            }
        } else if (account.direction === 'MONEY_TAKEN') {
            if (txType === 'PRINCIPAL_PAID') {
                // User repaying borrowed money reduces principal debt
                principalEffectPaisa = -txAmtPaisa;
            } else if (txType === 'MONEY_RECEIVED') {
                if (accountStartIso && txDateNorm > accountStartIso) {
                    principalEffectPaisa = txAmtPaisa;
                }
            }
        }

        // Only include transactions with non-zero principal effect
        if (principalEffectPaisa !== 0) {
            normalizedTxs.push({
                id: tx.id,
                transaction_date: txDateNorm,
                transaction_type: txType,
                amount_paisa: txAmtPaisa,
                principal_effect_paisa: principalEffectPaisa
            });
        }
    }

    // Sort by transaction_date ASC, id ASC
    normalizedTxs.sort((a, b) => {
        if (a.transaction_date !== b.transaction_date) {
            return a.transaction_date.localeCompare(b.transaction_date);
        }
        return (a.id || 0) - (b.id || 0);
    });

    // 5. Partition transactions: prior vs in-period vs future
    const priorTxs = normalizedTxs.filter(t => t.transaction_date < startIso);
    const inPeriodTxs = normalizedTxs.filter(t => t.transaction_date >= startIso && t.transaction_date < endIso);

    // 6. Compute opening principal at startIso
    let runningPrincipalPaisa = originalPrincipalPaisa;
    for (const tx of priorTxs) {
        runningPrincipalPaisa += tx.principal_effect_paisa;
        if (runningPrincipalPaisa < 0) {
            const err = new Error(`Data integrity error: Account #${account.id} principal became negative (${runningPrincipalPaisa / 100}) on prior transaction #${tx.id || ''}`);
            err.statusCode = 400;
            throw err;
        }
    }

    const openingPrincipalPaisa = runningPrincipalPaisa;

    // 7. Group in-period transactions by date
    const txByDate = new Map();
    for (const tx of inPeriodTxs) {
        const currentSum = txByDate.get(tx.transaction_date) || 0;
        txByDate.set(tx.transaction_date, currentSum + tx.principal_effect_paisa);
    }

    // 8. Build timeline segments
    const segments = [];
    const inPeriodDates = Array.from(txByDate.keys()).sort();

    let currentSegmentStart = startIso;

    for (const txDate of inPeriodDates) {
        if (txDate > currentSegmentStart) {
            const elapsedDays = calculateElapsedDays(currentSegmentStart, txDate);
            if (elapsedDays > 0) {
                segments.push({
                    startDate: currentSegmentStart,
                    start_date: currentSegmentStart,
                    endDate: txDate,
                    end_date: txDate,
                    principal: runningPrincipalPaisa / 100,
                    principal_paisa: runningPrincipalPaisa,
                    elapsedDays: elapsedDays,
                    elapsed_days: elapsedDays
                });
            }
            currentSegmentStart = txDate;
        }

        // Apply all net principal changes on txDate
        const delta = txByDate.get(txDate);
        runningPrincipalPaisa += delta;
        if (runningPrincipalPaisa < 0) {
            const err = new Error(`Data integrity error: Account #${account.id} principal became negative (${runningPrincipalPaisa / 100}) on ${txDate}`);
            err.statusCode = 400;
            throw err;
        }
    }

    // Final segment from currentSegmentStart to endIso
    if (currentSegmentStart < endIso) {
        const elapsedDays = calculateElapsedDays(currentSegmentStart, endIso);
        if (elapsedDays > 0 || startIso === endIso) {
            segments.push({
                startDate: currentSegmentStart,
                start_date: currentSegmentStart,
                endDate: endIso,
                end_date: endIso,
                principal: runningPrincipalPaisa / 100,
                principal_paisa: runningPrincipalPaisa,
                elapsedDays: elapsedDays,
                elapsed_days: elapsedDays
            });
        }
    }

    // Handle edge case of same-date start and end (0 days)
    if (segments.length === 0 && startIso === endIso) {
        segments.push({
            startDate: startIso,
            start_date: startIso,
            endDate: endIso,
            end_date: endIso,
            principal: runningPrincipalPaisa / 100,
            principal_paisa: runningPrincipalPaisa,
            elapsedDays: 0,
            elapsed_days: 0
        });
    }

    const closingPrincipalPaisa = runningPrincipalPaisa;
    const totalElapsedDays = calculateElapsedDays(startIso, endIso);

    return {
        accountId: Number(account.id),
        account_id: Number(account.id),
        personId: Number(account.person_id),
        person_id: Number(account.person_id),
        personName: account.person_name || null,
        person_name: account.person_name || null,
        originalPrincipal: originalPrincipalPaisa / 100,
        original_principal: originalPrincipalPaisa / 100,
        original_principal_paisa: originalPrincipalPaisa,
        openingPrincipal: openingPrincipalPaisa / 100,
        opening_principal: openingPrincipalPaisa / 100,
        opening_principal_paisa: openingPrincipalPaisa,
        closingPrincipal: closingPrincipalPaisa / 100,
        closing_principal: closingPrincipalPaisa / 100,
        closing_principal_paisa: closingPrincipalPaisa,
        startDate: startIso,
        start_date: startIso,
        endDate: endIso,
        end_date: endIso,
        totalElapsedDays: totalElapsedDays,
        total_elapsed_days: totalElapsedDays,
        boundaryConvention: DATE_BOUNDARY_CONVENTION.type,
        boundary_convention: DATE_BOUNDARY_CONVENTION.type,
        segments: segments,
        isReadOnly: true
    };
}

/**
 * Timeline-Based Interest Calculation Service (Step 5F)
 *
 * Combines:
 * - Step 5E: buildPrincipalTimeline
 * - Step 5C: Date-to-time calculation (ACTUAL/365)
 * - Step 5B: Simple interest formula (I = P * R/100 * T)
 *
 * Calculates interest across multiple principal segments when principal changes
 * during the calculation period.
 *
 * Read-Only:
 * - Does NOT modify accounts, transactions, or insert into interest_records.
 *
 * @param {Object} db - Database connection
 * @param {number|Object} accountOrId - Account ID or account record
 * @param {string} startDate - Start date (YYYY-MM-DD or DD/MM/YYYY)
 * @param {string} endDate   - End date (YYYY-MM-DD or DD/MM/YYYY)
 * @param {Object} [options] - Optional overrides { transactions: Array, dayCountConvention: 'ACTUAL_365' }
 * @returns {Object} Detailed breakdown of segment interest and total interest
 */
function calculateTimelineInterest(db, accountOrId, startDate, endDate, options = {}) {
    let account = null;

    // 1. Load account
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

    // 2. Validate account calculation method and rate
    const method = (account.calculation_method || 'SIMPLE_INTEREST').toUpperCase();
    if (!SUPPORTED_CALCULATION_METHODS.includes(method)) {
        const err = new Error(`Account #${account.id} uses unsupported calculation method "${account.calculation_method}". Active methods: ${SUPPORTED_CALCULATION_METHODS.join(', ')}`);
        err.statusCode = 400;
        throw err;
    }

    if (account.interest_rate === undefined || account.interest_rate === null || isNaN(Number(account.interest_rate)) || Number(account.interest_rate) < 0) {
        const err = new Error(`Account #${account.id} has invalid interest rate: ${account.interest_rate}`);
        err.statusCode = 400;
        throw err;
    }

    const rate = Number(account.interest_rate);

    // 3. Parse and validate date range
    const startParsed = parseCalendarDate(startDate, 'Start date');
    const endParsed = parseCalendarDate(endDate, 'End date');

    if (endParsed.utcTimestamp < startParsed.utcTimestamp) {
        const err = new Error(`End date (${endParsed.isoString}) cannot be before start date (${startParsed.isoString})`);
        err.statusCode = 400;
        throw err;
    }

    const startIso = startParsed.isoString;
    const endIso = endParsed.isoString;

    // Handle same-date range: 0 days, 0 interest, empty segments
    if (startIso === endIso) {
        const principalBasisPaisa = Number(account.outstanding_principal || account.principal || 0);
        return {
            accountId: Number(account.id),
            account_id: Number(account.id),
            personId: Number(account.person_id),
            person_id: Number(account.person_id),
            personName: account.person_name || null,
            person_name: account.person_name || null,
            originalPrincipal: Number(account.principal) / 100,
            original_principal: Number(account.principal) / 100,
            originalPrincipalPaisa: Number(account.principal),
            original_principal_paisa: Number(account.principal),
            openingPrincipal: principalBasisPaisa / 100,
            opening_principal: principalBasisPaisa / 100,
            openingPrincipalPaisa: principalBasisPaisa,
            opening_principal_paisa: principalBasisPaisa,
            closingPrincipal: principalBasisPaisa / 100,
            closing_principal: principalBasisPaisa / 100,
            closingPrincipalPaisa: principalBasisPaisa,
            closing_principal_paisa: principalBasisPaisa,
            annualRate: rate,
            annual_rate: rate,
            ratePercentage: `${rate}%`,
            rate_percentage: `${rate}%`,
            calculationMethod: method,
            calculation_method: method,
            calculationStartDate: startIso,
            calculation_start_date: startIso,
            calculationEndDate: endIso,
            calculation_end_date: endIso,
            totalElapsedDays: 0,
            total_elapsed_days: 0,
            dayCountConvention: 'ACTUAL/365',
            day_count_convention: 'ACTUAL/365',
            boundaryConvention: DATE_BOUNDARY_CONVENTION.type,
            boundary_convention: DATE_BOUNDARY_CONVENTION.type,
            totalInterest: 0,
            total_interest: 0,
            totalInterestPaisa: 0,
            total_interest_paisa: 0,
            totalPayable: principalBasisPaisa / 100,
            total_payable: principalBasisPaisa / 100,
            precisionPolicy: PRECISION_POLICY.roundingStrategy,
            precision_policy: PRECISION_POLICY.roundingStrategy,
            segments: [],
            isReadOnly: true
        };
    }

    // 4. Build the principal timeline using Step 5E
    const timeline = buildPrincipalTimeline(db, account, startIso, endIso, options);

    // 5. Calculate simple interest for each segment using Step 5B and Step 5C
    const calculatedSegments = [];
    let totalExactInterestPaisa = 0;

    for (const seg of timeline.segments) {
        const segElapsedDays = seg.elapsedDays;
        const timeInYears = segElapsedDays / 365;
        const segPrincipalPaisa = seg.principal_paisa;
        const segPrincipalRupees = seg.principal;

        let segInterestPaisa = 0;
        let segInterestRupees = 0;
        let exactSegInterestPaisa = 0;

        if (segPrincipalPaisa > 0 && timeInYears > 0) {
            // Rate decimal multiplier
            const rateDecimal = rate / 100;
            exactSegInterestPaisa = segPrincipalPaisa * rateDecimal * timeInYears;
            segInterestPaisa = Math.round(exactSegInterestPaisa);
            segInterestRupees = segInterestPaisa / 100;
            totalExactInterestPaisa += exactSegInterestPaisa;
        }

        calculatedSegments.push({
            startDate: seg.startDate,
            start_date: seg.startDate,
            endDate: seg.endDate,
            end_date: seg.endDate,
            elapsedDays: segElapsedDays,
            elapsed_days: segElapsedDays,
            timeInYears: timeInYears,
            time_in_years: timeInYears,
            principal: segPrincipalRupees,
            principal_paisa: segPrincipalPaisa,
            rate: rate,
            rate_percentage: `${rate}%`,
            interest: segInterestRupees,
            interest_paisa: segInterestPaisa,
            total: segPrincipalRupees + segInterestRupees,
            total_paisa: segPrincipalPaisa + segInterestPaisa
        });
    }

    // 6. Final sum of interest according to Step 5A precision policy (rounded at final monetary level)
    const totalInterestPaisa = Math.round(totalExactInterestPaisa);
    const totalInterestRupees = totalInterestPaisa / 100;
    const closingPrincipalPaisa = timeline.closing_principal_paisa;
    const totalPayableRupees = (closingPrincipalPaisa + totalInterestPaisa) / 100;

    return {
        accountId: Number(account.id),
        account_id: Number(account.id),
        personId: Number(account.person_id),
        person_id: Number(account.person_id),
        personName: account.person_name || null,
        person_name: account.person_name || null,
        originalPrincipal: timeline.originalPrincipal,
        original_principal: timeline.originalPrincipal,
        originalPrincipalPaisa: timeline.original_principal_paisa,
        original_principal_paisa: timeline.original_principal_paisa,
        openingPrincipal: timeline.openingPrincipal,
        opening_principal: timeline.openingPrincipal,
        openingPrincipalPaisa: timeline.opening_principal_paisa,
        opening_principal_paisa: timeline.opening_principal_paisa,
        closingPrincipal: timeline.closingPrincipal,
        closing_principal: timeline.closingPrincipal,
        closingPrincipalPaisa: timeline.closing_principal_paisa,
        closing_principal_paisa: timeline.closing_principal_paisa,
        annualRate: rate,
        annual_rate: rate,
        ratePercentage: `${rate}%`,
        rate_percentage: `${rate}%`,
        calculationMethod: method,
        calculation_method: method,
        calculationStartDate: timeline.startDate,
        calculation_start_date: timeline.startDate,
        calculationEndDate: timeline.endDate,
        calculation_end_date: timeline.endDate,
        totalElapsedDays: timeline.totalElapsedDays,
        total_elapsed_days: timeline.totalElapsedDays,
        dayCountConvention: 'ACTUAL/365',
        day_count_convention: 'ACTUAL/365',
        boundaryConvention: DATE_BOUNDARY_CONVENTION.type,
        boundary_convention: DATE_BOUNDARY_CONVENTION.type,
        totalInterest: totalInterestRupees,
        total_interest: totalInterestRupees,
        totalInterestPaisa: totalInterestPaisa,
        total_interest_paisa: totalInterestPaisa,
        totalPayable: totalPayableRupees,
        total_payable: totalPayableRupees,
        precisionPolicy: PRECISION_POLICY.roundingStrategy,
        precision_policy: PRECISION_POLICY.roundingStrategy,
        segments: calculatedSegments,
        isReadOnly: true
    };
}

// ─── Step 5I: Interest Outstanding & Payment Allocation ──────

/**
 * Record an interest accrual / calculation into interest_records (Step 5I)
 *
 * @param {Object} db - Database connection
 * @param {Object} data - { account_id, period_start, period_end, principal_basis, interest_rate, interest_amount, calculation_method }
 * @returns {Object} Created interest record
 */
function recordInterest(db, data) {
    const accountId = Number(data.account_id);
    if (!accountId || isNaN(accountId)) {
        const err = new Error('Valid account_id is required');
        err.statusCode = 400;
        throw err;
    }

    const account = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accountId]);
    if (!account) {
        const err = new Error(`Account #${accountId} not found`);
        err.statusCode = 404;
        throw err;
    }

    const startNorm = normalizeDate(data.period_start);
    const endNorm = normalizeDate(data.period_end);
    if (!startNorm || !endNorm) {
        const err = new Error('Valid period_start and period_end are required (YYYY-MM-DD or DD/MM/YYYY)');
        err.statusCode = 400;
        throw err;
    }

    if (endNorm < startNorm) {
        const err = new Error(`period_end (${endNorm}) cannot be before period_start (${startNorm})`);
        err.statusCode = 400;
        throw err;
    }

    // Convert amounts to integer paisa
    const amountPaisa = data.is_paisa === true || data.isPaisa === true
        ? Math.round(Number(data.interest_amount))
        : Math.round(Number(data.interest_amount) * 100);

    if (isNaN(amountPaisa) || amountPaisa <= 0) {
        const err = new Error('interest_amount must be greater than zero');
        err.statusCode = 400;
        throw err;
    }

    const basisPaisa = data.principal_basis !== undefined
        ? (data.is_paisa ? Math.round(Number(data.principal_basis)) : Math.round(Number(data.principal_basis) * 100))
        : Number(account.outstanding_principal || account.principal);

    const rate = Number(data.interest_rate !== undefined ? data.interest_rate : account.interest_rate);
    const method = (data.calculation_method || account.calculation_method || 'SIMPLE_INTEREST').toUpperCase();

    db.run(`
        INSERT INTO interest_records (
            account_id, period_start, period_end, principal_basis,
            interest_rate, interest_amount, paid_amount, calculation_method, status
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'PENDING')
    `, [accountId, startNorm, endNorm, basisPaisa, rate, amountPaisa, method]);

    const lastId = queryOne(db, 'SELECT last_insert_rowid() as id');
    const created = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [lastId.id]);

    db.run(
        `INSERT INTO audit_logs (entity_type, entity_id, action, new_value)
         VALUES ('INTEREST_RECORD', ?, 'CREATE', ?)`,
        [created.id, JSON.stringify(created)]
    );

    return {
        ...created,
        interest_amount_rupees: created.interest_amount / 100,
        paid_amount_rupees: created.paid_amount / 100,
        outstanding_amount_rupees: (created.interest_amount - created.paid_amount) / 100
    };
}

/**
 * Get derived interest balance and history for an account (Step 5I)
 *
 * Distinguishes:
 * - Interest Recorded: Total interest recorded in interest_records
 * - Interest Paid: Total money received as interest (INTEREST_RECEIVED transactions)
 * - Interest Outstanding: Recorded minus Paid (never negative)
 *
 * @param {Object} db - Database connection
 * @param {number} accountId - Account ID
 * @returns {Object} Structured interest balance descriptor
 */
function getAccountInterestBalance(db, accountId) {
    const accId = Number(accountId);
    if (!accId || isNaN(accId)) {
        const err = new Error('Valid account_id is required');
        err.statusCode = 400;
        throw err;
    }

    const account = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accId]);
    if (!account) {
        const err = new Error(`Account #${accId} not found`);
        err.statusCode = 404;
        throw err;
    }

    // 1. Total interest recorded
    const recRow = queryOne(db, `
        SELECT COALESCE(SUM(interest_amount), 0) as total_recorded,
               COUNT(*) as record_count
        FROM interest_records
        WHERE account_id = ?
    `, [accId]);
    const recordedPaisa = Number(recRow?.total_recorded || 0);
    const recordCount = Number(recRow?.record_count || 0);

    // 2. Total interest paid from transactions
    const paidRow = queryOne(db, `
        SELECT COALESCE(SUM(amount), 0) as total_paid
        FROM transactions
        WHERE account_id = ? AND transaction_type = 'INTEREST_RECEIVED'
    `, [accId]);
    const paidPaisa = Number(paidRow?.total_paid || 0);

    // 3. Defensive check against negative balance
    if (recordCount > 0 && paidPaisa > recordedPaisa) {
        const err = new Error(`Data integrity error: Account #${accId} has interest paid (₹${paidPaisa / 100}) exceeding recorded interest (₹${recordedPaisa / 100})`);
        err.statusCode = 400;
        throw err;
    }

    const outstandingPaisa = Math.max(0, recordedPaisa - paidPaisa);

    function formatDmy(d) {
        if (!d) return '';
        const parts = d.split('-');
        if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
        return d;
    }

    // 4. Fetch all individual interest records for this account
    const records = queryAll(db, `
        SELECT r.*,
               (r.interest_amount - r.paid_amount) as outstanding_amount
        FROM interest_records r
        WHERE r.account_id = ?
        ORDER BY r.period_start ASC, r.id ASC
    `, [accId]).map(r => ({
        id: r.id,
        account_id: r.account_id,
        period_start: r.period_start,
        period_end: r.period_end,
        period_formatted: `${formatDmy(r.period_start)} – ${formatDmy(r.period_end)}`,
        principal_basis: r.principal_basis / 100,
        principal_basis_paisa: r.principal_basis,
        interest_rate: r.interest_rate,
        interest_amount: r.interest_amount / 100,
        interest_amount_paisa: r.interest_amount,
        paid_amount: r.paid_amount / 100,
        paid_amount_paisa: r.paid_amount,
        outstanding_amount: (r.interest_amount - r.paid_amount) / 100,
        outstanding_amount_paisa: (r.interest_amount - r.paid_amount),
        calculation_method: r.calculation_method,
        status: r.status,
        created_at: r.created_at
    }));

    return {
        accountId: accId,
        account_id: accId,
        hasRecords: recordCount > 0,
        recordCount: recordCount,
        interestRecorded: recordedPaisa / 100,
        interest_recorded: recordedPaisa / 100,
        interestRecordedPaisa: recordedPaisa,
        interest_recorded_paisa: recordedPaisa,
        interestPaid: paidPaisa / 100,
        interest_paid: paidPaisa / 100,
        interestPaidPaisa: paidPaisa,
        interest_paid_paisa: paidPaisa,
        interestOutstanding: outstandingPaisa / 100,
        interest_outstanding: outstandingPaisa / 100,
        interestOutstandingPaisa: outstandingPaisa,
        interest_outstanding_paisa: outstandingPaisa,
        records: records
    };
}

/**
 * Helper to allocate an interest payment across pending/partially paid interest records in FIFO order (Step 5I)
 *
 * @param {Object} db - Database connection
 * @param {number} accountId - Account ID
 * @param {number} txId - Transaction ID of the INTEREST_RECEIVED transaction
 * @param {number} interestAmountPaisa - Amount of interest to allocate in paisa
 * @returns {Array} List of allocations made
 */
function allocateInterestPaymentToRecords(db, accountId, txId, interestAmountPaisa) {
    let remainingInterest = interestAmountPaisa;
    const allocations = [];

    const pendingRecords = queryAll(db, `
        SELECT * FROM interest_records
        WHERE account_id = ? AND status IN ('PENDING', 'PARTIALLY_PAID')
        ORDER BY period_start ASC, id ASC
    `, [accountId]);

    for (const rec of pendingRecords) {
        if (remainingInterest <= 0) break;

        const needed = rec.interest_amount - rec.paid_amount;
        if (needed <= 0) continue;

        const alloc = Math.min(remainingInterest, needed);
        const newPaid = rec.paid_amount + alloc;
        const newStatus = newPaid >= rec.interest_amount ? 'PAID' : 'PARTIALLY_PAID';

        db.run(`
            UPDATE interest_records
            SET paid_amount = ?, status = ?
            WHERE id = ?
        `, [newPaid, newStatus, rec.id]);

        db.run(`
            INSERT INTO interest_allocations (account_id, interest_record_id, transaction_id, amount)
            VALUES (?, ?, ?, ?)
        `, [accountId, rec.id, txId, alloc]);

        allocations.push({
            interest_record_id: rec.id,
            transaction_id: txId,
            amount: alloc,
            new_status: newStatus
        });

        remainingInterest -= alloc;
    }

    return allocations;
}

/**
 * Step 5J: Automatic Interest Accrual Service
 *
 * Automatically calculates timeline-based interest using Step 5F and persists it
 * into interest_records using Step 5H/5I mechanisms with strict duplicate protection,
 * concurrency safety, and zero-interest handling.
 *
 * @param {Object} db - SQLite database instance
 * @param {number|string} accountId - Account ID
 * @param {string} startDate - Start date (YYYY-MM-DD or DD/MM/YYYY)
 * @param {string} endDate - End date (YYYY-MM-DD or DD/MM/YYYY)
 * @param {Object} [options] - Additional options (e.g. dayCountConvention, in-memory transactions override)
 * @returns {Object} Structured result { status, accountId, periodStart, periodEnd, interestRecordId, interestAmount, interestAmountPaisa, alreadyRecorded, calculation }
 */
function accrueInterest(db, accountId, startDate, endDate, options = {}) {
    const accId = Number(accountId);
    if (!accId || isNaN(accId)) {
        const err = new Error('Valid account_id is required');
        err.statusCode = 400;
        throw err;
    }

    const account = queryOne(db, 'SELECT * FROM accounts WHERE id = ?', [accId]);
    if (!account) {
        const err = new Error(`Account #${accId} not found`);
        err.statusCode = 404;
        throw err;
    }

    // Closed / written-off account protection
    if (account.status === 'CLOSED' || account.status === 'WRITTEN_OFF') {
        const err = new Error(`Cannot accrue interest on ${account.status} Account #${accId}`);
        err.statusCode = 400;
        throw err;
    }

    if (account.calculation_method && account.calculation_method !== 'SIMPLE_INTEREST') {
        const err = new Error(`Unsupported calculation method: ${account.calculation_method}`);
        err.statusCode = 400;
        throw err;
    }

    const startNorm = normalizeDate(startDate);
    const endNorm = normalizeDate(endDate);
    if (!startNorm || !endNorm) {
        const err = new Error('Valid startDate and endDate are required (YYYY-MM-DD or DD/MM/YYYY)');
        err.statusCode = 400;
        throw err;
    }

    if (endNorm < startNorm) {
        const err = new Error(`endDate (${endNorm}) cannot be before startDate (${startNorm})`);
        err.statusCode = 400;
        throw err;
    }

    // 1. Duplicate Check: check if interest is already recorded for this account and period
    const existingRecord = queryOne(db, `
        SELECT * FROM interest_records
        WHERE account_id = ? AND period_start = ? AND period_end = ?
    `, [accId, startNorm, endNorm]);

    if (existingRecord) {
        return {
            status: 'ALREADY_RECORDED',
            accountId: accId,
            periodStart: startNorm,
            periodEnd: endNorm,
            interestRecordId: existingRecord.id,
            interestAmount: existingRecord.interest_amount / 100,
            interestAmountPaisa: existingRecord.interest_amount,
            alreadyRecorded: true,
            calculation: null,
            message: `Interest has already been recorded for Account #${accId} for period ${startNorm} to ${endNorm}`
        };
    }

    // 2. Authoritative Step 5F Calculation
    const calcResult = calculateTimelineInterest(db, accId, startNorm, endNorm, options);

    // 3. Zero Interest Handling:
    // If 0 elapsed days or 0 total interest (e.g. 0 principal or same start/end date)
    if (calcResult.totalElapsedDays === 0 || calcResult.totalInterestPaisa === 0) {
        return {
            status: 'ZERO_INTEREST',
            accountId: accId,
            periodStart: startNorm,
            periodEnd: endNorm,
            interestRecordId: null,
            interestAmount: 0,
            interestAmountPaisa: 0,
            alreadyRecorded: false,
            calculation: calcResult,
            message: 'Zero interest calculated for this period; no interest record created'
        };
    }

    // 4. Persistence with transaction & concurrency safety
    let createdRecord = null;
    try {
        db.run('BEGIN TRANSACTION');

        // Re-check duplicate inside transaction lock
        const freshExisting = queryOne(db, `
            SELECT * FROM interest_records
            WHERE account_id = ? AND period_start = ? AND period_end = ?
        `, [accId, startNorm, endNorm]);

        if (freshExisting) {
            db.run('ROLLBACK');
            return {
                status: 'ALREADY_RECORDED',
                accountId: accId,
                periodStart: startNorm,
                periodEnd: endNorm,
                interestRecordId: freshExisting.id,
                interestAmount: freshExisting.interest_amount / 100,
                interestAmountPaisa: freshExisting.interest_amount,
                alreadyRecorded: true,
                calculation: calcResult,
                message: `Interest has already been recorded for Account #${accId} for period ${startNorm} to ${endNorm}`
            };
        }

        const basisPaisa = calcResult.openingPrincipalPaisa || Math.round(calcResult.openingPrincipal * 100);
        const rate = calcResult.annualRate;
        const interestAmountPaisa = calcResult.totalInterestPaisa;

        db.run(`
            INSERT INTO interest_records (
                account_id, period_start, period_end, principal_basis,
                interest_rate, interest_amount, paid_amount, calculation_method, status
            ) VALUES (?, ?, ?, ?, ?, ?, 0, 'SIMPLE_INTEREST', 'PENDING')
        `, [accId, startNorm, endNorm, basisPaisa, rate, interestAmountPaisa]);

        const rowid = queryOne(db, 'SELECT last_insert_rowid() as id');
        createdRecord = queryOne(db, 'SELECT * FROM interest_records WHERE id = ?', [rowid.id]);

        // Audit log
        db.run(`
            INSERT INTO audit_logs (entity_type, entity_id, action, new_value)
            VALUES ('INTEREST_RECORD', ?, 'AUTO_ACCRUE', ?)
        `, [createdRecord.id, JSON.stringify({
            account_id: accId,
            period_start: startNorm,
            period_end: endNorm,
            principal_basis: basisPaisa,
            interest_rate: rate,
            interest_amount: interestAmountPaisa,
            segments: calcResult.segments?.length || 0,
            total_elapsed_days: calcResult.totalElapsedDays
        })]);

        db.run('COMMIT');
    } catch (err) {
        try { db.run('ROLLBACK'); } catch (_) {}
        // Check for unique constraint violation (concurrent insertion)
        if (err.message && err.message.includes('UNIQUE constraint failed')) {
            const fallback = queryOne(db, `
                SELECT * FROM interest_records
                WHERE account_id = ? AND period_start = ? AND period_end = ?
            `, [accId, startNorm, endNorm]);
            if (fallback) {
                return {
                    status: 'ALREADY_RECORDED',
                    accountId: accId,
                    periodStart: startNorm,
                    periodEnd: endNorm,
                    interestRecordId: fallback.id,
                    interestAmount: fallback.interest_amount / 100,
                    interestAmountPaisa: fallback.interest_amount,
                    alreadyRecorded: true,
                    calculation: calcResult
                };
            }
        }
        throw err;
    }

    saveDatabase();

    return {
        status: 'RECORDED',
        accountId: accId,
        periodStart: startNorm,
        periodEnd: endNorm,
        interestRecordId: createdRecord.id,
        interestAmount: createdRecord.interest_amount / 100,
        interestAmountPaisa: createdRecord.interest_amount,
        alreadyRecorded: false,
        calculation: calcResult,
        record: createdRecord
    };
}

module.exports = {
    SUPPORTED_CALCULATION_METHODS,
    SUPPORTED_FREQUENCIES,
    SUPPORTED_PRINCIPAL_BASIS,
    SUPPORTED_DAY_COUNT_CONVENTIONS,
    RATE_REPRESENTATION,
    PRECISION_POLICY,
    DATE_BOUNDARY_CONVENTION,
    parseCalendarDate,
    normalizeDate,
    calculateElapsedDays,
    calculateTimeFraction,
    calculateTimeBetweenDates,
    calculateSimpleInterestByDates,
    calculateAccountInterest,
    buildPrincipalTimeline,
    calculateTimelineInterest,
    recordInterest,
    getAccountInterestBalance,
    allocateInterestPaymentToRecords,
    accrueInterest,
    validateCalculationInput,
    prepareInterestCalculation,
    calculateInterest,
    calculateSimpleInterest
};
