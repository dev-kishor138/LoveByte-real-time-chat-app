import crypto from "crypto";
import { hash, verify, Algorithm } from "@node-rs/argon2";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import {
  RegisterInput,
  LoginInput,
  ChangePasswordInput,
  VerifyEmailInput,
  ResendOtpInput,
  ForgotPasswordInput,
  ResetPasswordInput,
} from "./auth.validation";
import { emailService } from "../../services/email/email.service";
import { logger } from "../../utils/logger";
import { isCanonicalUuid } from "../../utils/uuid";
import {
  disconnectSocketsBySessionId,
  disconnectSocketsByFamilyId,
  disconnectSocketsByUserId,
} from "../../sockets";

/**
 * OWASP-recommended Argon2id parameters.
 * Memory cost: 64 MiB (65536 KiB), Time cost: 3 iterations, Parallelism: 4 threads.
 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
  outputLen: 32,
};

export interface SafeUser {
  id: string;
  email: string;
  isVerified?: boolean;
  displayName?: string | null;
  lastSeenAt?: Date | null;
  createdAt: Date;
}

export interface RegisterResponse {
  user: SafeUser;
  requiresVerification?: boolean;
  message?: string;
}

export interface LoginResponse {
  user: SafeUser;
  accessToken: string;
  refreshToken: string;
  token?: string;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

export class AuthService {
  private db: typeof prisma;

  constructor(prismaClient?: typeof prisma) {
    this.db = prismaClient || prisma;
  }

  /**
   * Hashes a plaintext password using Argon2id with OWASP-recommended parameters.
   */
  async hashPassword(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  /**
   * Verifies plaintext password against stored hash.
   * Supports Argon2id (for new accounts) with fallback to bcrypt (for legacy baseline accounts).
   */
  async verifyPassword(password: string, hashStr: string): Promise<boolean> {
    if (hashStr.startsWith("$argon2id$")) {
      return verify(hashStr, password);
    }
    return bcrypt.compare(password, hashStr);
  }

  /**
   * Generates a 64-byte cryptographically secure random refresh token (128 hex chars = 512 bits).
   */
  generateRefreshToken(): string {
    return crypto.randomBytes(64).toString("hex");
  }

  /**
   * Computes deterministic SHA-256 hash of a raw refresh token for safe database persistence.
   */
  hashRefreshToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  /**
   * Generates a cryptographically secure 6-digit numeric OTP string.
   */
  generateOtp(): string {
    return crypto.randomInt(100000, 1000000).toString();
  }

  /**
   * Constructs an unambiguous length-prefixed context binding payload for OTP HMAC computation:
   * "v1:{len(userId)}:{userId}:{len(type)}:{type}:{len(code)}:{code}"
   * This guarantees that fields cannot collide or be manipulated via delimiter spoofing.
   */
  buildOtpContextPayload(userId: string, type: string, code: string): string {
    return `v1:${userId.length}:${userId}:${type.length}:${type}:${code.length}:${code}`;
  }

  /**
   * Computes HMAC-SHA256 digest of an OTP cryptographically bound to userId and OTP type
   * using the secret server-side pepper.
   * The pepper is stored strictly in server environment configuration.
   */
  hashOtp(userId: string, type: string, code: string): string {
    if (!env.OTP_PEPPER || env.OTP_PEPPER.length < 32) {
      throw new Error("Server configuration error: OTP_PEPPER is missing or insufficient");
    }
    const contextPayload = this.buildOtpContextPayload(userId, type, code);
    return crypto.createHmac("sha256", env.OTP_PEPPER).update(contextPayload).digest("hex");
  }

  /**
   * Verifies an OTP code using constant-time comparison against stored HMAC digest
   * bound to the target userId and OTP type.
   */
  verifyOtp(userId: string, type: string, code: string, expectedHash: string): boolean {
    const candidateHash = this.hashOtp(userId, type, code);
    const candidateBuffer = Buffer.from(candidateHash, "hex");
    const expectedBuffer = Buffer.from(expectedHash, "hex");
    if (candidateBuffer.length !== expectedBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
  }

  /**
   * Issues a signed JWT access token with userId, email, and mandatory sessionId using env.JWT_EXPIRES_IN (default: 15m).
   * Strictly validates that userId and sessionId conform to exact canonical UUID format prior to signing (SEC-01).
   */
  generateAccessToken(userId: string, email: string, sessionId: string): string {
    if (!isCanonicalUuid(userId)) {
      throw new Error("Cannot issue access token: userId must be a canonical UUID");
    }
    if (!isCanonicalUuid(sessionId)) {
      throw new Error("Cannot issue access token: sessionId must be a canonical UUID");
    }

    const payload: { userId: string; email: string; sessionId: string } = {
      userId,
      email,
      sessionId,
    };

    return jwt.sign(payload, env.JWT_SECRET, {
      expiresIn: (env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"]) || "15m",
    });
  }

  /**
   * Legacy token generation method maintained for backwards compatibility.
   * Strictly requires mandatory canonical UUID sessionId and delegates to hardened generateAccessToken (SEC-01).
   */
  generateToken(userId: string, email: string, sessionId: string): string {
    return this.generateAccessToken(userId, email, sessionId);
  }

  /**
   * Registers a new user with a valid Gmail address and Argon2id hashed password.
   * Newly registered accounts start unverified (isVerified: false).
   * Generates and dispatches a cryptographically secure 6-digit OTP code.
   * If an unverified account already exists with the same email, refreshes password and dispatches a new OTP.
   */
  async register(input: RegisterInput): Promise<RegisterResponse> {
    const normalizedEmail = input.email.trim().toLowerCase();

    // Check for existing account with the normalized email
    const existing = await this.db.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existing) {
      // If user is already verified (or verified by default in legacy records), reject duplicate registration
      if (existing.isVerified !== false) {
        const error = new Error("An account with this email already exists");
        (error as any).statusCode = 409;
        throw error;
      }

      // Existing unverified account: update password hash and issue fresh verification OTP
      const passwordHash = await this.hashPassword(input.password);
      const otp = this.generateOtp();
      const codeHash = this.hashOtp(existing.id, "EMAIL_VERIFICATION", otp);
      const expiresAt = new Date(Date.now() + env.OTP_EXPIRES_MINUTES * 60 * 1000);

      const createdOtp = await this.db.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: existing.id },
          data: { passwordHash },
        });

        // Invalidate existing unused verification OTPs
        await tx.otpCode.updateMany({
          where: { userId: existing.id, type: "EMAIL_VERIFICATION", isUsed: false },
          data: { isUsed: true },
        });

        return tx.otpCode.create({
          data: {
            userId: existing.id,
            type: "EMAIL_VERIFICATION",
            codeHash,
            expiresAt,
            maxAttempts: env.OTP_MAX_ATTEMPTS,
          },
        });
      });

      try {
        await emailService.sendVerificationEmail(normalizedEmail, otp);
      } catch (deliveryError) {
        await this.db.otpCode.delete({ where: { id: createdOtp.id } }).catch(() => {});
        logger.error("Failed to deliver verification email on re-registration", {
          userId: existing.id,
          error: deliveryError instanceof Error ? deliveryError.message : "Delivery failure",
        });
        const error = new Error("Failed to deliver verification email. Please try registering again.");
        (error as any).statusCode = 502;
        throw error;
      }

      return {
        user: {
          id: existing.id,
          email: existing.email,
          createdAt: existing.createdAt,
        },
        requiresVerification: true,
        message: "Verification code sent to your email. Please verify your account.",
      };
    }

    // Hash password with Argon2id before persistence
    const passwordHash = await this.hashPassword(input.password);
    const otp = this.generateOtp();
    const expiresAt = new Date(Date.now() + env.OTP_EXPIRES_MINUTES * 60 * 1000);

    let user;
    let createdOtp;
    try {
      const txResult = await this.db.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            email: normalizedEmail,
            passwordHash,
            isVerified: false,
          },
          select: {
            id: true,
            email: true,
            createdAt: true,
          },
        });

        const codeHash = this.hashOtp(newUser.id, "EMAIL_VERIFICATION", otp);

        const newOtp = await tx.otpCode.create({
          data: {
            userId: newUser.id,
            type: "EMAIL_VERIFICATION",
            codeHash,
            expiresAt,
            maxAttempts: env.OTP_MAX_ATTEMPTS,
          },
        });

        return { user: newUser, otp: newOtp };
      });
      user = txResult.user;
      createdOtp = txResult.otp;
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: unknown }).code === "P2002"
      ) {
        const conflictError = new Error("An account with this email already exists");
        (conflictError as any).statusCode = 409;
        throw conflictError;
      }
      throw error;
    }

    try {
      await emailService.sendVerificationEmail(normalizedEmail, otp);
    } catch (deliveryError) {
      await this.db.otpCode.delete({ where: { id: createdOtp.id } }).catch(() => {});
      await this.db.user.delete({ where: { id: user.id } }).catch(() => {});
      logger.error("Failed to deliver verification email on new registration", {
        userId: user.id,
        error: deliveryError instanceof Error ? deliveryError.message : "Delivery failure",
      });
      const error = new Error("Failed to deliver verification email. Please try registering again.");
      (error as any).statusCode = 502;
      throw error;
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
      },
      requiresVerification: true,
      message: "Verification code sent to your email. Please verify your account.",
    };
  }

  /**
   * Authenticates user credentials, verifies account activation, creates a persistent session record,
   * and issues a 15-minute access token and a 30-day rotating refresh token.
   */
  async login(
    input: LoginInput,
    meta?: { ipAddress?: string; deviceInfo?: string }
  ): Promise<LoginResponse> {
    const normalizedEmail = input.email.trim().toLowerCase();

    const user = await this.db.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user) {
      const error = new Error("Invalid email or password");
      (error as any).statusCode = 401;
      throw error;
    }

    const isMatch = await this.verifyPassword(input.password, user.passwordHash);
    if (!isMatch) {
      const error = new Error("Invalid email or password");
      (error as any).statusCode = 401;
      throw error;
    }

    // Enforce email verification status: unverified accounts cannot sign in
    if (user.isVerified === false) {
      const error = new Error("Email not verified. Please verify your email before signing in.");
      (error as any).statusCode = 403;
      (error as any).code = "EMAIL_NOT_VERIFIED";
      (error as any).email = user.email;
      throw error;
    }

    const rawRefreshToken = this.generateRefreshToken();
    const tokenHash = this.hashRefreshToken(rawRefreshToken);
    const expiresAt = new Date(
      Date.now() + env.REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000
    );

    const session = await this.db.session.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
        deviceInfo: meta?.deviceInfo,
        ipAddress: meta?.ipAddress,
      },
    });

    const accessToken = this.generateAccessToken(user.id, user.email, session.id);

    return {
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
      },
      accessToken,
      refreshToken: rawRefreshToken,
      token: accessToken,
    };
  }

  /**
   * Rotates a refresh token with atomic concurrency claim, reuse detection, and persistent family revocation.
   * Concurrency-safe design:
   * 1. Sequential replay check occurs before transaction; revokes family via standalone committed operation.
   * 2. Transaction atomically claims row (isRevoked = false -> true).
   * 3. If claim count is 0, transaction returns collision status without creating replacement session.
   * 4. Family revocation executes in a dedicated operation after transaction finishes so throwing 401 cannot roll it back.
   * 5. Unrelated database errors roll back transaction safely without touching the family.
   */
  async refresh(
    refreshToken: string,
    meta?: { ipAddress?: string; deviceInfo?: string }
  ): Promise<RefreshResponse> {
    const tokenHash = this.hashRefreshToken(refreshToken);

    // 1. Initial lookup by token hash
    const session = await this.db.session.findFirst({
      where: { tokenHash },
    });

    if (!session) {
      const error = new Error("Invalid or expired refresh token");
      (error as any).statusCode = 401;
      throw error;
    }

    // 2. Sequential Replay Detection:
    // If the session record was already revoked before this call, a previously-rotated token is being replayed.
    // Revoke the entire session family in a committed database operation outside any aborted transaction.
    if (session.isRevoked) {
      logger.warn("Sequential refresh token replay detected! Revoking token family", {
        userId: session.userId,
        familyId: session.familyId,
      });

      try {
        await this.db.session.updateMany({
          where: { familyId: session.familyId },
          data: { isRevoked: true },
        });

        // Disconnect all active sockets belonging to this revoked token family after DB commit
        disconnectSocketsByFamilyId(session.familyId);
      } catch (err) {
        logger.error("Failed to revoke session family during sequential replay", {
          familyId: session.familyId,
          error: err,
        });
      }

      const error = new Error("Invalid or expired refresh token");
      (error as any).statusCode = 401;
      throw error;
    }

    // 3. Expiration check (30-day window)
    if (session.expiresAt <= new Date()) {
      const error = new Error("Session expired, please login again");
      (error as any).statusCode = 401;
      throw error;
    }

    // 4. Atomic Transaction:
    // Attempt conditional claim. If another concurrent request claimed it first (count === 0),
    // return a collision result cleanly so the transaction completes without creating a replacement session.
    type TxResult =
      | { status: "COLLISION"; familyId: string; userId: string }
      | { status: "SUCCESS"; accessToken: string; refreshToken: string };

    const txResult: TxResult = await this.db.$transaction(async (tx) => {
      // Conditionally claim the session: update isRevoked = true ONLY if isRevoked is STILL false.
      const claimResult = await tx.session.updateMany({
        where: {
          id: session.id,
          isRevoked: false,
        },
        data: {
          isRevoked: true,
        },
      });

      if (claimResult.count === 0) {
        // Concurrency collision: another simultaneous request claimed or revoked this session!
        // Return COLLISION status without creating any replacement session.
        return {
          status: "COLLISION",
          familyId: session.familyId,
          userId: session.userId,
        };
      }

      // Claim succeeded (count === 1): proceed with rotation inside this transaction
      const user = await tx.user.findUnique({
        where: { id: session.userId },
      });

      if (!user) {
        const error = new Error("User not found");
        (error as any).statusCode = 401;
        throw error;
      }

      const newRawRefreshToken = this.generateRefreshToken();
      const newTokenHash = this.hashRefreshToken(newRawRefreshToken);
      const newExpiresAt = new Date(
        Date.now() + env.REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000
      );

      const newSession = await tx.session.create({
        data: {
          userId: session.userId,
          tokenHash: newTokenHash,
          familyId: session.familyId,
          expiresAt: newExpiresAt,
          deviceInfo: meta?.deviceInfo ?? session.deviceInfo,
          ipAddress: meta?.ipAddress ?? session.ipAddress,
        },
      });

      const accessToken = this.generateAccessToken(user.id, user.email, newSession.id);

      return {
        status: "SUCCESS",
        accessToken,
        refreshToken: newRawRefreshToken,
      };
    });

    // 5. Post-transaction handling for concurrent collision:
    // Revoke the token family in a committed database operation, then throw 401.
    if (txResult.status === "COLLISION") {
      logger.warn("Concurrent refresh collision detected! Revoking token family", {
        userId: txResult.userId,
        familyId: txResult.familyId,
      });

      try {
        await this.db.session.updateMany({
          where: { familyId: txResult.familyId },
          data: { isRevoked: true },
        });

        // Disconnect all active sockets belonging to this revoked token family after DB commit
        disconnectSocketsByFamilyId(txResult.familyId);
      } catch (err) {
        logger.error("Failed to revoke session family during concurrent collision", {
          familyId: txResult.familyId,
          error: err,
        });
      }

      const error = new Error("Invalid or expired refresh token");
      (error as any).statusCode = 401;
      throw error;
    }

    return {
      accessToken: txResult.accessToken,
      refreshToken: txResult.refreshToken,
    };
  }

  /**
   * Logs out user by verifying session ownership and revoking the active session.
   */
  async logout(options: {
    userId: string;
    sessionId?: string;
    refreshToken?: string;
  }): Promise<{ message: string }> {
    // 1. If refreshToken is supplied, verify it belongs to the authenticated user and active session
    if (options.refreshToken) {
      const tokenHash = this.hashRefreshToken(options.refreshToken);
      const session = await this.db.session.findFirst({
        where: { tokenHash },
      });

      if (!session) {
        const error = new Error("Invalid or expired refresh token");
        (error as any).statusCode = 401;
        throw error;
      }

      // Verify session belongs to the authenticated user
      if (session.userId !== options.userId) {
        const error = new Error("Forbidden: Session does not belong to authenticated user");
        (error as any).statusCode = 403;
        throw error;
      }

      // If sessionId is present in access token, verify it matches
      if (options.sessionId && session.id !== options.sessionId) {
        const error = new Error("Forbidden: Refresh token does not match active access token session");
        (error as any).statusCode = 403;
        throw error;
      }

      // Check if already revoked
      if (session.isRevoked) {
        const error = new Error("Session already revoked");
        (error as any).statusCode = 401;
        throw error;
      }

      // Atomically revoke
      const result = await this.db.session.updateMany({
        where: { id: session.id, isRevoked: false },
        data: { isRevoked: true },
      });

      if (result.count === 0) {
        const error = new Error("Session already revoked");
        (error as any).statusCode = 401;
        throw error;
      }

      // Disconnect all active sockets for this revoked session after DB commit
      disconnectSocketsBySessionId(session.id);

      return { message: "Logged out successfully" };
    }

    // 2. If no refreshToken supplied, revoke by verified sessionId from the access token
    if (options.sessionId) {
      const result = await this.db.session.updateMany({
        where: {
          id: options.sessionId,
          userId: options.userId,
          isRevoked: false,
        },
        data: {
          isRevoked: true,
        },
      });

      if (result.count === 0) {
        const session = await this.db.session.findUnique({
          where: { id: options.sessionId },
        });

        if (!session || session.userId !== options.userId) {
          const error = new Error("Session not found or does not belong to user");
          (error as any).statusCode = 404;
          throw error;
        }

        const error = new Error("Session already revoked");
        (error as any).statusCode = 401;
        throw error;
      }

      // Disconnect all active sockets for this revoked session after DB commit
      disconnectSocketsBySessionId(options.sessionId);

      return { message: "Logged out successfully" };
    }

    const error = new Error("Unable to identify active session to logout");
    (error as any).statusCode = 400;
    throw error;
  }

  /**
   * Retrieves user profile by verified token user ID.
   */
  async getProfile(userId: string): Promise<SafeUser> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        lastSeenAt: true,
        createdAt: true,
      },
    });

    if (!user) {
      const error = new Error("User not found");
      (error as any).statusCode = 404;
      throw error;
    }

    return user;
  }

  /**
   * Changes authenticated user's password.
   * Verifies current password using existing Argon2id/bcrypt verification,
   * hashes new password with Argon2id, updates password, and revokes ALL active sessions
   * transactionally. Sockets are disconnected strictly post-commit.
   */
  async changePassword(
    userId: string,
    input: ChangePasswordInput
  ): Promise<{ success: boolean; message: string }> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    });

    if (!user) {
      const error = new Error("User not found");
      (error as any).statusCode = 404;
      throw error;
    }

    const isCurrentValid = await this.verifyPassword(input.currentPassword, user.passwordHash);
    if (!isCurrentValid) {
      const error = new Error("Current password is incorrect");
      (error as any).statusCode = 401;
      throw error;
    }

    const newHash = await this.hashPassword(input.newPassword);

    await this.db.$transaction(async (tx) => {
      // 1. Update password hash
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash: newHash },
      });

      // 2. Revoke ALL active sessions for this user
      await tx.session.updateMany({
        where: { userId, isRevoked: false },
        data: { isRevoked: true },
      });
    });

    // 3. Strictly post-commit: disconnect all user sockets
    try {
      disconnectSocketsByUserId(userId, "Password changed. All active sessions have been revoked. Please log in again.");
    } catch (err) {
      logger.warn("Could not disconnect sockets on password change", { userId, error: err });
    }

    logger.info("Password changed and all sessions revoked", { userId });

    return {
      success: true,
      message: "Password updated successfully. All active sessions have been revoked. Please log in again.",
    };
  }

  /**
   * Safely purges expired and revoked sessions older than retention period (default: 30 days).
   * Strictly protects active, non-expired sessions. Bounded and idempotent.
   */
  async purgeExpiredSessions(options?: { retentionDays?: number }): Promise<{ deletedCount: number; cutoffDate: Date }> {
    const retentionDays = options?.retentionDays ?? 30;
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const now = new Date();

    const deleteResult = await this.db.session.deleteMany({
      where: {
        AND: [
          {
            OR: [
              { isRevoked: true },
              { expiresAt: { lt: now } },
            ],
          },
          {
            updatedAt: { lt: cutoffDate },
          },
        ],
      },
    });

    logger.info("Purged expired and revoked sessions", {
      deletedCount: deleteResult.count,
      cutoffDate,
    });

    return {
      deletedCount: deleteResult.count,
      cutoffDate,
    };
  }

  /**
   * Verifies a user's email using a 6-digit OTP.
   * Enforces 15-minute expiration, atomic 5-attempt brute-force protection,
   * constant-time HMAC comparison, and concurrency-safe single-use claiming.
   */
  async verifyEmail(input: VerifyEmailInput): Promise<{ success: boolean; message: string }> {
    const normalizedEmail = input.email.trim().toLowerCase();

    const user = await this.db.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user) {
      const error = new Error("Invalid verification code or email");
      (error as any).statusCode = 400;
      throw error;
    }

    if (user.isVerified) {
      return { success: true, message: "Email is already verified. You can log in." };
    }

    // Standardized Lock Order: Acquire exclusive User row lock first, then read and mutate OtpCode.
    // Concurrency & Persistence Guarantee: Failed attempt increments are COMMITTED inside the transaction,
    // returning an unsuccess status rather than throwing inside tx, ensuring PostgreSQL NEVER rolls back attempts.
    const result = await this.db.$transaction(async (tx) => {
      // 1. Acquire exclusive lock on the User row to serialize concurrent requests and eliminate deadlocks
      await tx.user.update({
        where: { id: user.id },
        data: { updatedAt: new Date() },
      });

      // 2. Re-read active verification code inside the locked transaction
      const otpRecord = await tx.otpCode.findFirst({
        where: {
          userId: user.id,
          type: "EMAIL_VERIFICATION",
          isUsed: false,
        },
        orderBy: { createdAt: "desc" },
      });

      if (!otpRecord) {
        return { status: "NOT_FOUND" as const };
      }

      // Check expiration
      if (otpRecord.expiresAt < new Date()) {
        return { status: "EXPIRED" as const };
      }

      // Check attempt limits
      if (otpRecord.attempts >= otpRecord.maxAttempts) {
        return { status: "MAX_ATTEMPTS_EXCEEDED" as const };
      }

      // 3. Verify HMAC with constant-time comparison
      const isValid = this.verifyOtp(user.id, "EMAIL_VERIFICATION", input.code, otpRecord.codeHash);
      if (!isValid) {
        const nextAttempts = otpRecord.attempts + 1;
        const reachedMax = nextAttempts >= otpRecord.maxAttempts;

        const updated = await tx.otpCode.update({
          where: { id: otpRecord.id },
          data: {
            attempts: { increment: 1 },
            ...(reachedMax ? { isUsed: true } : {}),
          },
          select: { attempts: true, maxAttempts: true },
        });

        const remaining = Math.max(0, updated.maxAttempts - updated.attempts);
        return {
          status: "INVALID_CODE" as const,
          remaining,
        };
      }

      // 4. Atomic single-use claim prevents race condition / double-spend
      const claim = await tx.otpCode.updateMany({
        where: {
          id: otpRecord.id,
          isUsed: false,
        },
        data: {
          isUsed: true,
        },
      });

      if (claim.count === 0) {
        return { status: "ALREADY_USED" as const };
      }

      // 5. Mark user verified in the same transaction
      await tx.user.update({
        where: { id: user.id },
        data: { isVerified: true },
      });

      // 6. Invalidate any remaining unused verification codes for this user
      await tx.otpCode.updateMany({
        where: {
          userId: user.id,
          type: "EMAIL_VERIFICATION",
          isUsed: false,
        },
        data: { isUsed: true },
      });

      return { status: "SUCCESS" as const };
    });

    if (result.status === "NOT_FOUND") {
      const error = new Error("No active verification code found. Please request a new one.");
      (error as any).statusCode = 400;
      throw error;
    }

    if (result.status === "EXPIRED") {
      const error = new Error("Verification code has expired. Please request a new one.");
      (error as any).statusCode = 400;
      (error as any).code = "OTP_EXPIRED";
      throw error;
    }

    if (result.status === "MAX_ATTEMPTS_EXCEEDED") {
      const error = new Error("Maximum verification attempts exceeded. Please request a new code.");
      (error as any).statusCode = 400;
      (error as any).code = "OTP_MAX_ATTEMPTS_EXCEEDED";
      throw error;
    }

    if (result.status === "INVALID_CODE") {
      const error = new Error(
        result.remaining > 0
          ? `Invalid verification code. ${result.remaining} attempt(s) remaining.`
          : "Maximum verification attempts exceeded. Please request a new code."
      );
      (error as any).statusCode = 400;
      (error as any).code = result.remaining > 0 ? "OTP_INVALID" : "OTP_MAX_ATTEMPTS_EXCEEDED";
      throw error;
    }

    if (result.status === "ALREADY_USED") {
      const error = new Error("Verification code has already been used");
      (error as any).statusCode = 400;
      (error as any).code = "OTP_ALREADY_USED";
      throw error;
    }

    logger.info("User email verified successfully", { userId: user.id });

    return {
      success: true,
      message: "Email verified successfully. You can now log in.",
    };
  }

  /**
   * Resends an OTP (EMAIL_VERIFICATION or PASSWORD_RESET) enforcing a 60-second cooldown.
   * Uses atomic serialization via row lock to prevent duplicate concurrent generation.
   * Returns a generic response to prevent account enumeration if the account does not exist.
   */
  async resendOtp(input: ResendOtpInput): Promise<{ message: string }> {
    const normalizedEmail = input.email.trim().toLowerCase();

    const user = await this.db.user.findUnique({
      where: { email: normalizedEmail },
    });

    // Account enumeration defense: return generic response if user not found
    if (!user) {
      return { message: "If an account exists with this email, a new code has been sent." };
    }

    if (input.type === "EMAIL_VERIFICATION" && user.isVerified) {
      return { message: "Email is already verified. You can log in." };
    }

    const otp = this.generateOtp();
    const codeHash = this.hashOtp(user.id, input.type, otp);
    const expiresAt = new Date(Date.now() + env.OTP_EXPIRES_MINUTES * 60 * 1000);

    const createdRecord = await this.db.$transaction(async (tx) => {
      // Serialize concurrent requests for this user via user row touch lock
      await tx.user.update({
        where: { id: user.id },
        data: { updatedAt: new Date() },
      });

      // Check 60-second cooldown against the latest OTP of this type
      const latestOtp = await tx.otpCode.findFirst({
        where: {
          userId: user.id,
          type: input.type,
        },
        orderBy: { createdAt: "desc" },
      });

      if (latestOtp) {
        const elapsedMs = Date.now() - latestOtp.createdAt.getTime();
        const cooldownMs = env.OTP_COOLDOWN_SECONDS * 1000;
        if (elapsedMs < cooldownMs) {
          const remainingSeconds = Math.ceil((cooldownMs - elapsedMs) / 1000);
          const error = new Error(`Please wait ${remainingSeconds} seconds before requesting a new code.`);
          (error as any).statusCode = 429;
          (error as any).code = "OTP_COOLDOWN";
          (error as any).retryAfter = remainingSeconds;
          throw error;
        }
      }

      // Invalidate existing unused codes of this type
      await tx.otpCode.updateMany({
        where: {
          userId: user.id,
          type: input.type,
          isUsed: false,
        },
        data: { isUsed: true },
      });

      return tx.otpCode.create({
        data: {
          userId: user.id,
          type: input.type,
          codeHash,
          expiresAt,
          maxAttempts: env.OTP_MAX_ATTEMPTS,
        },
      });
    });

    try {
      if (input.type === "EMAIL_VERIFICATION") {
        await emailService.sendVerificationEmail(user.email, otp);
      } else {
        await emailService.sendPasswordResetEmail(user.email, otp);
      }
    } catch (deliveryError) {
      await this.db.otpCode.delete({ where: { id: createdRecord.id } }).catch(() => {});
      logger.error("Failed to deliver resent OTP email", {
        userId: user.id,
        type: input.type,
        error: deliveryError instanceof Error ? deliveryError.message : "Delivery failure",
      });
      const error = new Error("Failed to deliver verification code email. Please try again later.");
      (error as any).statusCode = 502;
      throw error;
    }

    return { message: "A new code has been sent to your email." };
  }

  /**
   * Initiates password reset by issuing a 6-digit OTP.
   * Uses generic responses to completely eliminate account enumeration.
   */
  async forgotPassword(input: ForgotPasswordInput): Promise<{ message: string }> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const genericSuccess = {
      message: "If an account exists with this email, a password reset code has been sent.",
    };

    const user = await this.db.user.findUnique({
      where: { email: normalizedEmail },
    });

    // Account enumeration defense: return generic response if user not found or unverified
    if (!user || user.isVerified === false) {
      return genericSuccess;
    }

    const otp = this.generateOtp();
    const codeHash = this.hashOtp(user.id, "PASSWORD_RESET", otp);
    const expiresAt = new Date(Date.now() + env.OTP_EXPIRES_MINUTES * 60 * 1000);

    let createdRecord;
    try {
      createdRecord = await this.db.$transaction(async (tx) => {
        // Serialize concurrent requests for this user via user row touch lock
        await tx.user.update({
          where: { id: user.id },
          data: { updatedAt: new Date() },
        });

        // Check 60-second cooldown
        const latestOtp = await tx.otpCode.findFirst({
          where: {
            userId: user.id,
            type: "PASSWORD_RESET",
          },
          orderBy: { createdAt: "desc" },
        });

        if (latestOtp) {
          const elapsedMs = Date.now() - latestOtp.createdAt.getTime();
          const cooldownMs = env.OTP_COOLDOWN_SECONDS * 1000;
          if (elapsedMs < cooldownMs) {
            const remainingSeconds = Math.ceil((cooldownMs - elapsedMs) / 1000);
            const error = new Error(`Please wait ${remainingSeconds} seconds before requesting another reset code.`);
            (error as any).statusCode = 429;
            (error as any).code = "OTP_COOLDOWN";
            (error as any).retryAfter = remainingSeconds;
            throw error;
          }
        }

        // Invalidate existing unused PASSWORD_RESET codes
        await tx.otpCode.updateMany({
          where: {
            userId: user.id,
            type: "PASSWORD_RESET",
            isUsed: false,
          },
          data: { isUsed: true },
        });

        return tx.otpCode.create({
          data: {
            userId: user.id,
            type: "PASSWORD_RESET",
            codeHash,
            expiresAt,
            maxAttempts: env.OTP_MAX_ATTEMPTS,
          },
        });
      });
    } catch (err: unknown) {
      throw err;
    }

    try {
      await emailService.sendPasswordResetEmail(user.email, otp);
    } catch (deliveryError) {
      await this.db.otpCode.delete({ where: { id: createdRecord.id } }).catch(() => {});
      logger.error("Failed to deliver password reset email", {
        userId: user.id,
        error: deliveryError instanceof Error ? deliveryError.message : "Delivery failure",
      });
      // CRITICAL ANTI-ENUMERATION: Never return a distinguishable HTTP 502 response for an existing account
      // when an unknown account receives a generic HTTP 200 response. Both must return the identical generic success message.
      return genericSuccess;
    }

    return genericSuccess;
  }

  /**
   * Completes password reset using a verified 6-digit OTP.
   * Hashes new password with Argon2id, revokes all sessions, and disconnects all active sockets.
   * Atomic conditional claim eliminates concurrent replay or double-spending.
   */
  async resetPassword(input: ResetPasswordInput): Promise<{ success: boolean; message: string }> {
    const normalizedEmail = input.email.trim().toLowerCase();

    const user = await this.db.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user) {
      const error = new Error("Invalid reset code or email");
      (error as any).statusCode = 400;
      throw error;
    }

    // Pre-hash password before transaction to minimize database lock hold time
    const newHash = await this.hashPassword(input.newPassword);

    // Standardized Lock Order: Acquire exclusive User row lock first, then read and mutate OtpCode.
    // Concurrency & Persistence Guarantee: Failed attempt increments are COMMITTED inside the transaction,
    // returning an unsuccess status rather than throwing inside tx, ensuring PostgreSQL NEVER rolls back attempts.
    const result = await this.db.$transaction(async (tx) => {
      // 1. Acquire exclusive lock on the User row to standardize lock order and serialize concurrent requests
      await tx.user.update({
        where: { id: user.id },
        data: { updatedAt: new Date() },
      });

      // 2. Re-read the latest unused PASSWORD_RESET OTP inside the locked transaction
      const otpRecord = await tx.otpCode.findFirst({
        where: {
          userId: user.id,
          type: "PASSWORD_RESET",
          isUsed: false,
        },
        orderBy: { createdAt: "desc" },
      });

      if (!otpRecord) {
        return { status: "NOT_FOUND" as const };
      }

      if (otpRecord.expiresAt < new Date()) {
        return { status: "EXPIRED" as const };
      }

      if (otpRecord.attempts >= otpRecord.maxAttempts) {
        return { status: "MAX_ATTEMPTS_EXCEEDED" as const };
      }

      // 3. Verify HMAC with constant-time comparison
      const isValid = this.verifyOtp(user.id, "PASSWORD_RESET", input.code, otpRecord.codeHash);
      if (!isValid) {
        const nextAttempts = otpRecord.attempts + 1;
        const reachedMax = nextAttempts >= otpRecord.maxAttempts;

        const updated = await tx.otpCode.update({
          where: { id: otpRecord.id },
          data: {
            attempts: { increment: 1 },
            ...(reachedMax ? { isUsed: true } : {}),
          },
          select: { attempts: true, maxAttempts: true },
        });

        const remaining = Math.max(0, updated.maxAttempts - updated.attempts);
        return {
          status: "INVALID_CODE" as const,
          remaining,
        };
      }

      // 4. Atomic single-use claim prevents race condition / double-spend
      const claim = await tx.otpCode.updateMany({
        where: {
          id: otpRecord.id,
          isUsed: false,
        },
        data: {
          isUsed: true,
        },
      });

      if (claim.count === 0) {
        return { status: "ALREADY_USED" as const };
      }

      // 5. Update password hash (strictly preserve existing isVerified status to prevent accidental verification bypass)
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: newHash,
        },
      });

      // 6. Revoke all active sessions for this user
      await tx.session.updateMany({
        where: { userId: user.id, isRevoked: false },
        data: { isRevoked: true },
      });

      // 7. Invalidate any remaining unused PASSWORD_RESET codes for this user
      await tx.otpCode.updateMany({
        where: {
          userId: user.id,
          type: "PASSWORD_RESET",
          isUsed: false,
        },
        data: { isUsed: true },
      });

      return { status: "SUCCESS" as const };
    });

    if (result.status === "NOT_FOUND") {
      const error = new Error("No active password reset request found. Please request a new code.");
      (error as any).statusCode = 400;
      throw error;
    }

    if (result.status === "EXPIRED") {
      const error = new Error("Reset code has expired. Please request a new one.");
      (error as any).statusCode = 400;
      (error as any).code = "OTP_EXPIRED";
      throw error;
    }

    if (result.status === "MAX_ATTEMPTS_EXCEEDED") {
      const error = new Error("Maximum verification attempts exceeded. Please request a new reset code.");
      (error as any).statusCode = 400;
      (error as any).code = "OTP_MAX_ATTEMPTS_EXCEEDED";
      throw error;
    }

    if (result.status === "INVALID_CODE") {
      const error = new Error(
        result.remaining > 0
          ? `Invalid reset code. ${result.remaining} attempt(s) remaining.`
          : "Maximum reset attempts exceeded. Please request a new code."
      );
      (error as any).statusCode = 400;
      (error as any).code = result.remaining > 0 ? "OTP_INVALID" : "OTP_MAX_ATTEMPTS_EXCEEDED";
      throw error;
    }

    if (result.status === "ALREADY_USED") {
      const error = new Error("Reset code has already been used");
      (error as any).statusCode = 400;
      (error as any).code = "OTP_ALREADY_USED";
      throw error;
    }

    // Post-commit: disconnect all user sockets
    try {
      disconnectSocketsByUserId(
        user.id,
        "Password reset successfully. All active sessions have been revoked. Please log in again."
      );
    } catch (err) {
      logger.warn("Could not disconnect sockets on password reset", { userId: user.id, error: err });
    }

    logger.info("Password reset successfully and all sessions revoked", { userId: user.id });

    return {
      success: true,
      message: "Password reset successfully. All active sessions have been revoked. You can now log in with your new password.",
    };
  }
}

export const authService = new AuthService();
