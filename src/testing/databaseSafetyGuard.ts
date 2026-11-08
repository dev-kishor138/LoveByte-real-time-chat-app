import { URL } from "url";

export interface NormalizedDatabaseIdentity {
  protocol: string;
  host: string;
  port: number;
  database: string;
  neonEndpointId?: string;
  isPooler: boolean;
}

export interface DatabaseSafetyVerificationResult {
  isSafe: boolean;
  testDatabase: NormalizedDatabaseIdentity;
  testDirect?: NormalizedDatabaseIdentity;
}

/**
 * Normalizes loopback hostnames (localhost, 127.0.0.1, IPv6 loopback) to canonical 127.0.0.1.
 */
function normalizeHostname(rawHost: string): string {
  const lower = rawHost.toLowerCase();
  if (lower === "localhost" || lower === "127.0.0.1" || lower === "[::1]" || lower === "::1") {
    return "127.0.0.1";
  }
  return lower;
}

/**
 * Extracts a normalized database identity from a PostgreSQL connection string.
 * Strips all authentication credentials (username, password) and query params,
 * normalizing hostname, default port, database name, and Neon endpoint IDs.
 */
export function normalizeConnectionIdentity(
  rawUrl: string,
  fieldLabel: string = "Connection URL"
): NormalizedDatabaseIdentity {
  if (!rawUrl || typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new Error(`${fieldLabel} is required and cannot be empty.`);
  }

  const trimmed = rawUrl.trim();

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Malformed ${fieldLabel}: Unable to parse as a valid URL.`);
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error(
      `Invalid protocol for ${fieldLabel}: Expected 'postgresql:' or 'postgres:', got '${parsed.protocol}'.`
    );
  }

  if (!parsed.hostname) {
    throw new Error(`Invalid ${fieldLabel}: Missing hostname.`);
  }

  const host = normalizeHostname(parsed.hostname);
  const port = parsed.port ? parseInt(parsed.port, 10) : 5432;
  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port for ${fieldLabel}: Must be a valid TCP port (1-65535).`);
  }

  // Pathname is /<database_name>
  const rawPath = parsed.pathname.replace(/^\/+/, "").trim();
  if (!rawPath) {
    throw new Error(`Invalid ${fieldLabel}: Missing database name in path.`);
  }
  const database = rawPath.toLowerCase();

  // Detect Neon Cloud endpoint identifier (e.g. ep-soft-base-bdn4n6os)
  let neonEndpointId: string | undefined;
  let isPooler = false;

  if (host.includes(".neon.tech")) {
    const parts = host.split(".");
    const firstPart = parts[0] || "";
    if (firstPart.endsWith("-pooler")) {
      isPooler = true;
      neonEndpointId = firstPart.replace(/-pooler$/, "");
    } else {
      isPooler = false;
      neonEndpointId = firstPart;
    }
  }

  return {
    protocol: "postgresql:",
    host,
    port,
    database,
    neonEndpointId,
    isPooler,
  };
}

/**
 * Checks whether two normalized database targets point to the same physical database instance.
 * Compares normalized host, port, database, and Neon compute cluster endpoint IDs.
 * 
 * Rules:
 * 1. If both are Neon endpoints, sharing the same endpoint ID is treated as a collision
 *    regardless of database name (prevents running tests on the production Neon compute cluster).
 * 2. Compares both pooled and direct connection variants cleanly.
 * 3. Non-Neon hosts require matching host, port, and database name.
 */
export function isSameDatabaseTarget(
  targetA: NormalizedDatabaseIdentity,
  targetB: NormalizedDatabaseIdentity
): boolean {
  // If both are Neon endpoints, sharing the same base compute endpoint ID
  // is a fatal collision regardless of database name (FINDING-01).
  if (targetA.neonEndpointId && targetB.neonEndpointId) {
    return targetA.neonEndpointId === targetB.neonEndpointId;
  }

  // Standard comparison: host, port, and database name
  return (
    targetA.host === targetB.host &&
    targetA.port === targetB.port &&
    targetA.database === targetB.database
  );
}

export interface VerifyDatabaseSafetyOptions {
  requireDirectUrl?: boolean;
  env?: Record<string, string | undefined>;
}

/**
 * Reusable fail-closed safety guard for integration testing and schema operations.
 * 
 * Rules:
 * 1. TEST_DATABASE_URL must be explicitly configured and non-empty.
 * 2. Never falls back to DATABASE_URL or DIRECT_URL.
 * 3. Rejects missing or malformed configuration.
 * 4. Compares normalized target identities against configured production targets.
 *    Rejects execution if TEST_DATABASE_URL points to the same target as DATABASE_URL or DIRECT_URL.
 * 5. If requireDirectUrl is true, requires TEST_DIRECT_URL and ensures it also does not match production.
 * 6. Enforces explicit test isolation marker: The database name must contain 'test'
 *    (e.g. 'lovebyte_test', 'test_db') OR an explicit TEST_DATABASE_MARKER must be set.
 * 7. Never outputs database credentials or raw connection strings.
 */
export function verifyDatabaseSafety(
  options?: VerifyDatabaseSafetyOptions
): DatabaseSafetyVerificationResult {
  const envSource = options?.env ?? process.env;

  const testDbUrl = envSource.TEST_DATABASE_URL;
  if (!testDbUrl || !testDbUrl.trim()) {
    throw new Error(
      "SAFETY GUARD FAILURE: TEST_DATABASE_URL is not configured. " +
      "Integration tests refuse to run without an explicit, isolated test database URL."
    );
  }

  // Normalize TEST_DATABASE_URL (stripping credentials safely)
  const testDbIdentity = normalizeConnectionIdentity(testDbUrl, "TEST_DATABASE_URL");

  // Verify against production DATABASE_URL if present
  const prodDbUrl = envSource.DATABASE_URL;
  if (prodDbUrl && prodDbUrl.trim()) {
    const prodDbIdentity = normalizeConnectionIdentity(prodDbUrl, "DATABASE_URL");
    if (isSameDatabaseTarget(testDbIdentity, prodDbIdentity)) {
      throw new Error(
        "FATAL SAFETY VIOLATION: TEST_DATABASE_URL resolves to the same database target as production DATABASE_URL! " +
        `Refusing to proceed against target [host: ${testDbIdentity.host}, database: ${testDbIdentity.database}].`
      );
    }
  }

  // Verify against production DIRECT_URL if present
  const prodDirectUrl = envSource.DIRECT_URL;
  if (prodDirectUrl && prodDirectUrl.trim()) {
    const prodDirectIdentity = normalizeConnectionIdentity(prodDirectUrl, "DIRECT_URL");
    if (isSameDatabaseTarget(testDbIdentity, prodDirectIdentity)) {
      throw new Error(
        "FATAL SAFETY VIOLATION: TEST_DATABASE_URL resolves to the same database target as production DIRECT_URL! " +
        `Refusing to proceed against target [host: ${testDbIdentity.host}, database: ${testDbIdentity.database}].`
      );
    }
  }

  // Validate TEST_DIRECT_URL if required (e.g. for migrations / schema provisioning)
  let testDirectIdentity: NormalizedDatabaseIdentity | undefined;
  if (options?.requireDirectUrl) {
    const testDirectUrl = envSource.TEST_DIRECT_URL;
    if (!testDirectUrl || !testDirectUrl.trim()) {
      throw new Error(
        "SAFETY GUARD FAILURE: TEST_DIRECT_URL is required for schema provisioning operations but is not configured."
      );
    }

    testDirectIdentity = normalizeConnectionIdentity(testDirectUrl, "TEST_DIRECT_URL");

    if (prodDbUrl && prodDbUrl.trim()) {
      const prodDbIdentity = normalizeConnectionIdentity(prodDbUrl, "DATABASE_URL");
      if (isSameDatabaseTarget(testDirectIdentity, prodDbIdentity)) {
        throw new Error(
          "FATAL SAFETY VIOLATION: TEST_DIRECT_URL resolves to the same database target as production DATABASE_URL!"
        );
      }
    }

    if (prodDirectUrl && prodDirectUrl.trim()) {
      const prodDirectIdentity = normalizeConnectionIdentity(prodDirectUrl, "DIRECT_URL");
      if (isSameDatabaseTarget(testDirectIdentity, prodDirectIdentity)) {
        throw new Error(
          "FATAL SAFETY VIOLATION: TEST_DIRECT_URL resolves to the same database target as production DIRECT_URL!"
        );
      }
    }
  }

  // Explicit test isolation marker verification
  // A test database must have an identifiable test naming convention or an explicit marker variable
  const hasTestInDbName = testDbIdentity.database.includes("test");
  const hasTestMarker = Boolean(envSource.TEST_DATABASE_MARKER && envSource.TEST_DATABASE_MARKER.trim());

  if (!hasTestInDbName && !hasTestMarker) {
    throw new Error(
      "SAFETY GUARD FAILURE: Target database lacks an explicit test isolation marker. " +
      `The database name '${testDbIdentity.database}' does not contain 'test' and TEST_DATABASE_MARKER is not set. ` +
      "To prevent accidental execution against production, configure a database containing 'test' " +
      "(e.g. 'lovebyte_test') or set TEST_DATABASE_MARKER='verified-test-environment'."
    );
  }

  return {
    isSafe: true,
    testDatabase: testDbIdentity,
    testDirect: testDirectIdentity,
  };
}

