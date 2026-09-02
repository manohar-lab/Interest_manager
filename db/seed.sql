-- ============================================================
-- Interest Manager — Seed Data
-- Monetary values in paisa (1 INR = 100 paisa)
-- ============================================================

-- Person: Ramesh
INSERT INTO people (name, phone, notes) VALUES ('Ramesh', '9876543210', 'Initial seed data person');

-- Person: Mahesh
INSERT INTO people (name, phone, notes) VALUES ('Mahesh', '9876543211', 'Initial seed data person');

-- ============================================================
-- Ramesh's Accounts (person_id = 1)
-- ============================================================

-- Account 1: ₹2,000 at 15% monthly, starting 01/08/2026
INSERT INTO accounts (
    person_id, direction, principal, outstanding_principal,
    interest_rate, interest_frequency, calculation_method,
    start_date, due_date, status
) VALUES (
    1, 'MONEY_GIVEN', 200000, 200000,
    15.0, 'MONTHLY', 'SIMPLE_INTEREST',
    '2026-08-01', '2026-09-01', 'ACTIVE'
);

-- Account 2: ₹2,000 at 15% monthly, starting 01/09/2026
INSERT INTO accounts (
    person_id, direction, principal, outstanding_principal,
    interest_rate, interest_frequency, calculation_method,
    start_date, due_date, status
) VALUES (
    1, 'MONEY_GIVEN', 200000, 200000,
    15.0, 'MONTHLY', 'SIMPLE_INTEREST',
    '2026-09-01', '2026-10-01', 'ACTIVE'
);

-- Account 3: ₹5,000 at 18% monthly, starting 10/09/2026
INSERT INTO accounts (
    person_id, direction, principal, outstanding_principal,
    interest_rate, interest_frequency, calculation_method,
    start_date, due_date, status
) VALUES (
    1, 'MONEY_GIVEN', 500000, 500000,
    18.0, 'MONTHLY', 'SIMPLE_INTEREST',
    '2026-09-10', '2026-10-10', 'ACTIVE'
);

-- ============================================================
-- Mahesh's Account (person_id = 2)
-- ============================================================

-- Account: ₹1,00,000 at 10% monthly, MONEY_TAKEN
INSERT INTO accounts (
    person_id, direction, principal, outstanding_principal,
    interest_rate, interest_frequency, calculation_method,
    start_date, due_date, status
) VALUES (
    2, 'MONEY_TAKEN', 10000000, 10000000,
    10.0, 'MONTHLY', 'SIMPLE_INTEREST',
    '2026-08-01', '2026-09-01', 'ACTIVE'
);
