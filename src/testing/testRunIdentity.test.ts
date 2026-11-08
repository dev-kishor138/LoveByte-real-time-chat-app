import { describe, it, expect } from "vitest";
import {
  createTestRunIdentity,
  assertCleanupOwnership,
} from "./testRunIdentity";

describe("Test Run Identity & Cleanup Safety", () => {
  it("generates unique runId, cleanRunId, and valid email prefix", () => {
    const identity = createTestRunIdentity();

    expect(identity.runId).toBeDefined();
    expect(identity.cleanRunId).toMatch(/^[a-z0-9]+$/);
    expect(identity.emailPrefix).toBe(`test.run.${identity.cleanRunId}`);
  });

  it("accepts a valid custom runId and sanitizes it", () => {
    const identity = createTestRunIdentity("Run-Test-123_456");

    expect(identity.runId).toBe("Run-Test-123_456");
    expect(identity.cleanRunId).toBe("runtest123456");
    expect(identity.emailPrefix).toBe("test.run.runtest123456");
  });

  it("throws error when custom runId contains no alphanumeric characters", () => {
    expect(() => createTestRunIdentity("---___!@#")).toThrow(
      "Invalid runId: must contain alphanumeric characters."
    );
  });

  it("generates synthetic Gmail addresses matching registerSchema requirements", () => {
    const identity = createTestRunIdentity("suite-a");
    const userEmail = identity.createEmail("sender");
    const partnerEmail = identity.createEmail("receiver");

    // Standard LoveByte registration regex
    const gmailRegex = /^[a-zA-Z0-9._%+-]+@gmail\.com$/;
    expect(userEmail).toMatch(gmailRegex);
    expect(partnerEmail).toMatch(gmailRegex);

    expect(userEmail).toBe("test.run.suitea.sender@gmail.com");
    expect(partnerEmail).toBe("test.run.suitea.receiver@gmail.com");
  });

  it("defaults role to 'user' when role argument is empty or non-alphanumeric", () => {
    const identity = createTestRunIdentity("suite-b");
    const email = identity.createEmail("---");
    expect(email).toBe("test.run.suiteb.user@gmail.com");
  });

  it("correctly identifies owned vs foreign synthetic emails", () => {
    const identity1 = createTestRunIdentity("suite-1");
    const identity2 = createTestRunIdentity("suite-2");

    const email1 = identity1.createEmail("alice");
    const email2 = identity2.createEmail("bob");

    expect(identity1.isOwnedEmail(email1)).toBe(true);
    expect(identity1.isOwnedEmail(email2)).toBe(false);

    expect(identity1.isOwnedEmail("someone@gmail.com")).toBe(false);
    expect(identity1.isOwnedEmail("test.run.suite-1.alice@yahoo.com")).toBe(false);
    expect(identity1.isOwnedEmail("")).toBe(false);
    expect(identity1.isOwnedEmail(null as any)).toBe(false);
  });

  describe("assertCleanupOwnership Safety Guard", () => {
    const run = createTestRunIdentity("run-cleanup-guard");
    const foreignRun = createTestRunIdentity("other-foreign-run");

    it("rejects empty criteria object", () => {
      expect(() => assertCleanupOwnership(run, {})).toThrow(
        "SAFETY VIOLATION: Empty cleanup criteria rejected"
      );
      expect(() => assertCleanupOwnership(run, null as any)).toThrow(
        "SAFETY VIOLATION: Empty cleanup criteria rejected"
      );
    });

    it("allows single email belonging to the active test run", () => {
      const ownedEmail = run.createEmail("alice");
      expect(() => assertCleanupOwnership(run, { email: ownedEmail })).not.toThrow();
    });

    it("rejects single email belonging to a foreign test run or real user", () => {
      const foreignEmail = foreignRun.createEmail("bob");
      expect(() => assertCleanupOwnership(run, { email: foreignEmail })).toThrow(
        "SAFETY VIOLATION: Cleanup email"
      );
      expect(() => assertCleanupOwnership(run, { email: "realuser@gmail.com" })).toThrow(
        "SAFETY VIOLATION: Cleanup email"
      );
    });

    it("allows prefix matching active run email prefix", () => {
      expect(() =>
        assertCleanupOwnership(run, { emailPrefix: run.emailPrefix })
      ).not.toThrow();
      expect(() =>
        assertCleanupOwnership(run, { emailPrefix: `${run.emailPrefix}.` })
      ).not.toThrow();
    });

    it("rejects foreign or wildcard email prefixes", () => {
      expect(() =>
        assertCleanupOwnership(run, { emailPrefix: foreignRun.emailPrefix })
      ).toThrow("SAFETY VIOLATION: Cleanup prefix");

      expect(() =>
        assertCleanupOwnership(run, { emailPrefix: "test.run." })
      ).toThrow("SAFETY VIOLATION: Cleanup prefix");

      expect(() =>
        assertCleanupOwnership(run, { emailPrefix: "test." })
      ).toThrow("SAFETY VIOLATION: Cleanup prefix");
    });

    it("allows list of emails when all belong to the active test run", () => {
      const email1 = run.createEmail("user1");
      const email2 = run.createEmail("user2");
      expect(() =>
        assertCleanupOwnership(run, { emails: [email1, email2] })
      ).not.toThrow();
    });

    it("rejects list of emails if empty or containing any foreign email", () => {
      expect(() => assertCleanupOwnership(run, { emails: [] })).toThrow(
        "SAFETY VIOLATION: Empty emails array provided for cleanup."
      );

      const email1 = run.createEmail("user1");
      const foreignEmail = foreignRun.createEmail("foreignUser");

      expect(() =>
        assertCleanupOwnership(run, { emails: [email1, foreignEmail] })
      ).toThrow("SAFETY VIOLATION: Cleanup email");
    });

    describe("FINDING-02 Regression Tests — Cleanup Criteria Validation Hardening", () => {
      it("rejects empty string email { email: '' }", () => {
        expect(() => assertCleanupOwnership(run, { email: "" })).toThrow(
          "SAFETY VIOLATION: Cleanup email must be a non-empty string."
        );
      });

      it("rejects whitespace-only email { email: '   ' }", () => {
        expect(() => assertCleanupOwnership(run, { email: "   " })).toThrow(
          "SAFETY VIOLATION: Cleanup email must be a non-empty string."
        );
      });

      it("rejects undefined email { email: undefined }", () => {
        expect(() => assertCleanupOwnership(run, { email: undefined } as any)).toThrow(
          "SAFETY VIOLATION: Cleanup email must be a non-empty string."
        );
      });

      it("rejects null email { email: null }", () => {
        expect(() => assertCleanupOwnership(run, { email: null } as any)).toThrow(
          "SAFETY VIOLATION: Cleanup email must be a non-empty string."
        );
      });

      it("rejects empty string prefix { emailPrefix: '' }", () => {
        expect(() => assertCleanupOwnership(run, { emailPrefix: "" })).toThrow(
          "SAFETY VIOLATION: Cleanup prefix must be a non-empty string."
        );
      });

      it("rejects whitespace-only prefix { emailPrefix: '   ' }", () => {
        expect(() => assertCleanupOwnership(run, { emailPrefix: "   " })).toThrow(
          "SAFETY VIOLATION: Cleanup prefix must be a non-empty string."
        );
      });

      it("rejects undefined prefix { emailPrefix: undefined }", () => {
        expect(() => assertCleanupOwnership(run, { emailPrefix: undefined } as any)).toThrow(
          "SAFETY VIOLATION: Cleanup prefix must be a non-empty string."
        );
      });

      it("rejects emails array with empty string { emails: [''] }", () => {
        expect(() => assertCleanupOwnership(run, { emails: [""] })).toThrow(
          "SAFETY VIOLATION: Cleanup emails array contains an empty or invalid email."
        );
      });

      it("rejects emails array containing both valid and foreign emails", () => {
        const owned = run.createEmail("user1");
        const foreign = foreignRun.createEmail("foreignUser");
        expect(() =>
          assertCleanupOwnership(run, { emails: [owned, foreign] })
        ).toThrow("SAFETY VIOLATION: Cleanup email");
      });

      it("rejects criteria containing unsupported keys such as { userId: '123' }", () => {
        expect(() => assertCleanupOwnership(run, { userId: "123" } as any)).toThrow(
          "SAFETY VIOLATION: Unrecognized cleanup criterion 'userId' is forbidden."
        );
      });

      it("rejects criteria containing arbitrary unknown keys { unknownField: 'value' }", () => {
        expect(() =>
          assertCleanupOwnership(run, { unknownField: "value" } as any)
        ).toThrow("SAFETY VIOLATION: Unrecognized cleanup criterion 'unknownField' is forbidden.");
      });

      it("rejects criteria if it is an array or primitive", () => {
        expect(() => assertCleanupOwnership(run, [] as any)).toThrow(
          "SAFETY VIOLATION: Empty cleanup criteria rejected."
        );
        expect(() => assertCleanupOwnership(run, "invalid" as any)).toThrow(
          "SAFETY VIOLATION: Empty cleanup criteria rejected."
        );
      });
    });

    describe("FINDING-04 Regression Tests — Strict Owned Email Format & Validation", () => {
      it("1. Accepts valid owned Gmail address", () => {
        const valid = run.createEmail("alice");
        expect(run.isOwnedEmail(valid)).toBe(true);
      });

      it("2. Rejects valid foreign-run Gmail address", () => {
        const foreign = foreignRun.createEmail("alice");
        expect(run.isOwnedEmail(foreign)).toBe(false);
      });

      it("3. Rejects non-Gmail domain", () => {
        expect(run.isOwnedEmail(`test.run.${run.cleanRunId}.user@yahoo.com`)).toBe(false);
        expect(run.isOwnedEmail(`test.run.${run.cleanRunId}.user@hotmail.com`)).toBe(false);
      });

      it("4. Rejects multiple '@' characters in address", () => {
        expect(run.isOwnedEmail(`test.run.${run.cleanRunId}.user@other@gmail.com`)).toBe(false);
      });

      it("5. Rejects appended domain bypass attack (e.g. attacker@evil.com@gmail.com)", () => {
        expect(run.isOwnedEmail(`test.run.${run.cleanRunId}.attacker@evil.com@gmail.com`)).toBe(false);
      });

      it("6. Rejects whitespace and malformed addresses", () => {
        expect(run.isOwnedEmail(` test.run.${run.cleanRunId}.user@gmail.com `)).toBe(true); // Trimming works
        expect(run.isOwnedEmail(`test.run.${run.cleanRunId}.user @gmail.com`)).toBe(false); // Internal space invalid
        expect(run.isOwnedEmail(`test.run.${run.cleanRunId}.user!bad@gmail.com`)).toBe(false); // Special character not in regex
        expect(run.isOwnedEmail(`test.run.${run.cleanRunId}.user#bad@gmail.com`)).toBe(false);
      });

      it("7. Normalizes case consistently (uppercase email)", () => {
        const upper = `TEST.RUN.${run.cleanRunId.toUpperCase()}.ALICE@GMAIL.COM`;
        expect(run.isOwnedEmail(upper)).toBe(true);
      });
    });
  });
});

