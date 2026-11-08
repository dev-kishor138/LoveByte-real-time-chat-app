import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import { prisma } from "../config/prisma";
import { parseCorsOrigins, createCorsOriginResolver, evaluateOrigin } from "../config/cors";
import {
  AuthenticatedSocket,
  AuthenticatedSocketData,
  AuthenticatedSocketUser,
  socketAuthMiddleware,
  setupTokenExpirationEnforcement,
  clearTokenExpirationTimer,
} from "./socket.middleware";
import { registerChatSocketHandlers } from "./chat.socket";

export {
  AuthenticatedSocket,
  AuthenticatedSocketData,
  AuthenticatedSocketUser,
  socketAuthMiddleware,
  setupTokenExpirationEnforcement,
  clearTokenExpirationTimer,
  registerChatSocketHandlers,
};

/**
 * Basic in-memory rate limiter per socket connection.
 * Disconnects or drops messages if a client floods socket events.
 */
export function socketRateLimit(socket: AuthenticatedSocket, maxEventsPerSecond: number = 10): boolean {
  const now = Date.now();
  if (!socket.data.lastEventTime || now - socket.data.lastEventTime > 1000) {
    socket.data.lastEventTime = now;
    socket.data.eventCount = 1;
    return true;
  }

  socket.data.eventCount = (socket.data.eventCount || 0) + 1;
  if (socket.data.eventCount > maxEventsPerSecond) {
    logger.warn("Socket event rate limit exceeded", { userId: socket.data.user.userId });
    socket.emit("error", { error: "Rate limit exceeded" });
    return false;
  }
  return true;
}

let ioInstance: Server | null = null;

/**
 * Process-local in-memory tracking of active socket connections per user ID.
 * Maps userId -> Set of active socket IDs.
 * In the current single-instance architecture, this tracks whether a user has
 * at least one active connection (online) or zero connections (offline).
 */
const userSocketsMap = new Map<string, Set<string>>();

export function getUserActiveSocketCount(userId: string): number {
  return userSocketsMap.get(userId)?.size ?? 0;
}

export function isUserOnline(userId: string): boolean {
  return (userSocketsMap.get(userId)?.size ?? 0) > 0;
}

export function clearUserPresenceTracking(): void {
  userSocketsMap.clear();
}

/**
 * Broadcasts presence changes strictly to the user's active conversation partner(s).
 */
export async function broadcastPresenceToPartners(
  userId: string,
  status: "online" | "offline",
  lastSeenAt?: Date
): Promise<void> {
  if (!ioInstance) {
    return;
  }

  try {
    const conversations = await prisma.conversation.findMany({
      where: {
        OR: [{ user1Id: userId }, { user2Id: userId }],
      },
      select: { user1Id: true, user2Id: true },
    });

    const payload = {
      userId,
      status,
      lastSeenAt: lastSeenAt ? lastSeenAt.toISOString() : null,
    };

    for (const conv of conversations) {
      const partnerId = conv.user1Id === userId ? conv.user2Id : conv.user1Id;
      ioInstance.to(`user:${partnerId}`).emit("user_presence", payload);
    }
  } catch (err: any) {
    logger.warn("Error broadcasting presence to partners", {
      userId,
      status,
      error: err?.message,
    });
  }
}

export function trackUserSocketConnect(socket: AuthenticatedSocket): void {
  const userId = socket.data?.user?.userId;
  if (!userId) return;

  let sockets = userSocketsMap.get(userId);
  const wasOffline = !sockets || sockets.size === 0;

  if (!sockets) {
    sockets = new Set<string>();
    userSocketsMap.set(userId, sockets);
  }
  sockets.add(socket.id);

  if (wasOffline) {
    broadcastPresenceToPartners(userId, "online").catch(() => {});
  }
}

export function trackUserSocketDisconnect(socket: AuthenticatedSocket): void {
  const userId = socket.data?.user?.userId;
  if (!userId) return;

  const sockets = userSocketsMap.get(userId);
  if (sockets) {
    sockets.delete(socket.id);
    if (sockets.size === 0) {
      userSocketsMap.delete(userId);
      const lastSeenAt = new Date();

      // Persist lastSeenAt in Neon PostgreSQL
      prisma.user
        .update({
          where: { id: userId },
          data: { lastSeenAt },
        })
        .catch((err) => {
          logger.warn("Could not update lastSeenAt on disconnect", {
            userId,
            error: err?.message,
          });
        });

      broadcastPresenceToPartners(userId, "offline", lastSeenAt).catch(() => {});
    }
  }
}

export function initSocketIO(httpServer: HttpServer): Server {
  if (ioInstance) {
    throw new Error(
      "Socket.IO has already been initialized. Call closeSocketIO() before re-initializing."
    );
  }

  const allowedOrigins = parseCorsOrigins(env.CORS_ORIGIN);
  const corsOriginResolver = createCorsOriginResolver(allowedOrigins);

  const io = new Server(httpServer, {
    cors: {
      origin: corsOriginResolver,
      methods: ["GET", "POST"],
      credentials: true,
    },
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      const isAllowed = evaluateOrigin(origin, allowedOrigins);

      if (!isAllowed) {
        logger.warn("WebSocket handshake rejected by origin gatekeeper", {
          origin: origin ?? "(none)",
          url: req.url,
          ip: req.socket.remoteAddress,
        });
        callback("Origin not allowed", false);
        return;
      }

      callback(null, true);
    },
  });

  // Server-level Engine Connection Error handling
  if (io.engine) {
    io.engine.on("connection_error", (err: any) => {
      logger.warn("Socket.IO engine connection error", {
        code: err?.code,
        message: err?.message,
        contextName:
          typeof err?.context === "object" && err?.context !== null
            ? err.context.name
            : undefined,
      });
    });
  }

  // Socket Authentication Middleware
  io.use(socketAuthMiddleware);

  io.on("connection", (socket: Socket) => {
    const authSocket = socket as AuthenticatedSocket;
    logger.info("Socket connected", { userId: authSocket.data.user.userId });

    // 1. Connection-level and transport-level error handlers
    authSocket.on("error", (err: unknown) => {
      logger.warn("Socket error encountered", {
        socketId: authSocket.id,
        userId: authSocket.data?.user?.userId,
        error: err instanceof Error ? err.message : "Socket error",
      });
    });

    if (authSocket.conn) {
      authSocket.conn.on("error", (err: unknown) => {
        logger.warn("Socket transport error encountered", {
          socketId: authSocket.id,
          userId: authSocket.data?.user?.userId,
          error: err instanceof Error ? err.message : "Transport error",
        });
      });
    }

    // 2. Personal and server-controlled security rooms
    // Join room for this user's personal updates
    authSocket.join(`user:${authSocket.data.user.userId}`);

    // Join server-controlled room for this specific session
    if (authSocket.data.user.sessionId) {
      authSocket.join(`session:${authSocket.data.user.sessionId}`);
    }

    // Join server-controlled room for this refresh token family
    if (authSocket.data.user.familyId) {
      authSocket.join(`family:${authSocket.data.user.familyId}`);
    }

    // 3. Enforce access token expiration
    setupTokenExpirationEnforcement(authSocket);

    // 4. Register Stage 3.2 chat conversation room handlers
    registerChatSocketHandlers(authSocket);

    // 5. Multi-connection presence tracking
    trackUserSocketConnect(authSocket);

    authSocket.on("disconnect", () => {
      clearTokenExpirationTimer(authSocket);
      trackUserSocketDisconnect(authSocket);
      logger.info("Socket disconnected", { userId: authSocket.data.user?.userId });
    });
  });

  ioInstance = io;
  return io;
}

export function getIO(): Server {
  if (!ioInstance) {
    throw new Error("Socket.IO has not been initialized yet");
  }
  return ioInstance;
}

/**
 * Sets or resets the Socket.IO singleton instance. Exposed for test isolation.
 */
export function setIO(io: Server | null): void {
  ioInstance = io;
}

/**
 * Disconnects all active sockets associated with a revoked session ID.
 * Safe and idempotent; no-op if Socket.IO is uninitialized or session has no active sockets.
 * Cleans up token expiration timers and disconnects matching sockets while leaving other sessions active.
 */
export function disconnectSocketsBySessionId(sessionId: string): void {
  if (!sessionId || !ioInstance) {
    return;
  }

  const sessionRoom = `session:${sessionId}`;
  try {
    ioInstance.to(sessionRoom).emit("error", { error: "Session revoked" });
  } catch (err) {
    logger.warn("Error emitting session revocation notice to room", { sessionId, error: err });
  }

  if (ioInstance.sockets?.sockets) {
    for (const socket of ioInstance.sockets.sockets.values()) {
      const authSocket = socket as AuthenticatedSocket;
      if (authSocket.data?.user?.sessionId === sessionId) {
        try {
          clearTokenExpirationTimer(authSocket);
          authSocket.disconnect(true);
          logger.info("Disconnected socket for revoked session", {
            sessionId,
            socketId: authSocket.id,
            userId: authSocket.data?.user?.userId,
          });
        } catch (err) {
          logger.warn("Error disconnecting socket for revoked session", {
            sessionId,
            socketId: authSocket.id,
            error: err,
          });
        }
      }
    }
  }
}

/**
 * Disconnects all active sockets associated with a revoked refresh token family ID.
 * Triggered during token reuse/replay detection and concurrent refresh collisions.
 * Safe and idempotent; no-op if Socket.IO is uninitialized or family has no active sockets.
 * Cleans up token expiration timers and disconnects matching sockets while leaving other families active.
 */
export function disconnectSocketsByFamilyId(familyId: string): void {
  if (!familyId || !ioInstance) {
    return;
  }

  const familyRoom = `family:${familyId}`;
  try {
    ioInstance.to(familyRoom).emit("error", { error: "Session revoked" });
  } catch (err) {
    logger.warn("Error emitting family revocation notice to room", { familyId, error: err });
  }

  if (ioInstance.sockets?.sockets) {
    for (const socket of ioInstance.sockets.sockets.values()) {
      const authSocket = socket as AuthenticatedSocket;
      if (authSocket.data?.user?.familyId === familyId) {
        try {
          clearTokenExpirationTimer(authSocket);
          authSocket.disconnect(true);
          logger.info("Disconnected socket for revoked token family", {
            familyId,
            socketId: authSocket.id,
            userId: authSocket.data?.user?.userId,
          });
        } catch (err) {
          logger.warn("Error disconnecting socket for revoked token family", {
            familyId,
            socketId: authSocket.id,
            error: err,
          });
        }
      }
    }
  }
}

/**
 * Disconnects all active sockets associated with a revoked user ID.
 * Triggered on password change to force re-authentication across all connected devices.
 * Safe and idempotent; no-op if Socket.IO is uninitialized or user has no active sockets.
 */
export function disconnectSocketsByUserId(userId: string, reason: string = "Session revoked"): void {
  if (!userId || !ioInstance) {
    return;
  }

  const userRoom = `user:${userId}`;
  try {
    ioInstance.to(userRoom).emit("error", { error: reason });
  } catch (err) {
    logger.warn("Error emitting user revocation notice to room", { userId, error: err });
  }

  if (ioInstance.sockets?.sockets) {
    for (const socket of ioInstance.sockets.sockets.values()) {
      const authSocket = socket as AuthenticatedSocket;
      if (authSocket.data?.user?.userId === userId) {
        try {
          clearTokenExpirationTimer(authSocket);
          authSocket.disconnect(true);
          logger.info("Disconnected socket for revoked user", {
            userId,
            socketId: authSocket.id,
          });
        } catch (err) {
          logger.warn("Error disconnecting socket for revoked user", {
            userId,
            socketId: authSocket.id,
            error: err,
          });
        }
      }
    }
  }

  userSocketsMap.delete(userId);
}

/**
 * Cleanly closes the Socket.IO server, disconnects all active clients, and resets the singleton.
 * Safe and idempotent if Socket.IO is not initialized or already closed.
 */
export async function closeSocketIO(): Promise<void> {
  clearUserPresenceTracking();

  if (!ioInstance) {
    return;
  }
  const io = ioInstance;
  ioInstance = null;

  try {
    io.disconnectSockets(true);
  } catch (err) {
    logger.warn("Error disconnecting socket clients during shutdown", { error: err });
  }

  await new Promise<void>((resolve, reject) => {
    io.close((err) => {
      if (err && (err as any).code !== "ERR_SERVER_NOT_RUNNING") {
        logger.error("Error closing Socket.IO server", { error: err });
        reject(err);
      } else {
        logger.info("Socket.IO server closed cleanly");
        resolve();
      }
    });
  });
}
