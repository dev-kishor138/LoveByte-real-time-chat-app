/**
 * CORS Configuration and Origin Gatekeeper (SEC-02).
 *
 * Implements strict, fail-closed parsing and evaluation of allowed origins for both
 * Express REST CORS middleware and Socket.IO / Engine.IO connection handshakes.
 */

/**
 * Validates that an origin string conforms to RFC 6454 serialized origin rules:
 * - Scheme must be http: or https:
 * - Hostname must be non-empty
 * - No userinfo credentials (username/password)
 * - No subpath (pathname must be empty or '/')
 * - No query string or URL fragment
 */
export function isValidOrigin(originStr: string): boolean {
  try {
    const parsed = new URL(originStr);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    if (!parsed.hostname) {
      return false;
    }
    if (parsed.username !== "" || parsed.password !== "") {
      return false;
    }
    if (parsed.pathname !== "" && parsed.pathname !== "/") {
      return false;
    }
    if (parsed.search !== "" || parsed.hash !== "") {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses raw CORS configuration string into an allowed origin array or exclusive development wildcard.
 *
 * Rules:
 * - Empty, missing, or whitespace-only -> []
 * - Exactly "*" (exclusive) -> "*" in development/test; [] in production
 * - Mixed wildcard (e.g. "https://app.com,*") -> []
 * - Any malformed or credentialed candidate in a list -> [] (fails closed completely)
 * - Valid comma-separated origins -> array of normalized origins [scheme]://[host]:[port]
 */
export function parseCorsOrigins(
  rawOrigin?: string,
  isProduction: boolean = process.env.NODE_ENV === "production"
): string | string[] {
  if (!rawOrigin || typeof rawOrigin !== "string" || !rawOrigin.trim()) {
    return [];
  }

  const trimmed = rawOrigin.trim();

  // Exclusive wildcard check: permitted ONLY when the trimmed config is exactly "*"
  if (trimmed === "*") {
    // In production, wildcard '*' is disallowed to prevent CSRF and cross-origin credential exposure.
    // Fails closed by returning [] (rejecting browser requests with an Origin header).
    return isProduction ? [] : "*";
  }

  // Parse comma-separated list with trimming and redundant comma removal
  const candidates = trimmed
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  if (candidates.length === 0) {
    return [];
  }

  // Mixed wildcard rejection: wildcard is only valid if exclusively configured alone
  if (candidates.includes("*")) {
    return [];
  }

  const validOrigins: string[] = [];
  for (const candidate of candidates) {
    if (!isValidOrigin(candidate)) {
      // FAIL CLOSED: If ANY non-empty candidate is invalid, reject the entire configuration
      return [];
    }
    const parsed = new URL(candidate);
    validOrigins.push(parsed.origin.toLowerCase());
  }

  return validOrigins;
}

/**
 * Creates an Express CORS origin resolver callback for use with the `cors` package.
 */
export function createCorsOriginResolver(
  allowedOrigins: string | string[]
): (
  requestOrigin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void
) => void {
  return (requestOrigin, callback) => {
    // 1. Missing Origin header (native mobile clients, curl, server-to-server)
    if (!requestOrigin) {
      callback(null, true);
      return;
    }

    // 2. Exclusive development wildcard
    if (allowedOrigins === "*") {
      callback(null, true);
      return;
    }

    // 3. Allowed origins list
    if (Array.isArray(allowedOrigins)) {
      if (allowedOrigins.length === 0) {
        callback(null, false);
        return;
      }
      const isAllowed = allowedOrigins.includes(requestOrigin.toLowerCase());
      callback(null, isAllowed);
      return;
    }

    // Fail-closed fallback
    callback(null, false);
  };
}

/**
 * Synchronous evaluator for Engine.IO `allowRequest` hook to validate incoming Origin.
 */
export function evaluateOrigin(
  origin: string | undefined,
  allowedOrigins: string | string[]
): boolean {
  // Missing Origin header (native mobile clients, non-browser clients)
  if (!origin) {
    return true;
  }

  // Exclusive development wildcard
  if (allowedOrigins === "*") {
    return true;
  }

  // Allowed origins array
  if (Array.isArray(allowedOrigins)) {
    if (allowedOrigins.length === 0) {
      return false; // Fail-closed
    }
    return allowedOrigins.includes(origin.toLowerCase());
  }

  return false;
}

