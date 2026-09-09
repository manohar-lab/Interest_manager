/**
 * Interest Manager — Step 6C: Date & Day Calculation Utility
 *
 * Centralized, deterministic date/day calculation for the Interest Calculation Engine.
 *
 * This module is the SINGLE SOURCE OF TRUTH for:
 *   - Calendar date parsing & validation
 *   - Elapsed interest-day calculation between two dates
 *   - Date normalization
 *
 * DATE CONVENTION (established in Step 5A, preserved here):
 *   Boundary: INCLUSIVE_START_EXCLUSIVE_END [start_date, end_date)
 *   - Start date IS included in the interest period.
 *   - End date IS excluded from the interest period (acts as the cutoff boundary).
 *   - Same-day period (start_date === end_date) yields 0 elapsed days.
 *
 *   Examples:
 *     01-Jan → 02-Jan = 1 day
 *     01-Jan → 31-Jan = 30 days
 *     01-Jan → 01-Feb = 31 days
 *     01-Jan → 01-Jan = 0 days
 *
 * DATE-ONLY HANDLING:
 *   All calculations use UTC midnight dates (Date.UTC) to avoid timezone and
 *   clock-time artifacts. Interest accrual is based on calendar dates, not
 *   hours/minutes/seconds, so 2026-01-01T23:59 and 2026-01-02T00:01 are
 *   treated as separate calendar days.
 *
 * LEAP YEARS:
 *   Uses the JavaScript Date object's UTC calendar internally, which correctly
 *   handles leap years. No month lengths are hard-coded.
 *
 * IMPORTANT DISTINCTION:
 *   "Elapsed calendar days" (output of this module) is NOT the same as
 *   "Day-count basis" (the denominator used in interest formulas, e.g. 365).
 *   This module provides only the former. The day-count basis belongs to the
 *   interest calculation service (Step 6B).
 *
 * NO DATABASE SIDE EFFECTS:
 *   This module performs pure in-memory date arithmetic only.
 *   It does not create, read, update, or delete any database records.
 */

/**
 * Date boundary convention constant.
 * @type {string}
 */
const DATE_BOUNDARY_CONVENTION = 'INCLUSIVE_START_EXCLUSIVE_END';

/**
 * Milliseconds in one calendar day (24h × 60m × 60s × 1000ms).
 * @type {number}
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Strict calendar date parser that verifies actual calendar validity.
 * Rejects impossible dates (e.g. Feb 30, Apr 31) via UTC round-trip verification.
 *
 * Accepts formats:
 *   - YYYY-MM-DD  (ISO 8601)
 *   - DD/MM/YYYY  (Indian/European)
 *
 * @param {string|number} d - Date value to parse
 * @param {string} [fieldName='Date'] - Human-readable field name for error messages
 * @returns {Object} { year, month, day, isoString, utcTimestamp }
 * @throws {Error} With statusCode 400 for missing, invalid, or impossible dates
 */
function parseCalendarDate(d, fieldName = 'Date') {
    if (d === undefined || d === null || d === '' || (typeof d !== 'string' && typeof d !== 'number')) {
        const err = new Error(`${fieldName} is required`);
        err.statusCode = 400;
        throw err;
    }

    const str = String(d).trim();
    let year, month, day;

    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        const parts = str.split('-').map(Number);
        year = parts[0];
        month = parts[1];
        day = parts[2];
    } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(str)) {
        const parts = str.split('/').map(Number);
        day = parts[0];
        month = parts[1];
        year = parts[2];
    } else {
        const err = new Error(`${fieldName} "${str}" is invalid. Expected format YYYY-MM-DD or DD/MM/YYYY.`);
        err.statusCode = 400;
        throw err;
    }

    if (month < 1 || month > 12) {
        const err = new Error(`${fieldName} "${str}" has invalid month ${month}`);
        err.statusCode = 400;
        throw err;
    }

    // Use UTC to avoid timezone artifacts in day calculations
    const utcDate = new Date(Date.UTC(year, month - 1, day));

    // Round-trip verification: if JS Date rolled the date, the input was impossible
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

/**
 * Normalizes a date string to YYYY-MM-DD format.
 * Returns null if the input is not a valid calendar date.
 *
 * @param {string} d - Date string to normalize
 * @returns {string|null} ISO date string or null
 */
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
 *
 * Convention: INCLUSIVE_START_EXCLUSIVE_END [start_date, end_date)
 *   - start_date is included in the period
 *   - end_date is excluded (acts as the boundary cutoff)
 *   - days = end_date - start_date (in whole calendar days)
 *
 * Properties:
 *   - Same-day period (start === end) → 0 days
 *   - Reversed range (end < start) → validation error (never returns negative)
 *   - Leap years handled correctly via UTC Date arithmetic
 *   - Date-only: no clock-time artifacts (all timestamps are UTC midnight)
 *   - Deterministic: same inputs always produce the same output
 *   - No database side effects
 *
 * @param {string} startDate - Start date (YYYY-MM-DD or DD/MM/YYYY)
 * @param {string} endDate - End date (YYYY-MM-DD or DD/MM/YYYY)
 * @returns {Object} { elapsedDays, startDateIso, endDateIso }
 * @throws {Error} With statusCode 400 for missing, invalid, or reversed date ranges
 */
function calculateElapsedDays(startDate, endDate) {
    const start = parseCalendarDate(startDate, 'Start date');
    const end = parseCalendarDate(endDate, 'End date');

    if (end.utcTimestamp < start.utcTimestamp) {
        const err = new Error(`End date (${end.isoString}) cannot be earlier than start date (${start.isoString})`);
        err.statusCode = 400;
        throw err;
    }

    const diffMs = end.utcTimestamp - start.utcTimestamp;
    const elapsedDays = Math.round(diffMs / MS_PER_DAY);

    return {
        elapsedDays,
        startDateIso: start.isoString,
        endDateIso: end.isoString
    };
}

/**
 * Convenience function that returns only the integer day count.
 *
 * @param {string} startDate - Start date
 * @param {string} endDate - End date
 * @returns {number} Integer elapsed calendar days
 */
function getElapsedDays(startDate, endDate) {
    return calculateElapsedDays(startDate, endDate).elapsedDays;
}

/**
 * Checks whether a given year is a leap year.
 *
 * @param {number} year - Calendar year
 * @returns {boolean}
 */
function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

/**
 * Checks whether a period [startDate, endDate) spans a Feb 29 in any
 * leap year within the range.
 *
 * @param {string} startDate - Start date (YYYY-MM-DD or DD/MM/YYYY)
 * @param {string} endDate - End date (YYYY-MM-DD or DD/MM/YYYY)
 * @returns {boolean}
 */
function spansLeapDay(startDate, endDate) {
    const start = parseCalendarDate(startDate, 'Start date');
    const end = parseCalendarDate(endDate, 'End date');

    for (let y = start.year; y <= end.year; y++) {
        if (isLeapYear(y)) {
            const feb29 = new Date(Date.UTC(y, 1, 29)).getTime();
            if (feb29 >= start.utcTimestamp && feb29 < end.utcTimestamp) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Adds an integer number of calendar days to a date.
 * Uses UTC arithmetic to avoid clock/timezone issues.
 *
 * @param {string} dateStr - Input date (YYYY-MM-DD or DD/MM/YYYY)
 * @param {number} days - Number of days to add (integer)
 * @returns {string} ISO date string (YYYY-MM-DD)
 */
function addDays(dateStr, days) {
    const parsed = parseCalendarDate(dateStr, 'Date');
    const dt = new Date(parsed.utcTimestamp);
    dt.setUTCDate(dt.getUTCDate() + Number(days));
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Adds an integer number of months to a calendar date.
 * Clamps the day of month to the last day of target month if necessary
 * (e.g. Jan 31 + 1 month -> Feb 28/29).
 *
 * @param {string} dateStr - Input date (YYYY-MM-DD or DD/MM/YYYY)
 * @param {number} months - Number of months to add (integer)
 * @returns {string} ISO date string (YYYY-MM-DD)
 */
function addMonths(dateStr, months) {
    const parsed = parseCalendarDate(dateStr, 'Date');
    const totalMonths = (parsed.year * 12 + (parsed.month - 1)) + Number(months);
    const newYear = Math.floor(totalMonths / 12);
    const newMonth = (totalMonths % 12) + 1;

    const lastDay = new Date(Date.UTC(newYear, newMonth, 0)).getUTCDate();
    const clampedDay = Math.min(parsed.day, lastDay);

    return `${newYear}-${String(newMonth).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;
}

/**
 * Adds an integer number of years to a calendar date.
 * Clamps Feb 29 to Feb 28 in non-leap years.
 *
 * @param {string} dateStr - Input date (YYYY-MM-DD or DD/MM/YYYY)
 * @param {number} years - Number of years to add (integer)
 * @returns {string} ISO date string (YYYY-MM-DD)
 */
function addYears(dateStr, years) {
    const parsed = parseCalendarDate(dateStr, 'Date');
    const newYear = parsed.year + Number(years);
    const lastDay = new Date(Date.UTC(newYear, parsed.month, 0)).getUTCDate();
    const clampedDay = Math.min(parsed.day, lastDay);

    return `${newYear}-${String(parsed.month).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;
}

module.exports = {
    DATE_BOUNDARY_CONVENTION,
    MS_PER_DAY,
    parseCalendarDate,
    normalizeDate,
    calculateElapsedDays,
    getElapsedDays,
    isLeapYear,
    spansLeapDay,
    addDays,
    addMonths,
    addYears
};

