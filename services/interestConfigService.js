/**
 * Interest Manager — Step 6A: Interest Configuration Service
 *
 * Manages loan/account interest configurations, effective date ranges,
 * rate history, and validation.
 */

const { queryAll, queryOne } = require('../db/helpers');
const { saveDatabase } = require('../db/connection');

const SUPPORTED_CONFIG_METHODS = ['SIMPLE_INTEREST', 'SIMPLE'];

function parseCalendarDate(str) {
    if (!str || typeof str !== 'string') return null;
    const trimmed = str.trim();
    let year, month, day;

    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        const parts = trimmed.split('-').map(Number);
        year = parts[0];
        month = parts[1];
        day = parts[2];
    } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(trimmed)) {
        const parts = trimmed.split('/').map(Number);
        day = parts[0];
        month = parts[1];
        year = parts[2];
    } else {
        return null;
    }

    if (month < 1 || month > 12) return null;
    const utcDate = new Date(Date.UTC(year, month - 1, day));
    if (
        utcDate.getUTCFullYear() !== year ||
        utcDate.getUTCMonth() !== month - 1 ||
        utcDate.getUTCDate() !== day
    ) {
        return null;
    }

    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeDate(d) {
    return parseCalendarDate(d);
}


/**
 * Validates interest configuration payload.
 *
 * @param {Object} data - Input payload
 * @param {boolean} isUpdate - Whether this is an update validation
 * @returns {Object} { isValid, errors, normalized }
 */
function validateInterestConfigInput(data, isUpdate = false) {
    const errors = [];

    // Account association check
    let accountId = undefined;
    if (!isUpdate || data.account_id !== undefined || data.accountId !== undefined) {
        const rawAcc = data.account_id !== undefined ? data.account_id : data.accountId;
        accountId = Number(rawAcc);
        if (rawAcc === undefined || rawAcc === null || rawAcc === '' || isNaN(accountId) || accountId <= 0) {
            errors.push('A valid account association (account_id) is required');
        }
    }

    // Rate validation
    let interestRate = undefined;
    if (data.interest_rate === undefined && data.interestRate === undefined) {
        if (!isUpdate) {
            errors.push('Interest rate is required');
        }
    } else {
        const rawRate = data.interest_rate !== undefined ? data.interest_rate : data.interestRate;
        const parsedRate = Number(rawRate);
        if (rawRate === null || rawRate === '' || isNaN(parsedRate) || parsedRate < 0) {
            errors.push('Interest rate must be a valid non-negative number (e.g. 12.00, 10.50)');
        } else {
            interestRate = parsedRate;
        }
    }

    // Method validation
    let calculationMethod = 'SIMPLE_INTEREST';
    const rawMethod = data.calculation_method || data.calculationMethod;
    if (rawMethod !== undefined && rawMethod !== null && rawMethod !== '') {
        const normMethod = String(rawMethod).trim().toUpperCase();
        if (!SUPPORTED_CONFIG_METHODS.includes(normMethod)) {
            errors.push(`Invalid interest calculation method: "${rawMethod}". Supported methods are: ${SUPPORTED_CONFIG_METHODS.join(', ')}`);
        } else {
            calculationMethod = normMethod;
        }
    }

    // Effective dates validation
    const effFromRaw = data.effective_from || data.effectiveFrom;
    const effToRaw = data.effective_to !== undefined ? (data.effective_to || data.effectiveTo) : undefined;

    let effFrom = null;
    if (!isUpdate || effFromRaw !== undefined) {
        if (!effFromRaw) {
            errors.push('effective_from date is required');
        } else {
            effFrom = normalizeDate(effFromRaw);
            if (!effFrom) {
                errors.push(`Invalid effective_from date format: "${effFromRaw}". Expected YYYY-MM-DD or DD/MM/YYYY`);
            }
        }
    }

    let effTo = null;
    if (effToRaw !== undefined && effToRaw !== null && effToRaw !== '') {
        effTo = normalizeDate(effToRaw);
        if (!effTo) {
            errors.push(`Invalid effective_to date format: "${effToRaw}". Expected YYYY-MM-DD or DD/MM/YYYY`);
        }
    }

    if (effFrom && effTo && effTo < effFrom) {
        errors.push(`effective_to (${effTo}) cannot be earlier than effective_from (${effFrom})`);
    }

    return {
        isValid: errors.length === 0,
        errors,
        normalized: {
            accountId,
            interestRate,
            calculationMethod,
            effectiveFrom: effFrom,
            effectiveTo: effTo,
            notes: data.notes ? String(data.notes).trim() : null
        }
    };
}

/**
 * Creates a new interest configuration for an account.
 * Preserves existing configurations to support historical tracking.
 *
 * @param {Object} db - SQLite database instance
 * @param {number|string} accountId - Target account ID
 * @param {Object} data - Configuration attributes
 * @returns {Object} Newly created configuration
 */
function createInterestConfig(db, accountId, data) {
    const accId = Number(accountId);
    if (!accId || isNaN(accId) || accId <= 0) {
        const err = new Error('A valid account association is required');
        err.statusCode = 400;
        throw err;
    }

    const account = queryOne(db, 'SELECT id, principal, interest_rate FROM accounts WHERE id = ?', [accId]);
    if (!account) {
        const err = new Error(`Account #${accId} not found`);
        err.statusCode = 404;
        throw err;
    }

    const validation = validateInterestConfigInput({ ...data, account_id: accId });
    if (!validation.isValid) {
        const err = new Error(validation.errors.join('. '));
        err.statusCode = 400;
        err.errors = validation.errors;
        throw err;
    }

    const { interestRate, calculationMethod, effectiveFrom, effectiveTo, notes } = validation.normalized;

    // Insert configuration record
    db.run(`
        INSERT INTO account_interest_configs (
            account_id, calculation_method, interest_rate,
            effective_from, effective_to, notes
        ) VALUES (?, ?, ?, ?, ?, ?)
    `, [accId, calculationMethod, interestRate, effectiveFrom, effectiveTo, notes]);

    const rowId = queryOne(db, 'SELECT last_insert_rowid() as id').id;
    const createdConfig = queryOne(db, 'SELECT * FROM account_interest_configs WHERE id = ?', [rowId]);

    // Audit creation
    db.run(`
        INSERT INTO audit_logs (entity_type, entity_id, action, new_value)
        VALUES ('INTEREST_CONFIG', ?, 'CREATE', ?)
    `, [rowId, JSON.stringify(createdConfig)]);

    saveDatabase();

    return createdConfig;
}

/**
 * Retrieves all interest configurations for an account ordered by effective date.
 *
 * @param {Object} db - SQLite database instance
 * @param {number|string} accountId - Account ID
 * @returns {Array} List of configurations
 */
function getAccountInterestConfigs(db, accountId) {
    const accId = Number(accountId);
    if (!accId || isNaN(accId) || accId <= 0) {
        const err = new Error('A valid account ID is required');
        err.statusCode = 400;
        throw err;
    }

    const account = queryOne(db, 'SELECT id FROM accounts WHERE id = ?', [accId]);
    if (!account) {
        const err = new Error(`Account #${accId} not found`);
        err.statusCode = 404;
        throw err;
    }

    return queryAll(db, `
        SELECT * FROM account_interest_configs
        WHERE account_id = ?
        ORDER BY effective_from ASC, id ASC
    `, [accId]);
}

/**
 * Retrieves a specific interest configuration by its primary key ID.
 *
 * @param {Object} db - SQLite database instance
 * @param {number|string} configId - Configuration ID
 * @returns {Object|null} Configuration record
 */
function getInterestConfigById(db, configId) {
    const cId = Number(configId);
    if (!cId || isNaN(cId) || cId <= 0) {
        const err = new Error('A valid configuration ID is required');
        err.statusCode = 400;
        throw err;
    }

    return queryOne(db, 'SELECT * FROM account_interest_configs WHERE id = ?', [cId]);
}

/**
 * Updates an interest configuration (e.g. setting an end date to close a period).
 *
 * @param {Object} db - SQLite database instance
 * @param {number|string} configId - Configuration ID
 * @param {Object} data - Updated fields
 * @returns {Object} Updated configuration
 */
function updateInterestConfig(db, configId, data) {
    const cId = Number(configId);
    if (!cId || isNaN(cId) || cId <= 0) {
        const err = new Error('A valid configuration ID is required');
        err.statusCode = 400;
        throw err;
    }

    const existing = queryOne(db, 'SELECT * FROM account_interest_configs WHERE id = ?', [cId]);
    if (!existing) {
        const err = new Error(`Interest configuration #${cId} not found`);
        err.statusCode = 404;
        throw err;
    }

    const validation = validateInterestConfigInput({
        account_id: existing.account_id,
        effective_from: data.effective_from || data.effectiveFrom || existing.effective_from,
        effective_to: data.effective_to !== undefined ? (data.effective_to || data.effectiveTo) : existing.effective_to,
        interest_rate: data.interest_rate !== undefined ? data.interest_rate : (data.interestRate !== undefined ? data.interestRate : existing.interest_rate),
        calculation_method: data.calculation_method || data.calculationMethod || existing.calculation_method
    }, true);

    if (!validation.isValid) {
        const err = new Error(validation.errors.join('. '));
        err.statusCode = 400;
        err.errors = validation.errors;
        throw err;
    }

    const { interestRate, calculationMethod, effectiveFrom, effectiveTo, notes } = validation.normalized;
    const finalNotes = notes !== undefined && notes !== null ? notes : existing.notes;

    db.run(`
        UPDATE account_interest_configs
        SET calculation_method = ?,
            interest_rate = ?,
            effective_from = ?,
            effective_to = ?,
            notes = ?,
            updated_at = datetime('now')
        WHERE id = ?
    `, [calculationMethod, interestRate, effectiveFrom, effectiveTo, finalNotes, cId]);

    const updated = queryOne(db, 'SELECT * FROM account_interest_configs WHERE id = ?', [cId]);

    db.run(`
        INSERT INTO audit_logs (entity_type, entity_id, action, old_value, new_value)
        VALUES ('INTEREST_CONFIG', ?, 'UPDATE', ?, ?)
    `, [cId, JSON.stringify(existing), JSON.stringify(updated)]);

    saveDatabase();

    return updated;
}

/**
 * Resolves the active interest configuration for an account as of a specified date.
 *
 * @param {Object} db - SQLite database instance
 * @param {number|string} accountId - Account ID
 * @param {string} [asOfDate] - ISO date string (YYYY-MM-DD), defaults to current date
 * @returns {Object|null} Matching configuration or null
 */
function getActiveInterestConfig(db, accountId, asOfDate = null) {
    const accId = Number(accountId);
    if (!accId || isNaN(accId) || accId <= 0) {
        const err = new Error('A valid account ID is required');
        err.statusCode = 400;
        throw err;
    }

    let dateStr = asOfDate;
    if (asOfDate && typeof asOfDate === 'object' && asOfDate.asOfDate) {
        dateStr = asOfDate.asOfDate;
    }
    const targetDate = dateStr ? normalizeDate(dateStr) : new Date().toISOString().split('T')[0];

    return queryOne(db, `
        SELECT * FROM account_interest_configs
        WHERE account_id = ?
          AND effective_from <= ?
          AND (effective_to IS NULL OR effective_to >= ?)
        ORDER BY effective_from DESC, id DESC
        LIMIT 1
    `, [accId, targetDate, targetDate]);
}

module.exports = {
    SUPPORTED_CONFIG_METHODS,
    validateInterestConfigInput,
    validateInterestConfig: validateInterestConfigInput,
    createInterestConfig,
    getAccountInterestConfigs,
    getInterestConfigById,
    updateInterestConfig,
    getActiveInterestConfig,
    parseCalendarDate,
    normalizeDate
};
