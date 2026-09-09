/**
 * Interest Manager — In-App Notification Service (Part 12H, 12I)
 *
 * Implements:
 *   12H: Notification model, unread counts, mark read, list
 *   12I: Due soon, due today, overdue notifications integrated with Part 8
 *   12I.4: Duplicate notification prevention via unique event_key
 *   12I.6: Zero financial mutation guarantee
 */

const { queryOne, queryAll } = require('../db/helpers');

const NOTIFICATION_TYPES = {
    DUE_SOON: 'DUE_SOON',
    DUE_TODAY: 'DUE_TODAY',
    OVERDUE: 'OVERDUE',
    PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
    PAYMENT_REVERSED: 'PAYMENT_REVERSED',
    BACKUP_COMPLETED: 'BACKUP_COMPLETED',
    RESTORE_COMPLETED: 'RESTORE_COMPLETED',
    SECURITY_EVENT: 'SECURITY_EVENT'
};

/**
 * Creates an in-app notification. If event_key exists, prevents duplicate (12I.4).
 */
function createNotification(db, {
    userId = null,
    type,
    title,
    message,
    referenceType = null,
    referenceId = null,
    eventKey = null
}) {
    if (!type || !title || !message) {
        throw new Error('type, title, and message are required for notification');
    }

    if (!Object.values(NOTIFICATION_TYPES).includes(type)) {
        throw new Error(`Invalid notification type: ${type}`);
    }

    // Deduplication via eventKey
    if (eventKey) {
        const existing = queryOne(db, 'SELECT id FROM notifications WHERE event_key = ?', [eventKey]);
        if (existing) {
            return { id: existing.id, duplicate: true };
        }
    }

    try {
        db.run(`
            INSERT INTO notifications (user_id, type, title, message, reference_type, reference_id, event_key, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'UNREAD')
        `, [userId || null, type, title, message, referenceType || null, referenceId || null, eventKey || null]);

        const id = queryOne(db, 'SELECT last_insert_rowid() as id').id;
        return { id, duplicate: false, type, title };
    } catch (err) {
        // If race condition hit unique event_key
        if (err.message && err.message.includes('UNIQUE constraint failed')) {
            const existing = queryOne(db, 'SELECT id FROM notifications WHERE event_key = ?', [eventKey]);
            return { id: existing ? existing.id : null, duplicate: true };
        }
        throw err;
    }
}

/**
 * Lists notifications with pagination and status filtering.
 */
function getNotifications(db, userId = null, options = {}) {
    const status = options.status || 'ALL';
    const limit = Math.min(parseInt(options.limit, 10) || 50, 100);
    const offset = Math.max(parseInt(options.offset, 10) || 0, 0);

    const conditions = [];
    const params = [];

    if (userId !== null && userId !== undefined) {
        conditions.push('(user_id IS NULL OR user_id = ?)');
        params.push(userId);
    }

    if (status === 'UNREAD') {
        conditions.push("status = 'UNREAD'");
    } else if (status === 'READ') {
        conditions.push("status = 'READ'");
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = queryOne(db, `SELECT COUNT(*) as total FROM notifications ${whereClause}`, params);
    const total = countRow ? countRow.total : 0;

    const items = queryAll(db, `
        SELECT id, user_id, type, title, message, reference_type, reference_id,
               status, created_at, read_at
        FROM notifications
        ${whereClause}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    const unreadCount = getUnreadCount(db, userId);

    return {
        items,
        total,
        unread_count: unreadCount,
        limit,
        offset
    };
}

/**
 * Returns total unread notification count.
 */
function getUnreadCount(db, userId = null) {
    if (userId !== null && userId !== undefined) {
        const row = queryOne(db, "SELECT COUNT(*) as c FROM notifications WHERE status = 'UNREAD' AND (user_id IS NULL OR user_id = ?)", [userId]);
        return row ? row.c : 0;
    }
    const row = queryOne(db, "SELECT COUNT(*) as c FROM notifications WHERE status = 'UNREAD'");
    return row ? row.c : 0;
}

/**
 * Marks a single notification as read.
 */
function markAsRead(db, notificationId, userId = null) {
    const params = [notificationId];
    let userConstraint = '';
    if (userId !== null && userId !== undefined) {
        userConstraint = 'AND (user_id IS NULL OR user_id = ?)';
        params.push(userId);
    }

    db.run(`
        UPDATE notifications
        SET status = 'READ', read_at = datetime('now')
        WHERE id = ? AND status = 'UNREAD' ${userConstraint}
    `, params);

    return { success: true, notification_id: notificationId };
}

/**
 * Marks all unread notifications as read.
 */
function markAllAsRead(db, userId = null) {
    if (userId !== null && userId !== undefined) {
        db.run(`
            UPDATE notifications
            SET status = 'READ', read_at = datetime('now')
            WHERE status = 'UNREAD' AND (user_id IS NULL OR user_id = ?)
        `, [userId]);
    } else {
        db.run("UPDATE notifications SET status = 'READ', read_at = datetime('now') WHERE status = 'UNREAD'");
    }

    return { success: true, message: 'All notifications marked as read' };
}

/**
 * 12I: Checks due and overdue loans and generates notifications with deduplication.
 * Pure read-only with respect to financial records.
 */
function checkDueAndOverdueNotifications(db, asOfDate = null) {
    const today = asOfDate || new Date().toISOString().split('T')[0];

    // Compute date 3 days from today for DUE_SOON threshold
    const todayObj = new Date(today);
    const dueSoonLimitObj = new Date(todayObj.getTime() + 3 * 24 * 3600 * 1000);
    const dueSoonLimit = dueSoonLimitObj.toISOString().split('T')[0];

    // Query active accounts with borrowers
    const accounts = queryAll(db, `
        SELECT a.id, a.person_id, p.name as person_name, a.principal, a.outstanding_principal,
               a.start_date, a.due_date, a.grace_period, a.status
        FROM accounts a
        JOIN people p ON a.person_id = p.id
        WHERE a.status NOT IN ('CLOSED', 'WRITTEN_OFF')
          AND a.outstanding_principal > 0
    `);

    let dueSoonCount = 0;
    let dueTodayCount = 0;
    let overdueCount = 0;

    for (const a of accounts) {
        const principalRupees = (a.outstanding_principal / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
        const gracePeriod = a.grace_period || 0;

        // Calculate effective overdue threshold: due_date + grace_period days
        const dueDateObj = new Date(a.due_date);
        const overdueThresholdObj = new Date(dueDateObj.getTime() + gracePeriod * 24 * 3600 * 1000);
        const overdueThreshold = overdueThresholdObj.toISOString().split('T')[0];

        if (today > overdueThreshold || a.status === 'OVERDUE') {
            // 12I.3: OVERDUE notification
            const eventKey = `OVERDUE:${a.id}:${today}`;
            const res = createNotification(db, {
                type: NOTIFICATION_TYPES.OVERDUE,
                title: `Loan #${a.id} Overdue`,
                message: `Loan #${a.id} for ${a.person_name} (₹${principalRupees} outstanding) is overdue since ${a.due_date}.`,
                referenceType: 'ACCOUNT',
                referenceId: a.id,
                eventKey
            });
            if (!res.duplicate) overdueCount++;

        } else if (a.due_date === today) {
            // 12I.2: DUE_TODAY notification
            const eventKey = `DUE_TODAY:${a.id}:${today}`;
            const res = createNotification(db, {
                type: NOTIFICATION_TYPES.DUE_TODAY,
                title: `Loan #${a.id} Due Today`,
                message: `Loan #${a.id} for ${a.person_name} (₹${principalRupees}) is due today (${today}).`,
                referenceType: 'ACCOUNT',
                referenceId: a.id,
                eventKey
            });
            if (!res.duplicate) dueTodayCount++;

        } else if (a.due_date > today && a.due_date <= dueSoonLimit) {
            // 12I.1: DUE_SOON notification (within 3 days)
            const eventKey = `DUE_SOON:${a.id}:${a.due_date}`;
            const res = createNotification(db, {
                type: NOTIFICATION_TYPES.DUE_SOON,
                title: `Loan #${a.id} Due Soon`,
                message: `Loan #${a.id} for ${a.person_name} (₹${principalRupees}) is due on ${a.due_date}.`,
                referenceType: 'ACCOUNT',
                referenceId: a.id,
                eventKey
            });
            if (!res.duplicate) dueSoonCount++;
        }
    }

    return {
        success: true,
        as_of_date: today,
        created: {
            due_soon: dueSoonCount,
            due_today: dueTodayCount,
            overdue: overdueCount,
            total: dueSoonCount + dueTodayCount + overdueCount
        }
    };
}

module.exports = {
    NOTIFICATION_TYPES,
    createNotification,
    getNotifications,
    getUnreadCount,
    markAsRead,
    markAllAsRead,
    checkDueAndOverdueNotifications
};
