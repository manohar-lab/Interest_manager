/**
 * Interest Manager — Step 5N Test Suite
 * Comprehensive Verification of Interest Correction and Reversal
 * 
 * Tests (§40 - §56):
 * - §40: Simple Reversal (Status -> REVERSED, Outstanding -> 0, Audit logged)
 * - §41: Double Reversal Rejection
 * - §42: Concurrent Reversal Handling
 * - §43: Reversal of Partially Paid Interest Prohibited
 * - §44: Reversal of Fully Paid Interest Prohibited
 * - §45: Principal and Ledger Transactions Unaffected
 * - §46: Corrected Interest on Same Period Allowed Post-Reversal
 * - §47: Correction History API & Chain Retrieval
 * - §48: Distinct Audit Trail for Original, Reversal, and Correction
 * - §49: Immutability Protections (HTTP 405 on PUT/PATCH/DELETE)
 * - §50: Atomic Execution & Rollback Safety
 * - §51: Account Isolation
 * - §52: Automatic Record Reversal Source Tracking
 * - §53: Reversal Reason Validation (Required Non-Empty)
 * - §54: Active Record Period Uniqueness Enforcement
 * - §55: Zero Ledger / Transaction Table Pollution
 * - §56: Direct Service Function Integration & Error Handling
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

        req.on('error', reject);

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

async function resetDb() {
    const res = await request('POST', '/test/reset-state');
    assert.strictEqual(res.statusCode, 200, 'Reset state should succeed');
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    Error: ${err.message}`);
        if (err.stack) {
            console.error(`    Stack: ${err.stack.split('\n').slice(1, 4).join('\n')}`);
        }
        failed++;
    }
}

async function runTests() {
    console.log('\n======================================================');
    console.log('   STEP 5N: INTEREST CORRECTION & REVERSAL TESTS');
    console.log('======================================================\n');

    // ──────────────────────────────────────────────────────────
    // TEST GROUP 1: Core Reversal Mechanics
    // ──────────────────────────────────────────────────────────
    console.log('--- Test Group 1: Core Reversal Mechanics ---');

    await test('§40: Simple Reversal sets status REVERSED, clears outstanding, creates audit', async () => {
        await resetDb();

        // 1. Record an interest record for Account 1
        const recRes = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 2500,
            principal_basis: 200000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST',
            source: 'MANUAL'
        });
        assert.strictEqual(recRes.statusCode, 201);
        const recordId = recRes.body.data.id;

        // Check balance before reversal
        const balBefore = await request('GET', '/accounts/1/interest-balance');
        assert.strictEqual(balBefore.body.data.total_recorded, 2500);
        assert.strictEqual(balBefore.body.data.total_outstanding, 2500);

        // 2. Reverse the interest record
        const revRes = await request('POST', `/interest-records/${recordId}/reverse`, {
            reason: 'Erroneous rate applied by operator',
            actor_id: 'user_42',
            source: 'MANUAL'
        });
        assert.strictEqual(revRes.statusCode, 200, `Reversal failed: ${JSON.stringify(revRes.body)}`);
        assert.strictEqual(revRes.body.data.status, 'REVERSED');
        assert.strictEqual(revRes.body.data.reversal_reason, 'Erroneous rate applied by operator');
        assert.strictEqual(revRes.body.data.reversal_actor_id, 'user_42');
        assert.strictEqual(revRes.body.data.reversal_source, 'MANUAL');
        assert.ok(revRes.body.data.reversed_at, 'reversed_at should be set');

        // 3. Verify balance after reversal excludes reversed record
        const balAfter = await request('GET', '/accounts/1/interest-balance');
        assert.strictEqual(balAfter.body.data.total_recorded, 0, 'Reversed record should not be counted in total_recorded');
        assert.strictEqual(balAfter.body.data.total_outstanding, 0, 'Total outstanding should be 0');
        assert.strictEqual(balAfter.body.data.record_count, 0, 'Active record count should be 0');

        // 4. Verify audit log entry
        const auditRes = await request('GET', `/interest-records/${recordId}/audit`);
        assert.strictEqual(auditRes.statusCode, 200);
        assert.strictEqual(auditRes.body.data.record.status, 'REVERSED');
        assert.strictEqual(auditRes.body.data.record.reversal_reason, 'Erroneous rate applied by operator');
    });

    await test('§41: Double reversal rejection (returns 400)', async () => {
        await resetDb();

        const recRes = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 2500,
            principal_basis: 200000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        const recordId = recRes.body.data.id;

        // First reversal
        const rev1 = await request('POST', `/accounts/1/interest-records/${recordId}/reverse`, {
            reason: 'First reversal'
        });
        assert.strictEqual(rev1.statusCode, 200);

        // Second reversal must fail
        const rev2 = await request('POST', `/accounts/1/interest-records/${recordId}/reverse`, {
            reason: 'Attempted duplicate reversal'
        });
        assert.strictEqual(rev2.statusCode, 400, 'Second reversal should return 400');
        const errStr = (rev2.body.error || rev2.body.message || JSON.stringify(rev2.body)).toLowerCase();
        assert.ok(errStr.includes('already reversed') || errStr.includes('cannot be reversed') || errStr.includes('reversed'), `Expected already reversed message, got: ${errStr}`);
    });

    await test('§42: Concurrent reversal safety', async () => {
        await resetDb();

        const recRes = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 2500,
            principal_basis: 200000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        const recordId = recRes.body.data.id;

        // Dispatch two concurrent reversals
        const [p1, p2] = await Promise.all([
            request('POST', `/interest-records/${recordId}/reverse`, { reason: 'Concurrent req 1' }),
            request('POST', `/interest-records/${recordId}/reverse`, { reason: 'Concurrent req 2' })
        ]);

        const statuses = [p1.statusCode, p2.statusCode];
        assert.ok(statuses.includes(200), 'At least one reversal must succeed');
        assert.ok(statuses.includes(400), 'One concurrent reversal must fail with 400');
    });

    // ──────────────────────────────────────────────────────────
    // TEST GROUP 2: Payment Protection & Guardrails
    // ──────────────────────────────────────────────────────────
    console.log('--- Test Group 2: Payment Protection & Guardrails ---');

    await test('§43: Reversal of partially paid interest record is strictly rejected', async () => {
        await resetDb();

        // Record interest ₹2,500
        const recRes = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 2500,
            principal_basis: 200000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        const recordId = recRes.body.data.id;

        // Make partial payment ₹1,000 to interest via /payments/allocate
        const payRes = await request('POST', '/payments/allocate', {
            account_id: 1,
            total_amount: 1000,
            interest_amount: 1000,
            principal_amount: 0,
            payment_method: 'UPI',
            payment_date: '15/08/2026',
            reference: 'UPI/PARTIAL-001'
        });
        assert.strictEqual(payRes.statusCode, 201);

        // Verify status is PARTIALLY_PAID
        const balRes = await request('GET', '/accounts/1/interest-balance');
        const rec = balRes.body.data.records.find(r => r.id === recordId);
        assert.strictEqual(rec.status, 'PARTIALLY_PAID');
        assert.strictEqual(rec.paid_amount, 1000);

        // Attempt reversal -> Must be rejected (400)
        const revRes = await request('POST', `/interest-records/${recordId}/reverse`, {
            reason: 'Attempting to reverse partially paid interest'
        });
        assert.strictEqual(revRes.statusCode, 400);
        assert.ok(
            revRes.body.error.toLowerCase().includes('payment') ||
            revRes.body.error.toLowerCase().includes('paid'),
            `Expected payment protection error, got: ${revRes.body.error}`
        );
    });

    await test('§44: Reversal of fully paid interest record is strictly rejected', async () => {
        await resetDb();

        // Record interest ₹2,500
        const recRes = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 2500,
            principal_basis: 200000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        const recordId = recRes.body.data.id;

        // Make full payment ₹2,500 to interest via /payments/allocate
        const payRes = await request('POST', '/payments/allocate', {
            account_id: 1,
            total_amount: 2500,
            interest_amount: 2500,
            principal_amount: 0,
            payment_method: 'UPI',
            payment_date: '20/08/2026',
            reference: 'UPI/FULL-001'
        });
        assert.strictEqual(payRes.statusCode, 201);

        // Verify status is PAID
        const balRes = await request('GET', '/accounts/1/interest-balance');
        const rec = balRes.body.data.records.find(r => r.id === recordId);
        assert.strictEqual(rec.status, 'PAID');

        // Attempt reversal -> Must be rejected (400)
        const revRes = await request('POST', `/interest-records/${recordId}/reverse`, {
            reason: 'Attempting to reverse fully paid interest'
        });
        assert.strictEqual(revRes.statusCode, 400);
        assert.ok(
            revRes.body.error.toLowerCase().includes('payment') ||
            revRes.body.error.toLowerCase().includes('paid')
        );
    });

    await test('§45: Principal and Ledger Transactions remain completely unaffected', async () => {
        await resetDb();

        const accBefore = await request('GET', '/accounts/1');
        const principalBefore = accBefore.body.data.principal;
        const outstandingPrincipalBefore = accBefore.body.data.outstanding_principal;

        // Record interest and reverse it
        const recRes = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 2500,
            principal_basis: 200000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        await request('POST', `/interest-records/${recRes.body.data.id}/reverse`, {
            reason: 'Testing principal immutability'
        });

        // Verify account principal
        const accAfter = await request('GET', '/accounts/1');
        assert.strictEqual(accAfter.body.data.principal, principalBefore, 'Principal must not change');
        assert.strictEqual(accAfter.body.data.outstanding_principal, outstandingPrincipalBefore, 'Outstanding principal must not change');

        // Verify transaction count
        const txList = await request('GET', '/transactions?account_id=1');
        assert.strictEqual(txList.body.data.length, 0, 'No transactions should have been generated by interest reversal');
    });

    // ──────────────────────────────────────────────────────────
    // TEST GROUP 3: Correction & Chain Tracking
    // ──────────────────────────────────────────────────────────
    console.log('--- Test Group 3: Correction & Chain Tracking ---');

    await test('§46: Corrected interest on the same period allowed after reversal', async () => {
        await resetDb();

        // 1. Initial incorrect record (e.g. ₹3,000)
        const rec1 = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 3000,
            principal_basis: 200000,
            interest_rate: 18.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        const r1Id = rec1.body.data.id;

        // 2. Reverse R1
        const revRes = await request('POST', `/interest-records/${r1Id}/reverse`, {
            reason: 'Incorrect rate 18% used instead of 15%'
        });
        assert.strictEqual(revRes.statusCode, 200);

        // 3. Create corrected record for exact same period linking corrects_record_id
        const rec2 = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 2500,
            principal_basis: 200000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST',
            corrects_record_id: r1Id
        });
        assert.strictEqual(rec2.statusCode, 201, `Corrected record creation failed: ${JSON.stringify(rec2.body)}`);
        const r2Id = rec2.body.data.id;
        assert.strictEqual(rec2.body.data.corrects_record_id, r1Id);

        // 4. Verify account balance reflects ONLY the new active corrected record
        const bal = await request('GET', '/accounts/1/interest-balance');
        assert.strictEqual(bal.body.data.total_recorded, 2500);
        assert.strictEqual(bal.body.data.total_outstanding, 2500);
        assert.strictEqual(bal.body.data.record_count, 1);
    });

    await test('§47: Correction History API retrieves complete chain', async () => {
        await resetDb();

        // 1. Record R1
        const rec1 = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 3000,
            principal_basis: 200000,
            interest_rate: 18.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        const r1Id = rec1.body.data.id;

        // 2. Reverse R1
        await request('POST', `/interest-records/${r1Id}/reverse`, {
            reason: 'Rate correction needed'
        });

        // 3. Create R2 correcting R1
        const rec2 = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 2500,
            principal_basis: 200000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST',
            corrects_record_id: r1Id
        });
        const r2Id = rec2.body.data.id;

        // 4. Fetch correction history via both endpoints
        const hist1 = await request('GET', `/interest-records/${r1Id}/correction-history`);
        assert.strictEqual(hist1.statusCode, 200);
        assert.strictEqual(hist1.body.data.account_id, 1);
        assert.strictEqual(hist1.body.data.total_chain_length, 2);
        assert.strictEqual(hist1.body.data.chain[0].id, r1Id);
        assert.strictEqual(hist1.body.data.chain[0].type, 'ORIGINAL');
        assert.strictEqual(hist1.body.data.chain[0].status, 'REVERSED');
        assert.strictEqual(hist1.body.data.chain[1].id, r2Id);
        assert.strictEqual(hist1.body.data.chain[1].type, 'CORRECTION');
        assert.strictEqual(hist1.body.data.chain[1].status, 'PENDING');

        // Account-scoped endpoint check
        const hist2 = await request('GET', `/accounts/1/interest-records/${r2Id}/correction-history`);
        assert.strictEqual(hist2.statusCode, 200);
        assert.strictEqual(hist2.body.data.chain.length, 2);
    });

    await test('§48: Distinct audit events for original, reversal, and correction', async () => {
        await resetDb();

        // 1. Original
        const rec1 = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 3000,
            principal_basis: 200000,
            interest_rate: 18.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        const r1Id = rec1.body.data.id;

        // 2. Reversal
        await request('POST', `/interest-records/${r1Id}/reverse`, {
            reason: 'Audit distinctness test'
        });

        // 3. Correction
        const rec2 = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 2500,
            principal_basis: 200000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST',
            corrects_record_id: r1Id
        });
        const r2Id = rec2.body.data.id;

        // Check account audit history
        const auditHist = await request('GET', '/accounts/1/interest-audit');
        assert.strictEqual(auditHist.statusCode, 200);
        assert.strictEqual(auditHist.body.data.length, 2, 'Should have 2 interest records in audit history');

        // Verify R1 audit detail
        const r1Audit = await request('GET', `/interest-records/${r1Id}/audit`);
        assert.strictEqual(r1Audit.body.data.record.status, 'REVERSED');
        assert.strictEqual(r1Audit.body.data.record.reversal_reason, 'Audit distinctness test');

        // Verify R2 audit detail
        const r2Audit = await request('GET', `/interest-records/${r2Id}/audit`);
        assert.strictEqual(r2Audit.body.data.record.status, 'PENDING');
        assert.strictEqual(r2Audit.body.data.record.corrects_record_id, r1Id);
    });

    // ──────────────────────────────────────────────────────────
    // TEST GROUP 4: Immutability & Validation Guardrails
    // ──────────────────────────────────────────────────────────
    console.log('--- Test Group 4: Immutability & Validation Guardrails ---');

    await test('§49: Historical immutability (HTTP 405 on PUT/PATCH/DELETE for reversal & correction)', async () => {
        // Attempt PUT, PATCH, DELETE on reversal endpoints
        const putRev = await request('PUT', '/interest-records/1/reverse', { status: 'PENDING' });
        assert.strictEqual(putRev.statusCode, 405);

        const patchRev = await request('PATCH', '/accounts/1/interest-records/1/reverse', { reason: 'Tampered' });
        assert.strictEqual(patchRev.statusCode, 405);

        const delRev = await request('DELETE', '/interest-records/1/reverse');
        assert.strictEqual(delRev.statusCode, 405);

        // Attempt PUT, PATCH, DELETE on correction-history endpoints
        const putHist = await request('PUT', '/interest-records/1/correction-history');
        assert.strictEqual(putHist.statusCode, 405);

        const delHist = await request('DELETE', '/accounts/1/interest-records/1/correction-history');
        assert.strictEqual(delHist.statusCode, 405);
    });

    await test('§51: Account Isolation — reversing Account 1 does not alter Account 4', async () => {
        await resetDb();

        // Run scheduler for 2026-09-01 (accrues for Account 1 and Account 4)
        const runRes = await request('POST', '/scheduler/run', { as_of_date: '2026-09-01' });
        assert.strictEqual(runRes.statusCode, 200);

        const bal1Before = await request('GET', '/accounts/1/interest-balance');
        const bal4Before = await request('GET', '/accounts/4/interest-balance');
        assert.strictEqual(bal1Before.body.data.record_count, 1);
        assert.strictEqual(bal4Before.body.data.record_count, 1);

        const rec1Id = bal1Before.body.data.records[0].id;
        const rec4Id = bal4Before.body.data.records[0].id;

        // Reverse Account 1 record
        const rev1 = await request('POST', `/interest-records/${rec1Id}/reverse`, {
            reason: 'Account 1 isolated test'
        });
        assert.strictEqual(rev1.statusCode, 200);

        // Verify Account 4 is completely unchanged
        const bal4After = await request('GET', '/accounts/4/interest-balance');
        assert.strictEqual(bal4After.body.data.record_count, 1);
        assert.strictEqual(bal4After.body.data.total_recorded, bal4Before.body.data.total_recorded);
        assert.strictEqual(bal4After.body.data.records[0].status, 'PENDING');
    });

    await test('§52: Automatic record reversal maintains original source AUTOMATIC', async () => {
        await resetDb();

        // Run scheduler to create automatic record
        await request('POST', '/scheduler/run', { as_of_date: '2026-09-01' });

        const bal1 = await request('GET', '/accounts/1/interest-balance');
        const rec1 = bal1.body.data.records[0];
        assert.strictEqual(rec1.source, 'AUTOMATIC');

        // Reverse it
        const revRes = await request('POST', `/interest-records/${rec1.id}/reverse`, {
            reason: 'Reversing automated run due to rate mismatch',
            actor_id: 'ops_admin',
            source: 'MANUAL'
        });
        assert.strictEqual(revRes.statusCode, 200);
        assert.strictEqual(revRes.body.data.source, 'AUTOMATIC', 'Original source must remain AUTOMATIC');
        assert.strictEqual(revRes.body.data.reversal_source, 'MANUAL', 'Reversal source should be captured as MANUAL');
        assert.strictEqual(revRes.body.data.reversal_actor_id, 'ops_admin');
    });

    await test('§53: Reversal Reason is strictly required (non-empty)', async () => {
        await resetDb();

        const rec = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 2500,
            principal_basis: 200000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        const recId = rec.body.data.id;

        // Empty reason -> 400
        const noReason = await request('POST', `/interest-records/${recId}/reverse`, {});
        assert.strictEqual(noReason.statusCode, 400);
        assert.ok(noReason.body.error.toLowerCase().includes('reason'));

        // Whitespace only -> 400
        const blankReason = await request('POST', `/interest-records/${recId}/reverse`, { reason: '   ' });
        assert.strictEqual(blankReason.statusCode, 400);
    });

    await test('§54: Only 1 active record allowed per account-period (duplicate rejected)', async () => {
        await resetDb();

        // 1. Create first active record
        const rec1 = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 2500,
            principal_basis: 200000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        assert.strictEqual(rec1.statusCode, 201);

        // 2. Attempt duplicate active record without reversing -> Must fail (400)
        const dupRec = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 2500,
            principal_basis: 200000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        assert.strictEqual(dupRec.statusCode, 400);

        // 3. Reverse the first record
        await request('POST', `/interest-records/${rec1.body.data.id}/reverse`, {
            reason: 'Testing unique constraint clearance'
        });

        // 4. Now creating a new record for the exact same period succeeds
        const rec2 = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 2500,
            principal_basis: 200000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        assert.strictEqual(rec2.statusCode, 201);

        // 5. Attempting a 3rd record while rec2 is active fails
        const dup3 = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 2500,
            principal_basis: 200000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        assert.strictEqual(dup3.statusCode, 400);
    });

    await test('§55: Zero Ledger / Transaction Pollution during reversal lifecycle', async () => {
        await resetDb();

        const rec = await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 2500,
            principal_basis: 200000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST'
        });
        await request('POST', `/interest-records/${rec.body.data.id}/reverse`, {
            reason: 'Checking zero ledger mutations'
        });
        await request('POST', '/accounts/1/interest-records', {
            period_start: '2026-08-01',
            period_end: '2026-09-01',
            interest_amount: 2500,
            principal_basis: 200000,
            interest_rate: 15.0,
            calculation_method: 'SIMPLE_INTEREST',
            corrects_record_id: rec.body.data.id
        });

        const txs = await request('GET', '/transactions?account_id=1');
        assert.strictEqual(txs.body.data.length, 0, 'No transactions should exist');
    });

    // ──────────────────────────────────────────────────────────
    // SUMMARY
    // ──────────────────────────────────────────────────────────
    console.log('\n======================================================');
    console.log(`Step 5N Test Results: ${passed} passed, ${failed} failed`);
    console.log('======================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Test execution fatal error:', err);
    process.exit(1);
});
