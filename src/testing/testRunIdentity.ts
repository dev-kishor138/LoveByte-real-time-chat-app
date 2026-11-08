import crypto from "crypto";

export interface TestRunIdentity {
  runId: string;
  cleanRunId: string;
  emailPrefix: string;
  createEmail: (role: string) => string;
  isOwnedEmail: (email: string) => boolean;
}

/**
 * Canonical Gmail registration regex matching application validation rules.
 */
export const GMAIL_REGISTRATION_REGEX = /^[a-zA-Z0-9._%+-]+@gmail\.com$/;

/**
 * Validates that an identifier contains only alphanumeric characters.
 */
function sanitizeIdentifier(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Creates an isolated test-run identity context.
 * Generates a unique UUID runId and synthetic Gmail addresses strictly matching
 * the application's Gmail registration schema (/^[a-zA-Z0-9._%+-]+@gmail\.com$/).
 */
export function createTestRunIdentity(customRunId?: string): TestRunIdentity {
  const runId = customRunId || crypto.randomUUID();
  const cleanRunId = sanitizeIdentifier(runId);

  if (!cleanRunId) {
    throw new Error("Invalid runId: must contain alphanumeric characters.");
  }

  // Namespace pattern: test.run.<cleanRunId>.<role>@gmail.com
  const emailPrefix = `test.run.${cleanRunId}`;

  const createEmail = (role: string): string => {
    const cleanRole = sanitizeIdentifier(role) || "user";
    const email = `${emailPrefix}.${cleanRole}@gmail.com`;

    // Strict validation against Gmail format
    if (!GMAIL_REGISTRATION_REGEX.test(email)) {
      throw new Error(`Generated synthetic email '${email}' does not match Gmail regex.`);
    }

    return email;
  };

  /**
   * Strictly validates that an email belongs to this active test run.
   * Enforces full canonical Gmail regex validation before verifying the run namespace prefix (FINDING-04).
   */
  const isOwnedEmail = (email: string): boolean => {
    if (!email || typeof email !== "string") return false;
    const normalized = email.trim().toLowerCase();

    // 1. Full email address must strictly conform to canonical Gmail format
    if (!GMAIL_REGISTRATION_REGEX.test(normalized)) {
      return false;
    }

    // 2. Local-part must strictly begin with test run email prefix followed by a dot
    return normalized.startsWith(`${emailPrefix}.`);
  };

  return {
    runId,
    cleanRunId,
    emailPrefix,
    createEmail,
    isOwnedEmail,
  };
}

export interface CleanupOwnershipValidationCriteria {
  email?: string;
  emailPrefix?: string;
  emails?: string[];
}

const SUPPORTED_CRITERIA_KEYS = new Set(["email", "emailPrefix", "emails"]);

/**
 * Strict safety check for test data cleanup routines (FINDING-02).
 * Ensures that cleanup queries can ONLY affect records created by the specified test run.
 * 
 * Rejection Rules:
 * 1. Criteria must be a non-null, non-array object.
 * 2. Criteria must not be empty or contain unsupported/unrecognized keys.
 * 3. Empty strings, whitespace-only strings, null, undefined, or empty arrays are rejected.
 * 4. Unrestricted wildcards (e.g. '', '%', '@gmail.com') are rejected.
 * 5. Every targeted email or prefix must explicitly match the active runId namespace.
 */
export function assertCleanupOwnership(
  activeRun: TestRunIdentity,
  criteria: CleanupOwnershipValidationCriteria
): void {
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) {
    throw new Error(
      "SAFETY VIOLATION: Empty cleanup criteria rejected. Unrestricted database deletions are forbidden."
    );
  }

  const providedKeys = Object.keys(criteria);
  if (providedKeys.length === 0) {
    throw new Error(
      "SAFETY VIOLATION: Empty cleanup criteria rejected. Unrestricted database deletions are forbidden."
    );
  }

  // Reject unsupported / unrecognized keys
  for (const key of providedKeys) {
    if (!SUPPORTED_CRITERIA_KEYS.has(key)) {
      throw new Error(
        `SAFETY VIOLATION: Unrecognized cleanup criterion '${key}' is forbidden.`
      );
    }
  }

  let validatedCriteriaCount = 0;

  // 1. Validate email if present
  if ("email" in criteria) {
    const emailVal = criteria.email;
    if (typeof emailVal !== "string" || !emailVal.trim()) {
      throw new Error(
        "SAFETY VIOLATION: Cleanup email must be a non-empty string."
      );
    }
    if (!activeRun.isOwnedEmail(emailVal)) {
      throw new Error(
        `SAFETY VIOLATION: Cleanup email '${emailVal}' does not belong to active test run '${activeRun.runId}'.`
      );
    }
    validatedCriteriaCount++;
  }

  // 2. Validate emailPrefix if present
  if ("emailPrefix" in criteria) {
    const prefixVal = criteria.emailPrefix;
    if (typeof prefixVal !== "string" || !prefixVal.trim()) {
      throw new Error(
        "SAFETY VIOLATION: Cleanup prefix must be a non-empty string."
      );
    }
    const normalizedPrefix = prefixVal.trim().toLowerCase();
    const expectedPrefixWithDot = `${activeRun.emailPrefix}.`;
    if (
      normalizedPrefix !== activeRun.emailPrefix &&
      !normalizedPrefix.startsWith(expectedPrefixWithDot)
    ) {
      throw new Error(
        `SAFETY VIOLATION: Cleanup prefix '${prefixVal}' does not match active test run prefix '${expectedPrefixWithDot}'.`
      );
    }
    validatedCriteriaCount++;
  }

  // 3. Validate emails if present
  if ("emails" in criteria) {
    const emailsVal = criteria.emails;
    if (!Array.isArray(emailsVal) || emailsVal.length === 0) {
      throw new Error(
        "SAFETY VIOLATION: Empty emails array provided for cleanup."
      );
    }
    for (const email of emailsVal) {
      if (typeof email !== "string" || !email.trim()) {
        throw new Error(
          "SAFETY VIOLATION: Cleanup emails array contains an empty or invalid email."
        );
      }
      if (!activeRun.isOwnedEmail(email)) {
        throw new Error(
          `SAFETY VIOLATION: Cleanup email '${email}' does not belong to active test run '${activeRun.runId}'.`
        );
      }
    }
    validatedCriteriaCount++;
  }

  if (validatedCriteriaCount === 0) {
    throw new Error(
      "SAFETY VIOLATION: At least one recognized cleanup criterion (email, emailPrefix, emails) must be provided."
    );
  }
}

