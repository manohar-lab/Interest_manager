/**
 * Interest Manager — Step 5L: Accrual Monitoring & Failure Recovery
 *
 * Orchestration and operational layer that adds run-level and account-level
 * observability, error isolation, automatic retries with backoff, crash
 * recovery, and manual retry capabilities to the Step 5K scheduler.
 *
 * This module contains ZERO interest calculation formulas.
 * All calculation and recording logic is delegated strictly to Step 5J (accrueInterest).
 *
 * Architecture:
 *   Scheduler / Manual Trigger
 *       ↓
 *   Accrual Monitoring (Run tracking, stale cleanup, retry policy)
 *       ↓
 *   Step 5J accrueInterest()
 *       ↓
 *   Step 5F calculateTimelineInterest()
 *       ↓
 *   Step 5H interest_records (UNIQUE index prevents duplicates)
 *       ↓
 *   Step 5I interest outstanding / allocations
 */

const { queryAll, queryOne } = require('../db/helpers');
const { saveDatabase } = require('../db/connection');
const { accrueInterest, normalizeDate } = require('./interestService');

// ─── Eligible Account Statuses ───────────────────────────────
const ELIGIBLE_STATUSES = Object.freeze(['ACTIVE', 'PARTIALLY_PAID', 'OVERDUE']);

// ─── Max Automatic Retries ───────────────────────────────────
const MAX_AUTOMATIC_RETRIES = 3;

// Default stale run timeout: 5 minutes
const DEFAULT_STALE_RUN_TIMEOUT_MS = 5 * 60 * 1000;

// ─── Date/Time Provider ──────────────────────────────────────
/**
 * Returns the current date in Asia/Kolkata timezone as a YYYY-MM-DD string.
 * @returns {string} Current date in YYYY-MM-DD format (IST)
 */
function getCurrentDateIST() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(now);

    const year = parts.find(p => p.type === 'year').value;
    const month = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;
    return `${year}-${month}-${day}`;
}

// ─── Account Selection ───────────────────────────────────────
function getEligibleAccounts(db) {
    const placeholders = ELIGIBLE_STATUSES.map(() => '?').join(', ');
    return queryAll(db, `
        SELECT * FROM accounts
        WHERE status IN (${placeholders})
        ORDER BY id ASC
    `, [...ELIGIBLE_STATUSES]);
}

function getLastRecordedPeriodEnd(db, accountId) {
    const row = queryOne(db, `
        SELECT MAX(period_end) as last_end
        FROM interest_records
        WHERE account_id = ?
    `, [accountId]);
    return row && row.last_end ? row.last_end : null;
}

// ─── Date Arithmetic Helpers ─────────────────────────────────
function toUTCDate(isoStr) {
    const [y, m, d] = isoStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}

function formatUTCDate(dt) {
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function formatDate(dt) {
    return formatUTCDate(dt);
}

function addDays(isoStr, days) {
    const dt = toUTCDate(isoStr);
    dt.setUTCDate(dt.getUTCDate() + days);
    return formatUTCDate(dt);
}

function addMonths(isoStr, months) {
    const [y, m, d] = isoStr.split('-').map(Number);
    const totalMonths = (y * 12 + (m - 1)) + months;
    const newYear = Math.floor(totalMonths / 12);
    const newMonth = (totalMonths % 12) + 1;

    const lastDay = new Date(Date.UTC(newYear, newMonth, 0)).getUTCDate();
    const clampedDay = Math.min(d, lastDay);

    return formatUTCDate(new Date(Date.UTC(newYear, newMonth - 1, clampedDay)));
}

function addYears(isoStr, years) {
    const [y, m, d] = isoStr.split('-').map(Number);
    const newYear = y + years;

    const lastDay = new Date(Date.UTC(newYear, m, 0)).getUTCDate();
    const clampedDay = Math.min(d, lastDay);

    return formatUTCDate(new Date(Date.UTC(newYear, m - 1, clampedDay)));
}

// ─── Period Generation ───────────────────────────────────────
function generateDuePeriods(account, currentDate, startFrom = null) {
    const accountStart = normalizeDate(account.start_date);
    if (!accountStart) return [];

    const frequency = account.interest_frequency;
    const periods = [];
    let periodStart = accountStart;
    const skipBefore = startFrom || null;

    switch (frequency) {
        case 'DAILY': {
            while (periodStart < currentDate) {
                const periodEnd = addDays(periodStart, 1);
                if (periodEnd > currentDate) break;
                if (!skipBefore || periodStart >= skipBefore) {
                    periods.push({ start: periodStart, end: periodEnd });
                }
                periodStart = periodEnd;
            }
            break;
        }

        case 'WEEKLY': {
            while (periodStart < currentDate) {
                const periodEnd = addDays(periodStart, 7);
                if (periodEnd > currentDate) break;
                if (!skipBefore || periodStart >= skipBefore) {
                    periods.push({ start: periodStart, end: periodEnd });
                }
                periodStart = periodEnd;
            }
            break;
        }

        case 'MONTHLY': {
            let monthIndex = 0;
            while (true) {
                const pStart = monthIndex === 0 ? accountStart : addMonths(accountStart, monthIndex);
                const pEnd = addMonths(accountStart, monthIndex + 1);
                if (pEnd > currentDate) break;
                if (pStart >= currentDate) break;
                if (!skipBefore || pStart >= skipBefore) {
                    periods.push({ start: pStart, end: pEnd });
                }
                monthIndex++;
            }
            break;
        }

        case 'YEARLY': {
            let yearIndex = 0;
            while (true) {
                const pStart = yearIndex === 0 ? accountStart : addYears(accountStart, yearIndex);
                const pEnd = addYears(accountStart, yearIndex + 1);
                if (pEnd > currentDate) break;
                if (pStart >= currentDate) break;
                if (!skipBefore || pStart >= skipBefore) {
                    periods.push({ start: pStart, end: pEnd });
                }
                yearIndex++;
            }
            break;
        }

        default:
            break;
    }

    return periods;
}

// ─── Error Classification & Sanitization (§10, §8) ───────────
function isRetryableError(err) {
    if (!err) return false;
    const msg = (err.message || String(err)).toLowerCase();

    // Permanent errors
    if (
        msg.includes('not found') ||
        (msg.includes('account #') && msg.includes('not found')) ||
        msg.includes('closed') ||
        msg.includes('written_off') ||
        msg.includes('prohibited') ||
        msg.includes('invalid date') ||
        msg.includes('period_end must be') ||
        msg.includes('unsupported') ||
        msg.includes('validation') ||
        msg.includes('check constraint') ||
        msg.includes('foreign key constraint') ||
        msg.includes('cannot accrue') ||
        msg.includes('permanent')
    ) {
        return false;
    }

    // Explicit transient markers
    if (
        msg.includes('transient') ||
        msg.includes('temporary') ||
        msg.includes('busy') ||
        msg.includes('locked') ||
        msg.includes('timeout') ||
        msg.includes('timed out') ||
        msg.includes('econnrefused') ||
        msg.includes('deadlock') ||
        msg.includes('connection lost') ||
        msg.includes('db failure')
    ) {
        return true;
    }

    return false;
}

function sanitizeErrorMessage(err) {
    if (!err) return 'Unknown error';
    let msg = err.message || String(err);

    if (msg.includes('\n')) {
        msg = msg.split('\n')[0];
    }

    msg = msg.replace(/password\s*=\s*[^\s;]+/gi, 'password=***');
    msg = msg.replace(/token\s*=\s*[^\s;]+/gi, 'token=***');
    msg = msg.replace(/bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer ***');
    msg = msg.replace(/secret\s*=\s*[^\s;]+/gi, 'secret=***');

    if (msg.length > 500) {
        msg = msg.substring(0, 497) + '...';
    }

    return msg.trim() || 'Internal error';
}

// ─── Stale Run Cleanup (§15) ─────────────────────────────────
function cleanStaleRuns(db, staleTimeoutMs = DEFAULT_STALE_RUN_TIMEOUT_MS) {
    const runningRuns = queryAll(db, `
        SELECT run_id, started_at FROM accrual_runs
        WHERE status = 'RUNNING'
    `);

    let cleaned = 0;
    const now = Date.now();

    for (const run of runningRuns) {
        const startedTime = new Date(run.started_at).getTime();
        if (isNaN(startedTime) || (now - startedTime) > staleTimeoutMs) {
            const completedAt = new Date().toISOString();
            db.run(`
                UPDATE accrual_runs
                SET status = 'FAILED',
                    completed_at = ?,
                    error = 'Scheduler execution interrupted or timed out'
                WHERE run_id = ?
            `, [completedAt, run.run_id]);
            cleaned++;
            console.log(`[Scheduler] Cleaned up stale run ${run.run_id} (marked FAILED)`);
        }
    }

    if (cleaned > 0) {
        saveDatabase();
    }

    return cleaned;
}

// ─── Retry Runner (§11, §12, §13) ────────────────────────────
function executeAccrualWithRetry(accrualFn, options = {}) {
    const maxAttempts = options.maxRetries || MAX_AUTOMATIC_RETRIES;
    let attempt = 0;
    let lastError = null;

    while (attempt < maxAttempts) {
        attempt++;
        try {
            const accrualResult = accrualFn(attempt);
            return {
                result: accrualResult,
                error: null,
                attemptCount: attempt,
                isRetryable: false,
                retryCount: attempt - 1
            };
        } catch (err) {
            lastError = err;
            const retryable = isRetryableError(err);

            if (!retryable || attempt >= maxAttempts) {
                return {
                    result: null,
                    error: err,
                    attemptCount: attempt,
                    isRetryable: retryable,
                    retryCount: attempt - 1
                };
            }

            const delayMs = options.retryDelayMs !== undefined ? options.retryDelayMs : (attempt * 10);
            if (delayMs > 0) {
                const start = Date.now();
                while (Date.now() - start < delayMs) {
                    // busy wait
                }
            }
        }
    }

    return {
        result: null,
        error: lastError,
        attemptCount: attempt,
        isRetryable: isRetryableError(lastError),
        retryCount: attempt - 1
    };
}

// ─── Main Scheduler with Step 5L Monitoring ──────────────────
function runScheduler(db, options = {}) {
    const runId = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = new Date().toISOString();

    // 0. Clean up any stale stuck runs (§15)
    cleanStaleRuns(db, options.staleTimeoutMs);

    const currentDate = options.currentDate
        ? normalizeDate(options.currentDate)
        : getCurrentDateIST();

    if (!currentDate) {
        const errorMsg = 'Could not determine current date';
        const completedAt = new Date().toISOString();
        if (!options.dryRun) {
            db.run(`
                INSERT INTO accrual_runs (run_id, started_at, completed_at, status, current_date, error)
                VALUES (?, ?, ?, 'FAILED', 'UNKNOWN', ?)
            `, [runId, startedAt, completedAt, errorMsg]);
            saveDatabase();
        }
        return {
            runId,
            startedAt,
            completedAt,
            status: 'FAILED',
            error: errorMsg,
            accountsConsidered: 0,
            accountsProcessed: 0,
            accrualsCreated: 0,
            alreadyRecorded: 0,
            zeroInterest: 0,
            skipped: 0,
            failed: 0,
            retries: 0,
            details: []
        };
    }

    console.log(`[Scheduler] Interest accrual run started — ID: ${runId}, Date: ${currentDate}`);

    // 1. Select eligible accounts (§16)
    const accounts = getEligibleAccounts(db);
    console.log(`[Scheduler] Accounts considered: ${accounts.length}`);

    // Create initial RUNNING record in database (§2, §3)
    if (!options.dryRun) {
        db.run(`
            INSERT INTO accrual_runs (
                run_id, started_at, status, current_date, accounts_considered
            ) VALUES (?, ?, 'RUNNING', ?, ?)
        `, [runId, startedAt, currentDate, accounts.length]);
        saveDatabase();
    }

    const runSummary = {
        runId,
        startedAt,
        completedAt: null,
        status: 'RUNNING',
        currentDate,
        accountsConsidered: accounts.length,
        accountsProcessed: 0,
        accrualsCreated: 0,
        alreadyRecorded: 0,
        zeroInterest: 0,
        skipped: 0,
        failed: 0,
        retries: 0,
        details: []
    };

    const accountAttemptCounters = {};

    // 2. Process each account independently (§9, §25, §26)
    for (const account of accounts) {
        const accountDetail = {
            accountId: account.id,
            frequency: account.interest_frequency,
            periodsGenerated: 0,
            accrualsCreated: 0,
            alreadyRecorded: 0,
            zeroInterest: 0,
            failed: 0,
            retries: 0,
            errors: [],
            status: 'SUCCESS'
        };

        try {
            // 3. Generate due periods (§4–§9)
            const periods = generateDuePeriods(account, currentDate);
            accountDetail.periodsGenerated = periods.length;

            if (periods.length === 0) {
                accountDetail.status = 'NO_PERIODS_DUE';
                runSummary.skipped++;

                if (!options.dryRun) {
                    db.run(`
                        INSERT INTO accrual_run_details (
                            run_id, account_id, result, error_message, attempt_count
                        ) VALUES (?, ?, 'SKIPPED', 'No periods due for current date', 1)
                    `, [runId, account.id]);
                }

                console.log(`[Scheduler] Account #${account.id} period N/A → SKIPPED (No periods due)`);
                runSummary.details.push(accountDetail);
                continue;
            }

            // 4. Process each period via Step 5J with automatic retries (§11, §12, §13)
            for (const period of periods) {
                if (options.dryRun) {
                    accountDetail.accrualsCreated++;
                    runSummary.accrualsCreated++;
                    continue;
                }

                const accrualFn = (attemptNumber) => {
                    // Permanent error injection for testing (§31, §35, §41)
                    if (options.failAccountIds && options.failAccountIds.includes(account.id)) {
                        throw new Error(`Simulated permanent error for Account #${account.id}`);
                    }

                    // Transient error injection for testing (§32, §34, §39)
                    if (options.transientFailAccountIds && options.transientFailAccountIds.includes(account.id)) {
                        const countKey = `${account.id}_${period.start}`;
                        accountAttemptCounters[countKey] = (accountAttemptCounters[countKey] || 0) + 1;
                        const maxFails = options.transientFailAttempts !== undefined ? options.transientFailAttempts : 1;
                        if (accountAttemptCounters[countKey] <= maxFails) {
                            throw new Error('Simulated transient database failure');
                        }
                    }

                    return accrueInterest(db, account.id, period.start, period.end, {
                        source: 'AUTOMATIC',
                        schedulerRunId: runId
                    });
                };

                const execution = executeAccrualWithRetry(accrualFn, {
                    maxRetries: options.maxRetries || MAX_AUTOMATIC_RETRIES,
                    retryDelayMs: options.retryDelayMs
                });

                accountDetail.retries += execution.retryCount;
                runSummary.retries += execution.retryCount;

                if (execution.error) {
                    accountDetail.failed++;
                    runSummary.failed++;

                    const safeError = sanitizeErrorMessage(execution.error);
                    accountDetail.errors.push({
                        period: `${period.start} to ${period.end}`,
                        error: safeError,
                        attemptCount: execution.attemptCount,
                        isRetryable: execution.isRetryable
                    });

                    db.run(`
                        INSERT INTO accrual_run_details (
                            run_id, account_id, period_start, period_end,
                            result, error_message, attempt_count, is_retryable
                        ) VALUES (?, ?, ?, ?, 'FAILED', ?, ?, ?)
                    `, [
                        runId, account.id, period.start, period.end,
                        safeError, execution.attemptCount, execution.isRetryable ? 1 : 0
                    ]);

                    console.log(`[Scheduler] Account #${account.id} period ${period.start} → ${period.end} → FAILED: ${safeError}`);

                } else {
                    const accrualResult = execution.result;
                    let resultType = 'SUCCESS';
                    let interestRecordId = null;
                    let interestAmount = null;

                    switch (accrualResult.status) {
                        case 'RECORDED':
                            accountDetail.accrualsCreated++;
                            runSummary.accrualsCreated++;
                            resultType = 'SUCCESS';
                            interestRecordId = accrualResult.record ? accrualResult.record.id : null;
                            interestAmount = accrualResult.interest_amount_paisa || accrualResult.interestAmountPaisa || 0;
                            break;

                        case 'ALREADY_RECORDED':
                            accountDetail.alreadyRecorded++;
                            runSummary.alreadyRecorded++;
                            resultType = 'ALREADY_RECORDED';
                            interestRecordId = accrualResult.existingRecord ? accrualResult.existingRecord.id : null;
                            break;

                        case 'ZERO_INTEREST':
                            accountDetail.zeroInterest++;
                            runSummary.zeroInterest++;
                            resultType = 'SUCCESS';
                            interestRecordId = accrualResult.record ? accrualResult.record.id : null;
                            interestAmount = 0;
                            break;

                        default:
                            accountDetail.accrualsCreated++;
                            runSummary.accrualsCreated++;
                            resultType = 'SUCCESS';
                            break;
                    }

                    db.run(`
                        INSERT INTO accrual_run_details (
                            run_id, account_id, period_start, period_end,
                            result, attempt_count, interest_record_id, interest_amount
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        runId, account.id, period.start, period.end,
                        resultType, execution.attemptCount, interestRecordId, interestAmount
                    ]);

                    console.log(`[Scheduler] Account #${account.id} period ${period.start} → ${period.end} → ${resultType}`);
                }
            }

            if (accountDetail.failed > 0 && accountDetail.accrualsCreated === 0 && accountDetail.alreadyRecorded === 0) {
                accountDetail.status = 'FAILED';
            } else if (accountDetail.failed > 0) {
                accountDetail.status = 'PARTIAL';
            }

            runSummary.accountsProcessed++;

        } catch (accountErr) {
            accountDetail.status = 'ERROR';
            accountDetail.failed++;
            runSummary.failed++;

            const safeError = sanitizeErrorMessage(accountErr);
            const isRetryable = isRetryableError(accountErr);

            accountDetail.errors.push({
                error: safeError,
                isRetryable
            });

            if (!options.dryRun) {
                db.run(`
                    INSERT INTO accrual_run_details (
                        run_id, account_id, result, error_message, attempt_count, is_retryable
                    ) VALUES (?, ?, 'FAILED', ?, 1, ?)
                `, [runId, account.id, safeError, isRetryable ? 1 : 0]);
            }

            console.error(`[Scheduler] Account #${account.id} error: ${safeError}`);
        }

        runSummary.details.push(accountDetail);
    }

    const completedAt = new Date().toISOString();
    runSummary.completedAt = completedAt;

    if (runSummary.failed === 0) {
        runSummary.status = 'COMPLETED';
    } else {
        runSummary.status = 'COMPLETED_WITH_ERRORS';
    }

    if (!options.dryRun) {
        db.run(`
            UPDATE accrual_runs
            SET completed_at = ?,
                status = ?,
                accounts_processed = ?,
                accruals_created = ?,
                already_recorded = ?,
                zero_interest = ?,
                skipped = ?,
                failed = ?,
                retries = ?
            WHERE run_id = ?
        `, [
            completedAt,
            runSummary.status,
            runSummary.accountsProcessed,
            runSummary.accrualsCreated,
            runSummary.alreadyRecorded,
            runSummary.zeroInterest,
            runSummary.skipped,
            runSummary.failed,
            runSummary.retries,
            runId
        ]);
        saveDatabase();
    }

    console.log(`[Scheduler] Interest accrual run completed — Status: ${runSummary.status}`);
    console.log(`[Scheduler]   Accounts considered: ${runSummary.accountsConsidered}`);
    console.log(`[Scheduler]   Accounts processed:  ${runSummary.accountsProcessed}`);
    console.log(`[Scheduler]   Accruals created:    ${runSummary.accrualsCreated}`);
    console.log(`[Scheduler]   Already recorded:    ${runSummary.alreadyRecorded}`);
    console.log(`[Scheduler]   Zero interest:       ${runSummary.zeroInterest}`);
    console.log(`[Scheduler]   Skipped:             ${runSummary.skipped}`);
    console.log(`[Scheduler]   Failed:              ${runSummary.failed}`);
    console.log(`[Scheduler]   Retries:             ${runSummary.retries}`);

    return runSummary;
}

// ─── Manual Retry (§20, §21, §22) ────────────────────────────
function retryFailedAccrual(db, detailId) {
    const detail = queryOne(db, `
        SELECT * FROM accrual_run_details
        WHERE id = ?
    `, [Number(detailId)]);

    if (!detail) {
        const err = new Error(`Accrual record #${detailId} not found`);
        err.statusCode = 404;
        throw err;
    }

    if (!detail.period_start || !detail.period_end) {
        const err = new Error(`Accrual record #${detailId} has no period defined to retry`);
        err.statusCode = 400;
        throw err;
    }

    console.log(`[Scheduler] Manual retry requested for detail #${detailId} (Account #${detail.account_id}, Period: ${detail.period_start} → ${detail.period_end})`);

    try {
        const accrualResult = accrueInterest(db, detail.account_id, detail.period_start, detail.period_end, {
            source: 'AUTOMATIC',
            schedulerRunId: detail.run_id
        });
        const newAttemptCount = detail.attempt_count + 1;
        const now = new Date().toISOString();

        let resultType = 'SUCCESS';
        let interestRecordId = null;
        let interestAmount = null;

        if (accrualResult.status === 'RECORDED') {
            resultType = 'SUCCESS';
            interestRecordId = accrualResult.record ? accrualResult.record.id : null;
            interestAmount = accrualResult.interest_amount_paisa || accrualResult.interestAmountPaisa || 0;
        } else if (accrualResult.status === 'ALREADY_RECORDED') {
            resultType = 'ALREADY_RECORDED';
            interestRecordId = accrualResult.existingRecord ? accrualResult.existingRecord.id : null;
        } else if (accrualResult.status === 'ZERO_INTEREST') {
            resultType = 'SUCCESS';
            interestRecordId = accrualResult.record ? accrualResult.record.id : null;
            interestAmount = 0;
        }

        db.run(`
            UPDATE accrual_run_details
            SET result = ?,
                error_message = NULL,
                attempt_count = ?,
                interest_record_id = ?,
                interest_amount = ?,
                updated_at = ?
            WHERE id = ?
        `, [resultType, newAttemptCount, interestRecordId, interestAmount, now, detailId]);

        saveDatabase();

        const updated = queryOne(db, 'SELECT * FROM accrual_run_details WHERE id = ?', [detailId]);
        return {
            success: true,
            message: `Accrual retried successfully: ${resultType}`,
            detail: updated,
            accrualResult
        };

    } catch (err) {
        const safeError = sanitizeErrorMessage(err);
        const newAttemptCount = detail.attempt_count + 1;
        const now = new Date().toISOString();
        const isRetryable = isRetryableError(err);

        db.run(`
            UPDATE accrual_run_details
            SET result = 'FAILED',
                error_message = ?,
                attempt_count = ?,
                is_retryable = ?,
                updated_at = ?
            WHERE id = ?
        `, [safeError, newAttemptCount, isRetryable ? 1 : 0, now, detailId]);

        saveDatabase();

        const updated = queryOne(db, 'SELECT * FROM accrual_run_details WHERE id = ?', [detailId]);
        return {
            success: false,
            message: `Retry failed: ${safeError}`,
            detail: updated,
            error: safeError
        };
    }
}

// ─── Monitoring Query Services (§16, §17, §18, §19) ──────────
function getAccrualRuns(db, options = {}) {
    const limit = Math.min(Number(options.limit) || 50, 100);
    const offset = Number(options.offset) || 0;
    const status = options.status || null;

    let sql = 'SELECT * FROM accrual_runs';
    const params = [];

    if (status) {
        sql += ' WHERE status = ?';
        params.push(status);
    }

    sql += ' ORDER BY started_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return queryAll(db, sql, params);
}

function getAccrualRunById(db, runIdOrId) {
    const run = queryOne(db, `
        SELECT * FROM accrual_runs
        WHERE run_id = ? OR id = ?
    `, [String(runIdOrId), Number(runIdOrId) || 0]);

    if (!run) return null;

    const details = queryAll(db, `
        SELECT d.*, a.direction, a.interest_frequency, p.name as person_name
        FROM accrual_run_details d
        JOIN accounts a ON d.account_id = a.id
        JOIN people p ON a.person_id = p.id
        WHERE d.run_id = ?
        ORDER BY d.id ASC
    `, [run.run_id]);

    return {
        run,
        details
    };
}

function getFailedAccruals(db, options = {}) {
    const limit = Math.min(Number(options.limit) || 50, 100);
    const offset = Number(options.offset) || 0;

    return queryAll(db, `
        SELECT d.*, a.direction, a.interest_frequency, p.name as person_name
        FROM accrual_run_details d
        JOIN accounts a ON d.account_id = a.id
        JOIN people p ON a.person_id = p.id
        WHERE d.result = 'FAILED'
        ORDER BY d.id DESC
        LIMIT ? OFFSET ?
    `, [limit, offset]);
}

// ─── Background Scheduler Singleton Guard ─────────────────────
let _schedulerRegistered = false;
let _schedulerIntervalId = null;

function registerScheduler(db, options = {}) {
    if (_schedulerRegistered) {
        console.log('[Scheduler] Already registered — skipping duplicate registration');
        return false;
    }

    const intervalMs = options.intervalMs || 24 * 60 * 60 * 1000;
    const initialDelayMs = options.initialDelayMs || 10000;

    setTimeout(() => {
        console.log('[Scheduler] Initial run triggered');
        try {
            runScheduler(db);
        } catch (err) {
            console.error('[Scheduler] Initial run error:', err.message);
        }

        _schedulerIntervalId = setInterval(() => {
            console.log('[Scheduler] Periodic run triggered');
            try {
                runScheduler(db);
            } catch (err) {
                console.error('[Scheduler] Periodic run error:', err.message);
            }
        }, intervalMs);
    }, initialDelayMs);

    _schedulerRegistered = true;
    console.log(`[Scheduler] Registered — initial run in ${initialDelayMs}ms, then every ${intervalMs}ms`);
    return true;
}

function stopScheduler() {
    if (_schedulerIntervalId) {
        clearInterval(_schedulerIntervalId);
        _schedulerIntervalId = null;
    }
    _schedulerRegistered = false;
    console.log('[Scheduler] Stopped');
}

// ─── Exports ─────────────────────────────────────────────────
module.exports = {
    // Core Scheduler & Lifecycle
    runScheduler,
    registerScheduler,
    stopScheduler,
    cleanStaleRuns,

    // Monitoring & Retry Services
    getAccrualRuns,
    getAccrualRunById,
    getFailedAccruals,
    retryFailedAccrual,

    // Error classification & sanitization
    isRetryableError,
    sanitizeErrorMessage,
    executeAccrualWithRetry,

    // Account selection & Period generation
    getEligibleAccounts,
    ELIGIBLE_STATUSES,
    generateDuePeriods,
    getLastRecordedPeriodEnd,

    // Date helpers
    getCurrentDateIST,
    addDays,
    addMonths,
    addYears,
    toUTCDate,
    formatDate,
    MAX_AUTOMATIC_RETRIES
};
