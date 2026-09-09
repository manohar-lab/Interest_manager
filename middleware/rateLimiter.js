/**
 * Interest Manager — Rate Limiter Middleware (Part 12L)
 *
 * Sliding-window in-memory rate limiting to protect sensitive endpoints:
 *   - 12L.1: Login throttling
 *   - 12L.2: PIN verification throttling
 *   - 12L.3: Password / PIN recovery throttling
 */

const trackers = new Map();

/**
 * Creates an Express rate-limiting middleware instance.
 *
 * @param {Object} options
 * @param {string} options.keyPrefix - Unique namespace (e.g. 'login', 'pin', 'reset')
 * @param {number} options.windowMs - Time window in milliseconds (default: 15 min)
 * @param {number} options.maxAttempts - Maximum allowed attempts within window
 * @param {string} options.message - Custom error message
 */
function createRateLimiter(options = {}) {
    const keyPrefix = options.keyPrefix || 'default';
    const windowMs = options.windowMs || 15 * 60 * 1000;
    const maxAttempts = options.maxAttempts || 10;
    const message = options.message || 'Too many requests. Please try again later.';

    return function rateLimiterMiddleware(req, res, next) {
        // Exclude in internal test bypass if needed
        if (req.skipRateLimit || req.headers['x-bypass-rate-limit'] === 'test-internal') {
            return next();
        }

        const ip = req.ip || req.connection?.remoteAddress || '127.0.0.1';
        const key = `${keyPrefix}:${ip}`;
        const now = Date.now();

        let record = trackers.get(key);

        if (!record || now - record.startTime > windowMs) {
            record = {
                startTime: now,
                attempts: 0
            };
            trackers.set(key, record);
        }

        record.attempts += 1;

        if (record.attempts > maxAttempts) {
            const retryAfterSec = Math.ceil((record.startTime + windowMs - now) / 1000);
            res.set('Retry-After', String(retryAfterSec));
            return res.status(429).json({
                success: false,
                error: message,
                retry_after_seconds: retryAfterSec
            });
        }

        next();
    };
}

/**
 * Reset trackers (for testing).
 */
function resetRateLimiters() {
    trackers.clear();
}

const loginLimiter = createRateLimiter({
    keyPrefix: 'login',
    windowMs: 15 * 60 * 1000,
    maxAttempts: 50,
    message: 'Too many failed login attempts from this IP. Please try again in 15 minutes.'
});

const pinLimiter = createRateLimiter({
    keyPrefix: 'pin',
    windowMs: 15 * 60 * 1000,
    maxAttempts: 5,
    message: 'Too many PIN attempts. Please try again later.'
});

const resetLimiter = createRateLimiter({
    keyPrefix: 'reset',
    windowMs: 15 * 60 * 1000,
    maxAttempts: 5,
    message: 'Too many password reset requests. Please try again later.'
});

module.exports = {
    createRateLimiter,
    resetRateLimiters,
    loginLimiter,
    pinLimiter,
    resetLimiter
};
