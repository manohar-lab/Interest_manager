/**
 * Interest Manager — Database Helper Functions
 * Standardized query helpers for sql.js.
 */

function queryAll(db, sql, params = []) {
    const stmt = db.prepare(sql);
    if (params && params.length) stmt.bind(params);
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

module.exports = { queryAll, queryOne };
