import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import { startTestServer, stopTestServer, RunningTestServer } from "./testServerHelper";
import { prisma } from "../config/prisma";
import { resetRateLimiters } from "../middlewares/rateLimiter";

describe("Ephemeral HTTP & Socket.IO Test Server Helper", () => {
  let runningServer: RunningTestServer | null = null;
  let clientSocket: ClientSocket | null = null;

  beforeEach(() => {
    resetRateLimiters();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    if (clientSocket && clientSocket.connected) {
      clientSocket.disconnect();
      clientSocket = null;
    }
    await stopTestServer();
    runningServer = null;
  });

  it("starts HTTP server on dynamic ephemeral port (> 0) bound to loopback 127.0.0.1", async () => {
    runningServer = await startTestServer();

    expect(runningServer).toBeDefined();
    expect(runningServer.port).toBeGreaterThan(0);
    expect(runningServer.baseUrl).toBe(`http://127.0.0.1:${runningServer.port}`);
    expect(runningServer.wsUrl).toBe(`ws://127.0.0.1:${runningServer.port}`);
    expect(runningServer.server.listening).toBe(true);
  });

  it("serves HTTP requests over loopback TCP without port collision", async () => {
    vi.spyOn(prisma, "$queryRaw").mockResolvedValueOnce([{ 1: 1 }] as any);

    runningServer = await startTestServer();

    const response = await fetch(`${runningServer.baseUrl}/health`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as any;
    expect(body.status).toBe("ok");
    expect(body.database).toBe("connected");
  });

  it("is idempotent when calling startTestServer multiple times", async () => {
    const server1 = await startTestServer();
    const server2 = await startTestServer();

    expect(server1.port).toBe(server2.port);
    expect(server1.baseUrl).toBe(server2.baseUrl);
    expect(server1.server).toBe(server2.server);
  });

  it("accepts incoming real Socket.IO connections and executes handshake auth middleware", async () => {
    runningServer = await startTestServer();

    const connectErrorPromise = new Promise<string>((resolve) => {
      clientSocket = ioClient(runningServer!.baseUrl, {
        transports: ["websocket"],
        autoConnect: true,
        reconnection: false,
      });

      clientSocket.on("connect_error", (err) => {
        resolve(err.message);
      });
    });

    const errorMessage = await connectErrorPromise;
    // socketAuthMiddleware correctly rejects connection without token
    expect(errorMessage).toBe("Authentication token required");
  });

  it("stops cleanly without dangling listeners or hanging ports", async () => {
    runningServer = await startTestServer();
    expect(runningServer.server.listening).toBe(true);

    await stopTestServer();
    expect(runningServer.server.listening).toBe(false);

    // Repeated stop calls succeed safely
    await expect(stopTestServer()).resolves.not.toThrow();
  });

  describe("FINDING-03 Regression Tests — Server Startup Failure & Cleanup", () => {
    it("cleans up Socket.IO and HTTP resources on listen failure and propagates original error", async () => {
      // Simulate listen failure on next invocation
      vi.spyOn(http.Server.prototype, "listen").mockImplementationOnce(function (this: any) {
        process.nextTick(() => {
          this.emit("error", new Error("EADDRINUSE: simulated bind failure"));
        });
        return this;
      });

      // Assert error is propagated
      await expect(startTestServer()).rejects.toThrow("EADDRINUSE: simulated bind failure");

      // Verify a subsequent startTestServer() can start cleanly without "Socket.IO already initialized" error
      runningServer = await startTestServer();
      expect(runningServer.server.listening).toBe(true);
      expect(runningServer.port).toBeGreaterThan(0);
    });

    it("does not disrupt or close an already active test server on repeated calls", async () => {
      runningServer = await startTestServer();
      const originalPort = runningServer.port;
      expect(runningServer.server.listening).toBe(true);

      // Calling startTestServer while active returns the existing instance
      const secondCall = await startTestServer();
      expect(secondCall.port).toBe(originalPort);
      expect(secondCall.server.listening).toBe(true);
    });
  });
});
