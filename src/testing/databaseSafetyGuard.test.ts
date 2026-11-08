import { describe, it, expect } from "vitest";
import {
  normalizeConnectionIdentity,
  isSameDatabaseTarget,
  verifyDatabaseSafety,
} from "./databaseSafetyGuard";

describe("Database Safety Guard - Connection Normalization", () => {
  it("extracts normalized identity from standard PostgreSQL connection string and strips credentials", () => {
    const raw = "postgresql://myuser:supersecretpassword@db.example.com:5432/lovebyte_test?sslmode=require";
    const identity = normalizeConnectionIdentity(raw);

    expect(identity.protocol).toBe("postgresql:");
    expect(identity.host).toBe("db.example.com");
    expect(identity.port).toBe(5432);
    expect(identity.database).toBe("lovebyte_test");
    expect((identity as any).password).toBeUndefined();
    expect((identity as any).myuser).toBeUndefined();
  });

  it("extracts Neon endpoint identifier and detects pooler suffix", () => {
    const pooledUrl = "postgres://alex:secret123@ep-cool-base-123456-pooler.us-east-2.aws.neon.tech/lovebyte_test";
    const directUrl = "postgresql://alex:secret123@ep-cool-base-123456.us-east-2.aws.neon.tech/lovebyte_test";

    const pooledIdentity = normalizeConnectionIdentity(pooledUrl);
    const directIdentity = normalizeConnectionIdentity(directUrl);

    expect(pooledIdentity.neonEndpointId).toBe("ep-cool-base-123456");
    expect(pooledIdentity.isPooler).toBe(true);

    expect(directIdentity.neonEndpointId).toBe("ep-cool-base-123456");
    expect(directIdentity.isPooler).toBe(false);

    // Both point to the exact same Neon compute instance
    expect(isSameDatabaseTarget(pooledIdentity, directIdentity)).toBe(true);
  });

  it("throws descriptive error for missing or empty URL", () => {
    expect(() => normalizeConnectionIdentity("")).toThrow("is required and cannot be empty");
    expect(() => normalizeConnectionIdentity("   ")).toThrow("is required and cannot be empty");
  });

  it("throws descriptive error for invalid protocol", () => {
    expect(() => normalizeConnectionIdentity("mysql://user:pass@localhost:3306/test")).toThrow(
      "Expected 'postgresql:' or 'postgres:'"
    );
  });

  it("throws descriptive error for malformed URL", () => {
    expect(() => normalizeConnectionIdentity("not-a-valid-url")).toThrow("Unable to parse as a valid URL");
  });

  it("throws descriptive error for missing database name", () => {
    expect(() => normalizeConnectionIdentity("postgresql://user:pass@localhost:5432/")).toThrow(
      "Missing database name in path"
    );
  });
});

describe("Database Safety Guard - Fail-Closed Safety Verification", () => {
  const prodDatabaseUrl = "postgresql://prod_user:secret_prod_pw@ep-prod-cluster-pooler.c-8.us-east-2.aws.neon.tech/neondb";
  const prodDirectUrl = "postgresql://prod_user:secret_prod_pw@ep-prod-cluster.c-8.us-east-2.aws.neon.tech/neondb";

  it("fails closed when TEST_DATABASE_URL is missing or empty", () => {
    expect(() =>
      verifyDatabaseSafety({
        env: {
          DATABASE_URL: prodDatabaseUrl,
          DIRECT_URL: prodDirectUrl,
        },
      })
    ).toThrow("TEST_DATABASE_URL is not configured");
  });

  it("fails closed and rejects target when TEST_DATABASE_URL matches production DATABASE_URL", () => {
    expect(() =>
      verifyDatabaseSafety({
        env: {
          DATABASE_URL: prodDatabaseUrl,
          DIRECT_URL: prodDirectUrl,
          TEST_DATABASE_URL: prodDatabaseUrl, // Collision!
        },
      })
    ).toThrow("FATAL SAFETY VIOLATION: TEST_DATABASE_URL resolves to the same database target as production DATABASE_URL!");
  });

  it("fails closed when TEST_DATABASE_URL uses different credentials but points to production Neon cluster", () => {
    // Different username/password and direct instead of pooler, but SAME Neon endpoint cluster and database name!
    const sneakyProdCollision = "postgresql://other_user:other_pw@ep-prod-cluster.c-8.us-east-2.aws.neon.tech/neondb";

    expect(() =>
      verifyDatabaseSafety({
        env: {
          DATABASE_URL: prodDatabaseUrl,
          DIRECT_URL: prodDirectUrl,
          TEST_DATABASE_URL: sneakyProdCollision,
        },
      })
    ).toThrow("FATAL SAFETY VIOLATION: TEST_DATABASE_URL resolves to the same database target as production");
  });

  it("fails closed when TEST_DATABASE_URL matches production DIRECT_URL", () => {
    expect(() =>
      verifyDatabaseSafety({
        env: {
          DATABASE_URL: undefined,
          DIRECT_URL: prodDirectUrl,
          TEST_DATABASE_URL: prodDirectUrl,
        },
      })
    ).toThrow("FATAL SAFETY VIOLATION: TEST_DATABASE_URL resolves to the same database target as production DIRECT_URL!");
  });

  it("fails closed when schema provisioning requires TEST_DIRECT_URL but it is missing", () => {
    const validTestDb = "postgresql://test_user:test_pw@ep-test-cluster.us-east-2.aws.neon.tech/lovebyte_test";

    expect(() =>
      verifyDatabaseSafety({
        requireDirectUrl: true,
        env: {
          DATABASE_URL: prodDatabaseUrl,
          DIRECT_URL: prodDirectUrl,
          TEST_DATABASE_URL: validTestDb,
          // TEST_DIRECT_URL is missing
        },
      })
    ).toThrow("TEST_DIRECT_URL is required for schema provisioning operations but is not configured.");
  });

  it("fails closed when TEST_DIRECT_URL matches production database", () => {
    const validTestDb = "postgresql://test_user:test_pw@ep-test-cluster.us-east-2.aws.neon.tech/lovebyte_test";

    expect(() =>
      verifyDatabaseSafety({
        requireDirectUrl: true,
        env: {
          DATABASE_URL: prodDatabaseUrl,
          DIRECT_URL: prodDirectUrl,
          TEST_DATABASE_URL: validTestDb,
          TEST_DIRECT_URL: prodDirectUrl, // Collision!
        },
      })
    ).toThrow("FATAL SAFETY VIOLATION: TEST_DIRECT_URL resolves to the same database target");
  });

  it("fails closed when target database name lacks test isolation marker and TEST_DATABASE_MARKER is missing", () => {
    // Different host, but database is named 'production_db' or generic 'neondb' without test marker
    const unverifiedTarget = "postgresql://user:pass@ep-isolated-project.aws.neon.tech/neondb";

    expect(() =>
      verifyDatabaseSafety({
        env: {
          DATABASE_URL: prodDatabaseUrl,
          DIRECT_URL: prodDirectUrl,
          TEST_DATABASE_URL: unverifiedTarget,
        },
      })
    ).toThrow("Target database lacks an explicit test isolation marker");
  });

  it("passes verification when database name contains 'test'", () => {
    const validTestDb = "postgresql://test_user:test_pw@ep-isolated-project-pooler.aws.neon.tech/lovebyte_test";
    const validTestDirect = "postgresql://test_user:test_pw@ep-isolated-project.aws.neon.tech/lovebyte_test";

    const result = verifyDatabaseSafety({
      requireDirectUrl: true,
      env: {
        DATABASE_URL: prodDatabaseUrl,
        DIRECT_URL: prodDirectUrl,
        TEST_DATABASE_URL: validTestDb,
        TEST_DIRECT_URL: validTestDirect,
      },
    });

    expect(result.isSafe).toBe(true);
    expect(result.testDatabase.database).toBe("lovebyte_test");
    expect(result.testDatabase.host).toBe("ep-isolated-project-pooler.aws.neon.tech");
    expect(result.testDirect?.host).toBe("ep-isolated-project.aws.neon.tech");
  });

  it("passes verification when explicit TEST_DATABASE_MARKER is provided", () => {
    const validCustomTestDb = "postgresql://test_user:test_pw@ep-isolated-test-cluster.aws.neon.tech/customdb";

    const result = verifyDatabaseSafety({
      env: {
        DATABASE_URL: prodDatabaseUrl,
        DIRECT_URL: prodDirectUrl,
        TEST_DATABASE_URL: validCustomTestDb,
        TEST_DATABASE_MARKER: "verified-isolated-neon-project",
      },
    });

    expect(result.isSafe).toBe(true);
    expect(result.testDatabase.database).toBe("customdb");
  });

  describe("FINDING-01 Regression Tests — Neon Compute Endpoint Collision Hardening", () => {
    it("1. Rejects test database on same Neon endpoint even if database name is different", () => {
      // Production database is 'neondb' on 'ep-prod-cluster'; test database is 'lovebyte_test' on the same endpoint!
      const sameEndpointDiffDb = "postgresql://test_user:test_pw@ep-prod-cluster.c-8.us-east-2.aws.neon.tech/lovebyte_test";

      expect(() =>
        verifyDatabaseSafety({
          env: {
            DATABASE_URL: prodDatabaseUrl,
            DIRECT_URL: prodDirectUrl,
            TEST_DATABASE_URL: sameEndpointDiffDb,
          },
        })
      ).toThrow("FATAL SAFETY VIOLATION: TEST_DATABASE_URL resolves to the same database target as production");
    });

    it("2. Rejects test database on same Neon endpoint with different credentials and database name", () => {
      const sameEndpointDiffCreds = "postgresql://completely_diff_user:secret_other@ep-prod-cluster-pooler.c-8.us-east-2.aws.neon.tech/isolated_test_name";

      expect(() =>
        verifyDatabaseSafety({
          env: {
            DATABASE_URL: prodDatabaseUrl,
            DIRECT_URL: prodDirectUrl,
            TEST_DATABASE_URL: sameEndpointDiffCreds,
          },
        })
      ).toThrow("FATAL SAFETY VIOLATION: TEST_DATABASE_URL resolves to the same database target as production");
    });

    it("3. Rejects pooled production URL versus direct test URL on same Neon endpoint", () => {
      const prodPooled = "postgresql://prod:secret@ep-shared-cluster-pooler.aws.neon.tech/neondb";
      const testDirect = "postgresql://test:secret@ep-shared-cluster.aws.neon.tech/diff_test_db";

      expect(() =>
        verifyDatabaseSafety({
          env: {
            DATABASE_URL: prodPooled,
            TEST_DATABASE_URL: testDirect,
          },
        })
      ).toThrow("FATAL SAFETY VIOLATION: TEST_DATABASE_URL resolves to the same database target as production");
    });

    it("4. Rejects direct production URL versus pooled test URL on same Neon endpoint", () => {
      const prodDirect = "postgresql://prod:secret@ep-shared-cluster.aws.neon.tech/neondb";
      const testPooled = "postgresql://test:secret@ep-shared-cluster-pooler.aws.neon.tech/diff_test_db";

      expect(() =>
        verifyDatabaseSafety({
          env: {
            DIRECT_URL: prodDirect,
            TEST_DATABASE_URL: testPooled,
          },
        })
      ).toThrow("FATAL SAFETY VIOLATION: TEST_DATABASE_URL resolves to the same database target as production");
    });

    it("5. Rejects same endpoint collision even when TEST_DATABASE_MARKER is set", () => {
      const sameEndpointDb = "postgresql://user:pass@ep-prod-cluster.c-8.us-east-2.aws.neon.tech/lovebyte_test";

      expect(() =>
        verifyDatabaseSafety({
          env: {
            DATABASE_URL: prodDatabaseUrl,
            DIRECT_URL: prodDirectUrl,
            TEST_DATABASE_URL: sameEndpointDb,
            TEST_DATABASE_MARKER: "bypass-attempt",
          },
        })
      ).toThrow("FATAL SAFETY VIOLATION: TEST_DATABASE_URL resolves to the same database target as production");
    });

    it("6. Accepts when Neon compute endpoint is completely distinct and isolated", () => {
      const isolatedTestDb = "postgresql://user:pass@ep-totally-isolated-cluster-pooler.aws.neon.tech/lovebyte_test";
      const isolatedTestDirect = "postgresql://user:pass@ep-totally-isolated-cluster.aws.neon.tech/lovebyte_test";

      const result = verifyDatabaseSafety({
        requireDirectUrl: true,
        env: {
          DATABASE_URL: prodDatabaseUrl,
          DIRECT_URL: prodDirectUrl,
          TEST_DATABASE_URL: isolatedTestDb,
          TEST_DIRECT_URL: isolatedTestDirect,
        },
      });

      expect(result.isSafe).toBe(true);
      expect(result.testDatabase.neonEndpointId).toBe("ep-totally-isolated-cluster");
      expect(result.testDatabase.isPooler).toBe(true);
      expect(result.testDirect?.isPooler).toBe(false);
    });
  });

  describe("FINDING-05 Regression Tests — Localhost Hostname Normalization", () => {
    it("1. Treats localhost and 127.0.0.1 on the same port and database as the same target", () => {
      const targetLocalhost = normalizeConnectionIdentity("postgresql://user:pass@localhost:5432/my_test_db");
      const targetIpv4 = normalizeConnectionIdentity("postgresql://user:pass@127.0.0.1:5432/my_test_db");

      expect(isSameDatabaseTarget(targetLocalhost, targetIpv4)).toBe(true);
    });

    it("2. Distinguishes localhost and 127.0.0.1 when ports differ", () => {
      const target5432 = normalizeConnectionIdentity("postgresql://user:pass@localhost:5432/my_test_db");
      const target5433 = normalizeConnectionIdentity("postgresql://user:pass@127.0.0.1:5433/my_test_db");

      expect(isSameDatabaseTarget(target5432, target5433)).toBe(false);
    });

    it("3. Distinguishes localhost and 127.0.0.1 when database names differ", () => {
      const targetDb1 = normalizeConnectionIdentity("postgresql://user:pass@localhost:5432/db_one");
      const targetDb2 = normalizeConnectionIdentity("postgresql://user:pass@127.0.0.1:5432/db_two");

      expect(isSameDatabaseTarget(targetDb1, targetDb2)).toBe(false);
    });

    it("4. Treats IPv6 loopback [::1] as equivalent to 127.0.0.1 and localhost", () => {
      const targetIpv6 = normalizeConnectionIdentity("postgresql://user:pass@[::1]:5432/my_test_db");
      const targetLocalhost = normalizeConnectionIdentity("postgresql://user:pass@localhost:5432/my_test_db");

      expect(isSameDatabaseTarget(targetIpv6, targetLocalhost)).toBe(true);
    });

    it("5. Distinguishes remote host from localhost", () => {
      const targetRemote = normalizeConnectionIdentity("postgresql://user:pass@remote.db.server:5432/my_test_db");
      const targetLocalhost = normalizeConnectionIdentity("postgresql://user:pass@localhost:5432/my_test_db");

      expect(isSameDatabaseTarget(targetRemote, targetLocalhost)).toBe(false);
    });
  });
});
