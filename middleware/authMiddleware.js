/**
 * Interest Manager — Authentication & Authorization Middleware (Part 12A, 12E)
 *
 * Implements:
 *   12A: Backend authoritative authentication & token verification
 *   12E: Role-based access control (ADMIN, STAFF, VIEWER)
 *   12E.2: Read vs Write separation
 *   12E.3: Backup restore protection (ADMIN only)
 */

const { getDatabase } = require('../db/connection');
const { getUserFromSession, ROLES } = require('../services/authService');

/**
 * Extracts bearer token from request headers or cookies.
 */
function extractToken(req) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7).trim();
    }
    if (req.headers['x-auth-token']) {
        return String(req.headers['x-auth-token']).trim();
    }
    return null;
}

/**
 * 12A.1 & 12B: Authentication middleware.
 * Verifies bearer token against active user sessions.
 */
async function authenticate(req, res, next) {
    const token = extractToken(req);

    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'Authentication required. Please provide a valid bearer token.'
        });
    }

    try {
        const db = await getDatabase();
        const user = getUserFromSession(db, token);

        if (!user) {
            return res.status(401).json({
                success: false,
                error: 'Invalid, revoked, or expired authentication token.'
            });
        }

        req.user = user;
        req.token = token;
        next();
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: 'Authentication processing error'
        });
    }
}

/**
 * 12E: Role-based authorization middleware.
 */
function requireRole(...allowedRoles) {
    return function roleMiddleware(req, res, next) {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                error: 'Authentication required.'
            });
        }

        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: `Permission denied. Required role: ${allowedRoles.join(' or ')}. Your role: ${req.user.role}.`
            });
        }

        next();
    };
}

/**
 * Shortcut: Requires ADMIN role.
 */
const requireAdmin = requireRole(ROLES.ADMIN);

/**
 * Shortcut: Requires STAFF or ADMIN role (Write operations).
 */
const requireStaffOrAdmin = requireRole(ROLES.ADMIN, ROLES.STAFF);

/**
 * Optional authentication: attaches req.user if valid token provided, but does not block if missing.
 */
async function optionalAuth(req, res, next) {
    const token = extractToken(req);
    if (!token) {
        req.user = null;
        return next();
    }

    try {
        const db = await getDatabase();
        req.user = getUserFromSession(db, token);
    } catch (_) {
        req.user = null;
    }
    next();
}

module.exports = {
    extractToken,
    authenticate,
    requireRole,
    requireAdmin,
    requireStaffOrAdmin,
    optionalAuth,
    ROLES
};
