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
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id           INTEGER NOT NULL,
    period_start         TEXT    NOT NULL,
    period_end           TEXT    NOT NULL,
    principal_basis      INTEGER NOT NULL CHECK(principal_basis >= 0),
    interest_rate        REAL    NOT NULL CHECK(interest_rate >= 0),
    interest_amount      INTEGER NOT NULL CHECK(interest_amount >= 0),
    paid_amount          INTEGER NOT NULL DEFAULT 0 CHECK(paid_amount >= 0),
    calculation_method   TEXT    NOT NULL DEFAULT 'SIMPLE_INTEREST'
                                CHECK(calculation_method IN ('SIMPLE_INTEREST')),
    status               TEXT    NOT NULL DEFAULT 'PENDING'
                                CHECK(status IN ('PENDING', 'PAID', 'PARTIALLY_PAID', 'WAIVED')),
    created_at           TEXT    NOT NULL DEFAULT (datetime('now')),

    -- Foreign key
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,

    -- period_end must not be before period_start
    CHECK(period_end >= period_start),
    CHECK(paid_amount <= interest_amount)
);

-- Indexes for interest_records
CREATE INDEX IF NOT EXISTS idx_interest_records_account_id ON interest_records(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_interest_records_period ON interest_records(account_id, period_start, period_end);

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
