import crypto from "crypto";
import { hash, verify, Algorithm } from "@node-rs/argon2";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { RegisterInput, LoginInput, ChangePasswordInput } from "./auth.validation";
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
  displayName?: string | null;
  lastSeenAt?: Date | null;
  createdAt: Date;
}

export interface RegisterResponse {
  user: SafeUser;
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
   * Returns only safe user metadata; never exposes password or hash.
   */
  async register(input: RegisterInput): Promise<RegisterResponse> {
    const normalizedEmail = input.email.trim().toLowerCase();

    // Check for existing account with the normalized email
    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existing) {
      const error = new Error("An account with this email already exists");
      (error as any).statusCode = 409;
      throw error;
    }

    // Hash password with Argon2id before persistence
    const passwordHash = await this.hashPassword(input.password);

    // Persist new user in database
    let user;
    try {
      user = await prisma.user.create({
        data: {
          email: normalizedEmail,
          passwordHash,
        },
        select: {
          id: true,
          email: true,
          createdAt: true,
        },
      });
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

    return {
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
      },
    };
  }

  /**
   * Authenticates user credentials, creates a persistent session record,
   * and issues a 15-minute access token and a 30-day rotating refresh token.
   */
  async login(
    input: LoginInput,
    meta?: { ipAddress?: string; deviceInfo?: string }
  ): Promise<LoginResponse> {
    const normalizedEmail = input.email.trim().toLowerCase();

    const user = await prisma.user.findUnique({
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

    const rawRefreshToken = this.generateRefreshToken();
    const tokenHash = this.hashRefreshToken(rawRefreshToken);
    const expiresAt = new Date(
      Date.now() + env.REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000
    );

    const session = await prisma.session.create({
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
    const session = await prisma.session.findFirst({
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
        await prisma.session.updateMany({
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

    const txResult: TxResult = await prisma.$transaction(async (tx) => {
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
        await prisma.session.updateMany({
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
      const session = await prisma.session.findFirst({
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
      const result = await prisma.session.updateMany({
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
      const result = await prisma.session.updateMany({
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
        const session = await prisma.session.findUnique({
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
    const user = await prisma.user.findUnique({
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
    const user = await prisma.user.findUnique({
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

    await prisma.$transaction(async (tx) => {
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

    const deleteResult = await prisma.session.deleteMany({
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
}

export const authService = new AuthService();
