import rateLimit, { MemoryStore } from "express-rate-limit";

// Explicit memory stores to allow test-only deterministic resets
export const authStore = new MemoryStore();
export const refreshStore = new MemoryStore();
export const apiStore = new MemoryStore();

/**
 * Strict rate limiter for authentication endpoints (login, register).
 * Limits repeated attempts to prevent brute force.
 */
export const authRateLimiter = rateLimit({
  store: authStore,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many authentication attempts, please try again later.",
  },
});

/**
 * Dedicated rate limiter for token refresh rotation requests.
 */
export const refreshRateLimiter = rateLimit({
  store: refreshStore,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60, // Limit each IP to 60 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many token refresh attempts, please try again later.",
  },
});

/**
 * General API rate limiter for standard routes.
 */
export const apiRateLimiter = rateLimit({
  store: apiStore,
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // Limit each IP to 300 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests, please try again later.",
  },
});

/**
 * Test-only utility to reset all rate limiter memory stores between test suites.
 * Strictly rejected if NODE_ENV !== "test" to guarantee production rate limiting is never weakened.
 */
export function resetRateLimiters(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("resetRateLimiters is restricted strictly to test environment (NODE_ENV=test)");
  }
  authStore.resetAll();
  refreshStore.resetAll();
  apiStore.resetAll();
}


