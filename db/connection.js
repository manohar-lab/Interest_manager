const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, 'interest_manager.db');

let db = null;
let SQL = null;

/**
 * Initialize the sql.js engine and load (or create) the database file.
 * Returns the database instance.
 */
async function getDatabase() {
    if (db) return db;

    if (!SQL) {
        SQL = await initSqlJs();
    }

    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    // Enable foreign keys
    db.run('PRAGMA foreign_keys = ON;');

    return db;
}

/**
 * Save the in-memory database to disk.
 */
function saveDatabase() {
    if (db) {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(DB_PATH, buffer);
    }
}

/**
 * Close and save the database.
 */
function closeDatabase() {
    if (db) {
        saveDatabase();
        db.close();
        db = null;
    }
}

/**
 * Reset the database — delete file and clear in-memory reference.
 */
function resetDatabase() {
    if (db) {
        db.close();
        db = null;
    }
    if (fs.existsSync(DB_PATH)) {
        fs.unlinkSync(DB_PATH);
    }
}

module.exports = { getDatabase, saveDatabase, closeDatabase, resetDatabase, DB_PATH };
