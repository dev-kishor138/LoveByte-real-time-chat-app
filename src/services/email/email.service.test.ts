import { describe, it, expect, beforeEach, vi } from "vitest";
import { EmailService } from "./email.service";
import nodemailer from "nodemailer";

describe("EmailService Unit Tests", () => {
  let emailService: EmailService;

  beforeEach(() => {
    vi.clearAllMocks();
    emailService = new EmailService();
    emailService.clearSentEmailsForTesting();
  });

  describe("Mock Delivery in Test Mode", () => {
    it("records sent verification emails in test memory without network calls", async () => {
      const recipient = "test.user@gmail.com";
      const otp = "123456";

      await emailService.sendVerificationEmail(recipient, otp);

      expect(emailService.sentEmailsForTesting).toHaveLength(1);
      const record = emailService.sentEmailsForTesting[0];
      expect(record.to).toBe(recipient);
      expect(record.otp).toBe(otp);
      expect(record.type).toBe("verification");
      expect(record.subject).toContain("123456");
      expect(record.timestamp).toBeInstanceOf(Date);
    });

    it("records sent password reset emails in test memory without network calls", async () => {
      const recipient = "reset.user@gmail.com";
      const otp = "654321";

      await emailService.sendPasswordResetEmail(recipient, otp);

      expect(emailService.sentEmailsForTesting).toHaveLength(1);
      const record = emailService.sentEmailsForTesting[0];
      expect(record.to).toBe(recipient);
      expect(record.otp).toBe(otp);
      expect(record.type).toBe("reset");
      expect(record.subject).toContain("654321");
      expect(record.timestamp).toBeInstanceOf(Date);
    });

    it("clears sent email test records correctly", async () => {
      await emailService.sendVerificationEmail("test@example.com", "111222");
      expect(emailService.sentEmailsForTesting).toHaveLength(1);

      emailService.clearSentEmailsForTesting();
      expect(emailService.sentEmailsForTesting).toHaveLength(0);
    });
  });

  describe("Email Address Masking", () => {
    it("masks multi-character usernames safely for logs", () => {
      const maskMethod = (emailService as any).maskEmail.bind(emailService);
      expect(maskMethod("charlie@gmail.com")).toBe("c***e@gmail.com");
      expect(maskMethod("me@domain.com")).toBe("***@domain.com");
      expect(maskMethod("invalid-email")).toBe("***");
    });
  });

  describe("From Address Resolution for Gmail SMTP", () => {
    it("returns configured EMAIL_FROM when custom address is set", () => {
      const from = emailService.getFromAddress();
      expect(typeof from).toBe("string");
      expect(from.length).toBeGreaterThan(0);
    });
  });

  describe("Nodemailer Transporter App Password Sanitization", () => {
    it("sanitizes spaces from Google App Passwords when initializing transporter", () => {
      const createTransportSpy = vi.spyOn(nodemailer, "createTransport");

      try {
        new EmailService({
          provider: "smtp",
          user: "test@gmail.com",
          pass: "abcd efgh ijkl mnop", // Google 4x4 format with spaces
        });

        // Check if createTransport was called with sanitized password without spaces
        expect(createTransportSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            host: "smtp.gmail.com",
            port: 587,
            secure: false,
            requireTLS: true,
            auth: {
              user: "test@gmail.com",
              pass: "abcdefghijklmnop",
            },
          })
        );
      } finally {
        createTransportSpy.mockRestore();
      }
    });
  });
});
