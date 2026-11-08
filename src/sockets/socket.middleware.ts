import { Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { logger } from "../utils/logger";
import { isShutdownInProgress } from "../utils/shutdown";
import { isCanonicalUuid } from "../utils/uuid";

export interface AuthenticatedSocketUser {
  userId: string;
  email: string;
  sessionId: string;
  familyId?: string;
}

export interface AuthenticatedSocketData {
  user: AuthenticatedSocketUser;
  tokenExp: number;
  expiryTimer?: NodeJS.Timeout;
  lastEventTime?: number;
  eventCount?: number;
}

export interface AuthenticatedSocket extends Socket {
  data: AuthenticatedSocketData;
}

interface DecodedToken {
  userId?: unknown;
  email?: unknown;
  sessionId?: unknown;
  exp?: unknown;
  iat?: unknown;
}

/**
 * Socket.IO authentication middleware.
 * Verifies JWT signature using HS256 algorithm restriction, validates strict claim types
 * and canonical UUID formats, and confirms active session state in Neon PostgreSQL.
 *
 * M-1 Security Rule: All authentication failures return safe, generic client-facing errors:
 * - Missing token: "Authentication token required"
 * - Any validation, cryptographic, session, or database failure: "Authentication failed"
 */
export async function socketAuthMiddleware(
  socket: Socket,
  next: (err?: Error) => void
): Promise<void> {
  // Reject new socket handshakes if server shutdown is already in progress
  if (isShutdownInProgress()) {
    logger.warn("Socket handshake rejected: server shutdown in progress", {
      socketId: socket.id,
    });
    return next(new Error("SERVER_SHUTDOWN"));
  }

  try {
    if (!socket.data) {
      socket.data = {} as any;
    }

    let token: string | undefined;

    // 1. Extract token from auth payload or authorization header
    if (typeof socket.handshake.auth?.token === "string" && socket.handshake.auth.token.trim()) {
      token = socket.handshake.auth.token.trim();
    } else if (socket.handshake.headers?.authorization) {
      const authHeader = socket.handshake.headers.authorization;
      const headerStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
      if (typeof headerStr === "string") {
        token = headerStr.replace(/^Bearer\s+/i, "").trim();
      }
    }

    if (!token) {
      return next(new Error("Authentication token required"));
    }

    // 2. M-2: Verify JWT signature with explicit HS256 algorithm restriction
    let decoded: DecodedToken;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] }) as DecodedToken;
    } catch (err) {
      logger.warn("Socket handshake: JWT verification failed", {
        reason: err instanceof Error ? err.name : "VerificationError",
      });
      return next(new Error("Authentication failed"));
    }

    // 3. L-1: Strict claim type and format validation (SEC-01)
    if (
      typeof decoded.userId !== "string" ||
      !isCanonicalUuid(decoded.userId)
    ) {
      logger.warn("Socket handshake: invalid userId claim");
      return next(new Error("Authentication failed"));
    }

    if (
      typeof decoded.email !== "string" ||
      !decoded.email.trim() ||
      !decoded.email.includes("@")
    ) {
      logger.warn("Socket handshake: invalid email claim");
      return next(new Error("Authentication failed"));
    }

    if (
      typeof decoded.sessionId !== "string" ||
      !isCanonicalUuid(decoded.sessionId)
    ) {
      logger.warn("Socket handshake: invalid sessionId claim");
      return next(new Error("Authentication failed"));
    }

    if (
      typeof decoded.exp !== "number" ||
      !Number.isFinite(decoded.exp)
    ) {
      logger.warn("Socket handshake: invalid exp claim");
      return next(new Error("Authentication failed"));
    }

    const tokenExpMs = decoded.exp * 1000;
    if (tokenExpMs <= Date.now()) {
      logger.warn("Socket handshake: token expired");
      return next(new Error("Authentication failed"));
    }

    const validatedUserId = decoded.userId;
    const validatedEmail = decoded.email.trim();
    const validatedSessionId = decoded.sessionId;

    // 4. Verify session in PostgreSQL database
    let session;
    try {
      session = await prisma.session.findUnique({
        where: { id: validatedSessionId },
        select: {
          id: true,
          userId: true,
          isRevoked: true,
          expiresAt: true,
          familyId: true,
        },
      });
    } catch {
      logger.error("Socket handshake: database session lookup failed", {
        sessionId: validatedSessionId,
      });
      return next(new Error("Authentication failed"));
    }

    if (!session) {
      logger.warn("Socket handshake: session not found", {
        sessionId: validatedSessionId,
      });
      return next(new Error("Authentication failed"));
    }

    if (session.userId !== validatedUserId) {
      logger.warn("Socket handshake: session user ID mismatch", {
        tokenUserId: validatedUserId,
        sessionUserId: session.userId,
        sessionId: validatedSessionId,
      });
      return next(new Error("Authentication failed"));
    }

    if (session.isRevoked) {
      logger.warn("Socket handshake: session is revoked", {
        sessionId: validatedSessionId,
        userId: validatedUserId,
      });
      return next(new Error("Authentication failed"));
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      logger.warn("Socket handshake: session is expired", {
        sessionId: validatedSessionId,
        userId: validatedUserId,
      });
      return next(new Error("Authentication failed"));
    }

    // 5. Attach verified identity and expiration info to socket.data
    socket.data.user = {
      userId: validatedUserId,
      email: validatedEmail,
      sessionId: validatedSessionId,
      familyId: session.familyId,
    };
    socket.data.tokenExp = tokenExpMs;

    return next();
  } catch (error) {
    logger.error("Socket handshake: unexpected authentication failure", {
      error: error instanceof Error ? error.name : "Unknown",
    });
    return next(new Error("Authentication failed"));
  }
}

/**
 * Enforces access token expiration for an authenticated socket.
 * Calculates remaining time until token expiration and schedules disconnection.
 * Disconnects immediately if the token has already expired.
 * Automatically cleans up the scheduled timer upon socket disconnection.
 *
 * L-2: Safely clears any existing timer before scheduling to prevent re-entrance leaks.
 * L-3: Calls timer.unref() to avoid keeping the Node.js event loop unnecessarily active.
 */
export function setupTokenExpirationEnforcement(
  socket: AuthenticatedSocket
): NodeJS.Timeout | null {
  // L-2: Clear any pre-existing timer on this socket to prevent orphan timers or re-entrance leaks
  clearTokenExpirationTimer(socket);

  const tokenExpMs = socket.data?.tokenExp;
  if (!tokenExpMs || typeof tokenExpMs !== "number" || !Number.isFinite(tokenExpMs)) {
    logger.warn("Socket connected without verified token expiration timestamp, disconnecting immediately", {
      socketId: socket.id,
      userId: socket.data?.user?.userId,
    });
    socket.emit("error", { error: "Token expired" });
    socket.disconnect(true);
    return null;
  }

  const remainingMs = tokenExpMs - Date.now();

  if (remainingMs <= 0) {
    logger.info("Access token already expired upon connection, disconnecting immediately", {
      socketId: socket.id,
      userId: socket.data?.user?.userId,
    });
    socket.emit("error", { error: "Token expired" });
    socket.disconnect(true);
    return null;
  }

  const socketId = socket.id;

  const timer = setTimeout(() => {
    // Ensure the timer cannot disconnect a newer socket or an already closed socket
    if (socket.connected && socket.id === socketId) {
      logger.info("Access token expired for connected socket, disconnecting", {
        socketId,
        userId: socket.data?.user?.userId,
      });
      socket.emit("error", { error: "Token expired" });
      socket.disconnect(true);
    }
  }, remainingMs);

  // L-3: Unref the timer where supported so it does not keep the Node.js event loop active
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  socket.data.expiryTimer = timer;

  // Cleanup scheduled timer when the socket disconnects
  socket.once("disconnect", () => {
    clearTokenExpirationTimer(socket);
  });

  return timer;
}

/**
 * Manually clears scheduled token expiration timer if present.
 */
export function clearTokenExpirationTimer(socket: AuthenticatedSocket): void {
  if (socket.data?.expiryTimer) {
    clearTimeout(socket.data.expiryTimer);
    socket.data.expiryTimer = undefined;
  }
}
