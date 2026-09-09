const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, 'interest_manager.db');

let db = null;
let SQL = null;

/**
 * Initialize the sql.js engine and load (or create) the database file.
 * Returns the database instance.
 */
async function getDatabase() {
    if (db) return db;

    if (!SQL) {
        SQL = await initSqlJs();
    }

    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    // Enable foreign keys
    db.run('PRAGMA foreign_keys = ON;');

    // Ensure audit log table and indexes exist (Step 5M)
    try {
        db.run(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_type  TEXT    NOT NULL,
                entity_id    INTEGER NOT NULL,
                action       TEXT    NOT NULL,
                old_value    TEXT,
                new_value    TEXT,
                timestamp    TEXT    NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
            CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
            CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
        `);
    } catch (_) {}

    // Ensure Step 5N reversal & correction columns and CHECK constraint exist
    try {
        const stmt = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='interest_records'");
        if (stmt.step()) {
            const tableSql = stmt.getAsObject().sql || '';
            stmt.free();
            if (!tableSql.includes('REVERSED')) {
                db.run('PRAGMA foreign_keys = OFF;');
                db.run(`
                    CREATE TABLE interest_records_migration (
                        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
                        account_id              INTEGER NOT NULL,
                        period_start            TEXT    NOT NULL,
                        period_end              TEXT    NOT NULL,
                        principal_basis         INTEGER NOT NULL CHECK(principal_basis >= 0),
                        interest_rate           REAL    NOT NULL CHECK(interest_rate >= 0),
                        interest_amount         INTEGER NOT NULL CHECK(interest_amount >= 0),
                        paid_amount             INTEGER NOT NULL DEFAULT 0 CHECK(paid_amount >= 0),
                        calculation_method      TEXT    NOT NULL DEFAULT 'SIMPLE_INTEREST' CHECK(calculation_method IN ('SIMPLE_INTEREST')),
                        status                  TEXT    NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'PAID', 'PARTIALLY_PAID', 'WAIVED', 'REVERSED')),
                        reversal_reason         TEXT,
                        reversed_at             TEXT,
                        reversal_actor_id       TEXT,
                        reversal_source         TEXT,
                        corrects_record_id      INTEGER,
                        corrected_by_record_id  INTEGER,
                        created_at              TEXT    NOT NULL DEFAULT (datetime('now')),
                        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
                        FOREIGN KEY (corrects_record_id) REFERENCES interest_records(id) ON DELETE SET NULL ON UPDATE CASCADE,
                        FOREIGN KEY (corrected_by_record_id) REFERENCES interest_records(id) ON DELETE SET NULL ON UPDATE CASCADE,
                        CHECK(period_end >= period_start),
                        CHECK(paid_amount <= interest_amount)
                    );
                `);
                db.run(`
                    INSERT INTO interest_records_migration (
                        id, account_id, period_start, period_end, principal_basis, interest_rate,
                        interest_amount, paid_amount, calculation_method, status, created_at
                    )
                    SELECT id, account_id, period_start, period_end, principal_basis, interest_rate,
                           interest_amount, paid_amount, calculation_method, status, created_at
                    FROM interest_records;
                `);
                db.run('DROP TABLE interest_records;');
                db.run('ALTER TABLE interest_records_migration RENAME TO interest_records;');
                db.run('PRAGMA foreign_keys = ON;');
            }
        } else {
            stmt.free();
        }
    } catch (_) {}

    try { db.run("ALTER TABLE interest_records ADD COLUMN source TEXT NOT NULL DEFAULT 'MANUAL'"); } catch (_) {}
    try { db.run("ALTER TABLE interest_records ADD COLUMN scheduler_run_id TEXT"); } catch (_) {}
    try { db.run('ALTER TABLE accounts ADD COLUMN grace_period INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
    try { db.run('ALTER TABLE interest_records ADD COLUMN reversal_reason TEXT'); } catch (_) {}
    try { db.run('ALTER TABLE interest_records ADD COLUMN reversed_at TEXT'); } catch (_) {}
    try { db.run('ALTER TABLE interest_records ADD COLUMN reversal_actor_id TEXT'); } catch (_) {}
    try { db.run('ALTER TABLE interest_records ADD COLUMN reversal_source TEXT'); } catch (_) {}
    try { db.run('ALTER TABLE interest_records ADD COLUMN corrects_record_id INTEGER'); } catch (_) {}
    try { db.run('ALTER TABLE interest_records ADD COLUMN corrected_by_record_id INTEGER'); } catch (_) {}
    try {
        db.run('DROP INDEX IF EXISTS idx_interest_records_period');
        db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_interest_records_active_period ON interest_records(account_id, period_start, period_end) WHERE status != 'REVERSED'");
        db.run("CREATE INDEX IF NOT EXISTS idx_interest_records_acc_period ON interest_records(account_id, period_start)");
    } catch (_) {}

    // Ensure Step 5L monitoring tables exist
    db.run(`
        CREATE TABLE IF NOT EXISTS accrual_runs (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id              TEXT    NOT NULL UNIQUE,
            started_at          TEXT    NOT NULL,
            completed_at        TEXT,
            status              TEXT    NOT NULL CHECK(status IN ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED')),
            current_date        TEXT    NOT NULL,
            accounts_considered INTEGER NOT NULL DEFAULT 0,
            accounts_processed  INTEGER NOT NULL DEFAULT 0,
            accruals_created    INTEGER NOT NULL DEFAULT 0,
            already_recorded    INTEGER NOT NULL DEFAULT 0,
            zero_interest       INTEGER NOT NULL DEFAULT 0,
            skipped             INTEGER NOT NULL DEFAULT 0,
            failed              INTEGER NOT NULL DEFAULT 0,
            retries             INTEGER NOT NULL DEFAULT 0,
            error               TEXT,
            created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_accrual_runs_run_id ON accrual_runs(run_id);
        CREATE INDEX IF NOT EXISTS idx_accrual_runs_status ON accrual_runs(status);
        CREATE INDEX IF NOT EXISTS idx_accrual_runs_started ON accrual_runs(started_at);

        CREATE TABLE IF NOT EXISTS accrual_run_details (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id              TEXT    NOT NULL,
            account_id          INTEGER NOT NULL,
            period_start        TEXT,
            period_end          TEXT,
            result              TEXT    NOT NULL CHECK(result IN ('SUCCESS', 'ALREADY_RECORDED', 'SKIPPED', 'FAILED')),
            error_message       TEXT,
            attempt_count       INTEGER NOT NULL DEFAULT 1,
            is_retryable        INTEGER NOT NULL DEFAULT 0,
            interest_record_id  INTEGER,
            interest_amount     INTEGER,
            created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at          TEXT    NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (account_id)         REFERENCES accounts(id)         ON DELETE RESTRICT ON UPDATE CASCADE,
            FOREIGN KEY (interest_record_id) REFERENCES interest_records(id) ON DELETE SET NULL ON UPDATE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_accrual_run_details_run_id ON accrual_run_details(run_id);
        CREATE INDEX IF NOT EXISTS idx_accrual_run_details_account ON accrual_run_details(account_id);
        CREATE INDEX IF NOT EXISTS idx_accrual_run_details_result  ON accrual_run_details(result);

        -- Step 6A: Account Interest Configurations
        CREATE TABLE IF NOT EXISTS account_interest_configs (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id          INTEGER NOT NULL,
            calculation_method  TEXT    NOT NULL DEFAULT 'SIMPLE_INTEREST'
                                       CHECK(calculation_method IN ('SIMPLE_INTEREST', 'SIMPLE')),
            interest_rate       NUMERIC NOT NULL CHECK(interest_rate >= 0),
            effective_from      TEXT    NOT NULL,
            effective_to        TEXT,
            notes               TEXT,
            created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at          TEXT    NOT NULL DEFAULT (datetime('now')),

            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
            CHECK(effective_to IS NULL OR effective_to >= effective_from)
        );
        CREATE INDEX IF NOT EXISTS idx_account_interest_configs_account ON account_interest_configs(account_id);
        CREATE INDEX IF NOT EXISTS idx_account_interest_configs_effective ON account_interest_configs(account_id, effective_from);
    `);

    // Backfill configurations for existing accounts lacking one (Step 6A compatibility)
    try {
        db.run(`
            INSERT INTO account_interest_configs (account_id, calculation_method, interest_rate, effective_from, effective_to)
            SELECT id, calculation_method, interest_rate, start_date, NULL
            FROM accounts
            WHERE id NOT IN (SELECT DISTINCT account_id FROM account_interest_configs);
        `);
    } catch (_) {}

    // Step 12: Users, Sessions, and Notifications
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            username                TEXT    NOT NULL UNIQUE CHECK(length(trim(username)) >= 3),
            password_hash           TEXT    NOT NULL,
            password_salt           TEXT    NOT NULL,
            role                    TEXT    NOT NULL DEFAULT 'VIEWER' CHECK(role IN ('ADMIN', 'STAFF', 'VIEWER')),
            status                  TEXT    NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'DISABLED')),
            pin_hash                TEXT,
            pin_salt                TEXT,
            pin_failed_attempts     INTEGER NOT NULL DEFAULT 0,
            pin_locked_until        TEXT,
            reset_token             TEXT,
            reset_token_expires_at  TEXT,
            created_at              TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at              TEXT    NOT NULL DEFAULT (datetime('now')),
            last_login_at           TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_users_role     ON users(role);
        CREATE INDEX IF NOT EXISTS idx_users_status   ON users(status);

        CREATE TABLE IF NOT EXISTS user_sessions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            token       TEXT    NOT NULL UNIQUE,
            user_id     INTEGER NOT NULL,
            role        TEXT    NOT NULL,
            ip_address  TEXT,
            user_agent  TEXT,
            expires_at  TEXT    NOT NULL,
            revoked_at  TEXT,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_user_sessions_token   ON user_sessions(token);
        CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);

        CREATE TABLE IF NOT EXISTS notifications (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id         INTEGER,
            type            TEXT    NOT NULL,
            title           TEXT    NOT NULL,
            message         TEXT    NOT NULL,
            reference_type  TEXT,
            reference_id    INTEGER,
            event_key       TEXT    UNIQUE,
            status          TEXT    NOT NULL DEFAULT 'UNREAD' CHECK(status IN ('UNREAD', 'READ')),
            created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
            read_at         TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_user_id   ON notifications(user_id);
        CREATE INDEX IF NOT EXISTS idx_notifications_status    ON notifications(status);
        CREATE INDEX IF NOT EXISTS idx_notifications_event_key ON notifications(event_key);
        CREATE INDEX IF NOT EXISTS idx_notifications_created   ON notifications(created_at);
    `);

    seedDefaultUsers(db);

    return db;
}

/**
 * Seeds default administrative, staff, and viewer users if users table is empty.
 */
function seedDefaultUsers(db) {
    try {
        const { hashPassword } = require('../services/authService');
        const stmt = db.prepare('SELECT COUNT(*) as count FROM users');
        let count = 0;
        if (stmt.step()) {
            count = stmt.getAsObject().count;
        }
        stmt.free();

        if (count === 0) {
            const adminPass = hashPassword('AdminPassword@123');
            const staffPass = hashPassword('StaffPassword@123');
            const viewerPass = hashPassword('ViewerPassword@123');

            db.run(`
                INSERT INTO users (username, password_hash, password_salt, role, status)
                VALUES 
                    ('admin', ?, ?, 'ADMIN', 'ACTIVE'),
                    ('staff', ?, ?, 'STAFF', 'ACTIVE'),
                    ('viewer', ?, ?, 'VIEWER', 'ACTIVE');
            `, [
                adminPass.hash, adminPass.salt,
                staffPass.hash, staffPass.salt,
                viewerPass.hash, viewerPass.salt
            ]);
        }
    } catch (_) {}
}

/**
 * Save the in-memory database to disk.
 */
function saveDatabase() {
    if (db) {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(DB_PATH, buffer);
    }
}

/**
 * Close and save the database.
 */
function closeDatabase() {
    if (db) {
        saveDatabase();
        db.close();
        db = null;
    }
}

/**
 * Reset the database — delete file and clear in-memory reference.
 */
function resetDatabase() {
    if (db) {
        db.close();
        db = null;
    }
    if (fs.existsSync(DB_PATH)) {
        fs.unlinkSync(DB_PATH);
    }
}

module.exports = { getDatabase, saveDatabase, closeDatabase, resetDatabase, DB_PATH };
