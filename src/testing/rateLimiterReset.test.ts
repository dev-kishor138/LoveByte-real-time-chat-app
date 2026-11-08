import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  authStore,
  refreshStore,
  apiStore,
  resetRateLimiters,
} from "../middlewares/rateLimiter";

describe("Rate Limiter Test Reset Safety & Functionality", () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("resets all rate limiter stores when NODE_ENV === 'test'", async () => {
    // Populate store hits
    await authStore.increment("192.168.1.1");
    await refreshStore.increment("192.168.1.1");
    await apiStore.increment("192.168.1.1");

    // Verify hits exist
    const authHitBefore = await authStore.get("192.168.1.1");
    expect(authHitBefore?.totalHits).toBeGreaterThanOrEqual(1);

    // Call reset
    expect(() => resetRateLimiters()).not.toThrow();

    // Verify stores are cleared
    const authHitAfter = await authStore.get("192.168.1.1");
    const refreshHitAfter = await refreshStore.get("192.168.1.1");
    const apiHitAfter = await apiStore.get("192.168.1.1");

    expect(authHitAfter).toBeUndefined();
    expect(refreshHitAfter).toBeUndefined();
    expect(apiHitAfter).toBeUndefined();
  });

  it("strictly throws when NODE_ENV is set to 'production'", () => {
    process.env.NODE_ENV = "production";

    expect(() => resetRateLimiters()).toThrow(
      "resetRateLimiters is restricted strictly to test environment (NODE_ENV=test)"
    );
  });

  it("strictly throws when NODE_ENV is set to 'development'", () => {
    process.env.NODE_ENV = "development";

    expect(() => resetRateLimiters()).toThrow(
      "resetRateLimiters is restricted strictly to test environment (NODE_ENV=test)"
    );
  });

  it("strictly throws when NODE_ENV is undefined or empty", () => {
    delete process.env.NODE_ENV;

    expect(() => resetRateLimiters()).toThrow(
      "resetRateLimiters is restricted strictly to test environment (NODE_ENV=test)"
    );
  });
});

