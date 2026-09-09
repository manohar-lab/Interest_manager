/**
 * Interest Manager — Part 10: Server-Side PDF Statement Generator
 *
 * Generates professional, multi-page vector PDF financial statements from
 * the authoritative Statement DTO using PDFKit.
 *
 * Features:
 *   - Clean, modern layout (A4, consistent margins, elegant typography)
 *   - Customer Information & Period header
 *   - Key Financial Metrics Summary card
 *   - Loan Portfolio Overview table
 *   - Chronological Ledger Transactions table with automatic multi-page splitting
 *   - Due & Overdue obligations attention block
 *   - Dynamic page numbering ("Page X of Y") on every page
 *   - Deterministic filenames (person-statement-{person_id}-{date}.pdf)
 */

const PDFDocument = require('pdfkit');

/**
 * Formats monetary amounts as "Rs. 10,000.00" without floating-point artifacts.
 */
function formatCurrency(amount) {
    if (amount === undefined || amount === null || isNaN(amount)) return 'Rs. 0.00';
    const num = Number(amount);
    return 'Rs. ' + num.toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

/**
 * Formats date string to DD/MM/YYYY.
 */
function formatDate(dateStr) {
    if (!dateStr || dateStr === 'All History') return dateStr || 'N/A';
    try {
        const parts = dateStr.split('-');
        if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
        return dateStr;
    } catch {
        return dateStr;
    }
}

/**
 * Generates a deterministic filename for the statement PDF (10H.11).
 */
function generateStatementPdfFilename(statement) {
    const pId = statement.person ? statement.person.person_id || statement.person.id : 'unknown';
    const datePart = (statement.as_of_date || new Date().toISOString().slice(0, 10)).replace(/[^0-9-]/g, '');
    return `person-statement-${pId}-${datePart}.pdf`;
}

/**
 * Generates a PDF statement Buffer from a Statement DTO (10H, 10I).
 *
 * @param {Object} statement - Complete Statement DTO from statementService
 * @param {Object} [options={}] - Render options
 * @returns {Promise<Buffer>} Binary PDF Buffer
 */
function renderStatementPdf(statement, options = {}) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                margin: 40,
                bufferPages: true,
                info: {
                    Title: `Statement — ${statement.person ? statement.person.name : 'Customer'}`,
                    Author: 'Interest Manager',
                    Subject: 'Financial Statement of Accounts'
                }
            });

            const buffers = [];
            doc.on('data', b => buffers.push(b));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', err => reject(err));

            const colors = {
                primary: '#1e293b',       // Dark slate
                accent: '#0284c7',        // Blue
                accentDark: '#0369a1',
                textDark: '#0f172a',
                textMuted: '#64748b',
                bgLight: '#f8fafc',
                border: '#e2e8f0',
                green: '#16a34a',
                amber: '#d97706',
                red: '#dc2626'
            };

            const pageWidth = 595.28;
            const margin = 40;
            const contentWidth = pageWidth - (margin * 2);

            // ─── Header ─────────────────────────────────────────────
            doc.rect(margin, 40, contentWidth, 54).fill(colors.bgLight);
            doc.rect(margin, 40, contentWidth, 54).stroke(colors.border);

            doc.fillColor(colors.accentDark).fontSize(16).font('Helvetica-Bold')
               .text('INTEREST MANAGER', margin + 14, 52);

            const title = statement.statement_type === 'LOAN_STATEMENT'
                ? 'LOAN FINANCIAL STATEMENT'
                : 'PERSON FINANCIAL STATEMENT';
            doc.fillColor(colors.textDark).fontSize(10).font('Helvetica-Bold')
               .text(title, margin + 14, 72);

            doc.fillColor(colors.textMuted).fontSize(8).font('Helvetica')
               .text(`Generated: ${formatDate(statement.as_of_date || new Date().toISOString().slice(0, 10))}`, margin + contentWidth - 180, 56, { width: 170, align: 'right' });
            doc.text(`Reference: STMT-${statement.person.id}-${Date.now().toString().slice(-6)}`, margin + contentWidth - 180, 70, { width: 170, align: 'right' });

            let y = 105;

            // ─── Customer Details Box ───────────────────────────────
            doc.rect(margin, y, contentWidth, 68).fill(colors.bgLight);
            doc.rect(margin, y, contentWidth, 68).stroke(colors.border);

            doc.fillColor(colors.accent).fontSize(9).font('Helvetica-Bold')
               .text('CUSTOMER INFORMATION', margin + 12, y + 10);

            doc.fillColor(colors.textDark).fontSize(10).font('Helvetica-Bold')
               .text(statement.person.name || 'N/A', margin + 12, y + 25);
            doc.fillColor(colors.textMuted).fontSize(8).font('Helvetica')
               .text(`Customer ID: #${statement.person.id}`, margin + 12, y + 39)
               .text(`Phone: ${statement.person.phone || 'N/A'}`, margin + 12, y + 51);

            const col2X = margin + 260;
            doc.fillColor(colors.accent).fontSize(9).font('Helvetica-Bold')
               .text('STATEMENT PERIOD', col2X, y + 10);
            doc.fillColor(colors.textDark).fontSize(9).font('Helvetica')
               .text(`From: ${formatDate(statement.period.start_date)}`, col2X, y + 25)
               .text(`To:   ${formatDate(statement.period.end_date)}`, col2X, y + 39)
               .text(`Status: ${statement.summary.status || 'CURRENT'}`, col2X, y + 51);

            y += 80;

            // ─── Financial Summary Cards ────────────────────────────
            doc.fillColor(colors.primary).fontSize(10).font('Helvetica-Bold')
               .text('EXECUTIVE FINANCIAL SUMMARY', margin, y);
            y += 16;

            const cardWidth = (contentWidth - 12) / 3;
            const cardHeight = 46;

            function drawMetricCard(x, cardY, label, valRupees, color = colors.textDark) {
                doc.rect(x, cardY, cardWidth, cardHeight).fill('#ffffff').stroke(colors.border);
                doc.fillColor(colors.textMuted).fontSize(7.5).font('Helvetica').text(label.toUpperCase(), x + 8, cardY + 8);
                doc.fillColor(color).fontSize(11).font('Helvetica-Bold').text(formatCurrency(valRupees), x + 8, cardY + 24);
            }

            drawMetricCard(margin, y, 'Opening Balance', statement.summary.opening_balance);
            drawMetricCard(margin + cardWidth + 6, y, 'Total Principal', statement.summary.total_principal);
            drawMetricCard(margin + (cardWidth * 2) + 12, y, 'Total Paid', statement.summary.total_paid, colors.green);

            y += cardHeight + 6;

            drawMetricCard(margin, y, 'Total Interest', statement.summary.total_interest);
            drawMetricCard(margin + cardWidth + 6, y, 'Outstanding Interest', statement.summary.outstanding_interest);
            drawMetricCard(margin + (cardWidth * 2) + 12, y, 'Closing Balance', statement.summary.closing_balance, colors.accentDark);

            y += cardHeight + 14;

            // ─── Loan Portfolio Summary Table ────────────────────────
            if (statement.loans && statement.loans.length > 0) {
                doc.fillColor(colors.primary).fontSize(10).font('Helvetica-Bold')
                   .text(`LOAN ACCOUNTS (${statement.loans.length})`, margin, y);
                y += 14;

                // Table Header
                doc.rect(margin, y, contentWidth, 18).fill(colors.primary);
                doc.fillColor('#ffffff').fontSize(7.5).font('Helvetica-Bold');
                doc.text('Loan #', margin + 6, y + 5, { width: 45 });
                doc.text('Start Date', margin + 55, y + 5, { width: 65 });
                doc.text('Due Date', margin + 125, y + 5, { width: 65 });
                doc.text('Principal', margin + 195, y + 5, { width: 75, align: 'right' });
                doc.text('Paid', margin + 275, y + 5, { width: 70, align: 'right' });
                doc.text('Outstanding', margin + 350, y + 5, { width: 85, align: 'right' });
                doc.text('Status', margin + 445, y + 5, { width: 60, align: 'center' });
                y += 18;

                // Table Rows
                statement.loans.forEach((loan, idx) => {
                    const rowBg = idx % 2 === 0 ? '#ffffff' : colors.bgLight;
                    doc.rect(margin, y, contentWidth, 18).fill(rowBg).stroke(colors.border);

                    doc.fillColor(colors.textDark).fontSize(7.5).font('Helvetica');
                    doc.text(`#${loan.loan_id}`, margin + 6, y + 5, { width: 45 });
                    doc.text(formatDate(loan.start_date), margin + 55, y + 5, { width: 65 });
                    doc.text(formatDate(loan.due_date), margin + 125, y + 5, { width: 65 });
                    doc.text(formatCurrency(loan.principal), margin + 195, y + 5, { width: 75, align: 'right' });
                    doc.text(formatCurrency(loan.paid), margin + 275, y + 5, { width: 70, align: 'right' });
                    doc.text(formatCurrency(loan.outstanding), margin + 350, y + 5, { width: 85, align: 'right' });

                    const statusColor = loan.status === 'OVERDUE' ? colors.red : (loan.status === 'DUE' ? colors.amber : colors.green);
                    doc.fillColor(statusColor).font('Helvetica-Bold')
                       .text(loan.status || 'ACTIVE', margin + 445, y + 5, { width: 60, align: 'center' });

                    y += 18;
                });

                y += 14;
            }

            // ─── Chronological Transactions Ledger (10D, 10H.6) ──────
            function renderTxTableHeader() {
                doc.rect(margin, y, contentWidth, 18).fill(colors.primary);
                doc.fillColor('#ffffff').fontSize(7.5).font('Helvetica-Bold');
                doc.text('Date', margin + 6, y + 5, { width: 55 });
                doc.text('Loan', margin + 65, y + 5, { width: 35 });
                doc.text('Type', margin + 105, y + 5, { width: 95 });
                doc.text('Description', margin + 205, y + 5, { width: 120 });
                doc.text('Debit', margin + 330, y + 5, { width: 55, align: 'right' });
                doc.text('Credit', margin + 390, y + 5, { width: 55, align: 'right' });
                doc.text('Balance', margin + 450, y + 5, { width: 60, align: 'right' });
                y += 18;
            }

            if (y > 700) {
                doc.addPage();
                y = 40;
            }

            doc.fillColor(colors.primary).fontSize(10).font('Helvetica-Bold')
               .text(`TRANSACTION LEDGER (${statement.transactions.length})`, margin, y);
            y += 14;

            renderTxTableHeader();

            if (statement.transactions.length === 0) {
                doc.rect(margin, y, contentWidth, 24).fill(colors.bgLight).stroke(colors.border);
                doc.fillColor(colors.textMuted).fontSize(8).font('Helvetica')
                   .text('No transactions recorded during this statement period.', margin + 10, y + 8, { width: contentWidth - 20, align: 'center' });
                y += 24;
            } else {
                statement.transactions.forEach((tx, idx) => {
                    // Check if new page is needed
                    if (y > 760) {
                        doc.addPage();
                        y = 40;
                        renderTxTableHeader();
                    }

                    const rowBg = idx % 2 === 0 ? '#ffffff' : colors.bgLight;
                    doc.rect(margin, y, contentWidth, 18).fill(rowBg).stroke(colors.border);

                    doc.fillColor(colors.textDark).fontSize(7.5).font('Helvetica');
                    doc.text(formatDate(tx.date), margin + 6, y + 5, { width: 55 });
                    doc.text(`#${tx.loan_id}`, margin + 65, y + 5, { width: 35 });
                    doc.text(tx.type || 'N/A', margin + 105, y + 5, { width: 95 });
                    doc.text(tx.description || '—', margin + 205, y + 5, { width: 120, ellipsis: true });

                    const debitStr = tx.debit > 0 ? formatCurrency(tx.debit) : '—';
                    const creditStr = tx.credit > 0 ? formatCurrency(tx.credit) : '—';

                    doc.text(debitStr, margin + 330, y + 5, { width: 55, align: 'right' });
                    doc.fillColor(tx.credit > 0 ? colors.green : colors.textDark)
                       .text(creditStr, margin + 390, y + 5, { width: 55, align: 'right' });
                    doc.fillColor(colors.textDark).font('Helvetica-Bold')
                       .text(formatCurrency(tx.running_balance), margin + 450, y + 5, { width: 60, align: 'right' });

                    y += 18;
                });
            }

            y += 16;

            // ─── Due / Overdue Attention Box (10E.2, 10E.3) ───────────
            if (y > 720) {
                doc.addPage();
                y = 40;
            }

            if (statement.due_overdue.overdue_amount > 0 || statement.due_overdue.due_amount > 0) {
                const boxColor = statement.due_overdue.overdue_amount > 0 ? '#fef2f2' : '#fffbeb';
                const borderColor = statement.due_overdue.overdue_amount > 0 ? colors.red : colors.amber;
                const titleColor = statement.due_overdue.overdue_amount > 0 ? colors.red : colors.amber;

                doc.rect(margin, y, contentWidth, 38).fill(boxColor).stroke(borderColor);
                doc.fillColor(titleColor).fontSize(9).font('Helvetica-Bold')
                   .text('PAYMENT ATTENTION REQUIRED', margin + 12, y + 8);

                const alertText = `Currently Overdue: ${formatCurrency(statement.due_overdue.overdue_amount)} | Currently Due: ${formatCurrency(statement.due_overdue.due_amount)}`;
                doc.fillColor(colors.textDark).fontSize(8.5).font('Helvetica')
                   .text(alertText, margin + 12, y + 22);

                y += 48;
            }

            // ─── Closing Balance Banner (10C.2) ───────────────────────
            if (y > 750) {
                doc.addPage();
                y = 40;
            }

            doc.rect(margin, y, contentWidth, 32).fill(colors.primary);
            doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold')
               .text('CLOSING OUTSTANDING BALANCE', margin + 14, y + 10);
            doc.fontSize(12).font('Helvetica-Bold')
               .text(formatCurrency(statement.summary.closing_balance), margin + contentWidth - 210, y + 9, { width: 196, align: 'right' });

            // ─── Multi-page Footers ("Page X of Y") (10H.8) ──────────
            const range = doc.bufferedPageRange();
            for (let i = range.start; i < range.start + range.count; i++) {
                doc.switchToPage(i);

                // Footer rule
                doc.rect(margin, 800, contentWidth, 0.5).fill(colors.border);
                doc.fillColor(colors.textMuted).fontSize(7.5).font('Helvetica')
                   .text('This is a system-generated statement sourced from verified financial records.', margin, 808, { width: 350 });
                doc.text(`Page ${i + 1} of ${range.count}`, margin + contentWidth - 100, 808, { width: 100, align: 'right' });
            }

            doc.end();

        } catch (err) {
            reject(err);
        }
    });
}

module.exports = {
    renderStatementPdf,
    generateStatementPdfFilename,
    generateStatementPdf: renderStatementPdf,
    generateStatementFilename: generateStatementPdfFilename,
    formatCurrency,
    formatDate
};
