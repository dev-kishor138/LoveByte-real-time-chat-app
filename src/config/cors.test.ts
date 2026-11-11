import { describe, it, expect, vi } from "vitest";
import {
  isValidOrigin,
  parseCorsOrigins,
  createCorsOriginResolver,
  evaluateOrigin,
  DEFAULT_PRODUCTION_ORIGINS,
} from "./cors";

describe("Fail-Closed CORS Configuration & Origin Validator (SEC-02)", () => {
  describe("isValidOrigin", () => {
    it("accepts valid http and https origins with root or empty path", () => {
      expect(isValidOrigin("http://localhost:3000")).toBe(true);
      expect(isValidOrigin("https://app.lovebyte.com")).toBe(true);
      expect(isValidOrigin("https://app.lovebyte.com/")).toBe(true);
      expect(isValidOrigin("https://lovebyte-real-time-chat-app.onrender.com")).toBe(true);
    });

    it("rejects origins containing URL credentials (username/password)", () => {
      expect(isValidOrigin("https://user:password@example.com")).toBe(false);
      expect(isValidOrigin("http://admin:@localhost:3000")).toBe(false);
      expect(isValidOrigin("https://:secret@lovebyte.com")).toBe(false);
    });

    it("rejects invalid schemes", () => {
      expect(isValidOrigin("ftp://example.com")).toBe(false);
      expect(isValidOrigin("ws://example.com")).toBe(false);
      expect(isValidOrigin("javascript:alert(1)")).toBe(false);
      expect(isValidOrigin("file:///etc/passwd")).toBe(false);
    });

    it("rejects origins with subpaths", () => {
      expect(isValidOrigin("https://app.lovebyte.com/api")).toBe(false);
      expect(isValidOrigin("https://app.lovebyte.com/login")).toBe(false);
    });

    it("rejects origins with query strings or fragments", () => {
      expect(isValidOrigin("https://app.lovebyte.com?query=1")).toBe(false);
      expect(isValidOrigin("https://app.lovebyte.com#section")).toBe(false);
      expect(isValidOrigin("https://app.lovebyte.com/?query=1")).toBe(false);
    });

    it("rejects invalid or malformed URL strings", () => {
      expect(isValidOrigin("not-a-valid-url")).toBe(false);
      expect(isValidOrigin("")).toBe(false);
      expect(isValidOrigin("http://")).toBe(false);
    });
  });

  describe("parseCorsOrigins", () => {
    it("returns empty array for empty, undefined, or whitespace-only configuration in dev/test", () => {
      expect(parseCorsOrigins(undefined, false)).toEqual([]);
      expect(parseCorsOrigins("", false)).toEqual([]);
      expect(parseCorsOrigins("   ", false)).toEqual([]);
    });

    it("falls back to explicit DEFAULT_PRODUCTION_ORIGINS in production when configuration is missing or empty", () => {
      expect(parseCorsOrigins(undefined, true)).toEqual([
        "https://lovebyte-real-time-chat-app.onrender.com",
      ]);
      expect(parseCorsOrigins("", true)).toEqual([
        "https://lovebyte-real-time-chat-app.onrender.com",
      ]);
      expect(parseCorsOrigins("   ", true)).toEqual([
        "https://lovebyte-real-time-chat-app.onrender.com",
      ]);
    });

    it("accepts single valid origin and normalizes it", () => {
      expect(parseCorsOrigins("https://app.lovebyte.com")).toEqual([
        "https://app.lovebyte.com",
      ]);
    });

    it("accepts multiple comma-separated valid origins with trimming", () => {
      const config = "https://app.lovebyte.com, https://admin.lovebyte.com";
      expect(parseCorsOrigins(config)).toEqual([
        "https://app.lovebyte.com",
        "https://admin.lovebyte.com",
      ]);
    });

    it("handles redundant commas and surrounding whitespace safely", () => {
      const config = ",  https://app.lovebyte.com  , , https://admin.lovebyte.com , ";
      expect(parseCorsOrigins(config)).toEqual([
        "https://app.lovebyte.com",
        "https://admin.lovebyte.com",
      ]);
    });

    it("fails closed (returns []) if ANY candidate in a list is malformed", () => {
      // Mixed valid and invalid entry
      expect(
        parseCorsOrigins("https://trusted.example.com,not-a-valid-url")
      ).toEqual([]);
      // Valid origin followed by credentialed origin
      expect(
        parseCorsOrigins("https://app.lovebyte.com,https://user:pass@evil.com")
      ).toEqual([]);
      // Valid origin followed by subpath origin
      expect(
        parseCorsOrigins("https://app.lovebyte.com,https://other.com/api")
      ).toEqual([]);
    });

    it("supports exclusive wildcard '*' strictly in development/test", () => {
      expect(parseCorsOrigins("*", false)).toBe("*");
    });

    it("rejects exclusive wildcard '*' in production mode (fails closed)", () => {
      expect(parseCorsOrigins("*", true)).toEqual([]);
    });

    it("rejects mixed wildcard configurations in ALL environments (fails closed)", () => {
      // Wildcard mixed with other origins must never be interpreted as wildcard or allowed
      expect(parseCorsOrigins("https://app.example.com,*", false)).toEqual([]);
      expect(parseCorsOrigins("*,https://app.example.com", false)).toEqual([]);
      expect(parseCorsOrigins("https://app.example.com,*", true)).toEqual([]);
      expect(parseCorsOrigins("*,https://app.example.com", true)).toEqual([]);
    });
  });

  describe("createCorsOriginResolver", () => {
    it("allows missing Origin header (native mobile clients, curl, server-to-server)", () => {
      const resolver = createCorsOriginResolver(["https://app.lovebyte.com"]);
      const callback = vi.fn();

      resolver(undefined, callback);
      expect(callback).toHaveBeenCalledWith(null, true);
    });

    it("allows any origin when exclusively configured as wildcard '*'", () => {
      const resolver = createCorsOriginResolver("*");
      const callback = vi.fn();

      resolver("https://random-site.com", callback);
      expect(callback).toHaveBeenCalledWith(null, true);
    });

    it("allows request origin present in allowed list (case-insensitive)", () => {
      const resolver = createCorsOriginResolver([
        "https://app.lovebyte.com",
        "http://localhost:3000",
      ]);
      const callback = vi.fn();

      resolver("HTTPS://APP.LOVEBYTE.COM", callback);
      expect(callback).toHaveBeenCalledWith(null, true);
    });

    it("disallows request origin not present in allowed list", () => {
      const resolver = createCorsOriginResolver(["https://app.lovebyte.com"]);
      const callback = vi.fn();

      resolver("https://evil.com", callback);
      expect(callback).toHaveBeenCalledWith(null, false);
    });

    it("disallows all origins when allowed list is empty (fail-closed)", () => {
      const resolver = createCorsOriginResolver([]);
      const callback = vi.fn();

      resolver("https://app.lovebyte.com", callback);
      expect(callback).toHaveBeenCalledWith(null, false);
    });
  });

  describe("evaluateOrigin", () => {
    it("returns true for missing Origin (mobile/non-browser clients)", () => {
      expect(evaluateOrigin(undefined, ["https://app.lovebyte.com"])).toBe(true);
    });

    it("returns true for wildcard '*' configuration", () => {
      expect(evaluateOrigin("https://any.com", "*")).toBe(true);
    });

    it("returns true for allowed origin in array", () => {
      expect(
        evaluateOrigin("https://app.lovebyte.com", [
          "https://app.lovebyte.com",
        ])
      ).toBe(true);
    });

    it("returns false for unauthorized origin in array", () => {
      expect(
        evaluateOrigin("https://evil.com", ["https://app.lovebyte.com"])
      ).toBe(false);
    });

    it("returns false for empty allowed list (fail-closed)", () => {
      expect(evaluateOrigin("https://app.lovebyte.com", [])).toBe(false);
    });

    it("evaluates true for deployed production origin against DEFAULT_PRODUCTION_ORIGINS", () => {
      expect(
        evaluateOrigin(
          "https://lovebyte-real-time-chat-app.onrender.com",
          DEFAULT_PRODUCTION_ORIGINS as unknown as string[]
        )
      ).toBe(true);
    });

    it("evaluates false for unauthorized origin against DEFAULT_PRODUCTION_ORIGINS", () => {
      expect(
        evaluateOrigin(
          "https://malicious-site.com",
          DEFAULT_PRODUCTION_ORIGINS as unknown as string[]
        )
      ).toBe(false);
    });
  });
});

