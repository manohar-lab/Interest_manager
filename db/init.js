const fs = require('fs');
const path = require('path');
const { getDatabase, saveDatabase, closeDatabase, resetDatabase, seedDefaultUsers } = require('./connection');

/**
 * Initialize the database: run schema.sql then seed.sql.
 * Deletes existing DB file to ensure a clean state.
 */
async function initDatabase() {
    console.log('=== Interest Manager — Database Initialization ===\n');

    // Remove existing database for a clean init
    resetDatabase();
    console.log('  ✓ Clean slate prepared');

    const db = await getDatabase();

    // Read and execute schema
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
    db.run(schemaSql);
    console.log('  ✓ Schema created (tables, indexes, triggers)');

    // Seed default administrative and staff users
    seedDefaultUsers(db);
    console.log('  ✓ Default security users seeded (admin, staff, viewer)');

    // Verify tables exist
    const tablesStmt = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    const tables = [];
    while (tablesStmt.step()) {
        tables.push(tablesStmt.getAsObject().name);
    }
    tablesStmt.free();
    console.log(`  ✓ Tables: ${tables.join(', ')}`);

    // Read and execute seed data
    const seedPath = path.join(__dirname, 'seed.sql');
    const seedSql = fs.readFileSync(seedPath, 'utf-8');
    db.run(seedSql);
    console.log('  ✓ Seed data inserted');

    // Verify seed data — people
    const peopleStmt = db.prepare('SELECT id, name FROM people');
    const people = [];
    while (peopleStmt.step()) {
        people.push(peopleStmt.getAsObject());
    }
    peopleStmt.free();
    console.log(`  ✓ People: ${people.map(p => `${p.name} (id=${p.id})`).join(', ')}`);

    // Verify seed data — accounts
    const accStmt = db.prepare(
        'SELECT a.id, p.name, a.direction, a.principal, a.interest_rate FROM accounts a JOIN people p ON a.person_id = p.id'
    );
    const accounts = [];
    while (accStmt.step()) {
        accounts.push(accStmt.getAsObject());
    }
    accStmt.free();

    console.log(`  ✓ Accounts: ${accounts.length} total`);
    accounts.forEach(a => {
        const rupees = (a.principal / 100).toLocaleString('en-IN');
        console.log(`      → ${a.name}: ₹${rupees} @ ${a.interest_rate}% (${a.direction})`);
    });

    // Save to disk
    saveDatabase();
    console.log('  ✓ Database saved to disk');

    console.log('\n=== Database initialization complete ===');
    closeDatabase();
}

// Run if called directly
if (require.main === module) {
    initDatabase().catch(err => {
        console.error('  ✗ Initialization failed:', err.message);
        process.exit(1);
    });
}

module.exports = { initDatabase };
