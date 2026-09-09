# Interest Manager — Technical Documentation & Developer Handoff

> **Module Status:** Completed & Production Hardened (Steps 5A – 5R)  
> **Release Readiness:** RELEASE READY (Step 5Q release gate passed with 0 failures)

---

## 1. Module Overview

### 1.1 Purpose
The Interest Module provides end-to-end management of simple interest for personal lending and borrowing accounts. It automates periodic interest calculation, non-persistent previews, manual recording, batch accrual scheduling, FIFO payment allocation, audit trail capture, and immutable reversal/correction workflows.

### 1.2 Problem Solved
Manual interest tracking in lending spreadsheets is prone to:
* Rounding errors and financial leakage from floating-point arithmetic.
* Erroneous principal mutations during interest payments.
* Duplicate interest charges during batch or retry runs.
* Inability to audit historical rates or reconstruct post-reversal lineage.
* Hard deletes that destroy regulatory and financial audit trails.

This module enforces strict mathematical baselines (integer-paisa precision), transactional boundaries, partial uniqueness constraints, and append-only audit logging.

### 1.3 Implementation Scope

| Capability | Status | Notes |
| :--- | :--- | :--- |
| Simple Interest Calculation ($I = P \times R \times T$) | **Implemented** | Actual/365 day-count convention, integer-paisa rounding |
| Principal Timeline Segmentation | **Implemented** | Recalculates interest across principal step-changes |
| Non-Persistent Preview | **Implemented** | Real-time calculation without database side effects |
| Manual Interest Recording | **Implemented** | Creates `PENDING` records with source `MANUAL` |
| Derived Outstanding Balance | **Implemented** | Real-time aggregate (`Recorded - Paid`, excluding `REVERSED`) |
| FIFO Payment Allocation | **Implemented** | Allocates payment to oldest unpaid interest; leaves principal untouched |
| Automated Accrual Scheduler | **Implemented** | Singleton periodic runner with batch failure isolation |
| Scheduler Monitoring & Runs API | **Implemented** | Per-run summaries, account-level detail tracking, and controlled manual retries |
| Append-Only Audit Trail | **Implemented** | JSON-serialized event snapshots (`INTEREST_RECORDED`, `INTEREST_REVERSED`, `AUTO_ACCRUE`) |
| Unpaid Reversal Mechanics | **Implemented** | Reverses unpaid records; strictly rejects reversing records with payments |
| Correction Lineage Chains | **Implemented** | Bidirectional parent-child pointer tracing (`Original → Reversal → Corrected`) |
| Historical Immutability (HTTP 405) | **Implemented** | `PUT`, `PATCH`, `DELETE` disabled on all financial and audit routes |
| Compound Interest / 30/360 Basis | **Not Implemented** | Out of scope for current simple lending model |
| Multi-Currency Support | **Not Implemented** | Single currency (INR ₹, paisa integer storage) |
| Multi-Tenant User Authentication / RBAC | **Optional / Future** | Currently single-tenant local personal lending application |

---

## 2. Step History (Steps 5A – 5R)

1. **Step 5A — Baseline Interest Setup:** Defined simple interest requirements and verified baseline calculation equations.
2. **Step 5B — Principal Timeline Segmentation:** Implemented `buildPrincipalTimeline()` to partition interest periods when principal modifications occur.
3. **Step 5C — Non-Persistent Preview Engine:** Built `/api/interest/calculate` and `/api/interest/calculate-by-dates` with zero database writes.
4. **Step 5D — Manual Interest Recording:** Implemented persistent recording with `status = 'PENDING'` and `source = 'MANUAL'`.
5. **Step 5E — Payment Allocation & Principal Invariant:** Integrated payment allocation via `/api/payments/allocate` ensuring interest payments never alter principal balances.
6. **Step 5F — Authoritative Mathematical Precision:** Standardized calculations to integer paisa using `Math.round(P * (R / 100) * (D / 365))` with half-up rounding.
7. **Step 5G — Validation & Boundary Hardening:** Implemented validation for negative amounts, zero amounts, inverted dates, and calendar boundaries (leap years).
8. **Step 5H — Performance Baselines & Batch Processing:** Profiled in-memory operations and established batch transaction patterns.
9. **Step 5I — Interest Allocations Schema:** Created `interest_allocations` table to link payment transactions to specific interest records.
10. **Step 5J — Account & Period Isolation:** Verified that transactions and calculations on one account or period cannot leak into another.
11. **Step 5K — Automated Accrual Scheduler:** Built `services/schedulerService.js` with singleton registration and automatic daily background execution.
12. **Step 5L — Monitoring & Failure Recovery:** Added `accrual_runs` and `accrual_run_details` tables, run inspection endpoints, failure logging, and controlled manual retries.
13. **Step 5M — Audit & Financial Traceability:** Added `audit_logs` table and endpoints to inspect historical calculation snapshots.
14. **Step 5N — Reversal Mechanics & Correction Chains:** Added `reverseInterest()` guardrails and `getInterestCorrectionChain()` lineage tracking.
15. **Step 5O — End-to-End Lifecycle Integration:** Verified full lifecycle flows across recording, accrual, payment, reversal, correction, and isolation.
16. **Step 5P — Production Hardening & Immutability:** Enforced HTTP 405 on mutation routes, SQL injection protections, and credential error sanitization.
17. **Step 5Q — Final Release Gate:** Verified all 26 required release criteria and 30 regression suites; achieved 100% pass rate.
18. **Step 5R — Final Cleanup & Git Checkpoint:** Verified clean diff, removed debug code, audited TODOs, and confirmed mathematical baselines.

---

## 3. Architecture

```text
User Interface (Vanilla HTML5 / Modern CSS / Vanilla JS)
        │
        ▼
Express HTTP API Layer (server.js, routes/api.js)
  ├─ Middleware: JSON Body Parser, URL Encoded, Static Asset Server
  ├─ Security Guardrails: HTTP 405 Handlers for Immutable Routes
  └─ Route Handlers: /api/interest/*, /api/accounts/*, /api/scheduler/*
        │
        ▼
Service / Business Logic Layer
  ├─ interestService.js: Calculation, Timeline, Balances, Reversals, Lineage
  └─ schedulerService.js: Periodic Runner, Monitoring, Failure Recovery, Retries
        │
        ▼
Data Access & Persistence (db/connection.js, db/schema.sql)
  ├─ sql.js (WebAssembly SQLite engine in Node.js)
  ├─ Periodic disk flushes (every 30s + on state-changing operations)
  └─ Constraints: Foreign keys, CHECK constraints, Partial UNIQUE indexes
```

---

## 4. File Map

```text
Interest_manager/
├── server.js                        # App entry point, middleware, scheduler startup & shutdown
├── package.json                     # Project manifest and dependencies (express, sql.js)
├── .gitignore                       # Git ignore rules (node_modules, db binaries, logs)
├── README.md                        # Primary developer documentation & system architecture
│
├── db/
│   ├── connection.js                # Database connection lifecycle, auto-save, and runtime migrations
│   ├── schema.sql                   # Authoritative DDL schema (tables, indexes, constraints)
│   ├── seed.sql                     # Seed data for initial development and testing
│   └── init.js                      # Database reset and initialization script (`npm run db:init`)
│
├── routes/
│   └── api.js                       # Express REST router for all accounts, interest, payments & audit
│
├── services/
│   ├── interestService.js           # Core interest formulas, allocations, reversals, and audit queries
│   └── schedulerService.js          # Accrual scheduler engine, run telemetry, and retry handling
│
├── public/                          # Client-side web application
│   ├── index.html                   # Single-page interface markup
│   ├── css/style.css                # Visual styles and responsive design
│   └── js/app.js                    # Client-side API interactions and rendering
│
└── tests/                           # Comprehensive test suites
    ├── db-tests.js                  # Database constraints & seed verification
    ├── step2-tests.js to step4g     # Core entity and payment regression tests
    ├── step5a-tests.js to step5p    # Interest module milestone tests
    └── step5q-tests.js              # Final release gate verification suite
```

---

## 5. Database Model

### 5.1 `accounts`
Stores primary lending/borrowing accounts.
* `id` (`INTEGER PRIMARY KEY AUTOINCREMENT`)
* `person_id` (`INTEGER NOT NULL`, FK $\to$ `people.id`)
* `direction` (`TEXT NOT NULL`, `MONEY_GIVEN` or `MONEY_TAKEN`)
* `principal` (`INTEGER NOT NULL`, original principal in paisa, $\ge 0$)
* `outstanding_principal` (`INTEGER NOT NULL`, current unpaid principal in paisa, $\ge 0$)
* `interest_rate` (`REAL NOT NULL`, annual percentage rate, $\ge 0$)
* `interest_frequency` (`TEXT NOT NULL`, e.g., `'MONTHLY'`)
* `calculation_method` (`TEXT NOT NULL`, `'SIMPLE_INTEREST'`)
* `start_date` (`TEXT NOT NULL`, `YYYY-MM-DD`)
* `due_date` (`TEXT NOT NULL`, `YYYY-MM-DD`)
* `status` (`TEXT NOT NULL`, `'ACTIVE'`, `'SETTLED'`, `'CLOSED'`)

### 5.2 `interest_records`
Stores calculated and recorded periodic interest charges.
* `id` (`INTEGER PRIMARY KEY AUTOINCREMENT`)
* `account_id` (`INTEGER NOT NULL`, FK $\to$ `accounts.id` ON DELETE RESTRICT)
* `period_start` (`TEXT NOT NULL`, `YYYY-MM-DD`)
* `period_end` (`TEXT NOT NULL`, `YYYY-MM-DD`)
* `principal_basis` (`INTEGER NOT NULL`, principal in paisa used for calculation)
* `interest_rate` (`REAL NOT NULL`, annual percentage rate applied)
* `interest_amount` (`INTEGER NOT NULL`, calculated interest in paisa)
* `paid_amount` (`INTEGER NOT NULL DEFAULT 0`, amount paid towards this record in paisa)
* `calculation_method` (`TEXT NOT NULL DEFAULT 'SIMPLE_INTEREST'`)
* `status` (`TEXT NOT NULL DEFAULT 'PENDING'`, `CHECK(status IN ('PENDING', 'PAID', 'PARTIALLY_PAID', 'WAIVED', 'REVERSED'))`)
* `source` (`TEXT NOT NULL DEFAULT 'MANUAL'`, `'MANUAL'` or `'AUTOMATIC'`)
* `scheduler_run_id` (`TEXT`, run ID if created by background scheduler)
* `reversal_reason` (`TEXT`, mandatory explanation when reversed)
* `reversed_at` (`TEXT`, ISO timestamp of reversal)
* `reversal_actor_id` (`TEXT`, identifier of user or system triggering reversal)
* `reversal_source` (`TEXT`, origin of reversal request)
* `corrects_record_id` (`INTEGER`, FK $\to$ `interest_records.id` ON DELETE SET NULL)
* `corrected_by_record_id` (`INTEGER`, FK $\to$ `interest_records.id` ON DELETE SET NULL)
* `created_at` (`TEXT NOT NULL DEFAULT (datetime('now'))`)
* **Constraints:**
  - `CHECK(period_end >= period_start)`
  - `CHECK(paid_amount <= interest_amount)`
  - **Partial Unique Index:** `CREATE UNIQUE INDEX idx_interest_records_active_period ON interest_records(account_id, period_start, period_end) WHERE status != 'REVERSED';`

### 5.3 `interest_allocations`
Links payment transactions directly to interest records.
* `id` (`INTEGER PRIMARY KEY AUTOINCREMENT`)
* `transaction_id` (`INTEGER NOT NULL`, FK $\to$ `transactions.id`)
* `interest_record_id` (`INTEGER NOT NULL`, FK $\to$ `interest_records.id`)
* `allocated_amount` (`INTEGER NOT NULL CHECK(allocated_amount > 0)`, in paisa)
* `created_at` (`TEXT NOT NULL DEFAULT (datetime('now'))`)

### 5.4 `audit_logs`
Immutable audit log of all financial interest events.
* `id` (`INTEGER PRIMARY KEY AUTOINCREMENT`)
* `entity_type` (`TEXT NOT NULL`, e.g., `'INTEREST_RECORD'`)
* `entity_id` (`INTEGER NOT NULL`)
* `action` (`TEXT NOT NULL`, e.g., `'INTEREST_RECORDED'`, `'INTEREST_REVERSED'`, `'AUTO_ACCRUE'`)
* `old_value` (`TEXT`, JSON-serialized previous state)
* `new_value` (`TEXT`, JSON-serialized new state with full calculation metadata)
* `timestamp` (`TEXT NOT NULL DEFAULT (datetime('now'))`)

### 5.5 `accrual_runs`
Tracks batch execution history of the automatic accrual scheduler.
* `id` (`INTEGER PRIMARY KEY AUTOINCREMENT`)
* `run_id` (`TEXT NOT NULL UNIQUE`, format `sched_YYYYMMDD_...`)
* `started_at` (`TEXT NOT NULL`)
* `completed_at` (`TEXT`)
* `status` (`TEXT NOT NULL CHECK(status IN ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'))`)
* `current_date` (`TEXT NOT NULL`)
* Metrics: `accounts_considered`, `accounts_processed`, `accruals_created`, `already_recorded`, `zero_interest`, `skipped`, `failed`, `retries`
* `error` (`TEXT`, high-level run error if aborted)

### 5.6 `accrual_run_details`
Account-level execution detail for each scheduler run.
* `id` (`INTEGER PRIMARY KEY AUTOINCREMENT`)
* `run_id` (`TEXT NOT NULL`)
* `account_id` (`INTEGER NOT NULL`, FK $\to$ `accounts.id`)
* `period_start` (`TEXT`), `period_end` (`TEXT`)
* `result` (`TEXT NOT NULL CHECK(result IN ('SUCCESS', 'ALREADY_RECORDED', 'SKIPPED', 'FAILED'))`)
* `error_message` (`TEXT`)
* `attempt_count` (`INTEGER NOT NULL DEFAULT 1`)
* `is_retryable` (`INTEGER NOT NULL DEFAULT 0`)
* `interest_record_id` (`INTEGER`, FK $\to$ `interest_records.id`)
* `interest_amount` (`INTEGER`, in paisa)

---

## 6. Interest Calculation & Baselines

### 6.1 Formula
The system uses the **Simple Interest** formula under the **Actual/365** day-count convention:

$$\text{Interest (Paisa)} = \text{round}\left( P \times \frac{R}{100} \times \frac{D}{365} \right)$$

Where:
* $P$ = Principal basis in integer paisa (e.g., ₹10,000 = `1000000`)
* $R$ = Annual interest rate percentage (e.g., `12.0`)
* $D$ = Elapsed days ($\text{end\_date} - \text{start\_date}$)
* $\text{round}$ = Half-up integer rounding via `Math.round()`

Rupees are derived strictly by dividing paisa by 100: $\text{Rupees} = \frac{\text{Paisa}}{100}$.

### 6.2 Timeline Segmentation
When principal repayments occur mid-period:
1. The overall period $[T_{\text{start}}, T_{\text{end}}]$ is segmented into sub-periods $[t_0, t_1), [t_1, t_2), \dots, [t_{n-1}, t_n]$ bounded by transaction dates.
2. For each segment, the effective principal $P_i$ and elapsed days $D_i = t_{i+1} - t_i$ are determined.
3. Segment interest is computed: $I_i = \text{round}\left(P_i \times \frac{R}{100} \times \frac{D_i}{365}\right)$.
4. Total interest is the exact integer sum: $I_{\text{total}} = \sum I_i$.

### 6.3 Authoritative Test Baselines

* **Baseline 1:** ₹10,000 @ 12% for 30 days $\to$ **₹98.63** (9,863 paisa)
* **Baseline 2:** ₹20,000 @ 12% for 30 days $\to$ **₹197.26** (19,726 paisa)
* **Baseline 3:** ₹5,000 @ 12% for 30 days $\to$ **₹49.32** (4,932 paisa)
* **Segmented Baseline:** ₹10,000 for 14d + ₹8,000 for 14d @ 12% $\to$ ₹46.03 + ₹36.82 = **₹82.85** (8,285 paisa)
* **Corrected Baseline:** ₹10,000 @ 10% for 30 days $\to$ **₹82.19** (8,219 paisa)

---

## 7. Core Lifecycle Workflows

### 7.1 Preview Workflow
* **Endpoint:** `POST /api/interest/calculate` or `POST /api/interest/calculate-by-dates`
* **Behavior:** Validates inputs, executes calculation in memory, and returns interest in rupees and paisa.
* **Side Effects:** Strictly zero database rows created (`record_count` remains unchanged).

### 7.2 Manual Recording Workflow
* **Endpoint:** `POST /api/accounts/:id/interest-records` or `POST /api/interest/record`
* **Behavior:** Validates period and amount $\to$ inserts row into `interest_records` with `status = 'PENDING'` and `source = 'MANUAL'` $\to$ inserts JSON calculation snapshot into `audit_logs` with action `'INTEREST_RECORDED'`.
* **Constraint:** If an active record already exists for the same period, returns HTTP 400.

### 7.3 Payment Allocation Workflow
* **Endpoint:** `POST /api/payments/allocate`
* **Behavior:**
  - `total_amount` is partitioned into `principal_amount` and `interest_amount`.
  - `interest_amount` is allocated FIFO to the oldest active `PENDING` or `PARTIALLY_PAID` records.
  - Record `paid_amount` increments; status transitions to `PARTIALLY_PAID` or `PAID`.
  - An entry is created in `interest_allocations`.
  - **Principal Invariant:** Account `outstanding_principal` is modified **only** by `principal_amount`, never by interest allocations.

### 7.4 Outstanding Balance Derivation
* **Formula:**
  $$\text{Total Outstanding} = \sum_{\substack{r \in \text{Records} \\ r.\text{status} \neq \text{'REVERSED'}}} (r.\text{interest\_amount} - r.\text{paid\_amount})$$
* Reversed records are excluded from active outstanding balances.

### 7.5 Reversal Workflow
* **Endpoint:** `POST /api/interest-records/:id/reverse`
* **Eligibility Rules:**
  1. Record must exist (HTTP 404 if not found).
  2. Record must not already be reversed (HTTP 400 on double reversal).
  3. Record must have `paid_amount == 0`. If any payment has been allocated, reversal is **strictly rejected** (HTTP 400).
* **Execution:**
  - Updates record `status = 'REVERSED'`.
  - Records `reversal_reason`, `reversed_at`, `reversal_actor_id`, and `reversal_source`.
  - Writes audit entry `'INTEREST_REVERSED'`.
  - Original record is preserved in the database (never deleted).

### 7.6 Correction Lineage Chain Workflow
* **Process:**
  1. Original record (`#A`, e.g. ₹98.63) is reversed using the reversal endpoint.
  2. A new record (`#B`, e.g. ₹82.19) is created with `corrects_record_id = A`.
  3. Record `#A` is automatically linked to `#B` via `corrected_by_record_id = B`.
* **Inspection:** `GET /api/interest-records/:id/correction-history` traverses parent and child links to return the complete provenance:
  $$\text{Original (\#A, REVERSED)} \longrightarrow \text{Corrected (\#B, PENDING)}$$

---

## 8. Scheduler & Automatic Accrual

### 8.1 Background Lifecycle
* **Engine:** `services/schedulerService.js`
* **Registration:** Initialized in `server.js` via `registerScheduler(db)`.
* **Execution Interval:** Initial run 10 seconds after server startup, recurring every 24 hours (`86,400,000 ms`).
* **Singleton Guard:** Multiple calls to `registerScheduler()` are ignored.

### 8.2 Execution & Idempotency Logic
1. Generates unique `run_id` (`sched_YYYYMMDD_HHMMSS_...`).
2. Iterates over all active accounts.
3. Determines accrued period from `start_date` and `due_date`.
4. Checks for existing active records in `interest_records`:
   - If active record exists $\to$ logs `ALREADY_RECORDED`, increments `alreadyRecorded`, skips.
   - If no record exists $\to$ computes interest, persists with `source = 'AUTOMATIC'`, writes audit log `'AUTO_ACCRUE'`, increments `accrualsCreated`.
5. If an account calculation throws an error:
   - Error is logged in `accrual_run_details` with `result = 'FAILED'` and `is_retryable = 1`.
   - The loop continues to the next account (**failure isolation**).
6. Run summary is committed to `accrual_runs` with status `COMPLETED` or `COMPLETED_WITH_ERRORS`.

---

## 9. API Reference

| Method | Endpoint | Purpose | Status Code |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/interest/calculate` | Preview interest by duration/time | 200 OK |
| `POST` | `/api/interest/calculate-by-dates` | Preview interest by start/end dates | 200 OK |
| `POST` | `/api/accounts/:id/interest-records` | Manually record interest for an account | 201 Created |
| `POST` | `/api/interest/record` | Global endpoint for recording interest | 201 Created |
| `GET` | `/api/accounts/:id/interest-balance` | Get account interest summary & records | 200 OK |
| `POST` | `/api/accounts/:id/accrue-interest` | Trigger accrual for a specific account | 200 OK |
| `POST` | `/api/payments/allocate` | Allocate payment to principal/interest | 201 Created |
| `POST` | `/api/interest-records/:id/reverse` | Reverse an unpaid interest record | 200 OK |
| `GET` | `/api/interest-records/:id/correction-history` | Get lineage chain of corrections | 200 OK |
| `GET` | `/api/interest-records/:id/audit` | Get calculation & audit metadata for record | 200 OK |
| `GET` | `/api/accounts/:id/interest-audit` | Get all audit events for an account | 200 OK |
| `POST` | `/api/scheduler/run` | Trigger manual scheduler batch execution | 200 OK |
| `GET` | `/api/scheduler/runs` | Get list of recent scheduler batch runs | 200 OK |
| `GET` | `/api/scheduler/runs/:id` | Get account-level details for a specific run | 200 OK |
| `GET` | `/api/scheduler/failures` | Query failed accrual attempts | 200 OK |
| `POST` | `/api/scheduler/retry/:detailId` | Retry a specific failed accrual attempt | 200 OK |
| `PUT/PATCH/DELETE` | `/api/transactions/:id` | Blocked (Historical Immutability) | 405 Method Not Allowed |
| `PUT/PATCH/DELETE` | `/api/audit-logs/:id` | Blocked (Historical Immutability) | 405 Method Not Allowed |
| `PUT/PATCH/DELETE` | `/api/interest-records/:id/audit` | Blocked (Historical Immutability) | 405 Method Not Allowed |
| `PUT/PATCH/DELETE` | `/api/interest-records/:id/reverse` | Blocked (Historical Immutability) | 405 Method Not Allowed |

---

## 10. Sample Requests and Responses

### 10.1 Preview Calculation
```http
POST /api/interest/calculate
Content-Type: application/json

{
  "principal": 10000,
  "rate": 12.0,
  "time": 0.0821917808219178
}
```
**Response (200 OK):**
```json
{
  "message": "Interest calculated successfully",
  "data": {
    "principal": 10000,
    "principal_paisa": 1000000,
    "rate": 12,
    "time": 0.0821917808219178,
    "interest": 98.63,
    "interest_paisa": 9863,
    "total_amount": 10098.63,
    "total_amount_paisa": 1009863
  }
}
```

### 10.2 Reversal of Unpaid Record
```http
POST /api/interest-records/5/reverse
Content-Type: application/json

{
  "reason": "Applied incorrect rate of 12% instead of 10%",
  "actor_id": "ADMIN_USER"
}
```
**Response (200 OK):**
```json
{
  "message": "Interest record reversed successfully",
  "data": {
    "status": "REVERSED",
    "record": {
      "id": 5,
      "account_id": 2,
      "status": "REVERSED",
      "reversal_reason": "Applied incorrect rate of 12% instead of 10%",
      "reversed_at": "2026-09-06T04:45:00.000Z",
      "outstanding_amount_rupees": 0
    }
  }
}
```

### 10.3 Reversal Failure (Record Has Payments)
```http
POST /api/interest-records/1/reverse
Content-Type: application/json

{
  "reason": "Attempting to reverse paid record"
}
```
**Response (400 Bad Request):**
```json
{
  "error": "Cannot reverse interest record #1: record has associated payments (paid: ₹30.00). Reversal is only permitted on unpaid interest records."
}
```

---

## 11. Testing & Release Gate Verification

### 11.1 Test Suite Structure
The repository contains 31 test suites in `tests/`:
* `db-tests.js`: Core database constraints, foreign keys, and seed integrity.
* `step2-tests.js` to `step4g-tests.js`: Person, account, and transaction functionality.
* `step5a-tests.js` to `step5p-tests.js`: Progressive milestone verification of calculations, previews, payments, reversals, scheduler, and hardening.
* `step5q-tests.js`: **Final release gate verification suite** (contains 26 required end-to-end checks).

### 11.2 Step 5Q Required Verification Results

| Check Category | Verified Component | Result |
| :--- | :--- | :--- |
| **Database** | Migrations, tables, constraints, foreign keys | **PASS** |
| **Calculation** | Baselines 1, 2, 3, and segmented multi-principal | **PASS** |
| **Preview** | Non-persistent calculation, 0 database writes | **PASS** |
| **Recording** | Manual recording, status `PENDING`, source `MANUAL` | **PASS** |
| **Outstanding** | Derived sum of unpaid active records | **PASS** |
| **Payment** | FIFO interest allocation, accurate paid balance | **PASS** |
| **Principal Separation** | Interest payments leave principal unchanged | **PASS** |
| **Automatic Accrual** | Automated scheduler accrual, source `AUTOMATIC` | **PASS** |
| **Scheduler** | Run logging, run details, batch tracking | **PASS** |
| **Duplicate Prevention** | Prevention of repeat runs & cross-workflow duplicates | **PASS** |
| **Idempotency** | Re-running scheduler creates 0 duplicate records | **PASS** |
| **Retry** | Failure isolation and safe single-item retry | **PASS** |
| **Audit** | Append-only event logging with full metadata | **PASS** |
| **Reversal** | Unpaid reversal permitted, paid reversal blocked | **PASS** |
| **Correction** | Lineage chain tracking (`Original → Reversal → Corrected`) | **PASS** |
| **Concurrency** | Unique constraint catches simultaneous recording | **PASS** |
| **Authorization** | Immutability protection, actor capture | **PASS** |
| **Validation** | Inverted dates, negative amounts rejected | **PASS** |
| **Security** | Secrets scanning, sanitized error responses | **PASS** |
| **Regression** | Steps 1–5P regression test suites (30/30 passed) | **PASS** |
| **Build** | Node syntax validation across all source files | **PASS** |
| **API** | Critical interest API routes operational | **PASS** |

### 11.3 Optional Checks Status
* Load testing: `NOT RUN`
* Large dataset testing: `NOT RUN`
* Performance benchmarking: `NOT RUN`
* Extended UI testing: `NOT RUN`
* Backup/recovery drill: `NOT RUN`
* Penetration testing: `NOT RUN`

---

## 12. Local Development & Operational Guide

### 12.1 Prerequisites
* Node.js v18+ (tested on Node.js v24)
* npm v9+

### 12.2 Setup & Running

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Initialize Database:**
   ```bash
   npm run db:init
   ```
   *Resets the SQLite database and populates schema with default seed accounts.*

3. **Start the Application:**
   ```bash
   npm start
   # Or for auto-reload during development:
   npm run dev
   ```
   The application will be accessible at: `http://localhost:3000`

4. **Run Release Tests:**
   ```bash
   node tests/step5q-tests.js
   ```

5. **Run Complete Regression Suite:**
   ```bash
   node tests/step5p-tests.js
   node tests/step5o-tests.js
   ```

### 12.3 Troubleshooting Common Issues

* **`ECONNREFUSED 127.0.0.1:3000`:** The Express server is not running. Start with `npm start`.
* **Unique constraint failed (`idx_interest_records_active_period`):** An active interest record already exists for this account and period. Either choose a new period or reverse the existing record first.
* **Cannot reverse interest record (paid amount > 0):** Financial records with attached payments cannot be reversed. To adjust, remove or reallocate the payment first.
* **Missing tables on startup:** Run `npm run db:init` to recreate the schema and seed data.

---

## 13. Security, Invariants & Maintenance Rules

### 13.1 Core Financial Invariants
1. **Principal Balance Invariant:** Interest operations (recording, accrual, reversal, payment) must **never** modify the `outstanding_principal` column of an account.
2. **Payment Allocation Invariant:** Repayments allocated to interest attach strictly to `interest_records.paid_amount` and do not diminish principal.
3. **Period Exclusivity Invariant:** There can be at most **one active record** per account-period (`status != 'REVERSED'`).
4. **Reversal Invariant:** A record can only be reversed **once**, and only if it has **zero payments**.
5. **Lineage Preservation Invariant:** Corrected interest records must maintain an unbroken pointer back to the reversed original record.
6. **Immutability Invariant:** Existing entries in `audit_logs` and `transactions` must never be modified or deleted.

### 13.2 Maintenance Guidelines for Future Developers
* **Do not edit financial records directly:** Always use the reversal and correction flow.
* **Do not modify applied database migrations:** If schema modifications are required, append new table definitions or migration blocks in `db/connection.js`.
* **Always run `step5q-tests.js` before deploying:** Never release if any required check fails.
* **Never use floating-point types for currency math:** Perform all internal arithmetic in integer paisa using `Math.round()`.

---

## 14. Changelog

### Version 1.0.0 (Steps 5A – 5R Completed)
* Implemented complete Simple Interest calculation engine (`Actual/365`, integer paisa).
* Added principal timeline segmentation for multi-principal adjustments.
* Implemented non-persistent interest preview endpoints.
* Added manual recording with derived outstanding balances.
* Integrated FIFO payment allocation preserving principal invariants.
* Built background automated accrual scheduler with telemetry and retry endpoints.
* Added append-only audit logging and HTTP 405 immutability protections.
* Implemented reversal workflows with payment guardrails and bidirectional correction chains.
* Hardened against race conditions with SQLite partial unique indexing.
* Verified 100% pass rate across 30 regression suites and Step 5Q release gate.
