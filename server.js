const express = require('express');
const path = require('path');
const { getDatabase, saveDatabase, closeDatabase } = require('./db/connection');
const apiRoutes = require('./routes/api');
const { registerScheduler, stopScheduler } = require('./services/schedulerService');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ──────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));


// ─── Static files ────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── API routes ──────────────────────────────────────────────
app.use('/api', apiRoutes);

// ─── SPA fallback — serve index.html for all non-API routes ─
app.get('/{*splat}', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Auto-save database periodically ────────────────────────
setInterval(() => {
    try { saveDatabase(); } catch (_) {}
}, 30000); // every 30 seconds

// ─── Graceful shutdown ──────────────────────────────────────
process.on('SIGINT', () => {
    console.log('\nShutting down gracefully...');
    stopScheduler();
    closeDatabase();
    process.exit(0);
});

process.on('SIGTERM', () => {
    stopScheduler();
    closeDatabase();
    process.exit(0);
});

// ─── Start server ────────────────────────────────────────────
async function start() {
    try {
        const db = await getDatabase();
        // Verify tables
        const stmt = db.prepare(
            "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        );
        stmt.step();
        const tableCount = stmt.getAsObject().count;
        stmt.free();

        app.listen(PORT, () => {
            console.log(`\n  ✦ Interest Manager running at http://localhost:${PORT}`);
            console.log(`  ✦ Database: ${tableCount} tables connected`);
            console.log(`  ✦ Press Ctrl+C to stop\n`);

            // ─── Step 5K: Register automatic interest accrual scheduler ──
            // Runs once 10s after startup, then every 24 hours.
            // Singleton guard in registerScheduler() prevents double-registration (§26).
            registerScheduler(db);
        });
    } catch (err) {
        console.error('  ✗ Startup failed:', err.message);
        console.error('  ✗ Run "npm run db:init" first to initialize the database.\n');
        process.exit(1);
    }
}

start();

module.exports = app;
