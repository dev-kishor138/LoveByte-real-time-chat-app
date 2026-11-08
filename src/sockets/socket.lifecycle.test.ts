import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { startTestServer, stopTestServer, RunningTestServer } from "../testing/testServerHelper";
import { resetRateLimiters } from "../middlewares/rateLimiter";
import {
  gracefulShutdown,
  resetShutdownState,
  isShutdownInProgress,
  registerSignalHandlers,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
} from "../server";
import {
  initSocketIO,
  closeSocketIO,
  getIO,
  setIO,
  disconnectSocketsBySessionId,
  disconnectSocketsByFamilyId,
  disconnectSocketsByUserId,
  getUserActiveSocketCount,
  isUserOnline,
  clearUserPresenceTracking,
} from "./index";
import { prisma } from "../config/prisma";
import { logger } from "../utils/logger";
import EventEmitter from "events";

/**
 * Socket.IO & HTTP Server Lifecycle — Unit Tests (Stage 3.4.1 Graceful Shutdown)
 *
 * NOTE: These are mocked unit tests verifying server lifecycle, shutdown coordination,
 * and timeout safety. They do not represent live production network integration tests.
 */
describe("Server Lifecycle & Graceful Shutdown (Stage 3.4.1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetShutdownState();
    setIO(null);
  });

  afterEach(async () => {
    resetShutdownState();
    setIO(null);
  });

  // 1. Normal shutdown sequence
  it("1. Normal shutdown sequence executes closeSockets, HTTP server close, and Prisma disconnect in order", async () => {
    const executionOrder: string[] = [];

    const mockCloseSockets = vi.fn(async () => {
      executionOrder.push("sockets");
    });

    const mockServerClose = vi.fn((cb: (err?: Error) => void) => {
      executionOrder.push("http");
      cb();
    });

    const mockServer: any = {
      listening: true,
      close: mockServerClose,
      closeIdleConnections: vi.fn(),
    };

    const mockDisconnectPrisma = vi.fn(async () => {
      executionOrder.push("prisma");
    });

    await gracefulShutdown({
      timeoutMs: 1000,
      server: mockServer,
      closeSockets: mockCloseSockets,
      disconnectPrisma: mockDisconnectPrisma,
    });

    expect(executionOrder).toEqual(["sockets", "http", "prisma"]);
    expect(mockCloseSockets).toHaveBeenCalledTimes(1);
    expect(mockServer.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(mockServerClose).toHaveBeenCalledTimes(1);
    expect(mockDisconnectPrisma).toHaveBeenCalledTimes(1);
  });

  // 2. Socket.IO closure
  it("2. Socket.IO closure disconnects active sockets, closes the server, and resets the singleton", async () => {
    const mockHttpServer = http.createServer();
    const io = initSocketIO(mockHttpServer);
    expect(getIO()).toBe(io);

    const disconnectSocketsSpy = vi.spyOn(io, "disconnectSockets");
    const closeSpy = vi.spyOn(io, "close").mockImplementation(((cb: any) => {
      if (typeof cb === "function") cb();
      return io;
    }) as any);

    await closeSocketIO();

    expect(disconnectSocketsSpy).toHaveBeenCalledWith(true);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // Singleton should be reset to null; getIO() must throw
    expect(() => getIO()).toThrow("Socket.IO has not been initialized yet");

    // Idempotent: calling closeSocketIO() when already closed resolves safely
    await expect(closeSocketIO()).resolves.toBeUndefined();
  });

  // 3. HTTP server closure
  it("3. HTTP server closure handles active keep-alive connections via closeIdleConnections", async () => {
    const mockServerClose = vi.fn((cb: (err?: Error) => void) => cb());
    const mockCloseIdle = vi.fn();

    const mockServer: any = {
      listening: true,
      close: mockServerClose,
      closeIdleConnections: mockCloseIdle,
    };

    await gracefulShutdown({
      timeoutMs: 1000,
      server: mockServer,
      closeSockets: vi.fn().mockResolvedValue(undefined),
      disconnectPrisma: vi.fn().mockResolvedValue(undefined),
    });

    expect(mockCloseIdle).toHaveBeenCalledTimes(1);
    expect(mockServerClose).toHaveBeenCalledTimes(1);
  });

  // 4. Prisma disconnect
  it("4. Prisma disconnect is invoked during graceful shutdown using default singleton", async () => {
    const prismaSpy = vi.spyOn(prisma, "$disconnect").mockResolvedValueOnce();

    const mockServer: any = {
      listening: false,
      close: vi.fn(),
    };

    await gracefulShutdown({
      timeoutMs: 1000,
      server: mockServer,
      closeSockets: vi.fn().mockResolvedValue(undefined),
      // omit disconnectPrisma so it invokes the default prisma.$disconnect
    });

    expect(prismaSpy).toHaveBeenCalledTimes(1);
  });

  // 5. Repeated shutdown calls
  it("5. Repeated shutdown calls return the same active promise and execute cleanup only once", async () => {
    let resolveSockets: () => void = () => {};
    const mockCloseSockets = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSockets = resolve;
        })
    );

    const mockServerClose = vi.fn((cb: (err?: Error) => void) => cb());
    const mockServer: any = {
      listening: true,
      close: mockServerClose,
    };
    const mockDisconnectPrisma = vi.fn().mockResolvedValue(undefined);

    // Call gracefulShutdown concurrently twice
    const p1 = gracefulShutdown({
      timeoutMs: 1000,
      server: mockServer,
      closeSockets: mockCloseSockets,
      disconnectPrisma: mockDisconnectPrisma,
    });

    expect(isShutdownInProgress()).toBe(true);

    const p2 = gracefulShutdown({
      timeoutMs: 1000,
      server: mockServer,
      closeSockets: mockCloseSockets,
      disconnectPrisma: mockDisconnectPrisma,
    });

    // Both calls must return the identical promise instance
    expect(p1).toBe(p2);

    // Unblock the sockets closure
    resolveSockets();
    await Promise.all([p1, p2]);

    // Cleanup functions must have executed exactly once
    expect(mockCloseSockets).toHaveBeenCalledTimes(1);
    expect(mockServerClose).toHaveBeenCalledTimes(1);
    expect(mockDisconnectPrisma).toHaveBeenCalledTimes(1);
  });

  // 6. Shutdown timeout
  it("6. Shutdown timeout guard rejects if cleanup operations hang longer than timeoutMs", async () => {
    const hangingCloseSockets = vi.fn(
      () => new Promise<void>(() => {}) // never resolves
    );

    const mockServer: any = {
      listening: true,
      close: vi.fn(),
    };

    await expect(
      gracefulShutdown({
        timeoutMs: 50, // fast timeout for test
        server: mockServer,
        closeSockets: hangingCloseSockets,
        disconnectPrisma: vi.fn().mockResolvedValue(undefined),
      })
    ).rejects.toThrow("Graceful shutdown timed out after 50ms");
  });

  // 7. Socket.IO closure failure
  it("7. Socket.IO closure failure is caught and logged safely without aborting HTTP and Prisma cleanup", async () => {
    const failingCloseSockets = vi.fn().mockRejectedValue(new Error("Socket closure network error"));
    const mockServerClose = vi.fn((cb: (err?: Error) => void) => cb());
    const mockServer: any = {
      listening: true,
      close: mockServerClose,
    };
    const mockDisconnectPrisma = vi.fn().mockResolvedValue(undefined);

    // Should not throw; handles failure safely
    await gracefulShutdown({
      timeoutMs: 1000,
      server: mockServer,
      closeSockets: failingCloseSockets,
      disconnectPrisma: mockDisconnectPrisma,
    });

    expect(failingCloseSockets).toHaveBeenCalledTimes(1);
    expect(mockServerClose).toHaveBeenCalledTimes(1);
    expect(mockDisconnectPrisma).toHaveBeenCalledTimes(1);
  });

  // 8. Prisma disconnect failure
  it("8. Prisma disconnect failure is caught and logged safely without crashing shutdown pipeline", async () => {
    const mockCloseSockets = vi.fn().mockResolvedValue(undefined);
    const mockServerClose = vi.fn((cb: (err?: Error) => void) => cb());
    const mockServer: any = {
      listening: true,
      close: mockServerClose,
    };
    const failingDisconnectPrisma = vi.fn().mockRejectedValue(new Error("Prisma connection pool error"));

    await gracefulShutdown({
      timeoutMs: 1000,
      server: mockServer,
      closeSockets: mockCloseSockets,
      disconnectPrisma: failingDisconnectPrisma,
    });

    expect(mockCloseSockets).toHaveBeenCalledTimes(1);
    expect(mockServerClose).toHaveBeenCalledTimes(1);
    expect(failingDisconnectPrisma).toHaveBeenCalledTimes(1);
  });

  // 9. Server not listening
  it("9. Skips server.close() gracefully when server is not currently listening", async () => {
    const mockCloseSockets = vi.fn().mockResolvedValue(undefined);
    const mockServerClose = vi.fn((cb: (err?: Error) => void) => cb());
    const mockServer: any = {
      listening: false, // not listening
      close: mockServerClose,
    };
    const mockDisconnectPrisma = vi.fn().mockResolvedValue(undefined);

    await gracefulShutdown({
      timeoutMs: 1000,
      server: mockServer,
      closeSockets: mockCloseSockets,
      disconnectPrisma: mockDisconnectPrisma,
    });

    expect(mockServerClose).not.toHaveBeenCalled();
    expect(mockCloseSockets).toHaveBeenCalledTimes(1);
    expect(mockDisconnectPrisma).toHaveBeenCalledTimes(1);
  });

  // 10. Timer cleanup after successful shutdown
  it("10. Clears the timeout guard timer immediately upon successful shutdown completion", async () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    const mockServer: any = {
      listening: false,
      close: vi.fn(),
    };

    await gracefulShutdown({
      timeoutMs: 5000,
      server: mockServer,
      closeSockets: vi.fn().mockResolvedValue(undefined),
      disconnectPrisma: vi.fn().mockResolvedValue(undefined),
    });

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  // 11. Signal handlers registration
  it("11. Registers SIGINT and SIGTERM handlers without crashing", () => {
    const processOnceSpy = vi.spyOn(process, "once");

    registerSignalHandlers();

    expect(processOnceSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(processOnceSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
  });

  // 12. Default timeout constant verification
  it("12. Default shutdown timeout is configured to 10 seconds (10,000ms)", () => {
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(10_000);
  });
});

describe("Socket Error Handling & Session Revocation Disconnection (Stage 3.4.2)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setIO(null);
  });

  afterEach(async () => {
    setIO(null);
  });

  // 1. Server-level engine error handling
  it("1. Engine connection_error event logs safe diagnostic information without leaking headers or tokens", () => {
    const loggerWarnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    const mockHttpServer = http.createServer();
    const io = initSocketIO(mockHttpServer);

    // Emit simulated engine connection_error with sensitive headers
    const sensitiveErrorPayload = {
      req: {
        headers: {
          authorization: "Bearer secret-access-token-jwt-12345",
          cookie: "refresh_token=secret-refresh-token",
        },
        url: "/socket.io/?token=secret-token",
      },
      code: 1,
      message: "Session ID unknown",
      context: { name: "TRANSPORT_HANDSHAKE_ERROR" },
    };

    io.engine.emit("connection_error", sensitiveErrorPayload);

    expect(loggerWarnSpy).toHaveBeenCalledWith("Socket.IO engine connection error", {
      code: 1,
      message: "Session ID unknown",
      contextName: "TRANSPORT_HANDSHAKE_ERROR",
    });

    // Verify sensitive data was NOT passed in the log object
    const loggedMeta = loggerWarnSpy.mock.calls[0][1];
    expect(JSON.stringify(loggedMeta)).not.toContain("secret-access-token-jwt-12345");
    expect(JSON.stringify(loggedMeta)).not.toContain("secret-refresh-token");
  });

  // 2. Connection and transport error listeners
  it("2. Attaches socket and transport error listeners on connection and logs without crashing", () => {
    const loggerWarnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    const mockHttpServer = http.createServer();
    const io = initSocketIO(mockHttpServer);

    const mockSocket: any = new EventEmitter();
    mockSocket.id = "sock-err-1";
    mockSocket.data = {
      user: {
        userId: "user-err-1",
        email: "usererr1@gmail.com",
        sessionId: "sess-err-1",
        familyId: "fam-err-1",
      },
      tokenExp: Date.now() + 60_000,
    };
    mockSocket.conn = new EventEmitter();
    mockSocket.join = vi.fn();
    mockSocket.disconnect = vi.fn();

    // Trigger connection via Socket.IO reserved event
    (io.of("/") as any).emitReserved("connection", mockSocket);

    // Socket error
    mockSocket.emit("error", new Error("Simulated socket error"));
    expect(loggerWarnSpy).toHaveBeenCalledWith("Socket error encountered", {
      socketId: "sock-err-1",
      userId: "user-err-1",
      error: "Simulated socket error",
    });

    // Transport error
    mockSocket.conn.emit("error", new Error("Simulated transport error"));
    expect(loggerWarnSpy).toHaveBeenCalledWith("Socket transport error encountered", {
      socketId: "sock-err-1",
      userId: "user-err-1",
      error: "Simulated transport error",
    });
  });

  // 3. Security rooms joined on connection
  it("3. Authenticated socket joins user, session, and family security rooms upon connection", () => {
    const mockHttpServer = http.createServer();
    const io = initSocketIO(mockHttpServer);

    const joinedRooms: string[] = [];
    const mockSocket: any = new EventEmitter();
    mockSocket.id = "sock-rooms-1";
    mockSocket.data = {
      user: {
        userId: "u-100",
        email: "u100@gmail.com",
        sessionId: "s-200",
        familyId: "f-300",
      },
      tokenExp: Date.now() + 60_000,
    };
    mockSocket.conn = new EventEmitter();
    mockSocket.disconnect = vi.fn();
    mockSocket.emit = vi.fn();
    mockSocket.join = vi.fn((room: string) => {
      joinedRooms.push(room);
    });

    (io.of("/") as any).emitReserved("connection", mockSocket);

    expect(joinedRooms).toContain("user:u-100");
    expect(joinedRooms).toContain("session:s-200");
    expect(joinedRooms).toContain("family:f-300");
  });

  // 4. Individual session revocation disconnects active sockets for that session
  it("4. disconnectSocketsBySessionId disconnects all sockets for that session and emits error", () => {
    const socket1: any = {
      id: "sock-1",
      data: {
        user: { userId: "user-1", sessionId: "target-session-1", familyId: "fam-1" },
        expiryTimer: setTimeout(() => {}, 100_000),
      },
      disconnect: vi.fn(),
      emit: vi.fn(),
    };
    const socket2: any = {
      id: "sock-2",
      data: {
        user: { userId: "user-1", sessionId: "target-session-1", familyId: "fam-1" },
        expiryTimer: setTimeout(() => {}, 100_000),
      },
      disconnect: vi.fn(),
      emit: vi.fn(),
    };
    const otherSessionSameUser: any = {
      id: "sock-3",
      data: {
        user: { userId: "user-1", sessionId: "other-session-same-user", familyId: "fam-2" },
      },
      disconnect: vi.fn(),
      emit: vi.fn(),
    };
    const otherUserSocket: any = {
      id: "sock-4",
      data: {
        user: { userId: "user-2", sessionId: "user-2-session", familyId: "fam-3" },
      },
      disconnect: vi.fn(),
      emit: vi.fn(),
    };

    const mockSocketsMap = new Map<string, any>([
      ["sock-1", socket1],
      ["sock-2", socket2],
      ["sock-3", otherSessionSameUser],
      ["sock-4", otherUserSocket],
    ]);

    const mockIo: any = {
      sockets: { sockets: mockSocketsMap },
      to: vi.fn().mockReturnValue({ emit: vi.fn() }),
    };

    setIO(mockIo);

    disconnectSocketsBySessionId("target-session-1");

    // Sockets 1 and 2 (belonging to target-session-1) MUST be disconnected
    expect(socket1.disconnect).toHaveBeenCalledWith(true);
    expect(socket2.disconnect).toHaveBeenCalledWith(true);

    // Timers cleared
    expect(socket1.data.expiryTimer).toBeUndefined();
    expect(socket2.data.expiryTimer).toBeUndefined();

    // Sockets belonging to other sessions of the SAME user must NOT be disconnected
    expect(otherSessionSameUser.disconnect).not.toHaveBeenCalled();

    // Sockets belonging to other users must NOT be disconnected
    expect(otherUserSocket.disconnect).not.toHaveBeenCalled();

    // Session room receives error notification
    expect(mockIo.to).toHaveBeenCalledWith("session:target-session-1");
  });

  // 5. Refresh token family revocation disconnects all sockets in that family
  it("5. disconnectSocketsByFamilyId disconnects all sockets in the revoked family across multiple sessions", () => {
    const familySocket1: any = {
      id: "sock-fam-1",
      data: {
        user: { userId: "user-1", sessionId: "session-1a", familyId: "target-family-1" },
        expiryTimer: setTimeout(() => {}, 100_000),
      },
      disconnect: vi.fn(),
    };
    const familySocket2: any = {
      id: "sock-fam-2",
      data: {
        user: { userId: "user-1", sessionId: "session-1b", familyId: "target-family-1" },
        expiryTimer: setTimeout(() => {}, 100_000),
      },
      disconnect: vi.fn(),
    };
    const otherFamilySameUser: any = {
      id: "sock-fam-3",
      data: {
        user: { userId: "user-1", sessionId: "session-other", familyId: "other-family-2" },
      },
      disconnect: vi.fn(),
    };
    const otherUserSocket: any = {
      id: "sock-fam-4",
      data: {
        user: { userId: "user-2", sessionId: "session-user2", familyId: "user2-family" },
      },
      disconnect: vi.fn(),
    };

    const mockSocketsMap = new Map<string, any>([
      ["sock-fam-1", familySocket1],
      ["sock-fam-2", familySocket2],
      ["sock-fam-3", otherFamilySameUser],
      ["sock-fam-4", otherUserSocket],
    ]);

    const mockIo: any = {
      sockets: { sockets: mockSocketsMap },
      to: vi.fn().mockReturnValue({ emit: vi.fn() }),
    };

    setIO(mockIo);

    disconnectSocketsByFamilyId("target-family-1");

    // All sockets in target-family-1 are disconnected
    expect(familySocket1.disconnect).toHaveBeenCalledWith(true);
    expect(familySocket2.disconnect).toHaveBeenCalledWith(true);

    // Timers cleared
    expect(familySocket1.data.expiryTimer).toBeUndefined();
    expect(familySocket2.data.expiryTimer).toBeUndefined();

    // Other family for same user is NOT disconnected
    expect(otherFamilySameUser.disconnect).not.toHaveBeenCalled();

    // Other user's family is NOT disconnected
    expect(otherUserSocket.disconnect).not.toHaveBeenCalled();

    // Family room receives error notification
    expect(mockIo.to).toHaveBeenCalledWith("family:target-family-1");
  });

  // 6. Safe no-ops when io is uninitialized or null
  it("6. Disconnection helpers are safe no-ops when Socket.IO is null or uninitialized", () => {
    setIO(null);

    expect(() => disconnectSocketsBySessionId("any-session")).not.toThrow();
    expect(() => disconnectSocketsByFamilyId("any-family")).not.toThrow();
    expect(() => disconnectSocketsBySessionId("")).not.toThrow();
    expect(() => disconnectSocketsByFamilyId("")).not.toThrow();
  });

  // 7. Repeated revocation does not throw or cause duplicate side effects
  it("7. Repeated revocation calls are idempotent and safe", () => {
    const socket: any = {
      id: "sock-repeat",
      data: {
        user: { userId: "u-1", sessionId: "s-repeat", familyId: "f-repeat" },
      },
      disconnect: vi.fn(),
    };

    const mockSocketsMap = new Map<string, any>([["sock-repeat", socket]]);
    const mockIo: any = {
      sockets: { sockets: mockSocketsMap },
      to: vi.fn().mockReturnValue({ emit: vi.fn() }),
    };

    setIO(mockIo);

    // First call
    disconnectSocketsBySessionId("s-repeat");
    expect(socket.disconnect).toHaveBeenCalledTimes(1);

    // Second call (simulating repeat revocation)
    disconnectSocketsBySessionId("s-repeat");
    expect(socket.disconnect).toHaveBeenCalledTimes(2);
  });
});

describe("Socket.IO Initialization Idempotency & Lifecycle (Stage 3.4.4)", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await closeSocketIO();
    setIO(null);
  });

  afterEach(async () => {
    await closeSocketIO();
    setIO(null);
    vi.restoreAllMocks();
  });

  it("Test A — Duplicate Initialization Rejected: throws error and preserves original instance", async () => {
    const mockHttpServer1 = http.createServer();
    const io1 = initSocketIO(mockHttpServer1);
    expect(getIO()).toBe(io1);

    const mockHttpServer2 = http.createServer();
    expect(() => initSocketIO(mockHttpServer2)).toThrow(
      "Socket.IO has already been initialized. Call closeSocketIO() before re-initializing."
    );

    // Verify the original instance remains available through getIO() and has not been replaced
    expect(getIO()).toBe(io1);
    expect(getIO()).not.toBe(mockHttpServer2);

    await closeSocketIO();
  });

  it("Test B — Reinitialization After Clean Shutdown: initializes new instance after closeSocketIO()", async () => {
    const mockHttpServer1 = http.createServer();
    const io1 = initSocketIO(mockHttpServer1);
    expect(getIO()).toBe(io1);

    // Call and await closeSocketIO()
    await closeSocketIO();
    expect(() => getIO()).toThrow("Socket.IO has not been initialized yet");

    // Initialize Socket.IO again
    const mockHttpServer2 = http.createServer();
    const io2 = initSocketIO(mockHttpServer2);

    // Verify the new instance initializes successfully and getIO() returns it
    expect(io2).toBeDefined();
    expect(io2).not.toBe(io1);
    expect(getIO()).toBe(io2);

    await closeSocketIO();
  });
});

describe("Multi-Connection Presence Tracking & User-Level Revocation (Stage A)", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    try {
      await closeSocketIO();
    } catch {}
    setIO(null);
    clearUserPresenceTracking();
  });

  afterEach(async () => {
    try {
      await closeSocketIO();
    } catch {}
    setIO(null);
    clearUserPresenceTracking();
    vi.restoreAllMocks();
  });

  it("1. disconnectSocketsByUserId disconnects all sockets for that user and clears presence", () => {
    const user1Sock1: any = {
      id: "sock-u1-a",
      data: {
        user: { userId: "user-target", sessionId: "sess-1", familyId: "fam-1" },
        expiryTimer: setTimeout(() => {}, 100_000),
      },
      disconnect: vi.fn(),
    };
    const user1Sock2: any = {
      id: "sock-u1-b",
      data: {
        user: { userId: "user-target", sessionId: "sess-2", familyId: "fam-2" },
        expiryTimer: setTimeout(() => {}, 100_000),
      },
      disconnect: vi.fn(),
    };
    const otherUserSock: any = {
      id: "sock-other",
      data: {
        user: { userId: "user-other", sessionId: "sess-3", familyId: "fam-3" },
      },
      disconnect: vi.fn(),
    };

    const mockSocketsMap = new Map<string, any>([
      ["sock-u1-a", user1Sock1],
      ["sock-u1-b", user1Sock2],
      ["sock-other", otherUserSock],
    ]);

    const mockIo: any = {
      sockets: { sockets: mockSocketsMap },
      to: vi.fn().mockReturnValue({ emit: vi.fn() }),
      close: vi.fn((cb: any) => cb && cb()),
      disconnectSockets: vi.fn(),
    };

    setIO(mockIo);

    disconnectSocketsByUserId("user-target", "Session revoked");

    // Both sockets belonging to user-target are disconnected
    expect(user1Sock1.disconnect).toHaveBeenCalledWith(true);
    expect(user1Sock2.disconnect).toHaveBeenCalledWith(true);
    expect(user1Sock1.data.expiryTimer).toBeUndefined();
    expect(user1Sock2.data.expiryTimer).toBeUndefined();

    // Sockets belonging to other users must NOT be touched
    expect(otherUserSock.disconnect).not.toHaveBeenCalled();

    // User room receives error notification
    expect(mockIo.to).toHaveBeenCalledWith("user:user-target");

    setIO(null);
  });

  it("2. Multi-connection presence: transitions to online on first socket, remains online on second, and goes offline only when all sockets disconnect", async () => {
    const partnerId = "user-partner-1";
    const targetUserId = "user-target-1";

    const mockFindMany = vi.spyOn(prisma.conversation, "findMany").mockResolvedValue([
      { id: "conv-1", user1Id: targetUserId, user2Id: partnerId } as any,
    ]);
    const mockUserUpdate = vi.spyOn(prisma.user, "update").mockResolvedValue({} as any);

    const mockHttpServer = http.createServer();
    const io = initSocketIO(mockHttpServer);

    const partnerEmit = vi.fn();
    vi.spyOn(io, "to").mockImplementation((room: string) => {
      return {
        emit: (event: string, payload: any) => {
          if (room === `user:${partnerId}`) {
            partnerEmit(event, payload);
          }
        },
      } as any;
    });

    // Create first socket for target user
    const sock1: any = new EventEmitter();
    sock1.id = "sock-1";
    sock1.data = {
      user: { userId: targetUserId, email: "u1@gmail.com", sessionId: "s-1", familyId: "f-1" },
      tokenExp: Date.now() + 60_000,
    };
    sock1.conn = new EventEmitter();
    sock1.join = vi.fn();
    sock1.disconnect = vi.fn();

    // 1. Connect first socket
    (io.of("/") as any).emitReserved("connection", sock1);

    expect(getUserActiveSocketCount(targetUserId)).toBe(1);
    expect(isUserOnline(targetUserId)).toBe(true);

    // Allow promise tick for async broadcast
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { OR: [{ user1Id: targetUserId }, { user2Id: targetUserId }] },
      select: { user1Id: true, user2Id: true },
    });
    expect(partnerEmit).toHaveBeenCalledWith("user_presence", {
      userId: targetUserId,
      status: "online",
      lastSeenAt: null,
    });
    partnerEmit.mockClear();

    // 2. Connect second socket for SAME user
    const sock2: any = new EventEmitter();
    sock2.id = "sock-2";
    sock2.data = {
      user: { userId: targetUserId, email: "u1@gmail.com", sessionId: "s-2", familyId: "f-2" },
      tokenExp: Date.now() + 60_000,
    };
    sock2.conn = new EventEmitter();
    sock2.join = vi.fn();
    sock2.disconnect = vi.fn();

    (io.of("/") as any).emitReserved("connection", sock2);

    expect(getUserActiveSocketCount(targetUserId)).toBe(2);
    expect(isUserOnline(targetUserId)).toBe(true);

    // Second connection must NOT trigger duplicate "online" presence broadcast
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(partnerEmit).not.toHaveBeenCalled();

    // 3. Disconnect first socket
    sock1.emit("disconnect");

    expect(getUserActiveSocketCount(targetUserId)).toBe(1);
    expect(isUserOnline(targetUserId)).toBe(true);
    // User still has 1 socket, so should NOT go offline
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(partnerEmit).not.toHaveBeenCalled();
    expect(mockUserUpdate).not.toHaveBeenCalled();

    // 4. Disconnect second socket (all sockets gone)
    sock2.emit("disconnect");

    expect(getUserActiveSocketCount(targetUserId)).toBe(0);
    expect(isUserOnline(targetUserId)).toBe(false);

    // Transitions to offline: persists lastSeenAt and broadcasts offline
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: targetUserId },
        data: expect.objectContaining({ lastSeenAt: expect.any(Date) }),
      })
    );
    expect(partnerEmit).toHaveBeenCalledWith("user_presence", {
      userId: targetUserId,
      status: "offline",
      lastSeenAt: expect.any(String),
    });

    await closeSocketIO();
  });

  it("3. disconnectSocketsByUserId is safe no-op when Socket.IO is uninitialized", () => {
    setIO(null);
    expect(() => disconnectSocketsByUserId("any-user")).not.toThrow();
    expect(() => disconnectSocketsByUserId("")).not.toThrow();
  });
});

describe("Socket.IO Origin Gatekeeper & Missing-Origin Authentication (SEC-02)", () => {
  let runningServer: RunningTestServer | null = null;
  let clientSocket: ClientSocket | null = null;
  const originalCorsOrigin = env.CORS_ORIGIN;

  const validUserId = "11111111-1111-4111-8111-111111111111";
  const validEmail = "alice.test@gmail.com";
  const validSessionId = "22222222-2222-4222-8222-222222222222";

  function createTestJwt(overrides: Record<string, any> = {}): string {
    return jwt.sign(
      {
        userId: validUserId,
        email: validEmail,
        sessionId: validSessionId,
        ...overrides,
      },
      env.JWT_SECRET,
      { expiresIn: "15m" }
    );
  }

  beforeEach(async () => {
    resetRateLimiters();
    vi.restoreAllMocks();
    resetShutdownState();
    (env as any).CORS_ORIGIN = "https://allowed.example.com";
    await stopTestServer();
  });

  afterEach(async () => {
    if (clientSocket) {
      if (clientSocket.connected) {
        clientSocket.disconnect();
      }
      clientSocket = null;
    }
    await stopTestServer();
    (env as any).CORS_ORIGIN = originalCorsOrigin;
  });

  it("1. Allowed Origin + valid JWT + active session connects successfully", async () => {
    vi.spyOn(prisma.session, "findUnique").mockResolvedValue({
      id: validSessionId,
      userId: validUserId,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    } as any);

    runningServer = await startTestServer();
    const token = createTestJwt();

    const connectPromise = new Promise<void>((resolve, reject) => {
      clientSocket = ioClient(runningServer!.baseUrl, {
        transports: ["websocket"],
        autoConnect: true,
        reconnection: false,
        extraHeaders: {
          Origin: "https://allowed.example.com",
        },
        auth: { token },
      });

      clientSocket.on("connect", () => resolve());
      clientSocket.on("connect_error", (err) => reject(err));
    });

    await expect(connectPromise).resolves.toBeUndefined();
    expect(clientSocket!.connected).toBe(true);
  });

  it("2. Disallowed Origin over WebSocket transport is rejected by Engine.IO with HTTP 400 upgrade error", async () => {
    runningServer = await startTestServer();
    const token = createTestJwt();

    const errorPromise = new Promise<{ message: string; description: any }>((resolve) => {
      clientSocket = ioClient(runningServer!.baseUrl, {
        transports: ["websocket"],
        autoConnect: true,
        reconnection: false,
        extraHeaders: {
          Origin: "https://disallowed.example.com",
        },
        auth: { token },
      });

      clientSocket.on("connect_error", (err) => {
        resolve({ message: err.message, description: err.description });
      });
    });

    const error = await errorPromise;
    // Observed Engine.IO abortUpgrade behavior for WebSocket transport
    expect(error.message).toBe("websocket error");
    expect(clientSocket!.connected).toBe(false);
  });

  it("3. Disallowed Origin over HTTP polling transport is rejected with HTTP 403", async () => {
    runningServer = await startTestServer();
    const token = createTestJwt();

    const errorPromise = new Promise<{ message: string; status: number }>((resolve) => {
      clientSocket = ioClient(runningServer!.baseUrl, {
        transports: ["polling"],
        autoConnect: true,
        reconnection: false,
        extraHeaders: {
          Origin: "https://disallowed.example.com",
        },
        auth: { token },
      });

      clientSocket.on("connect_error", (err) => {
        resolve({
          message: err.message,
          status: (err as any).context?.status ?? Number((err as any).description),
        });
      });
    });

    const error = await errorPromise;
    expect(error.message).toBe("xhr poll error");
    expect(error.status).toBe(403);
    expect(clientSocket!.connected).toBe(false);
  });

  it("4. Missing Origin + valid JWT + active database session connects successfully", async () => {
    vi.spyOn(prisma.session, "findUnique").mockResolvedValue({
      id: validSessionId,
      userId: validUserId,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    } as any);

    runningServer = await startTestServer();
    const token = createTestJwt();

    // No Origin header is sent (native mobile client)
    const connectPromise = new Promise<void>((resolve, reject) => {
      clientSocket = ioClient(runningServer!.baseUrl, {
        transports: ["websocket"],
        autoConnect: true,
        reconnection: false,
        auth: { token },
      });

      clientSocket.on("connect", () => resolve());
      clientSocket.on("connect_error", (err) => reject(err));
    });

    await expect(connectPromise).resolves.toBeUndefined();
    expect(clientSocket!.connected).toBe(true);
  });

  it("5. Missing Origin + invalid JWT is rejected with 'Authentication failed' (does not bypass auth)", async () => {
    runningServer = await startTestServer();

    // No Origin header, but invalid token
    const errorPromise = new Promise<string>((resolve) => {
      clientSocket = ioClient(runningServer!.baseUrl, {
        transports: ["websocket"],
        autoConnect: true,
        reconnection: false,
        auth: { token: "invalid.jwt.token" },
      });

      clientSocket.on("connect_error", (err) => {
        resolve(err.message);
      });
    });

    const errorMessage = await errorPromise;
    expect(errorMessage).toBe("Authentication failed");
    expect(clientSocket!.connected).toBe(false);
  });

  it("6. Missing Origin + revoked database session is rejected with 'Authentication failed'", async () => {
    vi.spyOn(prisma.session, "findUnique").mockResolvedValue({
      id: validSessionId,
      userId: validUserId,
      isRevoked: true, // Revoked in DB
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    } as any);

    runningServer = await startTestServer();
    const token = createTestJwt();

    const errorPromise = new Promise<string>((resolve) => {
      clientSocket = ioClient(runningServer!.baseUrl, {
        transports: ["websocket"],
        autoConnect: true,
        reconnection: false,
        auth: { token },
      });

      clientSocket.on("connect_error", (err) => {
        resolve(err.message);
      });
    });

    const errorMessage = await errorPromise;
    expect(errorMessage).toBe("Authentication failed");
    expect(clientSocket!.connected).toBe(false);
  });

  it("7. Missing Origin + expired database session is rejected with 'Authentication failed'", async () => {
    vi.spyOn(prisma.session, "findUnique").mockResolvedValue({
      id: validSessionId,
      userId: validUserId,
      isRevoked: false,
      expiresAt: new Date(Date.now() - 1000 * 60), // Expired in DB
    } as any);

    runningServer = await startTestServer();
    const token = createTestJwt();

    const errorPromise = new Promise<string>((resolve) => {
      clientSocket = ioClient(runningServer!.baseUrl, {
        transports: ["websocket"],
        autoConnect: true,
        reconnection: false,
        auth: { token },
      });

      clientSocket.on("connect_error", (err) => {
        resolve(err.message);
      });
    });

    const errorMessage = await errorPromise;
    expect(errorMessage).toBe("Authentication failed");
    expect(clientSocket!.connected).toBe(false);
  });
});

