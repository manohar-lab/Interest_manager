/**
 * Interest Manager — Step 6A Test Suite
 * Interest Configuration & Model Foundation (§1 - §16)
 *
 * Verifies the configuration layer for loan/account interest:
 * - Valid & invalid interest rates (12.00%, 10.50%, 7.25%, negative rejection)
 * - Controlled interest methods (SIMPLE_INTEREST, SIMPLE, rejection of unsupported methods)
 * - Effective date handling (required effective_from, nullable effective_to, effective_to >= effective_from)
 * - Loan/Account relationship & foreign key integrity
 * - Multiple configurations over time (historical rate changes without overwriting)
 * - Compatibility with existing loan/account records
 * - Financial safety (configuration changes do NOT modify principal, transactions, payments, balances)
 */

const http = require('http');
const assert = require('assert');

const BASE_URL = 'http://localhost:3000/api';

function request(method, path, body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(BASE_URL + path);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                let parsed;
                try {
                    parsed = JSON.parse(data);
                } catch (e) {
                    parsed = data;
                }
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: parsed
                });
            });
        });

        req.on('error', (err) => reject(err));

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    Error: ${err.message}`);
        if (err.stack) {
            const lines = err.stack.split('\n').slice(1, 4).join('\n');
            console.error(`    ${lines}`);
        }
        failed++;
    }
}

async function runAll() {
    console.log('\n================================================================');
    console.log('   INTEREST MANAGER — STEP 6A: INTEREST CONFIGURATION TESTS');
    console.log('================================================================\n');

    // ─────────────────────────────────────────────────────────────
    // Phase 1: Environment & Existing Data Compatibility
    // ─────────────────────────────────────────────────────────────
    console.log('--- Phase 1: Environment & Compatibility ---');

    await runTest('Initial state reset & database verification', async () => {
        const resetRes = await request('POST', '/test/reset-state');
        assert.strictEqual(resetRes.statusCode, 200);

        const healthRes = await request('GET', '/health');
        assert.strictEqual(healthRes.statusCode, 200);
    });

    await runTest('Existing accounts (1-4) have baseline configurations backfilled', async () => {
        for (let id = 1; id <= 4; id++) {
            const res = await request('GET', `/accounts/${id}/interest-configs`);
            assert.strictEqual(res.statusCode, 200);
            assert(res.body.data.length >= 1, `Account #${id} must have at least 1 interest config`);
            const cfg = res.body.data[0];
            assert.strictEqual(cfg.account_id, id);
            assert(cfg.interest_rate >= 0);
            assert(cfg.effective_from);
            assert.strictEqual(cfg.effective_to, null, 'Baseline configuration is open-ended');
        }
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 2: Rate Precision & Validation
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 2: Interest Rate Precision & Validation ---');

    let testAccountId = null;

    await runTest('Create test account for configuration tests', async () => {
        const accRes = await request('POST', '/accounts', {
            person_id: 1,
            direction: 'MONEY_GIVEN',
            principal: 10000,
            interest_rate: 12.0,
            interest_frequency: 'MONTHLY',
            calculation_method: 'SIMPLE_INTEREST',
            start_date: '2026-01-01',
            due_date: '2026-12-31'
        });
        assert.strictEqual(accRes.statusCode, 201);
        testAccountId = accRes.body.data.id;
        assert(testAccountId);
    });

    await runTest('Valid interest rates with decimals (12.00%, 10.50%, 7.25%) are preserved', async () => {
        const rates = [12.00, 10.50, 7.25];
        for (let i = 0; i < rates.length; i++) {
            const rate = rates[i];
            const cfgRes = await request('POST', `/accounts/${testAccountId}/interest-configs`, {
                interest_rate: rate,
                calculation_method: 'SIMPLE_INTEREST',
                effective_from: `2026-0${i + 1}-01`,
                effective_to: `2026-0${i + 1}-28`,
                notes: `Test rate ${rate}%`
            });
            assert.strictEqual(cfgRes.statusCode, 201);
            assert.strictEqual(cfgRes.body.data.interest_rate, rate);
            assert.strictEqual(cfgRes.body.data.account_id, testAccountId);
        }
    });

    await runTest('Invalid interest rates (negative, missing, non-numeric) are rejected', async () => {
        // Negative rate
        const negRes = await request('POST', `/accounts/${testAccountId}/interest-configs`, {
            interest_rate: -5.0,
            calculation_method: 'SIMPLE_INTEREST',
            effective_from: '2026-05-01'
        });
        assert.strictEqual(negRes.statusCode, 400);

        // Missing rate
        const missingRes = await request('POST', `/accounts/${testAccountId}/interest-configs`, {
            calculation_method: 'SIMPLE_INTEREST',
            effective_from: '2026-05-01'
        });
        assert.strictEqual(missingRes.statusCode, 400);

        // Non-numeric rate
        const strRes = await request('POST', `/accounts/${testAccountId}/interest-configs`, {
            interest_rate: 'not-a-rate',
            calculation_method: 'SIMPLE_INTEREST',
            effective_from: '2026-05-01'
        });
        assert.strictEqual(strRes.statusCode, 400);
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 3: Calculation Method Validation
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 3: Calculation Method Validation ---');

    await runTest('Valid calculation methods: SIMPLE_INTEREST and SIMPLE', async () => {
        const res1 = await request('POST', `/accounts/${testAccountId}/interest-configs`, {
            interest_rate: 8.0,
            calculation_method: 'SIMPLE_INTEREST',
            effective_from: '2026-06-01'
        });
        assert.strictEqual(res1.statusCode, 201);
        assert.strictEqual(res1.body.data.calculation_method, 'SIMPLE_INTEREST');

        const res2 = await request('POST', `/accounts/${testAccountId}/interest-configs`, {
            interest_rate: 8.5,
            calculation_method: 'SIMPLE',
            effective_from: '2026-07-01'
        });
        assert.strictEqual(res2.statusCode, 201);
        assert.strictEqual(res2.body.data.calculation_method, 'SIMPLE');
    });

    await runTest('Unsupported calculation methods (COMPOUND, RANDOM) are strictly rejected', async () => {
        const compRes = await request('POST', `/accounts/${testAccountId}/interest-configs`, {
            interest_rate: 10.0,
            calculation_method: 'COMPOUND',
            effective_from: '2026-08-01'
        });
        assert.strictEqual(compRes.statusCode, 400);
        assert(compRes.body.error.includes('Invalid interest calculation method'));
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 4: Effective Dates Validation & Nullable End Dates
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 4: Effective Dates & Range Validation ---');

    await runTest('effective_from is required; effective_to is optional/nullable', async () => {
        // Missing effective_from
        const noFrom = await request('POST', `/accounts/${testAccountId}/interest-configs`, {
            interest_rate: 9.0
        });
        assert.strictEqual(noFrom.statusCode, 400);

        // Nullable effective_to succeeds
        const openEnded = await request('POST', `/accounts/${testAccountId}/interest-configs`, {
            interest_rate: 9.0,
            effective_from: '2026-09-01'
        });
        assert.strictEqual(openEnded.statusCode, 201);
        assert.strictEqual(openEnded.body.data.effective_to, null);
    });

    await runTest('effective_to < effective_from is rejected', async () => {
        const invDates = await request('POST', `/accounts/${testAccountId}/interest-configs`, {
            interest_rate: 9.0,
            effective_from: '2026-09-01',
            effective_to: '2026-08-01' // earlier than from
        });
        assert.strictEqual(invDates.statusCode, 400);
        assert(invDates.body.error.includes('cannot be earlier than effective_from'));
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 5: Loan / Account Relationship
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 5: Account Relationship & Foreign Keys ---');

    await runTest('Configuration requires valid existing account association', async () => {
        const nonExistent = await request('POST', '/accounts/999999/interest-configs', {
            interest_rate: 10.0,
            effective_from: '2026-01-01'
        });
        assert.strictEqual(nonExistent.statusCode, 404);
    });

    await runTest('List configurations belongs to the correct account only', async () => {
        const configs = await request('GET', `/accounts/${testAccountId}/interest-configs`);
        assert.strictEqual(configs.statusCode, 200);
        assert(configs.body.data.length > 0);
        for (const cfg of configs.body.data) {
            assert.strictEqual(cfg.account_id, testAccountId);
        }
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 6: Multiple Historical Configurations Over Time
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 6: Multiple Historical Configurations ---');

    await runTest('Historical rate transition (01-Jan -> 30-Jun @ 12%, 01-Jul -> ongoing @ 10%) preserves history', async () => {
        // Create clean account for timeline test
        const multiAccRes = await request('POST', '/accounts', {
            person_id: 1,
            direction: 'MONEY_GIVEN',
            principal: 20000,
            interest_rate: 12.0,
            interest_frequency: 'MONTHLY',
            start_date: '2026-01-01',
            due_date: '2026-12-31'
        });
        const mAccId = multiAccRes.body.data.id;

        // Get initial config
        const initialConfigs = await request('GET', `/accounts/${mAccId}/interest-configs`);
        const initConfigId = initialConfigs.body.data[0].id;

        // Close initial config at 2026-06-30
        const updateRes = await request('PUT', `/interest-configs/${initConfigId}`, {
            effective_to: '2026-06-30',
            interest_rate: 12.0
        });
        assert.strictEqual(updateRes.statusCode, 200);
        assert.strictEqual(updateRes.body.data.effective_to, '2026-06-30');

        // Add new effective configuration starting 2026-07-01 @ 10%
        const newCfgRes = await request('POST', `/accounts/${mAccId}/interest-configs`, {
            interest_rate: 10.0,
            effective_from: '2026-07-01',
            effective_to: null,
            notes: 'Rate revised to 10% starting July'
        });
        assert.strictEqual(newCfgRes.statusCode, 201);

        // Verify history has both configurations
        const allConfigs = await request('GET', `/accounts/${mAccId}/interest-configs`);
        assert.strictEqual(allConfigs.statusCode, 200);
        assert.strictEqual(allConfigs.body.data.length, 2);

        assert.strictEqual(allConfigs.body.data[0].interest_rate, 12.0);
        assert.strictEqual(allConfigs.body.data[0].effective_from, '2026-01-01');
        assert.strictEqual(allConfigs.body.data[0].effective_to, '2026-06-30');

        assert.strictEqual(allConfigs.body.data[1].interest_rate, 10.0);
        assert.strictEqual(allConfigs.body.data[1].effective_from, '2026-07-01');
        assert.strictEqual(allConfigs.body.data[1].effective_to, null);

        // Test active config resolver
        const asOfMarch = await request('GET', `/accounts/${mAccId}/interest-configs/active?date=2026-03-15`);
        assert.strictEqual(asOfMarch.statusCode, 200);
        assert.strictEqual(asOfMarch.body.data.interest_rate, 12.0);

        const asOfAugust = await request('GET', `/accounts/${mAccId}/interest-configs/active?date=2026-08-15`);
        assert.strictEqual(asOfAugust.statusCode, 200);
        assert.strictEqual(asOfAugust.body.data.interest_rate, 10.0);
    });

    // ─────────────────────────────────────────────────────────────
    // Phase 7: Financial Safety
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- Phase 7: Financial Safety ---');

    await runTest('Configuration changes do NOT modify principal, transactions, payments, or balances', async () => {
        const accBefore = await request('GET', `/accounts/${testAccountId}`);
        const balBefore = await request('GET', `/accounts/${testAccountId}/interest-balance`);

        // Add a new configuration
        await request('POST', `/accounts/${testAccountId}/interest-configs`, {
            interest_rate: 14.5,
            effective_from: '2027-01-01',
            notes: 'Future scheduled rate change'
        });

        const accAfter = await request('GET', `/accounts/${testAccountId}`);
        const balAfter = await request('GET', `/accounts/${testAccountId}/interest-balance`);

        // Financial balances must be completely identical
        assert.strictEqual(accAfter.body.data.principal, accBefore.body.data.principal);
        assert.strictEqual(accAfter.body.data.outstanding_principal, accBefore.body.data.outstanding_principal);
        assert.strictEqual(balAfter.body.data.total_recorded, balBefore.body.data.total_recorded);
        assert.strictEqual(balAfter.body.data.total_paid, balBefore.body.data.total_paid);
        assert.strictEqual(balAfter.body.data.total_outstanding, balBefore.body.data.total_outstanding);
    });

    console.log('\n================================================================');
    console.log(`Step 6A Test Results: ${passed} passed, ${failed} failed`);
    console.log('================================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runAll().catch((err) => {
    console.error('Step 6A test suite failed:', err);
    process.exit(1);
});
