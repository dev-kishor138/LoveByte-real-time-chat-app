import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import {
  app,
  resetHealthCheckCache,
  setHealthCheckTimeoutForTesting,
  DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
  HEALTH_CHECK_ERROR_CACHE_TTL_MS,
} from "./app";
import { prisma } from "./config/prisma";
import { warmUpDatabase } from "./server";
import * as shutdownModule from "./utils/shutdown";

describe("Application Health Check & Neon Database Recovery (Stage 1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetHealthCheckCache();
    vi.spyOn(shutdownModule, "isShutdownInProgress").mockReturnValue(false);
  });

  it("1. Returns status ok (200) and connected database when query succeeds", async () => {
    vi.spyOn(prisma, "$queryRaw").mockResolvedValueOnce([{ 1: 1 }] as any);

    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("status", "ok");
    expect(response.body).toHaveProperty("database", "connected");
    expect(response.body).toHaveProperty("timestamp");
  });

  it("2. Returns 503 Service Unavailable when database query fails", async () => {
    vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("Connection refused"));

    const response = await request(app).get("/health");
    expect(response.status).toBe(503);
    expect(response.body).toHaveProperty("status", "unhealthy");
    expect(response.body).toHaveProperty("error", "Database unavailable");
    expect(response.body).not.toHaveProperty("stack");
  });

  it("3. Returns 503 when shutdown is in progress", async () => {
    vi.spyOn(shutdownModule, "isShutdownInProgress").mockReturnValue(true);

    const response = await request(app).get("/health");
    expect(response.status).toBe(503);
    expect(response.body).toHaveProperty("status", "shutting_down");
  });

  it("4. Returns cached status on frequent repeated requests within 2 seconds", async () => {
    const querySpy = vi.spyOn(prisma, "$queryRaw").mockResolvedValueOnce([{ 1: 1 }] as any);

    const res1 = await request(app).get("/health");
    expect(res1.status).toBe(200);
    expect(querySpy).toHaveBeenCalledTimes(1);

    // Second immediate request should hit cache and NOT invoke query again
    const res2 = await request(app).get("/health");
    expect(res2.status).toBe(200);
    expect(res2.body.status).toBe("ok");
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it("5. Clears timeout timer when database query resolves successfully", async () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    vi.spyOn(prisma, "$queryRaw").mockResolvedValueOnce([{ 1: 1 }] as any);

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("6. Rejects and returns 503 when database query exceeds timeout", async () => {
    setHealthCheckTimeoutForTesting(100);
    vi.spyOn(prisma, "$queryRaw").mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 300))
    );

    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toHaveProperty("status", "unhealthy");
    expect(res.body).toHaveProperty("error", "Database unavailable");
  });

  it("7. Coalesces concurrent in-flight requests into a single database query (single-flight)", async () => {
    const querySpy = vi.spyOn(prisma, "$queryRaw").mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([{ 1: 1 }] as any), 80))
    );

    // Dispatch 5 concurrent health check requests simultaneously
    const responses = await Promise.all([
      request(app).get("/health"),
      request(app).get("/health"),
      request(app).get("/health"),
      request(app).get("/health"),
      request(app).get("/health"),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.database).toBe("connected");
    }

    // Single-flight ensures only 1 database query was initiated across all 5 requests
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it("8. Recovers after failure and does not leave application in permanent 503", async () => {
    const querySpy = vi
      .spyOn(prisma, "$queryRaw")
      .mockRejectedValueOnce(new Error("Neon waking up"))
      .mockResolvedValueOnce([{ 1: 1 }] as any);

    const res1 = await request(app).get("/health");
    expect(res1.status).toBe(503);
    expect(res1.body.status).toBe("unhealthy");

    // Fast-forward past error cache TTL (HEALTH_CHECK_ERROR_CACHE_TTL_MS)
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + HEALTH_CHECK_ERROR_CACHE_TTL_MS + 50);

    const res2 = await request(app).get("/health");
    expect(res2.status).toBe(200);
    expect(res2.body.status).toBe("ok");
    expect(res2.body.database).toBe("connected");
    expect(querySpy).toHaveBeenCalledTimes(2);
  });

  it("9. Query promise late rejection after timeout does not cause unhandled rejection", async () => {
    setHealthCheckTimeoutForTesting(50);
    let triggerLateReject: ((err: Error) => void) | null = null;
    vi.spyOn(prisma, "$queryRaw").mockImplementation(
      () =>
        new Promise((_, reject) => {
          triggerLateReject = reject;
        })
    );

    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unhealthy");

    // Simulate late rejection occurring after timeout has already settled
    expect(() => {
      triggerLateReject?.(new Error("Late Neon connection failure"));
    }).not.toThrow();
  });

  it("10. DEFAULT_HEALTH_CHECK_TIMEOUT_MS is configured to 5000ms", () => {
    expect(DEFAULT_HEALTH_CHECK_TIMEOUT_MS).toBe(5000);
  });
});

describe("Non-Blocking Database Warm-Up (Stage 1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(shutdownModule, "isShutdownInProgress").mockReturnValue(false);
  });

  it("1. Logs and succeeds when database query resolves cleanly", async () => {
    const querySpy = vi.spyOn(prisma, "$queryRaw").mockResolvedValueOnce([{ 1: 1 }] as any);

    await expect(warmUpDatabase()).resolves.toBeUndefined();
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it("2. Catches database failure safely and does not throw or crash", async () => {
    const querySpy = vi
      .spyOn(prisma, "$queryRaw")
      .mockRejectedValueOnce(new Error("Connection timeout during microVM wake-up"));

    await expect(warmUpDatabase()).resolves.toBeUndefined();
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it("3. Skips warm-up if shutdown is in progress", async () => {
    vi.spyOn(shutdownModule, "isShutdownInProgress").mockReturnValue(true);
    const querySpy = vi.spyOn(prisma, "$queryRaw").mockResolvedValueOnce([{ 1: 1 }] as any);

    await warmUpDatabase();
    expect(querySpy).not.toHaveBeenCalled();
  });
});

describe("Express CORS Integration (SEC-02)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetHealthCheckCache();
    vi.spyOn(shutdownModule, "isShutdownInProgress").mockReturnValue(false);
    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([{ 1: 1 }] as any);
  });

  it("1. Accepts request without Origin header (native mobile clients, curl)", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    // No Access-Control-Allow-Origin header is required when Origin was not sent
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("2. Handles preflight OPTIONS request with Access-Control-Allow-Credentials: true", async () => {
    const res = await request(app)
      .options("/health")
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "GET");

    // In dev/test with wildcard or localhost allowed, preflight returns 204 or 200
    expect([200, 204]).toContain(res.status);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });
});
