import nodemailer, { Transporter } from "nodemailer";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";

export interface SentEmailRecord {
  to: string;
  subject: string;
  otp: string;
  type: "verification" | "reset";
  timestamp: Date;
}

export class EmailService {
  private transporter: Transporter | null = null;
  public sentEmailsForTesting: SentEmailRecord[] = [];

  constructor() {
    if (env.EMAIL_PROVIDER === "smtp" && env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) {
      this.transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: {
          user: env.SMTP_USER,
          pass: env.SMTP_PASS,
        },
      });
    }
  }

  public clearSentEmailsForTesting(): void {
    this.sentEmailsForTesting = [];
  }

  private maskEmail(email: string): string {
    const parts = email.split("@");
    if (parts.length !== 2) return "***";
    const name = parts[0];
    const maskedName = name.length > 2 ? `${name.charAt(0)}***${name.charAt(name.length - 1)}` : "***";
    return `${maskedName}@${parts[1]}`;
  }

  /**
   * Dispatches a 6-digit email verification OTP to the user.
   */
  async sendVerificationEmail(to: string, otp: string): Promise<void> {
    const subject = `LoveByte — Your Verification Code: ${otp}`;
    const text = `Welcome to LoveByte!\n\nYour 6-digit verification code is: ${otp}\n\nThis code will expire in ${env.OTP_EXPIRES_MINUTES} minutes.\nDo not share this code with anyone.`;
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #EAE7F4; border-radius: 12px; background-color: #FFFFFF;">
        <h2 style="color: #7549D6; margin-top: 0;">LoveByte</h2>
        <p style="color: #111116; font-size: 16px;">Welcome! Verify your email to enter your private space.</p>
        <div style="margin: 24px 0; padding: 16px; background-color: #F8F7FC; border-radius: 8px; text-align: center;">
          <span style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #7549D6;">${otp}</span>
        </div>
        <p style="color: #555364; font-size: 14px;">This code will expire in <strong>${env.OTP_EXPIRES_MINUTES} minutes</strong>. If you did not request this, please ignore this email.</p>
      </div>
    `;

    await this.deliverEmail(to, subject, text, html, "verification", otp);
  }

  /**
   * Dispatches a 6-digit password reset OTP to the user.
   */
  async sendPasswordResetEmail(to: string, otp: string): Promise<void> {
    const subject = `LoveByte — Password Reset Code: ${otp}`;
    const text = `You requested a password reset for LoveByte.\n\nYour 6-digit reset code is: ${otp}\n\nThis code will expire in ${env.OTP_EXPIRES_MINUTES} minutes.\nAfter resetting, all active login sessions will be securely signed out.`;
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #EAE7F4; border-radius: 12px; background-color: #FFFFFF;">
        <h2 style="color: #7549D6; margin-top: 0;">LoveByte</h2>
        <p style="color: #111116; font-size: 16px;">Password Reset Request</p>
        <div style="margin: 24px 0; padding: 16px; background-color: #F8F7FC; border-radius: 8px; text-align: center;">
          <span style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #7549D6;">${otp}</span>
        </div>
        <p style="color: #555364; font-size: 14px;">This code will expire in <strong>${env.OTP_EXPIRES_MINUTES} minutes</strong>. Once reset, all active login sessions will be invalidated for security.</p>
      </div>
    `;

    await this.deliverEmail(to, subject, text, html, "reset", otp);
  }

  private async deliverEmail(
    to: string,
    subject: string,
    text: string,
    html: string,
    type: "verification" | "reset",
    otp: string
  ): Promise<void> {
    const masked = this.maskEmail(to);

    // In test or development mock mode:
    if (env.NODE_ENV === "test" || env.EMAIL_PROVIDER === "mock" || (!this.transporter && !env.RESEND_API_KEY)) {
      this.sentEmailsForTesting.push({
        to,
        subject,
        otp,
        type,
        timestamp: new Date(),
      });

      logger.info(`[EMAIL SERVICE] Dispatched ${type} OTP to ${masked}`);
      return;
    }

    // Resend Provider (via Resend REST API)
    if (env.EMAIL_PROVIDER === "resend" || Boolean(env.RESEND_API_KEY)) {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: env.EMAIL_FROM,
            to: [to],
            subject,
            text,
            html,
          }),
        });

        if (!response.ok) {
          logger.error("Resend API failed to dispatch email", {
            status: response.status,
            recipient: masked,
          });
          throw new Error("Failed to dispatch email via Resend");
        }
        logger.info("Email delivered via Resend", { recipient: masked, type });
        return;
      } catch (err: any) {
        logger.error("Error sending email via Resend", {
          errorName: err?.name,
          recipient: masked,
        });
        throw new Error("Email delivery failed via Resend");
      }
    }

    // SMTP Provider (via nodemailer)
    if (this.transporter) {
      try {
        await this.transporter.sendMail({
          from: env.EMAIL_FROM,
          to,
          subject,
          text,
          html,
        });
        logger.info("Email delivered via SMTP", { recipient: masked, type });
      } catch (err: any) {
        logger.error("Error sending email via SMTP", {
          code: err?.code,
          recipient: masked,
        });
        throw new Error("Email delivery failed via SMTP");
      }
    }
  }
}

export const emailService = new EmailService();
