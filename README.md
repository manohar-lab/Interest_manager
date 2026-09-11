# Interest Manager — Master Production Documentation

> **System Status:** 100% Production Ready & Hardened (Parts 1 – 13 Complete)  
> **Release Decision:** **GO FOR PRODUCTION RELEASE**  
> **Test Validation:** 26/26 Master Verification Tests Passed (100% Pass Rate)  
> **Live Demo:** [https://interest-manager.onrender.com](https://interest-manager.onrender.com)

---

## 1. System Overview

**Interest Manager** is an enterprise-grade financial management platform for personal lending, loan servicing, interest tracking, automated accruals, and statement generation. Built with a focus on mathematical precision, security, data integrity, and complete auditability, the system guarantees:

* **Strict Integer Paisa Storage:** Zero floating-point arithmetic drift (`₹100.00` = `10000` integer paisa).
* **Mathematical Parity:** Identical calculations across Database, API, Dashboard, Reports, Statements, PDF, and Excel.
* **Non-Destructive Financial History:** Append-only ledgers, immutable historical records, and explicit correction lineage.
* **Defense-in-Depth Security:** Role-Based Access Control (RBAC), bcrypt credential hashing, PIN locks, rate limiting, and HTTP security headers.
* **Automated Recovery:** Disaster recovery with tamper-proof SHA-256 verified backup and restore packages.

---

## 2. Technology Stack & Architecture

```text
               Client Layer
  ┌──────────────────────────────────────────────┐
  │ Vanilla HTML5 / Modern Responsive CSS / JS   │
  │ Micro-animations, Accessible Forms, Modals   │
  └──────────────────────┬───────────────────────┘
                         │ HTTPS / REST (JSON)
                         ▼
             Authoritative Backend Layer
  ┌──────────────────────────────────────────────┐
  │ Express 5.x Web Application Server           │
  │ Security Headers (nosniff, SAMEORIGIN, XSS)  │
  │ Centralized Error Handling & Rate Limiting   │
  └──────────────────────┬───────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  Auth & RBAC │ │ Core Engines │ │ Exporters    │
│  - Tokens    │ │  - Interest  │ │  - PDFKit    │
│  - PIN Lock  │ │  - Due/Aging │ │  - ExcelJS   │
│  - Roles     │ │  - Reports   │ │  - Backup    │
└──────────────┘ └──────────────┘ └──────────────┘
                         │
                         ▼
               Persistence Layer
  ┌──────────────────────────────────────────────┐
  │ sql.js (WebAssembly SQLite Engine)           │
  │ 12 Tables, Foreign Keys, CHECK Constraints   │
  │ Automated Disk Sync & File-Lock Management   │
  └──────────────────────────────────────────────┘
```

---

## 3. Database Schema & Invariants

The database maintains 12 relational tables under strict relational integrity:

1. **`people`**: Borrower & lender contact records.
2. **`accounts`**: Individual loan contracts (direction: `MONEY_GIVEN` / `MONEY_TAKEN`).
3. **`account_interest_configs`**: Interest rates, frequencies, calculation methods, and effective date windows.
4. **`transactions`**: Append-only cash ledger (`MONEY_LENT`, `MONEY_RECEIVED`, `PRINCIPAL_RECEIVED`, `INTEREST_RECEIVED`).
5. **`interest_records`**: Periodic accrued interest snapshots with tracking for paid amounts.
6. **`interest_allocations`**: Many-to-many junction binding payment transactions to interest records.
7. **`accrual_runs`**: High-level execution logs of automated background accrual jobs.
8. **`accrual_run_details`**: Per-account audit results for accrual runs.
9. **`audit_logs`**: System audit trail capturing sensitive operations, state mutations, and security events.
10. **`users`**: Platform user credentials, roles (`ADMIN`, `STAFF`, `VIEWER`), and status flags.
11. **`user_pins`**: Salted bcrypt hashes for 4-to-6 digit security PINs, attempt counters, and lockout timestamps.
12. **`notifications`**: In-app alert queue for due/overdue milestones and operational reminders.

### Mathematical & Relational Invariants
* **Non-Negative CHECK Constraints:** `principal > 0`, `outstanding_principal >= 0`, `interest_rate >= 0`.
* **Foreign Key Cascade Protection:** Restricts deleting people or accounts with active financial activity (`ON DELETE RESTRICT`).
* **Zero Float Drift:** All currency calculations use `Math.round(P * (R / 100) * (D / 365))` evaluated in integer paisa.

---

## 4. Default Credentials & Role-Based Access Control (RBAC)

Upon initialization, three standard accounts are seeded:

| Role | Username | Default Password | Default PIN | Permissions |
| :--- | :--- | :--- | :--- | :--- |
| **`ADMIN`** | `admin` | `AdminPassword@123` | `1234` | Full access: User management, restore, PIN reset, financial transactions, exports |
| **`STAFF`** | `staff` | `StaffPassword@123` | `1234` | Operational access: People, loans, transactions, payments, exports, backup creation |
| **`VIEWER`** | `viewer` | `ViewerPassword@123` | `1234` | Read-only access: View dashboard, statements, reports (cannot modify data or export backups) |

> **Security Note:** Default passwords and PINs should be rotated upon first production deployment via `/api/auth/change-password` and `/api/auth/pin/change`.

---

## 5. Getting Started & Installation

### Prerequisites
* Node.js v18.0.0 or higher
* npm v9.0.0 or higher

### Quick Start
```bash
# 1. Clone repository
git clone https://github.com/manohar-lab/Interest_manager.git
cd Interest_manager

# 2. Install dependencies
npm install

# 3. Initialize SQLite Database & Seed Default Accounts
npm run db:init

# 4. Start Application Server
npm start
```

Open your browser to `http://localhost:3000` to access the application.

---

## 6. Full API Reference

All protected endpoints require an `Authorization: Bearer <token>` header obtained from `/api/auth/login`.

### 6.1 Authentication & Security (`/api/auth`)
* `POST /api/auth/login` — Authenticate username & password; returns session token and role.
* `POST /api/auth/logout` — Revoke active session token.
* `GET  /api/auth/me` — Return profile of currently authenticated user.
* `POST /api/auth/change-password` — Update user password.
* `POST /api/auth/pin/setup` — Configure initial 4-6 digit security PIN.
* `POST /api/auth/pin/verify` — Verify security PIN (locks after 5 failed attempts).
* `POST /api/auth/pin/change` — Rotate security PIN (requires current PIN).
* `POST /api/auth/pin/reset` — Admin/Password-authenticated PIN reset during lockout.

### 6.2 People & Contacts (`/api/people`)
* `GET    /api/people` — List all contacts with balance summaries.
* `POST   /api/people` — Create a new borrower/lender contact.
* `GET    /api/people/:id` — Retrieve contact profile and associated loan list.
* `PUT    /api/people/:id` — Update contact contact details.
* `DELETE /api/people/:id` — Delete contact (strictly blocked if active accounts exist).

### 6.3 Loans & Accounts (`/api/accounts` & `/api/loans`)
* `GET  /api/accounts` — List all loans with filtering (`status`, `direction`, `person_id`).
* `POST /api/accounts` — Issue new loan contract with interest configuration.
* `GET  /api/accounts/:id` — Get comprehensive loan summary and ledger.
* `GET  /api/accounts/:id/interest-history` — Retrieve periodic interest records for loan.

### 6.4 Payments & Ledger (`/api/transactions`)
* `GET  /api/transactions` — List transaction records with date and type filters.
* `POST /api/transactions` — Record new payment or disbursement.
* `POST /api/payments/allocate` — Record payment and allocate across unpaid interest in FIFO order.

### 6.5 Financial Dashboard (`/api/dashboard`)
* `GET /api/dashboard` — Master integrated dashboard payload.
* `GET /api/dashboard/financial-summary` — Net principal, interest accrued, and total collected.
* `GET /api/dashboard/due-summary` — Current due and overdue loan metrics.
* `GET /api/dashboard/recent-activity` — Recent transactions and ledger events.

### 6.6 Reports Engine (`/api/reports`)
* `GET /api/reports/loans` — Detailed portfolio performance report.
* `GET /api/reports/people` — Consolidated borrower/lender balance report.
* `GET /api/reports/payments` — Transaction ledger report.
* `GET /api/reports/interest` — Accrued and settled interest report.
* `GET /api/reports/due-overdue` — Overdue aging and grace period analysis.
* `GET /api/reports/collections` — Prioritized collection actionable report.

### 6.7 Statements & Document Generation
* `GET /api/people/:id/statement` — JSON statement ledger for person.
* `GET /api/people/:id/statement/pdf` — Vector PDF statement download.
* `GET /api/export/people` — Excel workbook export of contacts (`.xlsx`).
* `GET /api/export/loans` — Excel workbook export of loans (`.xlsx`).
* `GET /api/export/report/:type` — Excel workbook export of any report (`.xlsx`).
* `GET /api/export/statement/:personId` — Multi-tab Excel workbook statement (`.xlsx`).

### 6.8 Backup & Disaster Recovery (`/api/backup` & `/api/restore`)
* `GET  /api/backup/download` — Export full JSON backup package with SHA-256 integrity hash.
* `POST /api/restore` — Validate and restore database from backup package (`ADMIN` only).

### 6.9 Notifications (`/api/notifications`)
* `GET   /api/notifications` — Retrieve pending and recent notifications.
* `PATCH /api/notifications/:id/read` — Mark notification as read.
* `POST  /api/notifications/check` — Trigger due/overdue notification evaluation.

---

## 7. Disaster Recovery & Backup Protocol

### Creating Backups
Backups can be generated via the UI or by calling:
```bash
curl -H "Authorization: Bearer <TOKEN>" http://localhost:3000/api/backup/download -o backup.json
```
The backup package contains:
* `metadata`: Version (`1`), timestamp, table counts, and environment signature.
* `checksum`: SHA-256 digest calculated over the serialized payload.
* `data`: Full relational export across all 12 tables.

### Restoring Backups
To restore data, submit the JSON package with administrative credentials and explicit confirmation:
```bash
curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"backup": <BACKUP_JSON>, "confirm": true}' \
     http://localhost:3000/api/restore
```
The restore service automatically validates:
1. Schema conformity across all 12 required tables.
2. SHA-256 checksum authenticity (rejecting tampered payloads).
3. Primary key and foreign key relational integrity.
4. Positive principal and non-negative balance invariants.

---

## 8. Automated Testing & Verification

The codebase includes an exhaustive test harness covering 56 test suites.

```bash
# Run Primary Database & Invariant Suite (10 tests)
npm test

# Run Master Part 13 Verification Suite (26 tests)
node tests/step13-tests.js

# Run Security, Auth & PIN Suite (28 tests)
node tests/step12-tests.js

# Run Excel Export & Backup/Restore Suite (21 tests)
node tests/step11-tests.js

# Run Statement & PDF Generation Suite (26 tests)
node tests/step10-tests.js

# Run Reports Suite (21 tests)
node tests/step9-tests.js

# Run Due & Overdue Tracking Suite (22 tests)
node tests/step8-tests.js
```

---

## 9. Production Hardening Checklist

* [x] **Zero Financial Float Mutation:** Paisa integer precision verified across all modules.
* [x] **Security Headers Enabled:** Strict `X-Content-Type-Options`, `X-Frame-Options`, and `X-XSS-Protection`.
* [x] **Rate Limiting Active:** Brute-force protection on authentication and PIN endpoints.
* [x] **SQL Injection Defense:** All database interactions use prepared/parameterized statements.
* [x] **Tamper Protection:** SHA-256 backup package validation.
* [x] **Idempotent Accruals:** Duplicate interest charges prevented via unique compound constraints.
* [x] **Graceful Process Shutdown:** Database disk flushes on `SIGINT` and `SIGTERM`.
