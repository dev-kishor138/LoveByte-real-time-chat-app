/**
 * CORS Configuration and Origin Gatekeeper (SEC-02).
 *
 * Implements strict, fail-closed parsing and evaluation of allowed origins for both
 * Express REST CORS middleware and Socket.IO / Engine.IO connection handshakes.
 */

/**
 * Default production origins explicitly approved for LoveByte deployments.
 * Covers the live Render web service and client origins.
 */
export const DEFAULT_PRODUCTION_ORIGINS: readonly string[] = [
  "https://lovebyte-real-time-chat-app.onrender.com",
];

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
 * - Empty, missing, or whitespace-only -> in production returns DEFAULT_PRODUCTION_ORIGINS; in dev/test returns []
 * - Exactly "*" (exclusive) -> "*" in development/test; [] in production (wildcards strictly rejected in prod)
 * - Mixed wildcard (e.g. "https://app.com,*") -> [] (fails closed completely)
 * - Any malformed or credentialed candidate in a list -> [] (fails closed completely)
 * - Valid comma-separated origins -> array of normalized origins [scheme]://[host]:[port]
 */
export function parseCorsOrigins(
  rawOrigin?: string,
  isProduction: boolean = process.env.NODE_ENV === "production"
): string | string[] {
  if (!rawOrigin || typeof rawOrigin !== "string" || !rawOrigin.trim()) {
    return isProduction ? [...DEFAULT_PRODUCTION_ORIGINS] : [];
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
    return isProduction ? [...DEFAULT_PRODUCTION_ORIGINS] : [];
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
 *
 * NATIVE CLIENT ORIGIN POLICY:
 * Cross-Origin Resource Sharing (CORS) is a browser-enforced security mechanism designed to protect
 * web users from cross-site request forgery and unauthorized data exfiltration.
 *
 * Native mobile clients (Android and iOS compiled via React Native / Expo / OkHttp) execute in an
 * operating-system process rather than a browser sandbox and do not inherently send an `Origin` header.
 * Therefore:
 * 1. Requests lacking an `Origin` header are permitted through the origin gatekeeper.
 * 2. Security for native clients is NOT compromised because origin gatekeeping is only the outer barrier;
 *    EVERY native request strictly requires cryptographic authentication via a verified JWT bearer token.
 * 3. Web browsers ALWAYS send an `Origin` header on cross-origin requests; thus, a browser attacker
 *    cannot omit the `Origin` header to bypass CORS.
 * 4. When native clients (or hybrid webviews) DO send an `Origin` header (such as the app host URL),
 *    it is strictly evaluated against the allowed origins allowlist.
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
 *
 * Enforces the identical Native Client Origin Policy as createCorsOriginResolver to guarantee
 * complete parity between HTTP REST CORS and Socket.IO connection handshakes.
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

