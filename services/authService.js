/**
 * Interest Manager — Authentication & Security Service (Part 12)
 *
 * Implements:
 *   12B: Password storage (PBKDF2 SHA-512) & Login/Logout
 *   12C: Cryptographic session tokens & expiration/revocation
 *   12D: PIN security (salted hash, attempt tracking, 15m lockout)
 *   12E: Role definitions (ADMIN, STAFF, VIEWER) & permissions
 *   12G: Password reset & recovery
 *   12K: Security audit logging (never logs credentials)
 */

const crypto = require('crypto');
const { queryOne, queryAll } = require('../db/helpers');

const ROLES = {
    ADMIN: 'ADMIN',
    STAFF: 'STAFF',
    VIEWER: 'VIEWER'
};

const STATUSES = {
    ACTIVE: 'ACTIVE',
    DISABLED: 'DISABLED'
};

const SESSION_EXPIRY_HOURS = 24;
const PIN_LOCKOUT_MINUTES = 15;
const MAX_FAILED_PIN_ATTEMPTS = 5;
const PASSWORD_RESET_EXPIRY_MINUTES = 60;

// ═════════════════════════════════════════════════════════════════════
// Cryptographic Hash Helpers
// ═════════════════════════════════════════════════════════════════════

/**
 * Generates a secure salt and computes PBKDF2 SHA-512 password hash.
 */
function hashPassword(password, salt = null) {
    if (!password || typeof password !== 'string') {
        throw new Error('Password must be a non-empty string');
    }
    const actualSalt = salt || crypto.randomBytes(32).toString('hex');
    const hash = crypto.pbkdf2Sync(password, actualSalt, 100000, 64, 'sha512').toString('hex');
    return { hash, salt: actualSalt };
}

/**
 * Constant-time verification of password against stored hash.
 */
function verifyPassword(password, hash, salt) {
    if (!password || !hash || !salt) return false;
    try {
        const computedHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
        const hashBuf = Buffer.from(hash, 'hex');
        const compBuf = Buffer.from(computedHash, 'hex');
        if (hashBuf.length !== compBuf.length) return false;
        return crypto.timingSafeEqual(hashBuf, compBuf);
    } catch {
        return false;
    }
}

/**
 * Computes salted PBKDF2 SHA-256 PIN hash.
 */
function hashPin(pin, salt = null) {
    if (!pin || !/^\d{4,6}$/.test(pin)) {
        throw new Error('PIN must be 4 to 6 numeric digits');
    }
    const actualSalt = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(pin, actualSalt, 50000, 32, 'sha256').toString('hex');
    return { hash, salt: actualSalt };
}

/**
 * Constant-time verification of PIN.
 */
function verifyPin(pin, hash, salt) {
    if (!pin || !hash || !salt) return false;
    try {
        const computedHash = crypto.pbkdf2Sync(pin, salt, 50000, 32, 'sha256').toString('hex');
        const hashBuf = Buffer.from(hash, 'hex');
        const compBuf = Buffer.from(computedHash, 'hex');
        if (hashBuf.length !== compBuf.length) return false;
        return crypto.timingSafeEqual(hashBuf, compBuf);
    } catch {
        return false;
    }
}

/**
 * Generates a random cryptographic token (hex).
 */
function generateToken(byteLength = 32) {
    return crypto.randomBytes(byteLength).toString('hex');
}

/**
 * Internal helper to record security audit logs.
 * NEVER logs passwords, PINs, or raw secrets.
 */
function recordSecurityAudit(db, { userId, action, oldValue = null, newValue = null }) {
    if (!db) return;
    try {
        db.run(`
            INSERT INTO audit_logs (entity_type, entity_id, action, old_value, new_value, timestamp)
            VALUES ('SECURITY', ?, ?, ?, ?, datetime('now'))
        `, [userId || 0, action, oldValue ? JSON.stringify(oldValue) : null, newValue ? JSON.stringify(newValue) : null]);
    } catch (_) {}
}

// ═════════════════════════════════════════════════════════════════════
// 12B — Authentication & Session Management
// ═════════════════════════════════════════════════════════════════════

/**
 * Authenticates user credentials and generates a session token.
 */
function login(db, username, password, clientInfo = {}) {
    if (!username || !password) {
        const err = new Error('Username and password are required');
        err.statusCode = 400;
        throw err;
    }

    const cleanUsername = String(username).trim().toLowerCase();
    const user = queryOne(db, 'SELECT * FROM users WHERE lower(username) = ?', [cleanUsername]);

    // 12B.4 & 12B.3: Generic failure without revealing user existence
    if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
        recordSecurityAudit(db, {
            userId: user ? user.id : 0,
            action: 'LOGIN_FAILURE',
            newValue: { username: cleanUsername, ip: clientInfo.ip || 'unknown' }
        });
        const err = new Error('Invalid username or password');
        err.statusCode = 401;
        throw err;
    }

    // 12B.5: Disabled user rejection
    if (user.status !== STATUSES.ACTIVE) {
        recordSecurityAudit(db, {
            userId: user.id,
            action: 'LOGIN_FAILURE',
            newValue: { reason: 'ACCOUNT_DISABLED', username: cleanUsername }
        });
        const err = new Error('Account is disabled. Contact system administrator.');
        err.statusCode = 403;
        throw err;
    }

    // 12C.1 & 12O.27: Generate fresh session token (prevents session fixation)
    const token = generateToken(32);
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_HOURS * 3600 * 1000).toISOString();

    db.run(`
        INSERT INTO user_sessions (token, user_id, role, ip_address, user_agent, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [token, user.id, user.role, clientInfo.ip || null, clientInfo.userAgent || null, expiresAt]);

    // Update last_login_at
    db.run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [user.id]);

    // 12K.1: Audit successful login
    recordSecurityAudit(db, {
        userId: user.id,
        action: 'LOGIN_SUCCESS',
        newValue: { role: user.role, ip: clientInfo.ip || 'unknown' }
    });

    return {
        token,
        expires_at: expiresAt,
        user: {
            id: user.id,
            username: user.username,
            role: user.role,
            status: user.status,
            has_pin: !!user.pin_hash,
            last_login_at: user.last_login_at
        }
    };
}

/**
 * 12B.6: Invalidate authenticated session token on logout.
 */
function logout(db, token) {
    if (!token) return { success: true };
    const session = queryOne(db, 'SELECT * FROM user_sessions WHERE token = ?', [token]);
    if (session) {
        db.run("UPDATE user_sessions SET revoked_at = datetime('now') WHERE token = ?", [token]);
        recordSecurityAudit(db, {
            userId: session.user_id,
            action: 'LOGOUT',
            newValue: { session_id: session.id }
        });
    }
    return { success: true, message: 'Logged out successfully' };
}

/**
 * 12C: Resolves and validates an active user session by token.
 */
function getUserFromSession(db, token) {
    if (!token) return null;

    const session = queryOne(db, `
        SELECT s.id as session_id, s.token, s.user_id, s.role as session_role, s.expires_at, s.revoked_at,
               u.id, u.username, u.role, u.status, u.pin_hash, u.last_login_at
        FROM user_sessions s
        JOIN users u ON s.user_id = u.id
        WHERE s.token = ?
    `, [token]);

    if (!session) return null;

    // Check revocation
    if (session.revoked_at) return null;

    // Check expiration
    if (new Date(session.expires_at) <= new Date()) return null;

    // Check user status
    if (session.status !== STATUSES.ACTIVE) return null;

    return {
        id: session.id,
        username: session.username,
        role: session.role,
        status: session.status,
        has_pin: !!session.pin_hash,
        session_id: session.session_id,
        expires_at: session.expires_at
    };
}

/**
 * 12B / 12J: Change user password. Requires current password and invalidates previous sessions.
 */
function changePassword(db, userId, currentPassword, newPassword) {
    if (!newPassword || newPassword.length < 6) {
        const err = new Error('New password must be at least 6 characters');
        err.statusCode = 400;
        throw err;
    }

    const user = queryOne(db, 'SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) {
        const err = new Error('User not found');
        err.statusCode = 404;
        throw err;
    }

    if (!verifyPassword(currentPassword, user.password_hash, user.password_salt)) {
        const err = new Error('Current password does not match');
        err.statusCode = 400;
        throw err;
    }

    const { hash, salt } = hashPassword(newPassword);
    db.run(`
        UPDATE users
        SET password_hash = ?, password_salt = ?, updated_at = datetime('now')
        WHERE id = ?
    `, [hash, salt, userId]);

    // 12C.2: Revoke all active sessions for this user
    db.run("UPDATE user_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL", [userId]);

    recordSecurityAudit(db, {
        userId,
        action: 'PASSWORD_CHANGE',
        newValue: { revoked_sessions: true }
    });

    return { success: true, message: 'Password changed successfully. Please log in again.' };
}

// ═════════════════════════════════════════════════════════════════════
// 12D — PIN Security
// ═════════════════════════════════════════════════════════════════════

/**
 * 12D.3: Set or setup initial application PIN.
 */
function setupPin(db, userId, pin, confirmPin) {
    if (!pin || !confirmPin) {
        const err = new Error('PIN and Confirm PIN are required');
        err.statusCode = 400;
        throw err;
    }

    if (pin !== confirmPin) {
        const err = new Error('PIN and Confirm PIN do not match');
        err.statusCode = 400;
        throw err;
    }

    if (!/^\d{4,6}$/.test(pin)) {
        const err = new Error('PIN must be 4 to 6 numeric digits');
        err.statusCode = 400;
        throw err;
    }

    const { hash, salt } = hashPin(pin);

    db.run(`
        UPDATE users
        SET pin_hash = ?, pin_salt = ?, pin_failed_attempts = 0, pin_locked_until = NULL, updated_at = datetime('now')
        WHERE id = ?
    `, [hash, salt, userId]);

    recordSecurityAudit(db, {
        userId,
        action: 'PIN_CHANGE',
        newValue: { setup: true }
    });

    return { success: true, message: 'PIN configured successfully' };
}

/**
 * 12D.5 & 12D.6 & 12D.7: Verify PIN with failed attempt tracking and lockout.
 */
function verifyUserPin(db, userId, pin) {
    const user = queryOne(db, 'SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) {
        const err = new Error('User not found');
        err.statusCode = 404;
        throw err;
    }

    if (!user.pin_hash) {
        const err = new Error('PIN is not configured for this account');
        err.statusCode = 400;
        throw err;
    }

    // 12D.7: Check active lockout
    if (user.pin_locked_until) {
        const lockUntil = new Date(user.pin_locked_until);
        if (lockUntil > new Date()) {
            const minutesLeft = Math.ceil((lockUntil.getTime() - Date.now()) / 60000);
            recordSecurityAudit(db, {
                userId,
                action: 'PIN_FAILURE',
                newValue: { reason: 'PIN_LOCKED', minutes_left: minutesLeft }
            });
            const err = new Error(`PIN verification locked due to excessive failed attempts. Please retry in ${minutesLeft} minute(s) or use password.`);
            err.statusCode = 423; // Locked
            throw err;
        } else {
            // Lockout period has elapsed; reset lock
            db.run('UPDATE users SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?', [userId]);
        }
    }

    const isValid = verifyPin(pin, user.pin_hash, user.pin_salt);

    if (!isValid) {
        const newAttempts = (user.pin_failed_attempts || 0) + 1;
        let lockUntilSql = null;

        if (newAttempts >= MAX_FAILED_PIN_ATTEMPTS) {
            const lockDate = new Date(Date.now() + PIN_LOCKOUT_MINUTES * 60 * 1000).toISOString();
            lockUntilSql = lockDate;
            db.run('UPDATE users SET pin_failed_attempts = ?, pin_locked_until = ? WHERE id = ?', [newAttempts, lockDate, userId]);

            recordSecurityAudit(db, {
                userId,
                action: 'ACCOUNT_LOCK',
                newValue: { lock_type: 'PIN_LOCKOUT', duration_minutes: PIN_LOCKOUT_MINUTES }
            });

            const err = new Error(`PIN locked for ${PIN_LOCKOUT_MINUTES} minutes due to ${MAX_FAILED_PIN_ATTEMPTS} failed attempts.`);
            err.statusCode = 423;
            throw err;
        } else {
            db.run('UPDATE users SET pin_failed_attempts = ? WHERE id = ?', [newAttempts, userId]);
            recordSecurityAudit(db, {
                userId,
                action: 'PIN_FAILURE',
                newValue: { failed_attempts: newAttempts }
            });

            const remaining = MAX_FAILED_PIN_ATTEMPTS - newAttempts;
            const err = new Error(`Incorrect PIN. ${remaining} attempt(s) remaining.`);
            err.statusCode = 401;
            throw err;
        }
    }

    // Success: reset failed attempts
    db.run('UPDATE users SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?', [userId]);

    return { success: true, message: 'PIN verified successfully' };
}

/**
 * 12D.4: Change existing PIN (requires current password or existing PIN).
 */
function changePin(db, userId, currentCredential, newPin, confirmPin) {
    const user = queryOne(db, 'SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) {
        const err = new Error('User not found');
        err.statusCode = 404;
        throw err;
    }

    // Authenticate with either existing PIN or account password
    const isPasswordMatch = verifyPassword(currentCredential, user.password_hash, user.password_salt);
    const isPinMatch = user.pin_hash && verifyPin(currentCredential, user.pin_hash, user.pin_salt);

    if (!isPasswordMatch && !isPinMatch) {
        const err = new Error('Current credential verification failed');
        err.statusCode = 400;
        throw err;
    }

    return setupPin(db, userId, newPin, confirmPin);
}

/**
 * 12D.8: PIN reset requiring strong authentication (password).
 */
function resetPin(db, userId, password, newPin, confirmPin) {
    const user = queryOne(db, 'SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) {
        const err = new Error('User not found');
        err.statusCode = 404;
        throw err;
    }

    if (!verifyPassword(password, user.password_hash, user.password_salt)) {
        const err = new Error('Password verification required to reset PIN');
        err.statusCode = 401;
        throw err;
    }

    return setupPin(db, userId, newPin, confirmPin);
}

// ═════════════════════════════════════════════════════════════════════
// 12G — Password Recovery
// ═════════════════════════════════════════════════════════════════════

/**
 * 12G.1 & 12G.2: Request password reset token.
 */
function requestPasswordReset(db, username) {
    if (!username) {
        const err = new Error('Username is required');
        err.statusCode = 400;
        throw err;
    }

    const cleanUsername = String(username).trim().toLowerCase();
    const user = queryOne(db, 'SELECT * FROM users WHERE lower(username) = ?', [cleanUsername]);

    if (!user || user.status !== STATUSES.ACTIVE) {
        // Prevent username enumeration: return generic success
        return {
            success: true,
            message: 'If the account exists and is active, a password reset token has been generated.'
        };
    }

    const resetToken = generateToken(32);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_MINUTES * 60 * 1000).toISOString();

    db.run(`
        UPDATE users
        SET reset_token = ?, reset_token_expires_at = ?
        WHERE id = ?
    `, [resetToken, expiresAt, user.id]);

    recordSecurityAudit(db, {
        userId: user.id,
        action: 'PASSWORD_RESET_REQUEST',
        newValue: { expires_at: expiresAt }
    });

    return {
        success: true,
        reset_token: resetToken,
        expires_at: expiresAt,
        message: 'Password reset token generated successfully.'
    };
}

/**
 * 12G.1 & 12G.4: Complete password reset using valid single-use token.
 */
function completePasswordReset(db, resetToken, newPassword) {
    if (!resetToken || !newPassword) {
        const err = new Error('Reset token and new password are required');
        err.statusCode = 400;
        throw err;
    }

    if (newPassword.length < 6) {
        const err = new Error('New password must be at least 6 characters');
        err.statusCode = 400;
        throw err;
    }

    const user = queryOne(db, `
        SELECT * FROM users
        WHERE reset_token = ? AND reset_token_expires_at > datetime('now')
    `, [resetToken]);

    if (!user) {
        const err = new Error('Invalid or expired password reset token');
        err.statusCode = 400;
        throw err;
    }

    const { hash, salt } = hashPassword(newPassword);

    // Update password and invalidate reset token
    db.run(`
        UPDATE users
        SET password_hash = ?, password_salt = ?, reset_token = NULL, reset_token_expires_at = NULL, updated_at = datetime('now')
        WHERE id = ?
    `, [hash, salt, user.id]);

    // 12G.4: Invalidate all existing sessions
    db.run("UPDATE user_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL", [user.id]);

    recordSecurityAudit(db, {
        userId: user.id,
        action: 'PASSWORD_CHANGE',
        newValue: { method: 'RESET_TOKEN', sessions_revoked: true }
    });

    return { success: true, message: 'Password has been reset successfully. Please log in with your new password.' };
}

// ═════════════════════════════════════════════════════════════════════
// User Administration (ADMIN only)
// ═════════════════════════════════════════════════════════════════════

function createUser(db, { username, password, role = ROLES.VIEWER }) {
    if (!username || !password) {
        const err = new Error('Username and password are required');
        err.statusCode = 400;
        throw err;
    }

    const cleanUsername = String(username).trim().toLowerCase();
    if (cleanUsername.length < 3) {
        const err = new Error('Username must be at least 3 characters');
        err.statusCode = 400;
        throw err;
    }

    if (!Object.values(ROLES).includes(role)) {
        const err = new Error(`Invalid role: ${role}. Allowed: ${Object.values(ROLES).join(', ')}`);
        err.statusCode = 400;
        throw err;
    }

    const existing = queryOne(db, 'SELECT id FROM users WHERE lower(username) = ?', [cleanUsername]);
    if (existing) {
        const err = new Error(`Username "${cleanUsername}" is already taken`);
        err.statusCode = 409;
        throw err;
    }

    const { hash, salt } = hashPassword(password);
    db.run(`
        INSERT INTO users (username, password_hash, password_salt, role, status)
        VALUES (?, ?, ?, ?, 'ACTIVE')
    `, [cleanUsername, hash, salt, role]);

    const createdUser = queryOne(db, 'SELECT id, username, role, status, created_at FROM users WHERE lower(username) = ?', [cleanUsername]);
    return createdUser;
}

function setUserStatus(db, userId, status) {
    if (![STATUSES.ACTIVE, STATUSES.DISABLED].includes(status)) {
        const err = new Error(`Invalid status: ${status}`);
        err.statusCode = 400;
        throw err;
    }

    db.run("UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, userId]);

    if (status === STATUSES.DISABLED) {
        // Revoke all active sessions for disabled user
        db.run("UPDATE user_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL", [userId]);
    }

    return { success: true, user_id: userId, status };
}

function listUsers(db) {
    return queryAll(db, `
        SELECT id, username, role, status,
               CASE WHEN pin_hash IS NOT NULL THEN 1 ELSE 0 END as has_pin,
               created_at, updated_at, last_login_at
        FROM users
        ORDER BY id ASC
    `);
}

module.exports = {
    ROLES,
    STATUSES,
    hashPassword,
    verifyPassword,
    hashPin,
    verifyPin,
    generateToken,
    login,
    logout,
    getUserFromSession,
    changePassword,
    setupPin,
    verifyUserPin,
    changePin,
    resetPin,
    requestPasswordReset,
    completePasswordReset,
    createUser,
    setUserStatus,
    listUsers,
    recordSecurityAudit
};
