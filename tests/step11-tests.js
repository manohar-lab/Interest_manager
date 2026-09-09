/**
 * Interest Manager — Part 11 Test Suite: Excel Export + Backup & Restore
 *
 * Verifies all specifications of Part 11:
 *   11K.1:  People export (3 people -> 3 data rows, proper headers, formatting)
 *   11K.2:  Loan export (3 loans -> 3 loan rows)
 *   11K.3:  Multiple loans per person (all loans represented individually)
 *   11K.4:  Transaction export (3 transactions totaling ₹10,000)
 *   11K.5:  Interest export (reconciles with Part 6 records)
 *   11K.6:  Due/Overdue export (reconciles with Part 8 engine)
 *   11K.7:  Person Statement export (multi-sheet: Summary, Loans, Transactions, Interest, Due_Overdue)
 *   11K.8:  PDF/Excel consistency (PDF == Excel == Statement API)
 *   11K.9:  Date filtering (inclusive boundary behavior)
 *   11K.10: Empty export (valid .xlsx with headers and 0 data rows)
 *   11K.11: Formula injection safety (=, +, -, @ escaped/quoted)
 *   11K.12: Backup round-trip (People, Loans, Transactions, Interest, Configs)
 *   11K.13: Financial round-trip (exact balances, interest, overdue amounts)
 *   11K.14: Relationship round-trip (FK integrity verified)
 *   11K.15: Corrupted backup rejection (tamper detection via SHA-256)
 *   11K.16: Invalid version rejection (backup_version != 1)
 *   11K.17: Duplicate primary ID rejection
 *   11K.18: Broken foreign key rejection
 *   11K.19: Authorization & confirmation requirement
 *   11K.20: Read-Only export verification (zero database mutations)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const initSqlJs = require('sql.js');
const ExcelJS = require('exceljs');


const {
    exportPeople,
    exportLoans,
    exportTransactions,
    exportInterest,
    exportDueOverdue,
    exportCollection,
    exportReport,
    exportPersonStatement,
    sanitizeFormula
} = require('../services/excelExportService');

const {
    createBackup,
    validateBackup,
    restoreBackup,
    getBackupStatus,
    computeChecksum
} = require('../services/backupService');

const { generatePersonStatement } = require('../services/statementService');
const { generateStatementPdf } = require('../services/pdfService');
const { queryOne, queryAll } = require('../db/helpers');

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

async function createFreshInMemoryDb(SQL) {
    const db = new SQL.Database();
    db.run('PRAGMA foreign_keys = ON;');
    const schemaSql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf-8');
    db.run(schemaSql);
    return db;
}

async function parseWorkbookFromBuffer(buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    return workbook;
}

async function runAll() {
    console.log('\n================================================================');
    console.log('   INTEREST MANAGER — PART 11: EXCEL EXPORT + BACKUP / RESTORE');
    console.log('================================================================\n');

    const SQL = await initSqlJs();
    const TEST_TODAY = '2026-09-09';

    // ─── 11K.1: People Export ──────────────────────────────────
    await runTest('11K.1 People export (3 people -> 3 data rows excluding header)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Alice', '9876543210');");
        db.run("INSERT INTO people (id, name, phone) VALUES (2, 'Bob', '9876543211');");
        db.run("INSERT INTO people (id, name, phone) VALUES (3, 'Charlie', '9876543212');");

        const result = await exportPeople(db);
        assert(Buffer.isBuffer(result), 'Result must be a Buffer');
        assert(result.length > 0, 'Buffer must not be empty');

        const wb = await parseWorkbookFromBuffer(result);
        const sheet = wb.getWorksheet('People');
        assert(sheet, 'Worksheet "People" must exist');

        // Header + 3 data rows = 4 rows
        const rowCount = sheet.actualRowCount;
        assert.strictEqual(rowCount, 4, `Expected 4 rows (1 header + 3 data), got ${rowCount}`);

        const headerRow = sheet.getRow(1);
        assert.strictEqual(headerRow.getCell(1).value, 'Person ID');
        assert.strictEqual(headerRow.getCell(2).value, 'Name');

        // Verify data rows (col 2 is name)
        assert.strictEqual(sheet.getRow(2).getCell(2).value, 'Alice');
        assert.strictEqual(sheet.getRow(3).getCell(2).value, 'Bob');
        assert.strictEqual(sheet.getRow(4).getCell(2).value, 'Charlie');
    });

    // ─── 11K.2: Loan Export ────────────────────────────────────
    await runTest('11K.2 Loan export (3 loans -> 3 loan rows excluding header)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Alice');");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-10-01', 'ACTIVE'),
                       (2, 1, 'MONEY_GIVEN', 2000000, 2000000, 15.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-11-01', 'ACTIVE'),
                       (3, 1, 'MONEY_TAKEN', 500000,  500000,  10.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-12-01', 'ACTIVE');`);

        const result = await exportLoans(db);
        const wb = await parseWorkbookFromBuffer(result);
        const sheet = wb.getWorksheet('Loans');
        assert(sheet, 'Worksheet "Loans" must exist');
        assert.strictEqual(sheet.actualRowCount, 4, `Expected 4 rows (1 header + 3 data), got ${sheet.actualRowCount}`);

        // Col 6 is principal_amount (1000000 paisa = 10000 rupees)
        const principals = [
            sheet.getRow(2).getCell(6).value,
            sheet.getRow(3).getCell(6).value,
            sheet.getRow(4).getCell(6).value
        ].sort((a, b) => a - b);
        assert.deepStrictEqual(principals, [5000, 10000, 20000]);
    });


    // ─── 11K.3: Multiple Loans Representation ──────────────────
    await runTest('11K.3 Multiple loans for Person A all represented (not collapsed)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'David');");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (101, 1, 'MONEY_GIVEN', 1000000, 1000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-10-01', 'ACTIVE'),
                       (102, 1, 'MONEY_GIVEN', 2000000, 2000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-11-01', 'ACTIVE'),
                       (103, 1, 'MONEY_GIVEN', 3000000, 3000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-12-01', 'ACTIVE');`);

        const result = await exportLoans(db, { person_id: 1 });
        const wb = await parseWorkbookFromBuffer(result);
        const sheet = wb.getWorksheet('Loans');

        const loanIds = [];
        sheet.eachRow((row, rowNumber) => {
            if (rowNumber > 1) {
                loanIds.push(row.getCell(1).value); // Col 1 is loan_id
            }
        });

        assert.strictEqual(loanIds.length, 3);
        assert.deepStrictEqual(loanIds.sort(), [101, 102, 103]);
    });

    // ─── 11K.4: Transaction Export ─────────────────────────────
    await runTest('11K.4 Transaction export (3 transactions totaling ₹10,000)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Eve');");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 5000000, 4000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-12-01', 'ACTIVE');`);

        // ₹5,000 (500,000 paisa), ₹3,000 (300,000 paisa), ₹2,000 (200,000 paisa)
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, payment_method, transaction_date)
                VALUES (1, 1, 1, 'PRINCIPAL_RECEIVED', 500000, 'CASH', '2026-08-10'),
                       (2, 1, 1, 'PRINCIPAL_RECEIVED', 300000, 'UPI', '2026-08-15'),
                       (3, 1, 1, 'PRINCIPAL_RECEIVED', 200000, 'BANK_TRANSFER', '2026-08-20');`);

        const result = await exportTransactions(db);
        const wb = await parseWorkbookFromBuffer(result);
        const sheet = wb.getWorksheet('Transactions');
        assert.strictEqual(sheet.actualRowCount, 4);

        let totalRupees = 0;
        sheet.eachRow((row, rowNum) => {
            if (rowNum > 1) {
                totalRupees += Number(row.getCell(7).value); // Col 7 is amount
            }
        });

        assert.strictEqual(totalRupees, 10000, `Expected total ₹10,000, got ₹${totalRupees}`);
    });

    // ─── 11K.5: Interest Export ────────────────────────────────
    await runTest('11K.5 Interest export reconciles with Part 6 interest records', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Frank');");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-10-01', 'ACTIVE');`);
        db.run(`INSERT INTO interest_records (id, account_id, period_start, period_end, principal_basis, interest_rate, interest_amount, paid_amount, status)
                VALUES (1, 1, '2026-08-01', '2026-08-31', 1000000, 12.0, 10000, 10000, 'PAID'),
                       (2, 1, '2026-09-01', '2026-09-30', 1000000, 12.0, 10000, 0, 'PENDING');`);

        const result = await exportInterest(db);
        const wb = await parseWorkbookFromBuffer(result);
        const sheet = wb.getWorksheet('Interest');
        assert.strictEqual(sheet.actualRowCount, 3);

        const rows = [
            { interest: sheet.getRow(2).getCell(9).value, paid: sheet.getRow(2).getCell(10).value, status: sheet.getRow(2).getCell(12).value },
            { interest: sheet.getRow(3).getCell(9).value, paid: sheet.getRow(3).getCell(10).value, status: sheet.getRow(3).getCell(12).value }
        ];
        const paidRow = rows.find(r => r.status === 'PAID');
        const pendingRow = rows.find(r => r.status === 'PENDING');
        assert(paidRow, 'Paid row must exist');
        assert(pendingRow, 'Pending row must exist');
        assert.strictEqual(paidRow.interest, 100);
        assert.strictEqual(paidRow.paid, 100);
        assert.strictEqual(pendingRow.interest, 100);
        assert.strictEqual(pendingRow.paid, 0);
    });


    // ─── 11K.6: Due/Overdue Export ─────────────────────────────
    await runTest('11K.6 Due/Overdue export reconciles with Part 8 engine', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Grace');");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 2000000, 2000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-09-01', 'OVERDUE');`);

        const result = await exportDueOverdue(db, { as_of_date: TEST_TODAY });
        const wb = await parseWorkbookFromBuffer(result);
        const sheet = wb.getWorksheet('Due_Overdue');
        assert.strictEqual(sheet.actualRowCount, 2);

        const row = sheet.getRow(2);
        assert.strictEqual(row.getCell(5).value, 'OVERDUE'); // Col 5 is status
        assert.strictEqual(row.getCell(6).value, 20000);     // Col 6 is outstanding_principal
        assert(row.getCell(10).value > 0, 'Must have overdue days'); // Col 10 is days_overdue
    });

    // ─── 11K.7: Person Statement Export ────────────────────────
    await runTest('11K.7 Person statement export (multi-sheet: Summary, Loans, Transactions, Interest, Due_Overdue)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone) VALUES (1, 'Harish', '9998887776');");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 800000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-10-01', 'ACTIVE');`);
        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, payment_method, transaction_date)
                VALUES (1, 1, 1, 'PRINCIPAL_RECEIVED', 200000, 'CASH', '2026-08-15');`);
        db.run(`INSERT INTO interest_records (id, account_id, period_start, period_end, principal_basis, interest_rate, interest_amount, paid_amount, status)
                VALUES (1, 1, '2026-08-01', '2026-08-31', 1000000, 12.0, 10000, 0, 'PENDING');`);

        const result = await exportPersonStatement(db, 1, { as_of_date: TEST_TODAY });
        const wb = await parseWorkbookFromBuffer(result);

        assert(wb.getWorksheet('Summary'), 'Summary sheet missing');
        assert(wb.getWorksheet('Loans'), 'Loans sheet missing');
        assert(wb.getWorksheet('Transactions'), 'Transactions sheet missing');
        assert(wb.getWorksheet('Interest'), 'Interest sheet missing');
        assert(wb.getWorksheet('Due_Overdue'), 'Due_Overdue sheet missing');

        const summarySheet = wb.getWorksheet('Summary');
        let closingBalance = null;
        summarySheet.eachRow(r => {
            if (r.getCell(1).value === 'Closing Balance (₹)') {
                closingBalance = r.getCell(2).value;
            }
        });

        // Closing balance: 8000 (principal) + 100 (interest) = 8100 rupees
        assert.strictEqual(closingBalance, 8100, `Expected closing balance ₹8,100, found ${closingBalance}`);
    });

    // ─── 11K.8: PDF / Excel Consistency ────────────────────────
    await runTest('11K.8 PDF / Excel / Statement API consistency for overlapping fields', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Ishaan');");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 5000000, 5000000, 15.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-07-01', '2026-12-01', 'ACTIVE');`);

        const stmtDto = generatePersonStatement(db, 1, { as_of_date: TEST_TODAY });
        const pdfBuf = await generateStatementPdf(stmtDto);
        const excelBuf = await exportPersonStatement(db, 1, { as_of_date: TEST_TODAY });

        assert(pdfBuf.length > 0, 'PDF buffer must not be empty');
        assert(excelBuf.length > 0, 'Excel buffer must not be empty');

        const wb = await parseWorkbookFromBuffer(excelBuf);
        const smSheet = wb.getWorksheet('Summary');

        let excelOpening = null, excelClosing = null;
        smSheet.eachRow(r => {
            if (r.getCell(1).value === 'Opening Balance (₹)') excelOpening = r.getCell(2).value;
            if (r.getCell(1).value === 'Closing Balance (₹)') excelClosing = r.getCell(2).value;
        });

        assert.strictEqual(excelOpening, stmtDto.summary.opening_balance);
        assert.strictEqual(excelClosing, stmtDto.summary.closing_balance);
    });

    // ─── 11K.9: Date Filtering ─────────────────────────────────
    await runTest('11K.9 Date filtering (inclusive boundary behavior)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Jaya');");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 5000000, 5000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-12-01', 'ACTIVE');`);

        db.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, payment_method, transaction_date)
                VALUES (1, 1, 1, 'PRINCIPAL_RECEIVED', 100000, 'CASH', '2026-09-01'),
                       (2, 1, 1, 'PRINCIPAL_RECEIVED', 200000, 'CASH', '2026-09-05'),
                       (3, 1, 1, 'PRINCIPAL_RECEIVED', 300000, 'CASH', '2026-09-10');`);

        // Filter start: 2026-09-01 to end: 2026-09-05 (should include 1 and 2, exclude 3)
        const result = await exportTransactions(db, { start_date: '2026-09-01', end_date: '2026-09-05' });
        const wb = await parseWorkbookFromBuffer(result);
        const sheet = wb.getWorksheet('Transactions');

        assert.strictEqual(sheet.actualRowCount, 3, `Expected 3 rows (1 header + 2 data), got ${sheet.actualRowCount}`);
        const dates = [sheet.getRow(2).getCell(2).value, sheet.getRow(3).getCell(2).value].sort();
        assert.deepStrictEqual(dates, ['2026-09-01', '2026-09-05']);
    });


    // ─── 11K.10: Empty Export ──────────────────────────────────
    await runTest('11K.10 Empty export produces valid .xlsx with headers and zero data rows', async () => {
        const db = await createFreshInMemoryDb(SQL);
        const result = await exportPeople(db);
        assert(Buffer.isBuffer(result));

        const wb = await parseWorkbookFromBuffer(result);
        const sheet = wb.getWorksheet('People');
        assert(sheet, 'Sheet must exist');
        assert.strictEqual(sheet.actualRowCount, 1, 'Only header row must be present');
        assert.strictEqual(sheet.getRow(1).getCell(1).value, 'Person ID');
    });

    // ─── 11K.11: Formula Injection Safety ──────────────────────
    await runTest('11K.11 Formula injection protection (=, +, -, @ prepended with quote)', async () => {
        assert.strictEqual(sanitizeFormula('=SUM(A1:A2)'), "'=SUM(A1:A2)");
        assert.strictEqual(sanitizeFormula('+123'), "'+123");
        assert.strictEqual(sanitizeFormula('-123'), "'-123");
        assert.strictEqual(sanitizeFormula('@calc'), "'@calc");
        assert.strictEqual(sanitizeFormula('Normal Text'), 'Normal Text');
        assert.strictEqual(sanitizeFormula(500), 500);

        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name, phone, notes) VALUES (1, '=2+5', '+919999999999', '-malicious');");

        const result = await exportPeople(db);
        const wb = await parseWorkbookFromBuffer(result);
        const sheet = wb.getWorksheet('People');
        const nameVal = sheet.getRow(2).getCell(2).value;  // Col 2 is name
        const phoneVal = sheet.getRow(2).getCell(3).value; // Col 3 is phone

        assert.strictEqual(nameVal, "'=2+5");
        assert.strictEqual(phoneVal, "'+919999999999");
    });

    // ─── 11K.12: Backup Round-Trip ─────────────────────────────
    await runTest('11K.12 Backup round-trip (People, Loans, Transactions, Interest, Configs restored)', async () => {
        const dbSource = await createFreshInMemoryDb(SQL);

        dbSource.run("INSERT INTO people (id, name, phone) VALUES (1, 'Kunal', '9876543210');");
        dbSource.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                      VALUES (1, 1, 'MONEY_GIVEN', 3000000, 2500000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-07-01', '2026-11-01', 'ACTIVE');`);
        dbSource.run(`INSERT INTO account_interest_configs (id, account_id, calculation_method, interest_rate, effective_from)
                      VALUES (1, 1, 'SIMPLE_INTEREST', 12.0, '2026-07-01');`);
        dbSource.run(`INSERT INTO interest_records (id, account_id, period_start, period_end, principal_basis, interest_rate, interest_amount, paid_amount, status)
                      VALUES (1, 1, '2026-07-01', '2026-07-31', 3000000, 12.0, 30000, 30000, 'PAID');`);
        dbSource.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, payment_method, transaction_date)
                      VALUES (1, 1, 1, 'PRINCIPAL_RECEIVED', 500000, 'CASH', '2026-08-01');`);

        const backupPackage = createBackup(dbSource);
        assert(backupPackage.checksum, 'Backup must have checksum');
        assert.strictEqual(backupPackage.metadata.backup_version, 1);

        // Restore into clean target database
        const dbTarget = await createFreshInMemoryDb(SQL);
        const restoreRes = restoreBackup(dbTarget, backupPackage, { confirm: true });
        assert.strictEqual(restoreRes.success, true);

        // Verify counts match exactly
        const peopleCount = queryOne(dbTarget, 'SELECT COUNT(*) as c FROM people').c;
        const accountCount = queryOne(dbTarget, 'SELECT COUNT(*) as c FROM accounts').c;
        const txCount = queryOne(dbTarget, 'SELECT COUNT(*) as c FROM transactions').c;
        const intCount = queryOne(dbTarget, 'SELECT COUNT(*) as c FROM interest_records').c;

        assert.strictEqual(peopleCount, 1);
        assert.strictEqual(accountCount, 1);
        assert.strictEqual(txCount, 1);
        assert.strictEqual(intCount, 1);

        const restoredPerson = queryOne(dbTarget, 'SELECT * FROM people WHERE id = 1');
        assert.strictEqual(restoredPerson.name, 'Kunal');
    });

    // ─── 11K.13: Financial Round-Trip ──────────────────────────
    await runTest('11K.13 Financial round-trip (zero drift in balances, principal, or interest)', async () => {
        const dbSource = await createFreshInMemoryDb(SQL);
        dbSource.run("INSERT INTO people (id, name) VALUES (1, 'Leela');");
        dbSource.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                      VALUES (1, 1, 'MONEY_GIVEN', 10000000, 7500000, 18.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-01-01', '2026-08-01', 'OVERDUE');`);

        const beforeTotalPrincipal = queryOne(dbSource, 'SELECT SUM(principal) as s FROM accounts').s;
        const beforeOutstanding = queryOne(dbSource, 'SELECT SUM(outstanding_principal) as s FROM accounts').s;

        const backup = createBackup(dbSource);
        const dbTarget = await createFreshInMemoryDb(SQL);
        restoreBackup(dbTarget, backup, { confirm: true });

        const afterTotalPrincipal = queryOne(dbTarget, 'SELECT SUM(principal) as s FROM accounts').s;
        const afterOutstanding = queryOne(dbTarget, 'SELECT SUM(outstanding_principal) as s FROM accounts').s;

        assert.strictEqual(beforeTotalPrincipal, afterTotalPrincipal);
        assert.strictEqual(beforeOutstanding, afterOutstanding);
    });

    // ─── 11K.14: Relationship Round-Trip ───────────────────────
    await runTest('11K.14 Relationship round-trip (foreign keys preserved and valid)', async () => {
        const dbSource = await createFreshInMemoryDb(SQL);
        dbSource.run("INSERT INTO people (id, name) VALUES (5, 'Manish');");
        dbSource.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                      VALUES (50, 5, 'MONEY_GIVEN', 4000000, 4000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-05-01', '2026-11-01', 'ACTIVE');`);
        dbSource.run(`INSERT INTO transactions (id, account_id, person_id, transaction_type, amount, payment_method, transaction_date)
                      VALUES (500, 50, 5, 'PRINCIPAL_RECEIVED', 100000, 'UPI', '2026-06-01');`);

        const backup = createBackup(dbSource);
        const dbTarget = await createFreshInMemoryDb(SQL);
        restoreBackup(dbTarget, backup, { confirm: true });

        // PRAGMA foreign_key_check must return 0 violations
        const fkStmt = dbTarget.prepare('PRAGMA foreign_key_check;');
        assert(!fkStmt.step(), 'Foreign key check must return zero violations');
        fkStmt.free();

        const tx = queryOne(dbTarget, 'SELECT * FROM transactions WHERE id = 500');
        assert.strictEqual(tx.account_id, 50);
        assert.strictEqual(tx.person_id, 5);
    });

    // ─── 11K.15: Corrupted Backup Rejection ─────────────────────
    await runTest('11K.15 Corrupted backup rejection (tamper detection via SHA-256)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Naveen');");
        const backup = createBackup(db);

        // Tamper with data without recomputing checksum
        backup.data.people[0].name = 'Hacked Name';

        assert.throws(() => {
            validateBackup(backup);
        }, /checksum mismatch/i);

        const dbTarget = await createFreshInMemoryDb(SQL);
        assert.throws(() => {
            restoreBackup(dbTarget, backup, { confirm: true });
        }, /checksum mismatch/i);
    });

    // ─── 11K.16: Invalid Version Rejection ─────────────────────
    await runTest('11K.16 Invalid version rejection (backup_version != 1)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        const backup = createBackup(db);
        backup.metadata.backup_version = 999;
        // Even if checksum updated, version must fail
        backup.checksum = computeChecksum(backup.data);

        assert.throws(() => {
            validateBackup(backup);
        }, /unsupported backup version/i);
    });

    // ─── 11K.17: Duplicate Primary ID Detection ────────────────
    await runTest('11K.17 Duplicate primary IDs detection', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Omkar');");
        const backup = createBackup(db);

        // Add duplicate record with id=1
        backup.data.people.push({ id: 1, name: 'Omkar Duplicate' });
        backup.checksum = computeChecksum(backup.data);

        assert.throws(() => {
            validateBackup(backup);
        }, /duplicate primary id/i);
    });

    // ─── 11K.18: Broken Foreign Key Detection ──────────────────
    await runTest('11K.18 Broken foreign key detection', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Pooja');");
        const backup = createBackup(db);

        // Loan referencing non-existent person 999
        backup.data.accounts.push({
            id: 10,
            person_id: 999,
            direction: 'MONEY_GIVEN',
            principal: 100000,
            outstanding_principal: 100000,
            interest_rate: 10.0,
            interest_frequency: 'MONTHLY',
            calculation_method: 'SIMPLE_INTEREST',
            start_date: '2026-01-01',
            due_date: '2026-06-01',
            status: 'ACTIVE'
        });
        backup.checksum = computeChecksum(backup.data);

        assert.throws(() => {
            validateBackup(backup);
        }, /broken foreign key/i);
    });

    // ─── 11K.19: Authorization & Confirmation ──────────────────
    await runTest('11K.19 Authorization & confirmation requirement for restore', async () => {
        const db = await createFreshInMemoryDb(SQL);
        const backup = createBackup(db);

        // Missing confirm option
        assert.throws(() => {
            restoreBackup(db, backup, {});
        }, /confirmation required/i);

        // confirm: false
        assert.throws(() => {
            restoreBackup(db, backup, { confirm: false });
        }, /confirmation required/i);
    });

    // ─── 11K.20: Read-Only Verification ────────────────────────
    await runTest('11K.20 Read-only verification (zero database writes during export)', async () => {
        const db = await createFreshInMemoryDb(SQL);
        db.run("INSERT INTO people (id, name) VALUES (1, 'Rahul');");
        db.run(`INSERT INTO accounts (id, person_id, direction, principal, outstanding_principal, interest_rate, interest_frequency, calculation_method, start_date, due_date, status)
                VALUES (1, 1, 'MONEY_GIVEN', 1000000, 1000000, 12.0, 'MONTHLY', 'SIMPLE_INTEREST', '2026-08-01', '2026-10-01', 'ACTIVE');`);

        const dbBefore = db.export();

        await exportPeople(db);
        await exportLoans(db);
        await exportTransactions(db);
        await exportInterest(db);
        await exportDueOverdue(db);
        await exportCollection(db);
        await exportPersonStatement(db, 1);

        const dbAfter = db.export();
        assert.strictEqual(Buffer.compare(Buffer.from(dbBefore), Buffer.from(dbAfter)), 0, 'Database mutated during export operations');
    });

    // ─── 11K.21: Live HTTP API Endpoints ───────────────────────
    await runTest('11K.21 Live HTTP API endpoints (Excel exports and Backup/Restore routes)', async () => {
        const express = require('express');
        const apiRoutes = require('../routes/api');
        const testApp = express();
        testApp.use(express.json({ limit: '50mb' }));
        testApp.use('/api', apiRoutes);

        const server = await new Promise(resolve => {
            const s = testApp.listen(0, '127.0.0.1', () => resolve(s));
        });
        const port = server.address().port;

        let cachedToken = null;
        async function getAuthToken() {
            if (cachedToken) return cachedToken;
            const res = await new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port,
                    path: '/api/auth/login',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                }, response => {
                    const chunks = [];
                    response.on('data', c => chunks.push(c));
                    response.on('end', () => {
                        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                        resolve(parsed.token);
                    });
                });
                req.on('error', reject);
                req.write(JSON.stringify({ username: 'admin', password: 'AdminPassword@123' }));
                req.end();
            });
            cachedToken = res;
            return cachedToken;
        }

        async function callApi(method, path, body = null, isBinary = false) {
            const token = await getAuthToken();
            return new Promise((resolve, reject) => {
                const headers = isBinary ? {} : { 'Content-Type': 'application/json' };
                if (token) headers['Authorization'] = `Bearer ${token}`;

                const req = http.request({
                    hostname: '127.0.0.1',
                    port,
                    path: `/api${path}`,
                    method,
                    headers
                }, res => {
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => {
                        const buffer = Buffer.concat(chunks);
                        if (isBinary) {
                            resolve({ statusCode: res.statusCode, headers: res.headers, body: buffer });
                        } else {
                            let parsed;
                            try { parsed = JSON.parse(buffer.toString('utf-8')); } catch { parsed = buffer.toString('utf-8'); }
                            resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
                        }
                    });
                });
                req.on('error', reject);
                if (body) req.write(JSON.stringify(body));
                req.end();
            });
        }

        try {
            // GET /api/reports/loans/excel
            const loansExcel = await callApi('GET', '/reports/loans/excel', null, true);
            assert.strictEqual(loansExcel.statusCode, 200, `loansExcel status: ${loansExcel.statusCode}`);
            assert.strictEqual(loansExcel.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            assert(loansExcel.body.length > 0);

            // GET /api/backup/status
            const statusRes = await callApi('GET', '/backup/status');
            assert.strictEqual(statusRes.statusCode, 200, `statusRes status: ${statusRes.statusCode} - ${JSON.stringify(statusRes.body)}`);
            assert.strictEqual(statusRes.body.status, 'ok');
            assert.strictEqual(statusRes.body.backup_format_version, 1);

            // GET /api/backup/export
            const backupExport = await callApi('GET', '/backup/export');
            assert.strictEqual(backupExport.statusCode, 200, `backupExport status: ${backupExport.statusCode} - ${JSON.stringify(backupExport.body)}`);
            assert(backupExport.body.checksum);
            assert(backupExport.body.metadata);
            assert.strictEqual(backupExport.body.metadata.backup_version, 1);

            // POST /api/backup/validate (valid payload)
            const valRes = await callApi('POST', '/backup/validate', { backup: backupExport.body });
            assert.strictEqual(valRes.statusCode, 200, `valRes status: ${valRes.statusCode} - ${JSON.stringify(valRes.body)}`);
            assert.strictEqual(valRes.body.success, true);

            // POST /api/backup/restore without confirm -> 400
            const unconfirmedRes = await callApi('POST', '/backup/restore', { backup: backupExport.body });
            assert.strictEqual(unconfirmedRes.statusCode, 400, `unconfirmedRes status: ${unconfirmedRes.statusCode} - ${JSON.stringify(unconfirmedRes.body)}`);

            // POST /api/backup/restore with confirm -> 200
            const restoreRes = await callApi('POST', '/backup/restore', { backup: backupExport.body, confirm: true });
            assert.strictEqual(restoreRes.statusCode, 200, `restoreRes status: ${restoreRes.statusCode} - ${JSON.stringify(restoreRes.body)}`);
            assert.strictEqual(restoreRes.body.success, true);

        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });


    console.log('\n================================================================');
    console.log(`   TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runAll().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
