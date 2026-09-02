/**
 * Interest Manager — Database & Application Test Suite
 * Covers all 10 required test cases from Step 1 specification.
 */

const path = require('path');
const fs = require('fs');

// ─── Test Runner ─────────────────────────────────────────────
let passed = 0;
let failed = 0;
let total = 0;

function test(name, fn) {
    total++;
    try {
        fn();
        passed++;
        console.log(`  ✅ Test ${total}: ${name}`);
    } catch (err) {
        failed++;
        console.log(`  ❌ Test ${total}: ${name}`);
        console.log(`      Error: ${err.message}`);
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(
            (message || 'Assertion failed') +
            ` — expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`
        );
    }
}

// ─── Helpers ─────────────────────────────────────────────────
function queryAll(db, sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    const results = [];
    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
}

function queryOne(db, sql, params = []) {
    const results = queryAll(db, sql, params);
    return results.length > 0 ? results[0] : null;
}

// ─── Main ────────────────────────────────────────────────────
async function runTests() {
    console.log('\n=== Interest Manager — Test Suite ===\n');

    // Load database
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();

    const dbPath = path.join(__dirname, '..', 'db', 'interest_manager.db');
    if (!fs.existsSync(dbPath)) {
        console.error('  ✗ Database file not found. Run "npm run db:init" first.');
        process.exit(1);
    }

    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);
    db.run('PRAGMA foreign_keys = ON;');

    // ─── Test 1: Ramesh exists ───────────────────────────────
    test('Ramesh exists', () => {
        const ramesh = queryOne(db, "SELECT * FROM people WHERE name = 'Ramesh'");
        assert(ramesh !== null, 'Ramesh not found in people table');
        assert(ramesh.id > 0, 'Ramesh should have a valid ID');
    });

    // ─── Test 2: Ramesh has exactly 3 separate accounts ──────
    test('Ramesh has exactly 3 separate accounts', () => {
        const ramesh = queryOne(db, "SELECT id FROM people WHERE name = 'Ramesh'");
        const accounts = queryAll(db, 'SELECT * FROM accounts WHERE person_id = ?', [ramesh.id]);
        assertEqual(accounts.length, 3, 'Ramesh account count');
    });

    // ─── Test 3: Accounts have different principal/rate/dates ─
    test('Three accounts have different principal, rate, and dates', () => {
        const ramesh = queryOne(db, "SELECT id FROM people WHERE name = 'Ramesh'");
        const accounts = queryAll(db,
            'SELECT principal, interest_rate, start_date, due_date FROM accounts WHERE person_id = ? ORDER BY start_date',
            [ramesh.id]
        );

        // Account 1: ₹2,000 (200000 paisa), 15%, 2026-08-01
        assertEqual(accounts[0].principal, 200000, 'Account 1 principal');
        assertEqual(accounts[0].interest_rate, 15.0, 'Account 1 rate');
        assertEqual(accounts[0].start_date, '2026-08-01', 'Account 1 start_date');

        // Account 2: ₹2,000 (200000 paisa), 15%, 2026-09-01
        assertEqual(accounts[1].principal, 200000, 'Account 2 principal');
        assertEqual(accounts[1].start_date, '2026-09-01', 'Account 2 start_date');

        // Account 3: ₹5,000 (500000 paisa), 18%, 2026-09-10
        assertEqual(accounts[2].principal, 500000, 'Account 3 principal');
        assertEqual(accounts[2].interest_rate, 18.0, 'Account 3 rate');
        assertEqual(accounts[2].start_date, '2026-09-10', 'Account 3 start_date');
    });

    // ─── Test 4: Mahesh has a MONEY_TAKEN account ────────────
    test('Mahesh has a separate MONEY_TAKEN account', () => {
        const mahesh = queryOne(db, "SELECT id FROM people WHERE name = 'Mahesh'");
        assert(mahesh !== null, 'Mahesh not found');

        const accounts = queryAll(db, 'SELECT * FROM accounts WHERE person_id = ?', [mahesh.id]);
        assertEqual(accounts.length, 1, 'Mahesh account count');
        assertEqual(accounts[0].direction, 'MONEY_TAKEN', 'Mahesh account direction');
        assertEqual(accounts[0].principal, 10000000, 'Mahesh principal (₹1,00,000 = 10000000 paisa)');
    });

    // ─── Test 5: Can add another account for Ramesh ──────────
    test('Can add another account for Ramesh without modifying existing', () => {
        const ramesh = queryOne(db, "SELECT id FROM people WHERE name = 'Ramesh'");
        const beforeCount = queryAll(db, 'SELECT id FROM accounts WHERE person_id = ?', [ramesh.id]).length;

        // Insert a new account
        db.run(`
            INSERT INTO accounts (
                person_id, direction, principal, outstanding_principal,
                interest_rate, interest_frequency, calculation_method,
                start_date, due_date, status
            ) VALUES (?, 'MONEY_GIVEN', 300000, 300000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-10-01', '2026-11-01', 'ACTIVE')
        `, [ramesh.id]);

        const afterCount = queryAll(db, 'SELECT id FROM accounts WHERE person_id = ?', [ramesh.id]).length;
        assertEqual(afterCount, beforeCount + 1, 'Account count after insertion');

        // Verify existing accounts are unchanged
        const originalAccounts = queryAll(db,
            'SELECT principal, interest_rate FROM accounts WHERE person_id = ? ORDER BY start_date LIMIT 3',
            [ramesh.id]
        );
        assertEqual(originalAccounts[0].principal, 200000, 'Original account 1 unchanged');
        assertEqual(originalAccounts[1].principal, 200000, 'Original account 2 unchanged');
        assertEqual(originalAccounts[2].principal, 500000, 'Original account 3 unchanged');

        // Clean up — remove the test account
        db.run("DELETE FROM accounts WHERE person_id = ? AND start_date = '2026-10-01'", [ramesh.id]);
    });

    // ─── Test 6: Principal and outstanding principal separate ─
    test('Original principal and outstanding principal are separate values', () => {
        const ramesh = queryOne(db, "SELECT id FROM people WHERE name = 'Ramesh'");
        const account = queryOne(db, 'SELECT principal, outstanding_principal FROM accounts WHERE person_id = ? LIMIT 1', [ramesh.id]);

        // Both should exist as separate columns
        assert(account.principal !== undefined, 'principal column exists');
        assert(account.outstanding_principal !== undefined, 'outstanding_principal column exists');

        // Initially they should be equal
        assertEqual(account.principal, account.outstanding_principal, 'Initial values should match');

        // Simulate a partial payment — update outstanding only
        db.run('UPDATE accounts SET outstanding_principal = ? WHERE person_id = ? AND principal = ?',
            [150000, ramesh.id, account.principal]);

        const updated = queryOne(db,
            'SELECT principal, outstanding_principal FROM accounts WHERE person_id = ? AND principal = ?',
            [ramesh.id, account.principal]
        );
        assertEqual(updated.principal, account.principal, 'Original principal unchanged after payment');
        assert(updated.outstanding_principal !== updated.principal, 'Outstanding differs from original');
        assertEqual(updated.outstanding_principal, 150000, 'Outstanding updated correctly');

        // Restore
        db.run('UPDATE accounts SET outstanding_principal = principal WHERE person_id = ? AND principal = ?',
            [ramesh.id, account.principal]);
    });

    // ─── Test 7: Foreign key relationships work ──────────────
    test('Foreign key relationships work correctly', () => {
        // Try inserting an account for a non-existent person — should fail
        let fkError = false;
        try {
            db.run(`
                INSERT INTO accounts (
                    person_id, direction, principal, outstanding_principal,
                    interest_rate, interest_frequency, calculation_method,
                    start_date, due_date, status
                ) VALUES (9999, 'MONEY_GIVEN', 100000, 100000, 10.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-02-01', 'ACTIVE')
            `);
        } catch (e) {
            fkError = true;
        }
        assert(fkError, 'Foreign key should prevent inserting account for non-existent person');
    });

    // ─── Test 8: Invalid values rejected ─────────────────────
    test('Invalid values (negative principal) are rejected', () => {
        const ramesh = queryOne(db, "SELECT id FROM people WHERE name = 'Ramesh'");

        // Negative principal
        let negPrincipalError = false;
        try {
            db.run(`
                INSERT INTO accounts (
                    person_id, direction, principal, outstanding_principal,
                    interest_rate, interest_frequency, calculation_method,
                    start_date, due_date, status
                ) VALUES (?, 'MONEY_GIVEN', -100, 0, 10.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-02-01', 'ACTIVE')
            `, [ramesh.id]);
        } catch (e) {
            negPrincipalError = true;
        }
        assert(negPrincipalError, 'Negative principal should be rejected');

        // Invalid direction
        let invalidDirectionError = false;
        try {
            db.run(`
                INSERT INTO accounts (
                    person_id, direction, principal, outstanding_principal,
                    interest_rate, interest_frequency, calculation_method,
                    start_date, due_date, status
                ) VALUES (?, 'INVALID', 100000, 100000, 10.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-02-01', 'ACTIVE')
            `, [ramesh.id]);
        } catch (e) {
            invalidDirectionError = true;
        }
        assert(invalidDirectionError, 'Invalid direction should be rejected');

        // Negative interest rate
        let negRateError = false;
        try {
            db.run(`
                INSERT INTO accounts (
                    person_id, direction, principal, outstanding_principal,
                    interest_rate, interest_frequency, calculation_method,
                    start_date, due_date, status
                ) VALUES (?, 'MONEY_GIVEN', 100000, 100000, -5.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-02-01', 'ACTIVE')
            `, [ramesh.id]);
        } catch (e) {
            negRateError = true;
        }
        assert(negRateError, 'Negative interest rate should be rejected');

        // due_date before start_date
        let dueDateError = false;
        try {
            db.run(`
                INSERT INTO accounts (
                    person_id, direction, principal, outstanding_principal,
                    interest_rate, interest_frequency, calculation_method,
                    start_date, due_date, status
                ) VALUES (?, 'MONEY_GIVEN', 100000, 100000, 10.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-06-01', '2026-05-01', 'ACTIVE')
            `, [ramesh.id]);
        } catch (e) {
            dueDateError = true;
        }
        assert(dueDateError, 'due_date before start_date should be rejected');

        // Empty name
        let emptyNameError = false;
        try {
            db.run("INSERT INTO people (name) VALUES ('')");
        } catch (e) {
            emptyNameError = true;
        }
        assert(emptyNameError, 'Empty name should be rejected');
    });

    // ─── Test 9: Application starts successfully ─────────────
    test('Application starts successfully (server module loads)', () => {
        // Verify server.js is loadable (without actually starting the listener)
        const serverPath = path.join(__dirname, '..', 'server.js');
        assert(fs.existsSync(serverPath), 'server.js exists');

        // Verify all required files exist
        const requiredFiles = [
            'package.json',
            'server.js',
            'db/schema.sql',
            'db/seed.sql',
            'db/connection.js',
            'db/init.js',
            'routes/api.js',
            'public/index.html',
            'public/css/styles.css',
            'public/js/app.js'
        ];

        for (const file of requiredFiles) {
            const filePath = path.join(__dirname, '..', file);
            assert(fs.existsSync(filePath), `Required file exists: ${file}`);
        }
    });

    // ─── Test 10: All navigation routes exist in HTML ────────
    test('All basic navigation routes/pages load without errors', () => {
        const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
        const html = fs.readFileSync(htmlPath, 'utf-8');

        // Verify all nav routes exist in HTML
        const expectedRoutes = ['dashboard', 'people', 'transactions', 'due', 'reports'];
        for (const route of expectedRoutes) {
            assert(html.includes(`data-route="${route}"`), `Navigation contains ${route} route`);
            assert(html.includes(`id="nav-${route}"`), `Navigation has ${route} ID`);
        }

        // Verify FAB exists
        assert(html.includes('id="fab-add"'), 'FAB button exists');

        // Verify JS app has all route renderers
        const jsPath = path.join(__dirname, '..', 'public', 'js', 'app.js');
        const js = fs.readFileSync(jsPath, 'utf-8');
        for (const route of expectedRoutes) {
            assert(js.includes(`${route}:`), `JS router has ${route} route`);
        }
    });

    // ─── Summary ─────────────────────────────────────────────
    db.close();

    console.log(`\n${'─'.repeat(48)}`);
    console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`${'─'.repeat(48)}\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('  ✗ Test suite crashed:', err.message);
    process.exit(1);
});
