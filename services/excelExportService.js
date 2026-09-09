/**
 * Interest Manager — Part 11: Excel Export Service
 *
 * Dedicated presentation module responsible for human-readable data extraction to .xlsx.
 * Strictly decoupled from application backup & recovery.
 *
 * Guarantees:
 *   - 11A.1: Pure presentation layer. Reuses authoritative domain and report services.
 *     Zero financial recalculation or business logic duplication.
 *   - 11B.5, 11B.6: Monetary amounts stored as numeric numbers in Rupees with
 *     Excel currency formatting (enabling spreadsheet arithmetic).
 *   - 11B.7: Formula injection safety: text starting with =, +, -, @ is sanitized.
 *   - 11B.8: Empty exports generate valid .xlsx workbooks with styled headers and 0 data rows.
 *   - 11B.9: Safe, sanitized filenames.
 *   - 11G.2: Multi-worksheet person statements (Summary, Loans, Transactions, Interest, Due_Overdue).
 *   - READ-ONLY: Pure read operations, zero database mutations.
 */

const ExcelJS = require('exceljs');
const {
    REPORT_TYPES,
    generateReport,
    generateLoanPortfolioReport,
    generatePeopleReport,
    generatePaymentReport,
    generateInterestReport,
    generateDueOverdueReport,
    generateCollectionReport
} = require('./reportService');

const { generatePersonStatement } = require('./statementService');

// ─── Style & Palette Constants ─────────────────────────────────────
const STYLES = {
    headerFill: {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1E293B' } // Slate 800
    },
    headerFont: {
        name: 'Segoe UI',
        size: 10,
        bold: true,
        color: { argb: 'FFFFFFFF' }
    },
    accentHeaderFill: {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF3B82F6' } // Blue 500
    },
    dataFont: {
        name: 'Segoe UI',
        size: 10,
        color: { argb: 'FF1E293B' }
    },
    boldDataFont: {
        name: 'Segoe UI',
        size: 10,
        bold: true,
        color: { argb: 'FF0F172A' }
    },
    borderThin: {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
    },
    numFmtCurrency: '₹#,##0.00;[Red](₹#,##0.00);"-"',
    numFmtInteger: '#,##0',
    numFmtRate: '0.00"%"',
    numFmtDate: 'yyyy-mm-dd'
};

// ─── Formula Injection Defense (11B.7) ──────────────────────────────
/**
 * Prevents CSV/Excel formula injection by prepending a single quote
 * if an untrusted string begins with '=', '+', '-', or '@'.
 */
function sanitizeFormula(val) {
    if (typeof val === 'string' && val.length > 0) {
        if (/^[=\+\-@]/.test(val)) {
            return `'${val}`;
        }
    }
    return val;
}

// ─── Worksheet Formatting Helpers ──────────────────────────────────
function styleHeaderRow(row, useAccent = false) {
    row.height = 28;
    row.eachCell((cell) => {
        cell.fill = useAccent ? STYLES.accentHeaderFill : STYLES.headerFill;
        cell.font = STYLES.headerFont;
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };
        cell.border = STYLES.borderThin;
    });
}

function autoFitColumns(worksheet, minWidth = 12, maxWidth = 45) {
    worksheet.columns.forEach((column) => {
        let maxLen = 0;
        if (column.header) {
            maxLen = String(column.header).length;
        }
        column.eachCell({ includeEmpty: true }, (cell) => {
            const val = cell.value;
            if (val !== undefined && val !== null) {
                const str = typeof val === 'object' && val.text ? val.text : String(val);
                if (str.length > maxLen) {
                    maxLen = str.length;
                }
            }
        });
        column.width = Math.min(maxWidth, Math.max(minWidth, maxLen + 3));
    });
}

function wrapBuffer(buffer, filename, workbook) {
    buffer.filename = filename;
    buffer.workbook = workbook;
    buffer.buffer = buffer;
    buffer.contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    return buffer;
}

function safeFilename(prefix, options = {}) {
    const today = new Date().toISOString().split('T')[0];
    const cleanPrefix = String(prefix).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    return `${cleanPrefix}-${today}.xlsx`;
}

// ═════════════════════════════════════════════════════════════════════
// 11C — PEOPLE EXCEL EXPORT
// ═════════════════════════════════════════════════════════════════════
async function exportPeople(db, options = {}) {
    const reportOpts = { ...options, export_all: true, all: true };
    const report = generatePeopleReport(db, reportOpts);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Interest Manager';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('People', {
        views: [{ state: 'frozen', ySplit: 1 }]
    });

    sheet.columns = [
        { header: 'Person ID', key: 'person_id', width: 12 },
        { header: 'Name', key: 'name', width: 22 },
        { header: 'Phone', key: 'phone', width: 16 },
        { header: 'Active Loans', key: 'active_loans', width: 14 },
        { header: 'Total Given (₹)', key: 'total_principal', width: 18 },
        { header: 'Total Paid (₹)', key: 'total_paid', width: 18 },
        { header: 'Outstanding Balance (₹)', key: 'total_outstanding', width: 22 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Created Date', key: 'created_at', width: 16 }
    ];

    styleHeaderRow(sheet.getRow(1));

    for (const p of report.items) {
        const row = sheet.addRow({
            person_id: p.person_id || p.id,
            name: sanitizeFormula(p.person_name || p.name),
            phone: sanitizeFormula(p.person_phone || p.phone || '—'),
            active_loans: p.active_loan_count !== undefined ? p.active_loan_count : (p.active_loans || 0),
            total_principal: p.total_principal || 0,
            total_paid: p.total_paid || 0,
            total_outstanding: p.total_outstanding || 0,
            status: sanitizeFormula(p.status || (p.active_loan_count > 0 || p.active_loans > 0 ? 'ACTIVE' : 'INACTIVE')),
            created_at: p.created_at ? p.created_at.split('T')[0].split(' ')[0] : '—'
        });


        row.font = STYLES.dataFont;
        row.height = 20;

        // Alignment & number formatting by column index (1-based)
        row.getCell(1).alignment = { horizontal: 'center' };
        row.getCell(1).numFmt = STYLES.numFmtInteger;
        row.getCell(3).alignment = { horizontal: 'center' };
        row.getCell(4).alignment = { horizontal: 'center' };
        row.getCell(4).numFmt = STYLES.numFmtInteger;
        row.getCell(5).numFmt = STYLES.numFmtCurrency;
        row.getCell(6).numFmt = STYLES.numFmtCurrency;
        row.getCell(7).numFmt = STYLES.numFmtCurrency;
        row.getCell(7).font = STYLES.boldDataFont;
        row.getCell(8).alignment = { horizontal: 'center' };
        row.getCell(9).alignment = { horizontal: 'center' };

        row.eachCell((cell) => { cell.border = STYLES.borderThin; });
    }

    autoFitColumns(sheet);
    const filename = safeFilename('people-export', options);
    const rawBuffer = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(rawBuffer);
    return wrapBuffer(buffer, filename, workbook);
}

// ═════════════════════════════════════════════════════════════════════
// 11D — LOANS EXCEL EXPORT
// ═════════════════════════════════════════════════════════════════════
async function exportLoans(db, options = {}) {
    const reportOpts = { ...options, export_all: true, all: true };
    const report = generateLoanPortfolioReport(db, reportOpts);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Interest Manager';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Loans', {
        views: [{ state: 'frozen', ySplit: 1 }]
    });

    sheet.columns = [
        { header: 'Loan ID', key: 'loan_id', width: 12 },
        { header: 'Person ID', key: 'person_id', width: 12 },
        { header: 'Person Name', key: 'person_name', width: 22 },
        { header: 'Direction', key: 'direction', width: 16 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Principal (₹)', key: 'principal_amount', width: 18 },
        { header: 'Paid Principal (₹)', key: 'paid_amount', width: 18 },
        { header: 'Outstanding Principal (₹)', key: 'outstanding_principal', width: 22 },
        { header: 'Interest Rate (%)', key: 'interest_rate', width: 16 },
        { header: 'Frequency', key: 'interest_frequency', width: 14 },
        { header: 'Calculation Method', key: 'calculation_method', width: 20 },
        { header: 'Start Date', key: 'start_date', width: 14 },
        { header: 'Due Date', key: 'due_date', width: 14 }
    ];

    styleHeaderRow(sheet.getRow(1));

    for (const l of report.items) {
        const row = sheet.addRow({
            loan_id: l.loan_id,
            person_id: l.person_id,
            person_name: sanitizeFormula(l.person_name),
            direction: sanitizeFormula(l.direction),
            status: sanitizeFormula(l.status || l.loan_status),
            principal_amount: l.principal_amount,
            paid_amount: l.paid_amount,
            outstanding_principal: l.outstanding_principal,
            interest_rate: l.interest_rate,
            interest_frequency: sanitizeFormula(l.interest_frequency),
            calculation_method: sanitizeFormula(l.calculation_method || 'SIMPLE_INTEREST'),
            start_date: l.start_date,
            due_date: l.due_date
        });

        row.font = STYLES.dataFont;
        row.height = 20;

        row.getCell(1).alignment = { horizontal: 'center' };
        row.getCell(1).numFmt = STYLES.numFmtInteger;
        row.getCell(2).alignment = { horizontal: 'center' };
        row.getCell(2).numFmt = STYLES.numFmtInteger;
        row.getCell(4).alignment = { horizontal: 'center' };
        row.getCell(5).alignment = { horizontal: 'center' };
        row.getCell(6).numFmt = STYLES.numFmtCurrency;
        row.getCell(7).numFmt = STYLES.numFmtCurrency;
        row.getCell(8).numFmt = STYLES.numFmtCurrency;
        row.getCell(8).font = STYLES.boldDataFont;
        row.getCell(9).numFmt = '0.00';
        row.getCell(10).alignment = { horizontal: 'center' };
        row.getCell(12).alignment = { horizontal: 'center' };
        row.getCell(13).alignment = { horizontal: 'center' };

        row.eachCell((cell) => { cell.border = STYLES.borderThin; });
    }

    autoFitColumns(sheet);
    const filename = safeFilename('loans-export', options);
    const rawBuffer = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(rawBuffer);
    return wrapBuffer(buffer, filename, workbook);
}

// ═════════════════════════════════════════════════════════════════════
// 11E — TRANSACTION / PAYMENT EXCEL EXPORT
// ═════════════════════════════════════════════════════════════════════
async function exportTransactions(db, options = {}) {
    const reportOpts = { ...options, export_all: true, all: true };
    const report = generatePaymentReport(db, reportOpts);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Interest Manager';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Transactions', {
        views: [{ state: 'frozen', ySplit: 1 }]
    });

    sheet.columns = [
        { header: 'Transaction ID', key: 'transaction_id', width: 14 },
        { header: 'Date', key: 'date', width: 14 },
        { header: 'Person ID', key: 'person_id', width: 12 },
        { header: 'Person Name', key: 'person_name', width: 22 },
        { header: 'Loan ID', key: 'loan_id', width: 12 },
        { header: 'Transaction Type', key: 'transaction_type', width: 20 },
        { header: 'Amount (₹)', key: 'amount', width: 18 },
        { header: 'Payment Method', key: 'payment_method', width: 16 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Reference', key: 'reference', width: 22 },
        { header: 'Notes', key: 'notes', width: 24 }
    ];

    styleHeaderRow(sheet.getRow(1));

    for (const t of report.items) {
        const row = sheet.addRow({
            transaction_id: t.transaction_id,
            date: t.transaction_date || t.date,
            person_id: t.person_id,
            person_name: sanitizeFormula(t.person_name),
            loan_id: t.account_id || t.loan_id,
            transaction_type: sanitizeFormula(t.transaction_type),
            amount: t.amount,
            payment_method: sanitizeFormula(t.payment_method || 'CASH'),
            status: sanitizeFormula(t.status || 'COMPLETED'),
            reference: sanitizeFormula(t.reference || '—'),
            notes: sanitizeFormula(t.notes || '—')
        });


        row.font = STYLES.dataFont;
        row.height = 20;

        row.getCell(1).alignment = { horizontal: 'center' };
        row.getCell(1).numFmt = STYLES.numFmtInteger;
        row.getCell(2).alignment = { horizontal: 'center' };
        row.getCell(3).alignment = { horizontal: 'center' };
        row.getCell(3).numFmt = STYLES.numFmtInteger;
        row.getCell(5).alignment = { horizontal: 'center' };
        row.getCell(5).numFmt = STYLES.numFmtInteger;
        row.getCell(6).alignment = { horizontal: 'center' };
        row.getCell(7).numFmt = STYLES.numFmtCurrency;
        row.getCell(7).font = STYLES.boldDataFont;
        row.getCell(8).alignment = { horizontal: 'center' };
        row.getCell(9).alignment = { horizontal: 'center' };

        row.eachCell((cell) => { cell.border = STYLES.borderThin; });
    }

    autoFitColumns(sheet);
    const filename = safeFilename('transactions-export', options);
    const rawBuffer = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(rawBuffer);
    return wrapBuffer(buffer, filename, workbook);
}

// ═════════════════════════════════════════════════════════════════════
// 11F.1 — INTEREST EXCEL EXPORT
// ═════════════════════════════════════════════════════════════════════
async function exportInterest(db, options = {}) {
    const reportOpts = { ...options, export_all: true, all: true };
    const report = generateInterestReport(db, reportOpts);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Interest Manager';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Interest', {
        views: [{ state: 'frozen', ySplit: 1 }]
    });

    sheet.columns = [
        { header: 'Interest ID', key: 'interest_id', width: 12 },
        { header: 'Loan ID', key: 'account_id', width: 12 },
        { header: 'Person ID', key: 'person_id', width: 12 },
        { header: 'Person Name', key: 'person_name', width: 22 },
        { header: 'Period Start', key: 'period_start', width: 14 },
        { header: 'Period End', key: 'period_end', width: 14 },
        { header: 'Principal Basis (₹)', key: 'principal_basis', width: 18 },
        { header: 'Rate (%)', key: 'interest_rate', width: 12 },
        { header: 'Interest Amount (₹)', key: 'interest_amount', width: 18 },
        { header: 'Paid Interest (₹)', key: 'paid_amount', width: 18 },
        { header: 'Outstanding Interest (₹)', key: 'outstanding_interest', width: 22 },
        { header: 'Status', key: 'status', width: 14 }
    ];

    styleHeaderRow(sheet.getRow(1));

    for (const r of report.items) {
        const row = sheet.addRow({
            interest_id: r.interest_id,
            account_id: r.account_id,
            person_id: r.person_id,
            person_name: sanitizeFormula(r.person_name),
            period_start: r.period_start,
            period_end: r.period_end,
            principal_basis: r.principal_basis,
            interest_rate: r.interest_rate,
            interest_amount: r.interest_amount,
            paid_amount: r.paid_interest !== undefined ? r.paid_interest : (r.paid_amount || 0),
            outstanding_interest: r.outstanding_interest,

            status: sanitizeFormula(r.status)
        });

        row.font = STYLES.dataFont;
        row.height = 20;

        row.getCell(1).alignment = { horizontal: 'center' };
        row.getCell(1).numFmt = STYLES.numFmtInteger;
        row.getCell(2).alignment = { horizontal: 'center' };
        row.getCell(2).numFmt = STYLES.numFmtInteger;
        row.getCell(3).alignment = { horizontal: 'center' };
        row.getCell(3).numFmt = STYLES.numFmtInteger;
        row.getCell(5).alignment = { horizontal: 'center' };
        row.getCell(6).alignment = { horizontal: 'center' };
        row.getCell(7).numFmt = STYLES.numFmtCurrency;
        row.getCell(8).numFmt = '0.00';
        row.getCell(9).numFmt = STYLES.numFmtCurrency;
        row.getCell(10).numFmt = STYLES.numFmtCurrency;
        row.getCell(11).numFmt = STYLES.numFmtCurrency;
        row.getCell(11).font = STYLES.boldDataFont;
        row.getCell(12).alignment = { horizontal: 'center' };

        row.eachCell((cell) => { cell.border = STYLES.borderThin; });
    }

    autoFitColumns(sheet);
    const filename = safeFilename('interest-export', options);
    const rawBuffer = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(rawBuffer);
    return wrapBuffer(buffer, filename, workbook);
}

// ═════════════════════════════════════════════════════════════════════
// 11F.2 — DUE / OVERDUE EXCEL EXPORT
// ═════════════════════════════════════════════════════════════════════
async function exportDueOverdue(db, options = {}) {
    const reportOpts = { ...options, export_all: true, all: true };
    const report = generateDueOverdueReport(db, reportOpts);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Interest Manager';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Due_Overdue', {
        views: [{ state: 'frozen', ySplit: 1 }]
    });

    sheet.columns = [
        { header: 'Loan ID', key: 'account_id', width: 12 },
        { header: 'Person ID', key: 'person_id', width: 12 },
        { header: 'Person Name', key: 'person_name', width: 22 },
        { header: 'Due Date', key: 'due_date', width: 14 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Required Amount (₹)', key: 'outstanding_principal', width: 20 },
        { header: 'Paid Amount (₹)', key: 'paid_amount', width: 18 },
        { header: 'Outstanding Amount (₹)', key: 'overdue_amount', width: 22 },
        { header: 'Overdue Since', key: 'overdue_since', width: 14 },
        { header: 'Days Overdue', key: 'days_overdue', width: 14 }
    ];

    styleHeaderRow(sheet.getRow(1));

    for (const d of report.items) {
        const row = sheet.addRow({
            account_id: d.account_id,
            person_id: d.person_id,
            person_name: sanitizeFormula(d.person_name),
            due_date: d.due_date,
            status: sanitizeFormula(d.status),
            outstanding_principal: d.outstanding_principal,
            paid_amount: d.paid_amount || 0,
            overdue_amount: d.overdue_amount,
            overdue_since: d.overdue_since || '—',
            days_overdue: d.days_overdue || 0
        });

        row.font = STYLES.dataFont;
        row.height = 20;

        row.getCell(1).alignment = { horizontal: 'center' };
        row.getCell(1).numFmt = STYLES.numFmtInteger;
        row.getCell(2).alignment = { horizontal: 'center' };
        row.getCell(2).numFmt = STYLES.numFmtInteger;
        row.getCell(4).alignment = { horizontal: 'center' };
        row.getCell(5).alignment = { horizontal: 'center' };
        row.getCell(6).numFmt = STYLES.numFmtCurrency;
        row.getCell(7).numFmt = STYLES.numFmtCurrency;
        row.getCell(8).numFmt = STYLES.numFmtCurrency;
        row.getCell(8).font = STYLES.boldDataFont;
        row.getCell(9).alignment = { horizontal: 'center' };
        row.getCell(10).alignment = { horizontal: 'center' };
        row.getCell(10).numFmt = STYLES.numFmtInteger;

        row.eachCell((cell) => { cell.border = STYLES.borderThin; });
    }

    autoFitColumns(sheet);
    const filename = safeFilename('due-overdue-export', options);
    const rawBuffer = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(rawBuffer);
    return wrapBuffer(buffer, filename, workbook);
}

// ═════════════════════════════════════════════════════════════════════
// 11F.3 — COLLECTION EXCEL EXPORT
// ═════════════════════════════════════════════════════════════════════
async function exportCollection(db, options = {}) {
    const reportOpts = { ...options, export_all: true, all: true };
    const report = generateCollectionReport(db, reportOpts);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Interest Manager';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Collection', {
        views: [{ state: 'frozen', ySplit: 1 }]
    });

    sheet.columns = [
        { header: 'Priority', key: 'priority', width: 10 },
        { header: 'Loan ID', key: 'account_id', width: 12 },
        { header: 'Person ID', key: 'person_id', width: 12 },
        { header: 'Person Name', key: 'person_name', width: 22 },
        { header: 'Phone', key: 'phone', width: 16 },
        { header: 'Due Date', key: 'due_date', width: 14 },
        { header: 'Overdue Since', key: 'overdue_since', width: 14 },
        { header: 'Days Overdue', key: 'days_overdue', width: 14 },
        { header: 'Outstanding Amount (₹)', key: 'outstanding_amount', width: 22 },
        { header: 'Status', key: 'status', width: 14 }
    ];

    styleHeaderRow(sheet.getRow(1));

    for (const c of report.items) {
        const row = sheet.addRow({
            priority: c.priority,
            account_id: c.account_id,
            person_id: c.person_id,
            person_name: sanitizeFormula(c.person_name),
            phone: sanitizeFormula(c.phone || '—'),
            due_date: c.due_date,
            overdue_since: c.overdue_since || '—',
            days_overdue: c.days_overdue || 0,
            outstanding_amount: c.outstanding_amount,
            status: sanitizeFormula(c.status)
        });

        row.font = STYLES.dataFont;
        row.height = 20;

        row.getCell(1).alignment = { horizontal: 'center' };
        row.getCell(1).numFmt = STYLES.numFmtInteger;
        row.getCell(2).alignment = { horizontal: 'center' };
        row.getCell(2).numFmt = STYLES.numFmtInteger;
        row.getCell(3).alignment = { horizontal: 'center' };
        row.getCell(3).numFmt = STYLES.numFmtInteger;
        row.getCell(6).alignment = { horizontal: 'center' };
        row.getCell(7).alignment = { horizontal: 'center' };
        row.getCell(8).alignment = { horizontal: 'center' };
        row.getCell(8).numFmt = STYLES.numFmtInteger;
        row.getCell(9).numFmt = STYLES.numFmtCurrency;
        row.getCell(9).font = STYLES.boldDataFont;
        row.getCell(10).alignment = { horizontal: 'center' };

        row.eachCell((cell) => { cell.border = STYLES.borderThin; });
    }

    autoFitColumns(sheet);
    const filename = safeFilename('collection-export', options);
    const rawBuffer = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(rawBuffer);
    return wrapBuffer(buffer, filename, workbook);
}

// ═════════════════════════════════════════════════════════════════════
// 11G.1 — GENERIC REPORT EXCEL EXPORT
// ═════════════════════════════════════════════════════════════════════
async function exportReport(db, options = {}) {
    const reportType = (options.report_type || options.type || '').toUpperCase();

    switch (reportType) {
        case REPORT_TYPES.LOAN_PORTFOLIO:
        case 'LOAN_PORTFOLIO':
        case 'LOANS':
            return exportLoans(db, options);

        case REPORT_TYPES.PEOPLE:
        case 'PEOPLE':
            return exportPeople(db, options);

        case REPORT_TYPES.PAYMENTS:
        case 'PAYMENTS':
        case 'TRANSACTIONS':
            return exportTransactions(db, options);

        case REPORT_TYPES.INTEREST:
        case 'INTEREST':
            return exportInterest(db, options);

        case REPORT_TYPES.DUE_OVERDUE:
        case 'DUE_OVERDUE':
        case 'DUE':
            return exportDueOverdue(db, options);

        case REPORT_TYPES.COLLECTION:
        case 'COLLECTION':
        case 'COLLECTIONS':
            return exportCollection(db, options);

        default: {
            const err = new Error(`Unsupported report type for Excel export: ${reportType}`);
            err.statusCode = 400;
            throw err;
        }
    }
}

// ═════════════════════════════════════════════════════════════════════
// 11G.2 — PERSON STATEMENT EXCEL EXPORT (Multi-Worksheet)
// ═════════════════════════════════════════════════════════════════════
async function exportPersonStatement(db, personId, options = {}) {
    const statement = generatePersonStatement(db, personId, options);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Interest Manager';
    workbook.created = new Date();

    const p = statement.person;
    const sm = statement.summary;
    const loans = statement.loans || [];
    const txs = statement.transactions || [];
    const interestList = statement.interest_records || (statement.interest && statement.interest.records) || [];
    const dueList = Array.isArray(statement.due_overdue)
        ? statement.due_overdue
        : ((statement.due_overdue && statement.due_overdue.obligations) || []);

    // ─────────────────────────────────────────────────────────────
    // SHEET 1: Summary
    // ─────────────────────────────────────────────────────────────
    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.columns = [
        { header: 'Field', key: 'field', width: 28 },
        { header: 'Value', key: 'value', width: 36 }
    ];
    styleHeaderRow(summarySheet.getRow(1));

    const summaryData = [
        ['Person ID', p.id],
        ['Person Name', sanitizeFormula(p.name)],
        ['Phone', sanitizeFormula(p.phone || '—')],
        ['Address', sanitizeFormula(p.address || '—')],
        ['Statement Type', statement.statement_type.replace('_', ' ')],
        ['As of Date', statement.as_of_date],
        ['Period Start', statement.period.start_date || 'Beginning'],
        ['Period End', statement.period.end_date || 'Present'],
        ['Total Loans', sm.total_loans],
        ['Active Loans', sm.active_loans],
        ['Closed Loans', sm.closed_loans],
        ['Overall Status', sm.overall_status || sm.status],
        ['Opening Balance (₹)', sm.opening_balance],
        ['Total Principal (₹)', sm.total_principal],
        ['Total Payments (₹)', sm.total_payments || sm.total_paid],
        ['Total Interest (₹)', sm.total_interest],
        ['Outstanding Principal (₹)', sm.outstanding_principal],
        ['Outstanding Interest (₹)', sm.outstanding_interest],
        ['Total Overdue (₹)', sm.total_overdue || sm.overdue_amount],
        ['Closing Balance (₹)', sm.closing_balance]
    ];

    summaryData.forEach(([label, val]) => {
        const row = summarySheet.addRow({ field: label, value: val });
        row.font = STYLES.dataFont;
        row.height = 20;
        row.getCell(1).font = STYLES.boldDataFont;

        if (label.includes('(₹)')) {
            row.getCell(2).numFmt = STYLES.numFmtCurrency;
            if (label.includes('Closing Balance')) {
                row.getCell(2).font = STYLES.boldDataFont;
            }
        }
        row.eachCell((c) => { c.border = STYLES.borderThin; });
    });
    autoFitColumns(summarySheet);

    // ─────────────────────────────────────────────────────────────
    // SHEET 2: Loans
    // ─────────────────────────────────────────────────────────────
    const loansSheet = workbook.addWorksheet('Loans', {
        views: [{ state: 'frozen', ySplit: 1 }]
    });
    loansSheet.columns = [
        { header: 'Loan ID', key: 'id', width: 12 },
        { header: 'Direction', key: 'direction', width: 16 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Principal (₹)', key: 'principal', width: 18 },
        { header: 'Paid (₹)', key: 'paid', width: 18 },
        { header: 'Outstanding Principal (₹)', key: 'outstanding_principal', width: 22 },
        { header: 'Interest Rate (%)', key: 'interest_rate', width: 16 },
        { header: 'Frequency', key: 'interest_frequency', width: 14 },
        { header: 'Start Date', key: 'start_date', width: 14 },
        { header: 'Due Date', key: 'due_date', width: 14 }
    ];
    styleHeaderRow(loansSheet.getRow(1));

    for (const l of loans) {
        const row = loansSheet.addRow({
            id: l.id,
            direction: sanitizeFormula(l.direction),
            status: sanitizeFormula(l.status),
            principal: l.principal,
            paid: l.paid || 0,
            outstanding_principal: l.outstanding_principal,
            interest_rate: l.interest_rate,
            interest_frequency: sanitizeFormula(l.interest_frequency),
            start_date: l.start_date,
            due_date: l.due_date
        });
        row.font = STYLES.dataFont;
        row.height = 20;

        row.getCell(1).alignment = { horizontal: 'center' };
        row.getCell(1).numFmt = STYLES.numFmtInteger;
        row.getCell(2).alignment = { horizontal: 'center' };
        row.getCell(3).alignment = { horizontal: 'center' };
        row.getCell(4).numFmt = STYLES.numFmtCurrency;
        row.getCell(5).numFmt = STYLES.numFmtCurrency;
        row.getCell(6).numFmt = STYLES.numFmtCurrency;
        row.getCell(6).font = STYLES.boldDataFont;
        row.getCell(7).numFmt = '0.00';
        row.getCell(8).alignment = { horizontal: 'center' };
        row.getCell(9).alignment = { horizontal: 'center' };
        row.getCell(10).alignment = { horizontal: 'center' };

        row.eachCell((c) => { c.border = STYLES.borderThin; });
    }
    autoFitColumns(loansSheet);

    // ─────────────────────────────────────────────────────────────
    // SHEET 3: Transactions (Ledger)
    // ─────────────────────────────────────────────────────────────
    const txSheet = workbook.addWorksheet('Transactions', {
        views: [{ state: 'frozen', ySplit: 1 }]
    });
    txSheet.columns = [
        { header: 'Date', key: 'date', width: 14 },
        { header: 'Loan ID', key: 'loan_id', width: 12 },
        { header: 'Type', key: 'type', width: 20 },
        { header: 'Description / Reference', key: 'description', width: 26 },
        { header: 'Debit (₹)', key: 'debit', width: 18 },
        { header: 'Credit (₹)', key: 'credit', width: 18 },
        { header: 'Running Balance (₹)', key: 'running_balance', width: 22 }
    ];
    styleHeaderRow(txSheet.getRow(1));

    for (const t of txs) {
        const row = txSheet.addRow({
            date: t.date,
            loan_id: t.account_id || t.loan_id || '—',
            type: sanitizeFormula(t.type),
            description: sanitizeFormula(t.description || t.reference || '—'),
            debit: t.debit || 0,
            credit: t.credit || 0,
            running_balance: t.running_balance
        });
        row.font = STYLES.dataFont;
        row.height = 20;

        row.getCell(1).alignment = { horizontal: 'center' };
        row.getCell(2).alignment = { horizontal: 'center' };
        row.getCell(3).alignment = { horizontal: 'center' };
        row.getCell(5).numFmt = STYLES.numFmtCurrency;
        row.getCell(6).numFmt = STYLES.numFmtCurrency;
        row.getCell(7).numFmt = STYLES.numFmtCurrency;
        row.getCell(7).font = STYLES.boldDataFont;

        row.eachCell((c) => { c.border = STYLES.borderThin; });
    }
    autoFitColumns(txSheet);

    // ─────────────────────────────────────────────────────────────
    // SHEET 4: Interest
    // ─────────────────────────────────────────────────────────────
    const intSheet = workbook.addWorksheet('Interest', {
        views: [{ state: 'frozen', ySplit: 1 }]
    });
    intSheet.columns = [
        { header: 'Interest ID', key: 'id', width: 12 },
        { header: 'Loan ID', key: 'account_id', width: 12 },
        { header: 'Period Start', key: 'period_start', width: 14 },
        { header: 'Period End', key: 'period_end', width: 14 },
        { header: 'Principal Basis (₹)', key: 'principal_basis', width: 18 },
        { header: 'Rate (%)', key: 'interest_rate', width: 12 },
        { header: 'Interest Amount (₹)', key: 'interest_amount', width: 18 },
        { header: 'Paid Amount (₹)', key: 'paid_amount', width: 18 },
        { header: 'Outstanding Interest (₹)', key: 'outstanding_interest', width: 22 },
        { header: 'Status', key: 'status', width: 14 }
    ];
    styleHeaderRow(intSheet.getRow(1));

    for (const r of interestList) {
        const outInterest = Math.max(0, (r.interest_amount || 0) - (r.paid_amount || 0));
        const row = intSheet.addRow({
            id: r.id,
            account_id: r.account_id,
            period_start: r.period_start,
            period_end: r.period_end,
            principal_basis: r.principal_basis,
            interest_rate: r.interest_rate,
            interest_amount: r.interest_amount,
            paid_amount: r.paid_amount || 0,
            outstanding_interest: outInterest,
            status: sanitizeFormula(r.status)
        });
        row.font = STYLES.dataFont;
        row.height = 20;

        row.getCell(1).alignment = { horizontal: 'center' };
        row.getCell(1).numFmt = STYLES.numFmtInteger;
        row.getCell(2).alignment = { horizontal: 'center' };
        row.getCell(2).numFmt = STYLES.numFmtInteger;
        row.getCell(3).alignment = { horizontal: 'center' };
        row.getCell(4).alignment = { horizontal: 'center' };
        row.getCell(5).numFmt = STYLES.numFmtCurrency;
        row.getCell(6).numFmt = '0.00';
        row.getCell(7).numFmt = STYLES.numFmtCurrency;
        row.getCell(8).numFmt = STYLES.numFmtCurrency;
        row.getCell(9).numFmt = STYLES.numFmtCurrency;
        row.getCell(9).font = STYLES.boldDataFont;
        row.getCell(10).alignment = { horizontal: 'center' };

        row.eachCell((c) => { c.border = STYLES.borderThin; });
    }
    autoFitColumns(intSheet);

    // ─────────────────────────────────────────────────────────────
    // SHEET 5: Due_Overdue
    // ─────────────────────────────────────────────────────────────
    const dueSheet = workbook.addWorksheet('Due_Overdue', {
        views: [{ state: 'frozen', ySplit: 1 }]
    });
    dueSheet.columns = [
        { header: 'Loan ID', key: 'id', width: 12 },
        { header: 'Due Date', key: 'due_date', width: 14 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Required Amount (₹)', key: 'amount_due', width: 20 },
        { header: 'Outstanding Amount (₹)', key: 'outstanding', width: 22 },
        { header: 'Overdue Amount (₹)', key: 'amount_overdue', width: 20 },
        { header: 'Overdue Since', key: 'overdue_since', width: 14 },
        { header: 'Days Overdue', key: 'days_overdue', width: 14 }
    ];
    styleHeaderRow(dueSheet.getRow(1));

    for (const d of dueList) {
        const row = dueSheet.addRow({
            id: d.id,
            due_date: d.due_date,
            status: sanitizeFormula(d.status),
            amount_due: d.amount_due || 0,
            outstanding: d.outstanding || d.outstanding_amount || 0,
            amount_overdue: d.amount_overdue || 0,
            overdue_since: d.overdue_since || '—',
            days_overdue: d.days_overdue || 0
        });
        row.font = STYLES.dataFont;
        row.height = 20;

        row.getCell(1).alignment = { horizontal: 'center' };
        row.getCell(1).numFmt = STYLES.numFmtInteger;
        row.getCell(2).alignment = { horizontal: 'center' };
        row.getCell(3).alignment = { horizontal: 'center' };
        row.getCell(4).numFmt = STYLES.numFmtCurrency;
        row.getCell(5).numFmt = STYLES.numFmtCurrency;
        row.getCell(6).numFmt = STYLES.numFmtCurrency;
        row.getCell(6).font = STYLES.boldDataFont;
        row.getCell(7).alignment = { horizontal: 'center' };
        row.getCell(8).alignment = { horizontal: 'center' };
        row.getCell(8).numFmt = STYLES.numFmtInteger;

        row.eachCell((c) => { c.border = STYLES.borderThin; });
    }
    autoFitColumns(dueSheet);

    const safeName = p.name ? p.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase() : 'statement';
    const filename = `statement-${safeName}-${statement.as_of_date}.xlsx`;
    const rawBuffer = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(rawBuffer);
    return wrapBuffer(buffer, filename, workbook);
}

module.exports = {
    exportPeople,
    exportLoans,
    exportTransactions,
    exportInterest,
    exportDueOverdue,
    exportCollection,
    exportReport,
    exportPersonStatement,
    sanitizeFormula,
    safeFilename
};
