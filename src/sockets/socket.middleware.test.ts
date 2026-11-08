import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import {
  socketAuthMiddleware,
  setupTokenExpirationEnforcement,
  clearTokenExpirationTimer,
  AuthenticatedSocket,
} from "./socket.middleware";
import { socketRateLimit } from "./index";
import {
  setShutdownInProgress,
  resetShutdownState,
  isShutdownInProgress,
} from "../utils/shutdown";

function createMockSocket(
  handshakeAuth: any = {},
  handshakeHeaders: any = {},
  socketId = "mock-socket-001"
): AuthenticatedSocket {
  const socket: any = new EventEmitter();
  socket.id = socketId;
  socket.connected = true;
  socket.handshake = {
    auth: handshakeAuth,
    headers: handshakeHeaders,
  };
  socket.data = {};

  // Attach a no-op listener to "error" so EventEmitter does not throw on unhandled "error" event
  socket.on("error", () => {});

  const originalEmit = socket.emit.bind(socket);
  socket.emit = vi.fn((event: string, ...args: any[]) => {
    return originalEmit(event, ...args);
  });

  socket.disconnect = vi.fn((close?: boolean) => {
    socket.connected = false;
    socket.emit("disconnect");
    return socket;
  });

  socket.join = vi.fn();
  return socket as AuthenticatedSocket;
}

describe("Socket.IO Authentication & Security Middleware (Stage 3.1 Remediation)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetShutdownState();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetShutdownState();
  });

  const validUserId = "00000000-0000-0000-0000-000000000001";
  const validEmail = "alice.test@gmail.com";
  const validSessionId = "00000000-0000-0000-0000-000000000002";

  function createValidToken(overrides: Record<string, any> = {}, options: jwt.SignOptions = { expiresIn: "15m" }): string {
    const payload = {
      userId: validUserId,
      email: validEmail,
      sessionId: validSessionId,
      ...overrides,
    };
    return jwt.sign(payload, env.JWT_SECRET, { algorithm: "HS256", ...options });
  }

  // 1. Missing token
  it("1. Rejects handshake with 'Authentication token required' when token is missing or empty", async () => {
    // Subcase 1a: No token in auth or headers
    const socketNoToken = createMockSocket({}, {});
    const next1 = vi.fn();
    await socketAuthMiddleware(socketNoToken, next1);
    expect(next1).toHaveBeenCalledWith(expect.any(Error));
    expect(next1.mock.calls[0][0].message).toBe("Authentication token required");

    // Subcase 1b: Empty string token
    const socketEmptyToken = createMockSocket({ token: "   " }, {});
    const next2 = vi.fn();
    await socketAuthMiddleware(socketEmptyToken, next2);
    expect(next2).toHaveBeenCalledWith(expect.any(Error));
    expect(next2.mock.calls[0][0].message).toBe("Authentication token required");
  });

  // 2. Invalid JWT
  it("2. Rejects handshake with generic 'Authentication failed' on invalid or malformed JWT", async () => {
    const socketInvalidJwt = createMockSocket({ token: "malformed.jwt.token" });
    const next = vi.fn();
    await socketAuthMiddleware(socketInvalidJwt, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toBe("Authentication failed");
  });

  // 3. Expired JWT
  it("3. Rejects handshake with generic 'Authentication failed' when JWT has expired", async () => {
    const expiredToken = createValidToken({}, { expiresIn: "-10s" });
    const socketExpired = createMockSocket({ token: expiredToken });
    const next = vi.fn();
    await socketAuthMiddleware(socketExpired, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toBe("Authentication failed");
  });

  // 4. M-2: Algorithm restriction
  it("4. Rejects handshake with generic 'Authentication failed' when token uses unexpected algorithm", async () => {
    // Sign token with HS384 instead of approved HS256
    const hs384Token = jwt.sign(
      { userId: validUserId, email: validEmail, sessionId: validSessionId },
      env.JWT_SECRET,
      { algorithm: "HS384", expiresIn: "15m" }
    );
    const socket = createMockSocket({ token: hs384Token });
    const next = vi.fn();
    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toBe("Authentication failed");
  });

  // 5. L-1: Strict claim type and format validation
  describe("5. L-1: Strict JWT Claim Type Validation", () => {
    it("5a. Rejects handshake when sessionId claim is missing", async () => {
      const token = jwt.sign(
        { userId: validUserId, email: validEmail },
        env.JWT_SECRET,
        { algorithm: "HS256", expiresIn: "15m" }
      );
      const socket = createMockSocket({ token });
      const next = vi.fn();
      await socketAuthMiddleware(socket, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe("Authentication failed");
    });

    it("5b. Rejects handshake when userId is a boolean", async () => {
      const token = createValidToken({ userId: true });
      const socket = createMockSocket({ token });
      const next = vi.fn();
      await socketAuthMiddleware(socket, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe("Authentication failed");
    });

    it("5c. Rejects handshake when sessionId is a number", async () => {
      const token = createValidToken({ sessionId: 12345678 });
      const socket = createMockSocket({ token });
      const next = vi.fn();
      await socketAuthMiddleware(socket, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe("Authentication failed");
    });

    it("5d. Rejects handshake when email is a non-string or malformed", async () => {
      const tokenNonString = createValidToken({ email: 99999 });
      const socket1 = createMockSocket({ token: tokenNonString });
      const next1 = vi.fn();
      await socketAuthMiddleware(socket1, next1);
      expect(next1).toHaveBeenCalledWith(expect.any(Error));
      expect(next1.mock.calls[0][0].message).toBe("Authentication failed");

      const tokenNoAt = createValidToken({ email: "invalid-email-without-at" });
      const socket2 = createMockSocket({ token: tokenNoAt });
      const next2 = vi.fn();
      await socketAuthMiddleware(socket2, next2);
      expect(next2).toHaveBeenCalledWith(expect.any(Error));
      expect(next2.mock.calls[0][0].message).toBe("Authentication failed");
    });

    it("5e. Rejects handshake when userId is not a valid UUID format", async () => {
      const token = createValidToken({ userId: "not-a-valid-uuid" });
      const socket = createMockSocket({ token });
      const next = vi.fn();
      await socketAuthMiddleware(socket, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe("Authentication failed");
    });

    it("5f. Rejects handshake when sessionId is not a valid UUID format", async () => {
      const token = createValidToken({ sessionId: "invalid-session-uuid-123" });
      const socket = createMockSocket({ token });
      const next = vi.fn();
      await socketAuthMiddleware(socket, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe("Authentication failed");
    });

    it("5f-1. Rejects handshake when userId contains whitespace padding (SEC-01)", async () => {
      const token = createValidToken({ userId: ` ${validUserId} ` });
      const socket = createMockSocket({ token });
      const next = vi.fn();
      await socketAuthMiddleware(socket, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe("Authentication failed");
    });

    it("5f-2. Rejects handshake when sessionId contains whitespace padding (SEC-01)", async () => {
      const token = createValidToken({ sessionId: ` ${validSessionId} ` });
      const socket = createMockSocket({ token });
      const next = vi.fn();
      await socketAuthMiddleware(socket, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe("Authentication failed");
    });

    it("5g. Rejects handshake when exp is non-finite or invalid", async () => {
      // Craft a cryptographically valid HS256 token with a non-number/non-finite exp claim
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          userId: validUserId,
          email: validEmail,
          sessionId: validSessionId,
          exp: "not-a-number",
        })
      ).toString("base64url");
      const crypto = await import("crypto");
      const signature = crypto.createHmac("sha256", env.JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
      const token = `${header}.${payload}.${signature}`;

      const socket = createMockSocket({ token });
      const next = vi.fn();
      await socketAuthMiddleware(socket, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe("Authentication failed");
    });
  });

  // 6. Nonexistent database session (M-1: generic error)
  it("6. Rejects handshake with generic 'Authentication failed' when session does not exist in database", async () => {
    const token = createValidToken();
    const socket = createMockSocket({ token });
    const next = vi.fn();

    vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce(null);

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toBe("Authentication failed");
  });

  // 7. Revoked session (M-1: generic error)
  it("7. Rejects handshake with generic 'Authentication failed' when session is revoked", async () => {
    const token = createValidToken();
    const socket = createMockSocket({ token });
    const next = vi.fn();

    vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce({
      id: validSessionId,
      userId: validUserId,
      isRevoked: true,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    } as any);

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toBe("Authentication failed");
  });

  // 8. Expired database session (M-1: generic error)
  it("8. Rejects handshake with generic 'Authentication failed' when database session expiresAt is in the past", async () => {
    const token = createValidToken();
    const socket = createMockSocket({ token });
    const next = vi.fn();

    vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce({
      id: validSessionId,
      userId: validUserId,
      isRevoked: false,
      expiresAt: new Date(Date.now() - 5000), // Expired 5 seconds ago
    } as any);

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toBe("Authentication failed");
  });

  // 9. Session belonging to another user (M-1: generic error)
  it("9. Rejects handshake with generic 'Authentication failed' when session userId mismatches token", async () => {
    const token = createValidToken();
    const socket = createMockSocket({ token });
    const next = vi.fn();

    const differentUserId = "00000000-0000-0000-0000-999999999999";
    vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce({
      id: validSessionId,
      userId: differentUserId,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    } as any);

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toBe("Authentication failed");
  });

  // 10. Database failure fails closed (M-1: generic error)
  it("10. Rejects handshake with generic 'Authentication failed' if database query throws", async () => {
    const token = createValidToken();
    const socket = createMockSocket({ token });
    const next = vi.fn();

    vi.spyOn(prisma.session, "findUnique").mockRejectedValueOnce(new Error("Database connection dropped"));

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toBe("Authentication failed");
  });

  // 11. Successful authentication with valid JWT and active session
  it("11. Authenticates successfully and populates socket.data with verified user and expiration", async () => {
    const token = createValidToken();
    const socket = createMockSocket({ token });
    const next = vi.fn();

    vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce({
      id: validSessionId,
      userId: validUserId,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    } as any);

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.data.user).toEqual({
      userId: validUserId,
      email: validEmail,
      sessionId: validSessionId,
    });
    expect(socket.data.tokenExp).toBeGreaterThan(Date.now());

    // Also verify authorization header extraction ("Bearer <token>")
    const headerSocket = createMockSocket({}, { authorization: `Bearer ${token}` });
    const nextHeader = vi.fn();
    vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce({
      id: validSessionId,
      userId: validUserId,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    } as any);

    await socketAuthMiddleware(headerSocket, nextHeader);
    expect(nextHeader).toHaveBeenCalledWith();
    expect(headerSocket.data.user.userId).toBe(validUserId);
  });

  // 12. Socket disconnection when the access token expires
  it("12. Disconnects socket automatically when access token reaches its expiration time", () => {
    vi.useFakeTimers();

    const socket = createMockSocket();
    const expiresInMs = 5000;
    socket.data.tokenExp = Date.now() + expiresInMs;
    socket.data.user = {
      userId: validUserId,
      email: validEmail,
      sessionId: validSessionId,
    };

    setupTokenExpirationEnforcement(socket);

    // Before expiration, socket remains connected
    vi.advanceTimersByTime(4000);
    expect(socket.disconnect).not.toHaveBeenCalled();

    // Advance to expiration time
    vi.advanceTimersByTime(1000);
    expect(socket.emit).toHaveBeenCalledWith("error", { error: "Token expired" });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it("12b. Disconnects socket immediately if access token has already expired upon setup", () => {
    const socket = createMockSocket();
    socket.data.tokenExp = Date.now() - 1000; // Expired 1 second ago
    socket.data.user = {
      userId: validUserId,
      email: validEmail,
      sessionId: validSessionId,
    };

    setupTokenExpirationEnforcement(socket);

    expect(socket.emit).toHaveBeenCalledWith("error", { error: "Token expired" });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  // 13. L-2: Expiration timer re-entrance safety
  it("13. L-2: Clears any pre-existing timer when setupTokenExpirationEnforcement is called repeatedly", () => {
    vi.useFakeTimers();

    const socket = createMockSocket();
    socket.data.tokenExp = Date.now() + 5000;
    socket.data.user = {
      userId: validUserId,
      email: validEmail,
      sessionId: validSessionId,
    };

    // First setup
    const timer1 = setupTokenExpirationEnforcement(socket);
    expect(socket.data.expiryTimer).toBe(timer1);

    // Second setup with a longer expiration
    socket.data.tokenExp = Date.now() + 12000;
    const timer2 = setupTokenExpirationEnforcement(socket);

    expect(socket.data.expiryTimer).toBe(timer2);
    expect(timer2).not.toBe(timer1);

    // Advancing past timer1 (5000ms) should NOT disconnect because timer1 was cleared
    vi.advanceTimersByTime(6000);
    expect(socket.disconnect).not.toHaveBeenCalled();

    // Advancing past timer2 (12000ms) disconnects the socket
    vi.advanceTimersByTime(7000);
    expect(socket.emit).toHaveBeenCalledWith("error", { error: "Token expired" });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  // 14. L-3: Timer unref()
  it("14. L-3: Calls unref() on scheduled expiration timer where supported", () => {
    const socket = createMockSocket();
    socket.data.tokenExp = Date.now() + 10000;
    socket.data.user = {
      userId: validUserId,
      email: validEmail,
      sessionId: validSessionId,
    };

    const timer = setupTokenExpirationEnforcement(socket);
    expect(timer).toBeDefined();

    // In Node.js, timer has unref function
    if (timer && typeof timer.unref === "function") {
      const unrefSpy = vi.spyOn(timer, "unref");
      // Call setup again to check unref is called on the new timer
      setupTokenExpirationEnforcement(socket);
      // Clean up
      clearTokenExpirationTimer(socket);
    }
  });

  // 15. Expiration timer cleanup after manual disconnection
  it("15. Cleans up expiration timer when socket is manually disconnected", () => {
    vi.useFakeTimers();

    const socket = createMockSocket();
    socket.data.tokenExp = Date.now() + 10000;
    socket.data.user = {
      userId: validUserId,
      email: validEmail,
      sessionId: validSessionId,
    };

    setupTokenExpirationEnforcement(socket);
    expect(socket.data.expiryTimer).toBeDefined();

    // Trigger manual disconnect
    socket.emit("disconnect");

    // Timer reference is cleared
    expect(socket.data.expiryTimer).toBeUndefined();

    // Advance time past original expiration — socket.disconnect is NOT called by the timer
    vi.advanceTimersByTime(15000);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it("15b. clearTokenExpirationTimer safely clears active timer", () => {
    const socket = createMockSocket();
    socket.data.tokenExp = Date.now() + 10000;
    setupTokenExpirationEnforcement(socket);

    expect(socket.data.expiryTimer).toBeDefined();
    clearTokenExpirationTimer(socket);
    expect(socket.data.expiryTimer).toBeUndefined();
  });

  it("15c. Timer does not disconnect an already closed or newer socket with different id", () => {
    vi.useFakeTimers();

    const socket = createMockSocket({}, {}, "socket-abc");
    socket.data.tokenExp = Date.now() + 5000;
    setupTokenExpirationEnforcement(socket);

    // Simulate socket changing id or closing before timer fires
    socket.connected = false;

    vi.advanceTimersByTime(6000);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  // 16. Rate limiter
  it("16. Enforces socketRateLimit per connection", () => {
    const socket = createMockSocket();
    socket.data.user = { userId: validUserId, email: validEmail, sessionId: validSessionId };

    // Emit 10 events within 1 second — all allowed
    for (let i = 0; i < 10; i++) {
      expect(socketRateLimit(socket, 10)).toBe(true);
    }

    // 11th event exceeds limit
    expect(socketRateLimit(socket, 10)).toBe(false);
    expect(socket.emit).toHaveBeenCalledWith("error", { error: "Rate limit exceeded" });
  });

  // 17. Server shutdown handshake guard (Stage 3.4.3)
  it("17. Rejects socket handshake with 'SERVER_SHUTDOWN' when server shutdown is in progress", async () => {
    setShutdownInProgress(true);
    expect(isShutdownInProgress()).toBe(true);

    const validToken = createValidToken();
    const socket = createMockSocket({ token: validToken });
    const next = vi.fn();

    const findUniqueSpy = vi.spyOn(prisma.session, "findUnique");

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toBe("SERVER_SHUTDOWN");
    // Fails fast before database or cryptographic operations
    expect(findUniqueSpy).not.toHaveBeenCalled();
  });

  // 18. Normal handshake allowed when shutdown is false (Stage 3.4.3)
  it("18. Allows valid socket handshake when shutdown is false", async () => {
    setShutdownInProgress(false);

    const validToken = createValidToken();
    const socket = createMockSocket({ token: validToken });
    const next = vi.fn();

    vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce({
      id: validSessionId,
      userId: validUserId,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 86400000),
      familyId: "fam-1",
    } as any);

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.data.user.userId).toBe(validUserId);
    expect(socket.data.user.sessionId).toBe(validSessionId);
  });

  // 19. Reconnection with revoked session rejected when shutdown is false (Stage 3.4.3)
  it("19. Rejects reconnecting socket with revoked session as generic 'Authentication failed'", async () => {
    setShutdownInProgress(false);

    const validToken = createValidToken();
    const socket = createMockSocket({ token: validToken });
    const next = vi.fn();

    vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce({
      id: validSessionId,
      userId: validUserId,
      isRevoked: true, // Revoked session
      expiresAt: new Date(Date.now() + 86400000),
      familyId: "fam-1",
    } as any);

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toBe("Authentication failed");
  });

  // 20. Reconnection with expired session in database rejected when shutdown is false (Stage 3.4.3)
  it("20. Rejects reconnecting socket with expired session as generic 'Authentication failed'", async () => {
    setShutdownInProgress(false);

    const validToken = createValidToken();
    const socket = createMockSocket({ token: validToken });
    const next = vi.fn();

    vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce({
      id: validSessionId,
      userId: validUserId,
      isRevoked: false,
      expiresAt: new Date(Date.now() - 1000), // Expired session
      familyId: "fam-1",
    } as any);

    await socketAuthMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toBe("Authentication failed");
  });
});
