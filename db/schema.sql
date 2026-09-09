-- ============================================================
-- Interest Manager — Database Schema
-- All monetary values stored as INTEGER in paisa (1 INR = 100 paisa)
-- Interest rates stored as REAL (percentage, e.g. 15.0 = 15%)
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. PEOPLE
-- ============================================================
CREATE TABLE IF NOT EXISTS people (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL CHECK(length(trim(name)) > 0),
    phone           TEXT,
    address         TEXT,
    notes           TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for people
CREATE INDEX IF NOT EXISTS idx_people_name  ON people(name);
CREATE INDEX IF NOT EXISTS idx_people_phone ON people(phone);

-- Trigger: auto-update updated_at on people
CREATE TRIGGER IF NOT EXISTS trg_people_updated_at
    AFTER UPDATE ON people
    FOR EACH ROW
BEGIN
    UPDATE people SET updated_at = datetime('now') WHERE id = OLD.id;
END;

-- ============================================================
-- 2. ACCOUNTS
-- ============================================================
CREATE TABLE IF NOT EXISTS accounts (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id               INTEGER NOT NULL,
    direction               TEXT    NOT NULL CHECK(direction IN ('MONEY_GIVEN', 'MONEY_TAKEN')),
    principal               INTEGER NOT NULL CHECK(principal > 0),
    outstanding_principal   INTEGER NOT NULL CHECK(outstanding_principal >= 0),
    interest_rate           REAL    NOT NULL CHECK(interest_rate >= 0),
    interest_frequency      TEXT    NOT NULL CHECK(interest_frequency IN ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY')),
    calculation_method      TEXT    NOT NULL CHECK(calculation_method IN ('SIMPLE_INTEREST')),
    start_date              TEXT    NOT NULL,
    due_date                TEXT    NOT NULL,
    grace_period            INTEGER NOT NULL DEFAULT 0 CHECK(grace_period >= 0),
    status                  TEXT    NOT NULL DEFAULT 'ACTIVE'
                                   CHECK(status IN ('ACTIVE', 'PARTIALLY_PAID', 'OVERDUE', 'CLOSED', 'WRITTEN_OFF')),
    notes                   TEXT,
    created_at              TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT    NOT NULL DEFAULT (datetime('now')),

    -- Foreign key
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE RESTRICT ON UPDATE CASCADE,

    -- due_date must not be before start_date
    CHECK(due_date >= start_date)
);

-- Indexes for accounts
CREATE INDEX IF NOT EXISTS idx_accounts_person_id  ON accounts(person_id);
CREATE INDEX IF NOT EXISTS idx_accounts_status     ON accounts(status);
CREATE INDEX IF NOT EXISTS idx_accounts_due_date   ON accounts(due_date);
CREATE INDEX IF NOT EXISTS idx_accounts_direction  ON accounts(direction);

-- Trigger: auto-update updated_at on accounts
CREATE TRIGGER IF NOT EXISTS trg_accounts_updated_at
    AFTER UPDATE ON accounts
    FOR EACH ROW
BEGIN
    UPDATE accounts SET updated_at = datetime('now') WHERE id = OLD.id;
END;

-- ============================================================
-- 3. INTEREST RECORDS
-- ============================================================
CREATE TABLE IF NOT EXISTS interest_records (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id              INTEGER NOT NULL,
    period_start            TEXT    NOT NULL,
    period_end              TEXT    NOT NULL,
    principal_basis         INTEGER NOT NULL CHECK(principal_basis >= 0),
    interest_rate           REAL    NOT NULL CHECK(interest_rate >= 0),
    interest_amount         INTEGER NOT NULL CHECK(interest_amount >= 0),
    paid_amount             INTEGER NOT NULL DEFAULT 0 CHECK(paid_amount >= 0),
    calculation_method      TEXT    NOT NULL DEFAULT 'SIMPLE_INTEREST'
                                   CHECK(calculation_method IN ('SIMPLE_INTEREST')),
    status                  TEXT    NOT NULL DEFAULT 'PENDING'
                                   CHECK(status IN ('PENDING', 'PAID', 'PARTIALLY_PAID', 'WAIVED', 'REVERSED')),
    reversal_reason         TEXT,
    reversed_at             TEXT,
    reversal_actor_id       TEXT,
    reversal_source         TEXT,
    corrects_record_id      INTEGER,
    corrected_by_record_id  INTEGER,
    created_at              TEXT    NOT NULL DEFAULT (datetime('now')),

    -- Foreign keys
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    FOREIGN KEY (corrects_record_id) REFERENCES interest_records(id) ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY (corrected_by_record_id) REFERENCES interest_records(id) ON DELETE SET NULL ON UPDATE CASCADE,

    -- period_end must not be before period_start
    CHECK(period_end >= period_start),
    CHECK(paid_amount <= interest_amount)
);

-- Indexes for interest_records
CREATE INDEX IF NOT EXISTS idx_interest_records_account_id ON interest_records(account_id);
CREATE INDEX IF NOT EXISTS idx_interest_records_acc_period ON interest_records(account_id, period_start);
CREATE UNIQUE INDEX IF NOT EXISTS idx_interest_records_active_period ON interest_records(account_id, period_start, period_end) WHERE status != 'REVERSED';

-- ============================================================
-- 3b. INTEREST ALLOCATIONS (Step 5I)
-- Associates interest payments with specific recorded interest entries
-- ============================================================
CREATE TABLE IF NOT EXISTS interest_allocations (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id          INTEGER NOT NULL,
    interest_record_id  INTEGER NOT NULL,
    transaction_id      INTEGER NOT NULL,
    amount              INTEGER NOT NULL CHECK(amount > 0),
    allocated_at        TEXT    NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (account_id)         REFERENCES accounts(id)         ON DELETE RESTRICT ON UPDATE CASCADE,
    FOREIGN KEY (interest_record_id) REFERENCES interest_records(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    FOREIGN KEY (transaction_id)     REFERENCES transactions(id)     ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_interest_allocations_account ON interest_allocations(account_id);
CREATE INDEX IF NOT EXISTS idx_interest_allocations_record  ON interest_allocations(interest_record_id);
CREATE INDEX IF NOT EXISTS idx_interest_allocations_tx      ON interest_allocations(transaction_id);

-- ============================================================
-- 4. TRANSACTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS transactions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id        INTEGER NOT NULL,
    person_id         INTEGER NOT NULL,
    transaction_type  TEXT    NOT NULL CHECK(transaction_type IN (
                          'MONEY_RECEIVED', 'MONEY_LENT',
                          'INTEREST_RECEIVED', 'INTEREST_PAID',
                          'PRINCIPAL_RECEIVED', 'PRINCIPAL_PAID',
                          'EXPENSE', 'LOSS', 'OTHER'
                      )),
    amount            INTEGER NOT NULL CHECK(amount > 0),
    payment_method    TEXT    NOT NULL DEFAULT 'CASH'
                             CHECK(payment_method IN ('CASH', 'UPI', 'BANK_TRANSFER', 'OTHER')),
    transaction_date  TEXT    NOT NULL,
    payment_id        TEXT,
    reference         TEXT,
    notes             TEXT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),

    -- Foreign keys
    FOREIGN KEY (account_id) REFERENCES accounts(id)  ON DELETE RESTRICT ON UPDATE CASCADE,
    FOREIGN KEY (person_id)  REFERENCES people(id)     ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Indexes for transactions
CREATE INDEX IF NOT EXISTS idx_transactions_account_id       ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_person_id        ON transactions(person_id);
CREATE INDEX IF NOT EXISTS idx_transactions_payment_id       ON transactions(payment_id);
CREATE INDEX IF NOT EXISTS idx_transactions_transaction_date ON transactions(transaction_date);

-- ============================================================
-- 5. AUDIT LOGS
-- ============================================================
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

-- ============================================================
-- 6. ACCRUAL RUNS (Step 5L: Monitoring & Failure Recovery)
-- ============================================================
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

-- ============================================================
-- 7. ACCRUAL RUN DETAILS (Step 5L: Account-level results)
-- ============================================================
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

-- ============================================================
-- 8. ACCOUNT INTEREST CONFIGURATIONS (Step 6A: Historical Rate Configuration)
-- ============================================================
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

-- ============================================================
-- 9. USERS (Part 12: Authentication & RBAC)
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    username                TEXT    NOT NULL UNIQUE CHECK(length(trim(username)) >= 3),
    password_hash           TEXT    NOT NULL,
    password_salt           TEXT    NOT NULL,
    role                    TEXT    NOT NULL DEFAULT 'VIEWER'
                                   CHECK(role IN ('ADMIN', 'STAFF', 'VIEWER')),
    status                  TEXT    NOT NULL DEFAULT 'ACTIVE'
                                   CHECK(status IN ('ACTIVE', 'DISABLED')),
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

-- ============================================================
-- 10. USER SESSIONS (Part 12: Session / Token Management)
-- ============================================================
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

-- ============================================================
-- 11. NOTIFICATIONS (Part 12: In-App Notification System)
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER,
    type            TEXT    NOT NULL
                            CHECK(type IN (
                                'DUE_SOON', 'DUE_TODAY', 'OVERDUE',
                                'PAYMENT_RECEIVED', 'PAYMENT_REVERSED',
                                'BACKUP_COMPLETED', 'RESTORE_COMPLETED',
                                'SECURITY_EVENT'
                            )),
    title           TEXT    NOT NULL,
    message         TEXT    NOT NULL,
    reference_type  TEXT,
    reference_id    INTEGER,
    event_key       TEXT    UNIQUE,
    status          TEXT    NOT NULL DEFAULT 'UNREAD'
                            CHECK(status IN ('UNREAD', 'READ')),
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    read_at         TEXT,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id   ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_status    ON notifications(status);
CREATE INDEX IF NOT EXISTS idx_notifications_event_key ON notifications(event_key);
CREATE INDEX IF NOT EXISTS idx_notifications_created   ON notifications(created_at);

