import { describe, it, expect } from "vitest";
import { CANONICAL_UUID_REGEX, isCanonicalUuid } from "./uuid";

describe("Canonical UUID Format Validator (SEC-01)", () => {
  const validLower = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e5f";
  const validUpper = "C1F2E3D4-B5A6-4C7D-8E9F-0A1B2C3D4E5F";
  const validMixed = "c1F2e3D4-B5a6-4C7d-8E9f-0A1b2C3d4E5f";

  it("accepts valid lowercase canonical UUID", () => {
    expect(isCanonicalUuid(validLower)).toBe(true);
    expect(CANONICAL_UUID_REGEX.test(validLower)).toBe(true);
  });

  it("accepts valid uppercase canonical UUID", () => {
    expect(isCanonicalUuid(validUpper)).toBe(true);
    expect(CANONICAL_UUID_REGEX.test(validUpper)).toBe(true);
  });

  it("accepts valid mixed-case canonical UUID", () => {
    expect(isCanonicalUuid(validMixed)).toBe(true);
    expect(CANONICAL_UUID_REGEX.test(validMixed)).toBe(true);
  });

  it("strictly rejects leading whitespace without trimming", () => {
    expect(isCanonicalUuid(` ${validLower}`)).toBe(false);
    expect(isCanonicalUuid(`\t${validLower}`)).toBe(false);
    expect(isCanonicalUuid(`\n${validLower}`)).toBe(false);
  });

  it("strictly rejects trailing whitespace without trimming", () => {
    expect(isCanonicalUuid(`${validLower} `)).toBe(false);
    expect(isCanonicalUuid(`${validLower}\t`)).toBe(false);
    expect(isCanonicalUuid(`${validLower}\n`)).toBe(false);
  });

  it("strictly rejects both-sided whitespace", () => {
    expect(isCanonicalUuid(`   ${validLower}   `)).toBe(false);
    expect(isCanonicalUuid(`\t\n${validLower}\n\t`)).toBe(false);
  });

  it("strictly rejects internal whitespace", () => {
    const internalSpace = "c1f2e3d4-b5a6- 4c7d-8e9f-0a1b2c3d4e5f";
    expect(isCanonicalUuid(internalSpace)).toBe(false);
  });

  it("rejects empty and whitespace-only strings", () => {
    expect(isCanonicalUuid("")).toBe(false);
    expect(isCanonicalUuid("   ")).toBe(false);
  });

  it("rejects non-UUID strings and malformed formats", () => {
    expect(isCanonicalUuid("session-123")).toBe(false);
    expect(isCanonicalUuid("not-a-uuid")).toBe(false);
    // Missing hyphens (32 hex digits)
    expect(isCanonicalUuid("c1f2e3d4b5a64c7d8e9f0a1b2c3d4e5f")).toBe(false);
    // Extra character
    expect(isCanonicalUuid(`${validLower}a`)).toBe(false);
    // Missing character
    expect(isCanonicalUuid(validLower.slice(0, -1))).toBe(false);
    // Non-hex character
    expect(isCanonicalUuid("g1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e5f")).toBe(false);
  });

  it("rejects null and undefined", () => {
    expect(isCanonicalUuid(null)).toBe(false);
    expect(isCanonicalUuid(undefined)).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isCanonicalUuid(12345)).toBe(false);
    expect(isCanonicalUuid({})).toBe(false);
    expect(isCanonicalUuid([])).toBe(false);
    expect(isCanonicalUuid(true)).toBe(false);
    expect(isCanonicalUuid(Symbol("uuid"))).toBe(false);
  });
});

