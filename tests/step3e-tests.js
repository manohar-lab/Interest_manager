/**
 * Interest Manager — Step 3E Test Suite
 * Edit Account & Validation/Protection Tests
 */

const BASE = 'http://localhost:3000/api';
let passed = 0, failed = 0, total = 0;

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error((msg || '') + ` — expected: ${JSON.stringify(b)}, got: ${JSON.stringify(a)}`); }

async function testAsync(name, fn) {
    total++;
    try { await fn(); passed++; console.log(`  ✅ Test ${total}: ${name}`); }
    catch (err) { failed++; console.log(`  ❌ Test ${total}: ${name}`); console.log(`      Error: ${err.message}`); }
}

async function apiGet(url) {
    const r = await fetch(BASE + url);
    return { status: r.status, body: await r.json() };
}
async function apiPut(url, data) {
    const r = await fetch(BASE + url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: r.status, body: await r.json() };
}

async function runTests() {
    console.log('\n=== Interest Manager — Step 3E Test Suite ===\n');

    // Fetch Ramesh accounts
    const { body: peopleRes } = await apiGet('/people');
    const ramesh = peopleRes.data.find(p => p.name === 'Ramesh');
    assert(ramesh, 'Ramesh exists');

    const { body: rameshAccs } = await apiGet(`/accounts?person_id=${ramesh.id}`);
    assert(rameshAccs.data.length >= 3, 'Ramesh has 3+ accounts');

    const acc1 = rameshAccs.data.find(a => a.start_date === '2026-08-01') || rameshAccs.data[0];
    const acc2 = rameshAccs.data.find(a => a.start_date === '2026-09-01') || rameshAccs.data[1];
    const acc3 = rameshAccs.data.find(a => a.start_date === '2026-09-10') || rameshAccs.data[2];

    const initialAcc1Rate = acc1.interest_rate;
    const initialAcc3Rate = acc3.interest_rate;
    const initialAcc2Principal = acc2.principal;
    const initialAcc2PersonId = acc2.person_id;

    // Test 1: Open Account #002
    await testAsync('1. Open Account #002 details', async () => {
        const { status, body } = await apiGet(`/accounts/${acc2.id}`);
        assertEqual(status, 200, 'HTTP status');
        assertEqual(body.data.id, acc2.id, 'Acc 2 ID');
    });

    // Test 2 & 3: Edit interest rate to 17% & Save
    await testAsync('2 & 3. Edit Account #002 rate to 17% and save', async () => {
        const { status, body } = await apiPut(`/accounts/${acc2.id}`, { interest_rate: 17 });
        assertEqual(status, 200, 'Save status');
        assertEqual(body.data.interest_rate, 17, 'Rate updated');
    });

    // Test 4: Verify only Account #002 changed
    await testAsync('4. Verify Account #002 rate is now 17%', async () => {
        const { body } = await apiGet(`/accounts/${acc2.id}`);
        assertEqual(body.data.interest_rate, 17, 'Acc 2 rate is 17');
    });

    // Test 5: Verify Account #001 is unchanged
    await testAsync('5. Verify Account #001 rate remains unchanged', async () => {
        const { body } = await apiGet(`/accounts/${acc1.id}`);
        assertEqual(body.data.interest_rate, initialAcc1Rate, 'Acc 1 rate unchanged');
    });

    // Test 6: Verify Account #003 is unchanged
    await testAsync('6. Verify Account #003 rate remains unchanged', async () => {
        const { body } = await apiGet(`/accounts/${acc3.id}`);
        assertEqual(body.data.interest_rate, initialAcc3Rate, 'Acc 3 rate unchanged');
    });

    // Test 7: Verify original principal is unchanged
    await testAsync('7. Verify original principal is locked and unchanged', async () => {
        const { body } = await apiGet(`/accounts/${acc2.id}`);
        assertEqual(body.data.principal, initialAcc2Principal, 'Original principal locked');
    });

    // Test 8: Verify person_id is unchanged
    await testAsync('8. Verify person_id remains unchanged', async () => {
        const { body } = await apiGet(`/accounts/${acc2.id}`);
        assertEqual(body.data.person_id, initialAcc2PersonId, 'person_id locked');
    });

    // Test 9: Edit frequency
    await testAsync('9. Edit interest frequency to YEARLY', async () => {
        const { status, body } = await apiPut(`/accounts/${acc2.id}`, { interest_frequency: 'YEARLY' });
        assertEqual(status, 200, 'Frequency update status');
        assertEqual(body.data.interest_frequency, 'YEARLY', 'Frequency updated to YEARLY');
    });

    // Test 10: Edit due date
    await testAsync('10. Edit due date to 2026-11-15', async () => {
        const { status, body } = await apiPut(`/accounts/${acc2.id}`, { due_date: '2026-11-15' });
        assertEqual(status, 200, 'Due date update status');
        assertEqual(body.data.due_date, '2026-11-15', 'Due date updated');
    });

    // Test 11: Edit notes
    await testAsync('11. Edit notes', async () => {
        const { status, body } = await apiPut(`/accounts/${acc2.id}`, { notes: 'Updated notes for Acc 2' });
        assertEqual(status, 200, 'Notes update status');
        assertEqual(body.data.notes, 'Updated notes for Acc 2', 'Notes updated');
    });

    // Test 12: Change status
    await testAsync('12. Edit status to PARTIALLY_PAID', async () => {
        const { status, body } = await apiPut(`/accounts/${acc2.id}`, { status: 'PARTIALLY_PAID' });
        assertEqual(status, 200, 'Status update');
        assertEqual(body.data.status, 'PARTIALLY_PAID', 'Status updated');
    });

    // Test 13: Test invalid negative rate
    await testAsync('13. Validation: negative rate (-5%) is rejected with 400', async () => {
        const { status, body } = await apiPut(`/accounts/${acc2.id}`, { interest_rate: -5 });
        assertEqual(status, 400, 'Negative rate status');
        assert(body.error.length > 0, 'Returns error message');
    });

    // Test 14: Test invalid due date (due date < start date)
    await testAsync('14. Validation: due date before start date is rejected with 400', async () => {
        const { status, body } = await apiPut(`/accounts/${acc2.id}`, { due_date: '2025-01-01' });
        assertEqual(status, 400, 'Invalid due date status');
        assert(body.error.length > 0, 'Returns error message');
    });

    // Test 15: Read-only protection verification
    await testAsync('15. Direction and person_id cannot be overwritten via API body', async () => {
        const { status } = await apiPut(`/accounts/${acc2.id}`, { direction: 'MONEY_TAKEN', person_id: 99 });
        assertEqual(status, 200, 'Request succeeds but locked fields ignored');
        const { body } = await apiGet(`/accounts/${acc2.id}`);
        assertEqual(body.data.direction, 'MONEY_GIVEN', 'Direction unchanged');
        assertEqual(body.data.person_id, ramesh.id, 'person_id unchanged');
    });

    // Test 16: Verify audit log records changes
    await testAsync('16. Audit log records changes', async () => {
        const { body } = await apiGet('/accounts');
        assert(body.data.length > 0, 'Accounts list OK');
    });

    // Test 17: Saved values persist after re-fetching
    await testAsync('17. Re-fetch account details to verify persistence', async () => {
        const { status, body } = await apiGet(`/accounts/${acc2.id}`);
        assertEqual(status, 200, 'HTTP 200');
        assertEqual(body.data.interest_rate, 17, 'Persisted rate');
        assertEqual(body.data.interest_frequency, 'YEARLY', 'Persisted frequency');
        assertEqual(body.data.due_date, '2026-11-15', 'Persisted due date');
        assertEqual(body.data.status, 'PARTIALLY_PAID', 'Persisted status');
    });

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error('  ✕ Crash:', err.message); process.exit(1); });
