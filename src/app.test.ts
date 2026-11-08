import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app, resetHealthCheckCache } from "./app";
import { prisma } from "./config/prisma";
import * as shutdownModule from "./utils/shutdown";

describe("Application Health Check (Stage A)", () => {
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

  it("6. Rejects and returns 503 when database query exceeds 2-second timeout", { timeout: 5000 }, async () => {
    vi.spyOn(prisma, "$queryRaw").mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 2500))
    );

    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toHaveProperty("status", "unhealthy");
    expect(res.body).toHaveProperty("error", "Database unavailable");
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
