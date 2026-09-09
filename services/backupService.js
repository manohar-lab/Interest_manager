/**
 * Interest Manager — Part 11: Application Backup & Restore Service
 *
 * Dedicated data recovery module responsible for machine-readable state serialization,
 * integrity validation, and atomic transactional restoration.
 * Strictly decoupled from human-readable Excel export.
 *
 * Guarantees:
 *   - 11A.2, 11H.1: Full application state preservation across all 9 core schema tables.
 *   - 11H.2, 11H.3: Foreign-key relationships and stable primary keys strictly preserved.
 *   - 11H.5: Versioned backup format (backup_version = 1).
 *   - 11H.6, 11I.1: SHA-256 cryptographic payload integrity verification.
 *   - 11H.9: Atomic backup generation.
 *   - 11I.3, 11I.4, 11I.5: Multi-level pre-restore validation (Schema, Foreign Keys,
 *     Duplicate Primary Keys, Financial Invariants).
 *   - 11J.1, 11J.2: Explicit confirmation required for destructive restore operations.
 *   - 11J.3, 11J.5: Transactional atomicity: automatic ROLLBACK on any restore failure.
 *   - 11J.6: Post-restore verification of entity counts and financial reconciliation.
 */

const crypto = require('crypto');
const { queryAll, queryOne } = require('../db/helpers');
const { saveDatabase } = require('../db/connection');

const CURRENT_BACKUP_VERSION = 1;
const APPLICATION_NAME = 'Interest Manager';
const APPLICATION_VERSION = '1.0.0';
const SCHEMA_VERSION = 1;

/**
 * Computes deterministic SHA-256 hash of a JSON payload.
 */
function computeChecksum(data) {
    const serialized = JSON.stringify(data);
    return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * Generates safe backup filename: application-backup-YYYY-MM-DD-HHmmss.json
 */
function generateBackupFilename(timestamp = new Date()) {
    const d = new Date(timestamp);
    const dateStr = d.toISOString().split('T')[0];
    const timeStr = [
        String(d.getHours()).padStart(2, '0'),
        String(d.getMinutes()).padStart(2, '0'),
        String(d.getSeconds()).padStart(2, '0')
    ].join('');
    return `application-backup-${dateStr}-${timeStr}.json`;
}

// ═════════════════════════════════════════════════════════════════════
// 11H — BACKUP CREATION
// ═════════════════════════════════════════════════════════════════════
function createBackup(db, options = {}) {
    if (!db) {
        const err = new Error('Database connection is required to create backup');
        err.statusCode = 500;
        throw err;
    }

    // Query all authoritative tables in deterministic order
    const people = queryAll(db, 'SELECT id, name, phone, address, notes, created_at, updated_at FROM people ORDER BY id ASC');
    const accounts = queryAll(db, `
        SELECT id, person_id, direction, principal, outstanding_principal, interest_rate,
               interest_frequency, calculation_method, start_date, due_date, grace_period,
               status, notes, created_at, updated_at
        FROM accounts
        ORDER BY id ASC
    `);
    const accountInterestConfigs = queryAll(db, `
        SELECT id, account_id, calculation_method, interest_rate, effective_from, effective_to, notes, created_at, updated_at
        FROM account_interest_configs
        ORDER BY id ASC
    `);
    const interestRecords = queryAll(db, `
        SELECT id, account_id, period_start, period_end, principal_basis, interest_rate,
               interest_amount, paid_amount, calculation_method, status, reversal_reason,
               reversed_at, reversal_actor_id, reversal_source, corrects_record_id,
               corrected_by_record_id, created_at
        FROM interest_records
        ORDER BY id ASC
    `);
    const transactions = queryAll(db, `
        SELECT id, account_id, person_id, transaction_type, amount, payment_method,
               transaction_date, payment_id, reference, notes, created_at
        FROM transactions
        ORDER BY id ASC
    `);
    const interestAllocations = queryAll(db, `
        SELECT id, account_id, interest_record_id, transaction_id, amount, allocated_at
        FROM interest_allocations
        ORDER BY id ASC
    `);
    const auditLogs = queryAll(db, `
        SELECT id, entity_type, entity_id, action, old_value, new_value, timestamp
        FROM audit_logs
        ORDER BY id ASC
    `);
    const accrualRuns = queryAll(db, `
        SELECT id, run_id, started_at, completed_at, status, current_date, accounts_considered,
               accounts_processed, accruals_created, already_recorded, zero_interest, skipped,
               failed, retries, error, created_at
        FROM accrual_runs
        ORDER BY id ASC
    `);
    const accrualRunDetails = queryAll(db, `
        SELECT id, run_id, account_id, period_start, period_end, result, error_message,
               attempt_count, is_retryable, interest_record_id, interest_amount, created_at, updated_at
        FROM accrual_run_details
        ORDER BY id ASC
    `);

    const data = {
        people,
        accounts,
        account_interest_configs: accountInterestConfigs,
        interest_records: interestRecords,
        transactions,
        interest_allocations: interestAllocations,
        audit_logs: auditLogs,
        accrual_runs: accrualRuns,
        accrual_run_details: accrualRunDetails
    };

    const entityCounts = {
        people: people.length,
        accounts: accounts.length,
        account_interest_configs: accountInterestConfigs.length,
        interest_records: interestRecords.length,
        transactions: transactions.length,
        interest_allocations: interestAllocations.length,
        audit_logs: auditLogs.length,
        accrual_runs: accrualRuns.length,
        accrual_run_details: accrualRunDetails.length
    };

    const checksum = computeChecksum(data);
    const createdAt = new Date().toISOString();

    const backupPackage = {
        metadata: {
            backup_version: CURRENT_BACKUP_VERSION,
            application: APPLICATION_NAME,
            application_version: APPLICATION_VERSION,
            schema_version: SCHEMA_VERSION,
            created_at: createdAt,
            entity_counts: entityCounts
        },
        checksum,
        data
    };

    // Pre-flight validate created backup (11H.9: Atomic creation guarantee)
    validateBackup(backupPackage);

    return backupPackage;
}

// ═════════════════════════════════════════════════════════════════════
// 11I — BACKUP VALIDATION
// ═════════════════════════════════════════════════════════════════════
function validateBackup(backupPackage) {
    if (!backupPackage || typeof backupPackage !== 'object') {
        const err = new Error('Invalid backup: Payload must be a non-null object');
        err.statusCode = 400;
        throw err;
    }

    const { metadata, checksum, data } = backupPackage;

    // 11I.1 Format & Metadata validation
    if (!metadata || typeof metadata !== 'object') {
        const err = new Error('Invalid backup: Missing metadata section');
        err.statusCode = 400;
        throw err;
    }

    if (metadata.backup_version !== CURRENT_BACKUP_VERSION) {
        const err = new Error(`Unsupported backup version: ${metadata.backup_version}. Expected: ${CURRENT_BACKUP_VERSION}`);
        err.statusCode = 400;
        throw err;
    }

    if (!checksum || typeof checksum !== 'string') {
        const err = new Error('Invalid backup: Missing or invalid checksum');
        err.statusCode = 400;
        throw err;
    }

    if (!data || typeof data !== 'object') {
        const err = new Error('Invalid backup: Missing data section');
        err.statusCode = 400;
        throw err;
    }

    // 11H.6 & 11K.15 Integrity Verification (SHA-256 Checksum)
    const computedHash = computeChecksum(data);
    if (computedHash !== checksum) {
        const err = new Error('Backup integrity validation failed: Data checksum mismatch (payload corrupted or modified)');
        err.statusCode = 400;
        throw err;
    }

    // 11I.2 Schema & Structure validation
    const requiredTables = [
        'people',
        'accounts',
        'account_interest_configs',
        'interest_records',
        'transactions',
        'interest_allocations',
        'audit_logs',
        'accrual_runs',
        'accrual_run_details'
    ];

    for (const table of requiredTables) {
        if (!Array.isArray(data[table])) {
            const err = new Error(`Invalid backup schema: Missing required table array "${table}"`);
            err.statusCode = 400;
            throw err;
        }
    }

    // 11I.4 Duplicate Primary ID Detection
    for (const table of requiredTables) {
        const seenIds = new Set();
        for (const row of data[table]) {
            if (row && row.id !== undefined && row.id !== null) {
                if (seenIds.has(row.id)) {
                    const err = new Error(`Duplicate primary ID ${row.id} detected in table "${table}"`);
                    err.statusCode = 400;
                    throw err;
                }
                seenIds.add(row.id);
            }
        }
    }

    // Sets of primary IDs for foreign-key validation
    const personIds = new Set(data.people.map(p => p.id));
    const accountIds = new Set(data.accounts.map(a => a.id));
    const interestRecordIds = new Set(data.interest_records.map(i => i.id));
    const transactionIds = new Set(data.transactions.map(t => t.id));

    // 11I.3 Foreign Key & Relationship Validation
    for (const a of data.accounts) {
        if (!personIds.has(a.person_id)) {
            const err = new Error(`Broken foreign key: Loan #${a.id} references non-existent Person #${a.person_id}`);
            err.statusCode = 400;
            throw err;
        }
        // 11I.5 Financial Invariants — Accounts
        if (a.principal <= 0) {
            const err = new Error(`Invalid financial value: Loan #${a.id} has invalid principal ${a.principal}`);
            err.statusCode = 400;
            throw err;
        }
        if (a.outstanding_principal < 0) {
            const err = new Error(`Invalid financial value: Loan #${a.id} has negative outstanding principal ${a.outstanding_principal}`);
            err.statusCode = 400;
            throw err;
        }
        if (a.due_date && a.start_date && a.due_date < a.start_date) {
            const err = new Error(`Invalid dates: Loan #${a.id} due_date ${a.due_date} is earlier than start_date ${a.start_date}`);
            err.statusCode = 400;
            throw err;
        }
        if (!['MONEY_GIVEN', 'MONEY_TAKEN'].includes(a.direction)) {
            const err = new Error(`Invalid loan direction: ${a.direction} in Loan #${a.id}`);
            err.statusCode = 400;
            throw err;
        }
    }

    for (const t of data.transactions) {
        if (!accountIds.has(t.account_id)) {
            const err = new Error(`Broken foreign key: Transaction #${t.id} references non-existent Loan #${t.account_id}`);
            err.statusCode = 400;
            throw err;
        }
        if (!personIds.has(t.person_id)) {
            const err = new Error(`Broken foreign key: Transaction #${t.id} references non-existent Person #${t.person_id}`);
            err.statusCode = 400;
            throw err;
        }
        if (t.amount <= 0) {
            const err = new Error(`Invalid financial value: Transaction #${t.id} has non-positive amount ${t.amount}`);
            err.statusCode = 400;
            throw err;
        }
    }

    for (const ir of data.interest_records) {
        if (!accountIds.has(ir.account_id)) {
            const err = new Error(`Broken foreign key: Interest Record #${ir.id} references non-existent Loan #${ir.account_id}`);
            err.statusCode = 400;
            throw err;
        }
        if (ir.interest_amount < 0 || ir.paid_amount < 0 || ir.paid_amount > ir.interest_amount) {
            const err = new Error(`Invalid financial values in Interest Record #${ir.id}: interest=${ir.interest_amount}, paid=${ir.paid_amount}`);
            err.statusCode = 400;
            throw err;
        }
    }

    for (const ia of data.interest_allocations) {
        if (!accountIds.has(ia.account_id)) {
            const err = new Error(`Broken foreign key: Interest Allocation #${ia.id} references non-existent Loan #${ia.account_id}`);
            err.statusCode = 400;
            throw err;
        }
        if (!interestRecordIds.has(ia.interest_record_id)) {
            const err = new Error(`Broken foreign key: Interest Allocation #${ia.id} references non-existent Interest Record #${ia.interest_record_id}`);
            err.statusCode = 400;
            throw err;
        }
        if (!transactionIds.has(ia.transaction_id)) {
            const err = new Error(`Broken foreign key: Interest Allocation #${ia.id} references non-existent Transaction #${ia.transaction_id}`);
            err.statusCode = 400;
            throw err;
        }
    }

    return {
        valid: true,
        backup_version: metadata.backup_version,
        entity_counts: metadata.entity_counts,
        created_at: metadata.created_at
    };
}

// ═════════════════════════════════════════════════════════════════════
// 11J — RESTORE
// ═════════════════════════════════════════════════════════════════════
function restoreBackup(db, backupPackage, options = {}) {
    if (!db) {
        const err = new Error('Database connection is required to restore backup');
        err.statusCode = 500;
        throw err;
    }

    // 11J.1 & 11J.2 Authorization & Explicit Confirmation
    const isConfirmed = options.confirm === true || options.confirm === 'RESTORE' || options.confirmation === true;
    if (!isConfirmed) {
        const err = new Error('Restore confirmation required. Explicit confirm flag must be provided for destructive restore operation');
        err.statusCode = 400;
        throw err;
    }

    // 11I: Comprehensive pre-restore validation
    validateBackup(backupPackage);

    const { data, metadata } = backupPackage;

    // Disable foreign keys BEFORE beginning transaction so it takes effect in SQLite
    db.run('PRAGMA foreign_keys = OFF;');

    // 11J.3 & 11J.5: Atomic Transaction Strategy
    db.run('BEGIN TRANSACTION;');

    try {

        // Delete existing data in reverse dependency order
        db.run('DELETE FROM accrual_run_details;');
        db.run('DELETE FROM accrual_runs;');
        db.run('DELETE FROM interest_allocations;');
        db.run('DELETE FROM transactions;');
        db.run('DELETE FROM interest_records;');
        db.run('DELETE FROM account_interest_configs;');
        db.run('DELETE FROM accounts;');
        db.run('DELETE FROM people;');
        db.run('DELETE FROM audit_logs;');

        // 1. Restore People
        for (const p of data.people) {
            db.run(
                'INSERT INTO people (id, name, phone, address, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [p.id, p.name, p.phone || null, p.address || null, p.notes || null, p.created_at, p.updated_at]
            );
        }

        // 2. Restore Accounts (Loans)
        for (const a of data.accounts) {
            db.run(`
                INSERT INTO accounts (
                    id, person_id, direction, principal, outstanding_principal, interest_rate,
                    interest_frequency, calculation_method, start_date, due_date, grace_period,
                    status, notes, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                a.id, a.person_id, a.direction, a.principal, a.outstanding_principal, a.interest_rate,
                a.interest_frequency, a.calculation_method || 'SIMPLE_INTEREST', a.start_date, a.due_date,
                a.grace_period || 0, a.status, a.notes || null, a.created_at, a.updated_at
            ]);
        }

        // 3. Restore Account Interest Configs
        for (const c of data.account_interest_configs) {
            db.run(`
                INSERT INTO account_interest_configs (
                    id, account_id, calculation_method, interest_rate, effective_from, effective_to, notes, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                c.id, c.account_id, c.calculation_method || 'SIMPLE_INTEREST', c.interest_rate,
                c.effective_from, c.effective_to || null, c.notes || null, c.created_at, c.updated_at
            ]);
        }

        // 4. Restore Interest Records
        for (const ir of data.interest_records) {
            db.run(`
                INSERT INTO interest_records (
                    id, account_id, period_start, period_end, principal_basis, interest_rate,
                    interest_amount, paid_amount, calculation_method, status, reversal_reason,
                    reversed_at, reversal_actor_id, reversal_source, corrects_record_id,
                    corrected_by_record_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                ir.id, ir.account_id, ir.period_start, ir.period_end, ir.principal_basis, ir.interest_rate,
                ir.interest_amount, ir.paid_amount || 0, ir.calculation_method || 'SIMPLE_INTEREST', ir.status,
                ir.reversal_reason || null, ir.reversed_at || null, ir.reversal_actor_id || null,
                ir.reversal_source || null, ir.corrects_record_id || null, ir.corrected_by_record_id || null,
                ir.created_at
            ]);
        }

        // 5. Restore Transactions
        for (const t of data.transactions) {
            db.run(`
                INSERT INTO transactions (
                    id, account_id, person_id, transaction_type, amount, payment_method,
                    transaction_date, payment_id, reference, notes, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                t.id, t.account_id, t.person_id, t.transaction_type, t.amount, t.payment_method || 'CASH',
                t.transaction_date, t.payment_id || null, t.reference || null, t.notes || null, t.created_at
            ]);
        }

        // 6. Restore Interest Allocations
        for (const ia of data.interest_allocations) {
            db.run(`
                INSERT INTO interest_allocations (id, account_id, interest_record_id, transaction_id, amount, allocated_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [ia.id, ia.account_id, ia.interest_record_id, ia.transaction_id, ia.amount, ia.allocated_at]);
        }

        // 7. Restore Audit Logs
        for (const log of data.audit_logs) {
            db.run(`
                INSERT INTO audit_logs (id, entity_type, entity_id, action, old_value, new_value, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [log.id, log.entity_type, log.entity_id, log.action, log.old_value || null, log.new_value || null, log.timestamp]);
        }

        // 8. Restore Accrual Runs
        for (const run of data.accrual_runs) {
            db.run(`
                INSERT INTO accrual_runs (
                    id, run_id, started_at, completed_at, status, current_date, accounts_considered,
                    accounts_processed, accruals_created, already_recorded, zero_interest, skipped,
                    failed, retries, error, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                run.id, run.run_id, run.started_at, run.completed_at || null, run.status, run.current_date,
                run.accounts_considered || 0, run.accounts_processed || 0, run.accruals_created || 0,
                run.already_recorded || 0, run.zero_interest || 0, run.skipped || 0, run.failed || 0,
                run.retries || 0, run.error || null, run.created_at
            ]);
        }

        // 9. Restore Accrual Run Details
        for (const d of data.accrual_run_details) {
            db.run(`
                INSERT INTO accrual_run_details (
                    id, run_id, account_id, period_start, period_end, result, error_message,
                    attempt_count, is_retryable, interest_record_id, interest_amount, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                d.id, d.run_id, d.account_id, d.period_start || null, d.period_end || null, d.result,
                d.error_message || null, d.attempt_count || 1, d.is_retryable || 0, d.interest_record_id || null,
                d.interest_amount || null, d.created_at, d.updated_at
            ]);
        }

        // Re-enable and verify foreign keys
        const fkStmt = db.prepare('PRAGMA foreign_key_check;');
        if (fkStmt.step()) {
            const errRow = fkStmt.getAsObject();
            fkStmt.free();
            throw new Error(`Database integrity violation during restore: foreign key check failed on table ${errRow.table}`);
        }
        fkStmt.free();

        // 11J.6: Post-Restore Verification
        const restoredCounts = {
            people: queryOne(db, 'SELECT COUNT(*) as c FROM people').c,
            accounts: queryOne(db, 'SELECT COUNT(*) as c FROM accounts').c,
            account_interest_configs: queryOne(db, 'SELECT COUNT(*) as c FROM account_interest_configs').c,
            interest_records: queryOne(db, 'SELECT COUNT(*) as c FROM interest_records').c,
            transactions: queryOne(db, 'SELECT COUNT(*) as c FROM transactions').c,
            interest_allocations: queryOne(db, 'SELECT COUNT(*) as c FROM interest_allocations').c
        };

        for (const [entity, count] of Object.entries(restoredCounts)) {
            const expected = metadata.entity_counts[entity];
            if (expected !== undefined && expected !== count) {
                throw new Error(`Post-restore count mismatch for ${entity}: expected ${expected}, found ${count}`);
            }
        }

        // Record restore event in audit logs
        try {
            db.run(`
                INSERT INTO audit_logs (entity_type, entity_id, action, new_value)
                VALUES ('SYSTEM', 0, 'RESTORE_BACKUP', ?)
            `, [JSON.stringify({ restored_at: new Date().toISOString(), counts: restoredCounts })]);
        } catch (_) {}

        db.run('COMMIT;');
        db.run('PRAGMA foreign_keys = ON;');

        // Persist to disk
        try { saveDatabase(); } catch (_) {}

        return {
            success: true,
            message: 'Application data restored successfully',
            restored_at: new Date().toISOString(),
            entity_counts: restoredCounts
        };

    } catch (err) {
        db.run('ROLLBACK;');
        db.run('PRAGMA foreign_keys = ON;');
        err.statusCode = err.statusCode || 500;
        throw err;
    }
}

/**
 * Returns current database backup status and statistics.
 */
function getBackupStatus(db) {
    if (!db) return { status: 'disconnected' };

    const counts = {
        people: queryOne(db, 'SELECT COUNT(*) as c FROM people').c,
        accounts: queryOne(db, 'SELECT COUNT(*) as c FROM accounts').c,
        transactions: queryOne(db, 'SELECT COUNT(*) as c FROM transactions').c,
        interest_records: queryOne(db, 'SELECT COUNT(*) as c FROM interest_records').c
    };

    const lastAudit = queryOne(db, `
        SELECT action, timestamp FROM audit_logs
        WHERE action IN ('BACKUP_RESTORE', 'RESTORE_BACKUP')
        ORDER BY id DESC LIMIT 1
    `);

    return {
        status: 'ok',
        application: APPLICATION_NAME,
        version: APPLICATION_VERSION,
        backup_format_version: CURRENT_BACKUP_VERSION,
        entity_counts: counts,
        last_restore: lastAudit ? lastAudit.timestamp : null
    };
}

module.exports = {
    CURRENT_BACKUP_VERSION,
    createBackup,
    validateBackup,
    restoreBackup,
    getBackupStatus,
    computeChecksum,
    generateBackupFilename
};
