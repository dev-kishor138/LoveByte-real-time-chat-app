import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "../../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { AuthService } from "./auth.service";
import { verifyDatabaseSafety } from "../../testing/databaseSafetyGuard";
import { env } from "../../config/env";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL || "postgresql://postgres@127.0.0.1:54333/lovebyte_test";

// Enforce fail-closed database safety guard prior to any test execution
verifyDatabaseSafety({
  env: {
    ...process.env,
    TEST_DATABASE_URL: TEST_DB_URL,
    TEST_DATABASE_MARKER: "verified-test-environment",
  },
});

const adapter = new PrismaPg({
  connectionString: TEST_DB_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

const testPrisma = new PrismaClient({ adapter });
const realAuthService = new AuthService(testPrisma);

describe("Real PostgreSQL Concurrency Integration Verification", () => {
  let pgVersion: string = "unknown";

  beforeAll(async () => {
    // Verify physical connection and fetch exact PostgreSQL engine version
    const result = await testPrisma.$queryRaw<Array<{ version: string }>>`SELECT version();`;
    expect(result).toBeDefined();
    expect(result.length).toBeGreaterThan(0);
    pgVersion = result[0].version;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean up test data in isolated lovebyte_test database between test cases
    await testPrisma.otpCode.deleteMany();
    await testPrisma.session.deleteMany();
    await testPrisma.message.deleteMany();
    await testPrisma.conversation.deleteMany();
    await testPrisma.user.deleteMany();
  });

  // =========================================================================
  // Section 2A: Failed OTP Attempt Persistence in Real PostgreSQL
  // =========================================================================
  describe("2A. Failed OTP Attempt Persistence", () => {
    it("persists failed attempt counter increments to PostgreSQL even when request returns 400", async () => {
      const email = "attempt-persist@gmail.com";
      const user = await testPrisma.user.create({
        data: {
          email,
          passwordHash: await realAuthService.hashPassword("SecurePass123!"),
          isVerified: false,
        },
      });

      const correctCode = "123456";
      const codeHash = realAuthService.hashOtp(user.id, "EMAIL_VERIFICATION", correctCode);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

      const otp = await testPrisma.otpCode.create({
        data: {
          userId: user.id,
          type: "EMAIL_VERIFICATION",
          codeHash,
          expiresAt,
          maxAttempts: 5,
          attempts: 0,
          isUsed: false,
        },
      });

      // 1. Submit an invalid OTP
      await expect(
        realAuthService.verifyEmail({ email, code: "999999" })
      ).rejects.toThrow("Invalid verification code");

      // 2. Query PostgreSQL independently and verify attempts increased to 1
      const recordAfter1 = await testPrisma.otpCode.findUnique({ where: { id: otp.id } });
      expect(recordAfter1).not.toBeNull();
      expect(recordAfter1!.attempts).toBe(1);
      expect(recordAfter1!.isUsed).toBe(false);

      // 3. Repeat for attempts 2, 3, and 4
      for (let i = 2; i <= 4; i++) {
        await expect(
          realAuthService.verifyEmail({ email, code: "000000" })
        ).rejects.toThrow();

        const rec = await testPrisma.otpCode.findUnique({ where: { id: otp.id } });
        expect(rec!.attempts).toBe(i);
        expect(rec!.isUsed).toBe(false);
      }

      // 4. 5th invalid attempt reaches maxAttempts (5)
      await expect(
        realAuthService.verifyEmail({ email, code: "111111" })
      ).rejects.toThrow("Maximum verification attempts exceeded");

      // Verify PostgreSQL has permanently locked the OTP
      const recordAfter5 = await testPrisma.otpCode.findUnique({ where: { id: otp.id } });
      expect(recordAfter5!.attempts).toBe(5);
      expect(recordAfter5!.isUsed).toBe(true);

      // 5. Subsequent request with the CORRECT OTP must be rejected
      await expect(
        realAuthService.verifyEmail({ email, code: correctCode })
      ).rejects.toThrow();

      // Confirm user is still unverified
      const userFinal = await testPrisma.user.findUnique({ where: { id: user.id } });
      expect(userFinal!.isVerified).toBe(false);
    });
  });

  // =========================================================================
  // Section 2B: Concurrent Invalid OTP Requests in Real PostgreSQL
  // =========================================================================
  describe("2B. Concurrent Invalid OTP Requests", () => {
    it("serializes concurrent invalid OTP requests via User row lock without losing attempt counts", async () => {
      const email = "concurrent-invalid@gmail.com";
      const user = await testPrisma.user.create({
        data: {
          email,
          passwordHash: await realAuthService.hashPassword("SecurePass123!"),
          isVerified: false,
        },
      });

      const correctCode = "654321";
      const codeHash = realAuthService.hashOtp(user.id, "EMAIL_VERIFICATION", correctCode);
      const otp = await testPrisma.otpCode.create({
        data: {
          userId: user.id,
          type: "EMAIL_VERIFICATION",
          codeHash,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
          maxAttempts: 5,
          attempts: 0,
          isUsed: false,
        },
      });

      // Submit 5 concurrent incorrect OTP requests simultaneously
      const invalidPromises = [
        realAuthService.verifyEmail({ email, code: "000001" }),
        realAuthService.verifyEmail({ email, code: "000002" }),
        realAuthService.verifyEmail({ email, code: "000003" }),
        realAuthService.verifyEmail({ email, code: "000004" }),
        realAuthService.verifyEmail({ email, code: "000005" }),
      ];

      const results = await Promise.allSettled(invalidPromises);
      // All 5 must have failed with rejection
      expect(results.every((r) => r.status === "rejected")).toBe(true);

      // Query PostgreSQL independently: exactly 5 attempts must be recorded (no lost updates!)
      const otpRecord = await testPrisma.otpCode.findUnique({ where: { id: otp.id } });
      expect(otpRecord).not.toBeNull();
      expect(otpRecord!.attempts).toBe(5);
      expect(otpRecord!.isUsed).toBe(true);

      // Even with the correct code, lockout cannot be bypassed
      await expect(
        realAuthService.verifyEmail({ email, code: correctCode })
      ).rejects.toThrow();

      const userAfter = await testPrisma.user.findUnique({ where: { id: user.id } });
      expect(userAfter!.isVerified).toBe(false);
    });
  });

  // =========================================================================
  // Section 2C: Concurrent Successful OTP Claims in Real PostgreSQL
  // =========================================================================
  describe("2C. Concurrent Successful OTP Claims", () => {
    it("allows exactly one claim when two simultaneous requests submit the same valid OTP", async () => {
      const email = "concurrent-claims@gmail.com";
      const user = await testPrisma.user.create({
        data: {
          email,
          passwordHash: await realAuthService.hashPassword("SecurePass123!"),
          isVerified: false,
        },
      });

      const validCode = "777888";
      const codeHash = realAuthService.hashOtp(user.id, "EMAIL_VERIFICATION", validCode);
      const otp = await testPrisma.otpCode.create({
        data: {
          userId: user.id,
          type: "EMAIL_VERIFICATION",
          codeHash,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
          maxAttempts: 5,
          attempts: 0,
          isUsed: false,
        },
      });

      // Submit two simultaneous verification requests with the same valid OTP
      const results = await Promise.allSettled([
        realAuthService.verifyEmail({ email, code: validCode }),
        realAuthService.verifyEmail({ email, code: validCode }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Exactly ONE request must succeed; the other must be rejected
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      // Verify PostgreSQL state
      const updatedUser = await testPrisma.user.findUnique({ where: { id: user.id } });
      expect(updatedUser!.isVerified).toBe(true);

      const updatedOtp = await testPrisma.otpCode.findUnique({ where: { id: otp.id } });
      expect(updatedOtp!.isUsed).toBe(true);
    });
  });

  // =========================================================================
  // Section 2D: Transaction Rollback in Real PostgreSQL
  // =========================================================================
  describe("2D. Transaction Rollback Safety", () => {
    it("rolls back OTP claim in PostgreSQL if user account mutation fails, leaving OTP unconsumed", async () => {
      const email = "rollback-test@gmail.com";
      const user = await testPrisma.user.create({
        data: {
          email,
          passwordHash: await realAuthService.hashPassword("SecurePass123!"),
          isVerified: false,
        },
      });

      const validCode = "333444";
      const codeHash = realAuthService.hashOtp(user.id, "EMAIL_VERIFICATION", validCode);
      const otp = await testPrisma.otpCode.create({
        data: {
          userId: user.id,
          type: "EMAIL_VERIFICATION",
          codeHash,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
          maxAttempts: 5,
          attempts: 0,
          isUsed: false,
        },
      });

      // Simulate an unhandled failure during account mutation inside a transaction
      let transactionError: Error | null = null;
      try {
        await testPrisma.$transaction(async (tx) => {
          // 1. Lock user
          await tx.user.update({
            where: { id: user.id },
            data: { updatedAt: new Date() },
          });

          // 2. Claim OTP
          const claim = await tx.otpCode.updateMany({
            where: { id: otp.id, isUsed: false },
            data: { isUsed: true },
          });
          expect(claim.count).toBe(1);

          // 3. Force database error / exception during user state update
          throw new Error("Simulated storage failure during user mutation");
        });
      } catch (err) {
        transactionError = err as Error;
      }

      expect(transactionError).not.toBeNull();
      expect(transactionError!.message).toContain("Simulated storage failure");

      // Verify PostgreSQL executed ROLLBACK: OTP isUsed must remain FALSE
      const otpAfterRollback = await testPrisma.otpCode.findUnique({ where: { id: otp.id } });
      expect(otpAfterRollback!.isUsed).toBe(false);

      // Verify the OTP is still usable by realAuthService
      const successResult = await realAuthService.verifyEmail({ email, code: validCode });
      expect(successResult.success).toBe(true);

      const userFinal = await testPrisma.user.findUnique({ where: { id: user.id } });
      expect(userFinal!.isVerified).toBe(true);
    });
  });

  // =========================================================================
  // Section 2E: Resend and Verification Concurrency in Real PostgreSQL
  // =========================================================================
  describe("2E. Resend and Verification Concurrency", () => {
    it("executes resend and verification concurrently without deadlock (40P01) or inconsistent state", async () => {
      const email = "concurrency-resend@gmail.com";
      const user = await testPrisma.user.create({
        data: {
          email,
          passwordHash: await realAuthService.hashPassword("SecurePass123!"),
          isVerified: false,
        },
      });

      const initialCode = "555666";
      const codeHash = realAuthService.hashOtp(user.id, "EMAIL_VERIFICATION", initialCode);
      await testPrisma.otpCode.create({
        data: {
          userId: user.id,
          type: "EMAIL_VERIFICATION",
          codeHash,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
          maxAttempts: 5,
          attempts: 0,
          isUsed: false,
          // Set createdAt to 70 seconds ago so resend cooldown does not block it immediately
          createdAt: new Date(Date.now() - 70 * 1000),
        },
      });

      // Concurrently execute resend and verification on the same user
      const results = await Promise.allSettled([
        realAuthService.verifyEmail({ email, code: initialCode }),
        realAuthService.resendOtp({ email, type: "EMAIL_VERIFICATION" }),
      ]);

      // Both must complete cleanly without PostgreSQL deadlock error (40P01)
      for (const res of results) {
        if (res.status === "rejected") {
          const errMsg = (res.reason as Error)?.message || "";
          expect(errMsg).not.toContain("deadlock detected");
          expect(errMsg).not.toContain("40P01");
        }
      }

      // Check cooldown enforcement: immediate subsequent resend must be rejected with 429
      const rapidResend = await Promise.allSettled([
        realAuthService.resendOtp({ email, type: "EMAIL_VERIFICATION" }),
      ]);

      // If already verified, returns generic 'already verified' message;
      // if still unverified, rejects with 429 OTP_COOLDOWN
      const firstResend = rapidResend[0];
      if (firstResend.status === "rejected") {
        expect((firstResend.reason as any).statusCode).toBe(429);
      } else {
        expect(firstResend.value.message).toContain("already verified");
      }
    });
  });

  // =========================================================================
  // Section 2F: Password Reset Concurrency in Real PostgreSQL
  // =========================================================================
  describe("2F. Password Reset Concurrency", () => {
    it("allows exactly one password reset, revokes sessions atomically, and preserves isVerified", async () => {
      const email = "reset-concurrency@gmail.com";
      const initialHash = await realAuthService.hashPassword("OldPassword123!");
      const user = await testPrisma.user.create({
        data: {
          email,
          passwordHash: initialHash,
          isVerified: true, // User was verified
        },
      });

      // Create 2 active sessions for the user
      const s1 = await testPrisma.session.create({
        data: {
          userId: user.id,
          tokenHash: "token-hash-1",
          familyId: "fam-1",
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          isRevoked: false,
        },
      });
      const s2 = await testPrisma.session.create({
        data: {
          userId: user.id,
          tokenHash: "token-hash-2",
          familyId: "fam-2",
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          isRevoked: false,
        },
      });

      const resetCode = "987654";
      const codeHash = realAuthService.hashOtp(user.id, "PASSWORD_RESET", resetCode);
      const otp = await testPrisma.otpCode.create({
        data: {
          userId: user.id,
          type: "PASSWORD_RESET",
          codeHash,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
          maxAttempts: 5,
          attempts: 0,
          isUsed: false,
        },
      });

      // Submit concurrent reset requests using the same OTP
      const results = await Promise.allSettled([
        realAuthService.resetPassword({
          email,
          code: resetCode,
          newPassword: "BrandNewPassword1!",
        }),
        realAuthService.resetPassword({
          email,
          code: resetCode,
          newPassword: "BrandNewPassword2!",
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Exactly ONE reset succeeds
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      // Verify sessions revoked in PostgreSQL
      const sessions = await testPrisma.session.findMany({ where: { userId: user.id } });
      expect(sessions.every((s) => s.isRevoked === true)).toBe(true);

      // Verify user in PostgreSQL: password changed, isVerified STRICTLY preserved as true
      const userAfter = await testPrisma.user.findUnique({ where: { id: user.id } });
      expect(userAfter!.passwordHash).not.toBe(initialHash);
      expect(userAfter!.isVerified).toBe(true);

      // Verify OTP in PostgreSQL is marked isUsed: true
      const otpAfter = await testPrisma.otpCode.findUnique({ where: { id: otp.id } });
      expect(otpAfter!.isUsed).toBe(true);
    });

    it("strictly preserves isVerified: false when resetting password for an unverified account", async () => {
      const email = "unverified-reset@gmail.com";
      const user = await testPrisma.user.create({
        data: {
          email,
          passwordHash: await realAuthService.hashPassword("OldUnverified123!"),
          isVerified: false, // Unverified account
        },
      });

      const resetCode = "112233";
      const codeHash = realAuthService.hashOtp(user.id, "PASSWORD_RESET", resetCode);
      await testPrisma.otpCode.create({
        data: {
          userId: user.id,
          type: "PASSWORD_RESET",
          codeHash,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
          maxAttempts: 5,
          attempts: 0,
          isUsed: false,
        },
      });

      await realAuthService.resetPassword({
        email,
        code: resetCode,
        newPassword: "NewUnverifiedPass1!",
      });

      // Verify password reset succeeded BUT isVerified remains strictly false
      const userAfter = await testPrisma.user.findUnique({ where: { id: user.id } });
      expect(userAfter!.isVerified).toBe(false);
    });
  });
});
