import dotenv from "dotenv";
import { z } from "zod";
import { DEFAULT_PRODUCTION_ORIGINS } from "./cors";

// Load environment variables from .env
dotenv.config();

const envSchema = z
  .object({
    PORT: z.coerce.number().default(5000),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters long"),
    JWT_EXPIRES_IN: z.string().default("15m"),
    REFRESH_TOKEN_EXPIRES_DAYS: z.coerce.number().default(30),
    CORS_ORIGIN: z.string().default(
      process.env.NODE_ENV === "production" ? DEFAULT_PRODUCTION_ORIGINS[0] : "*"
    ),
    // Email and OTP configuration
    EMAIL_PROVIDER: z.enum(["smtp", "resend", "mock"]).default("mock"),
    EMAIL_FROM: z.string().default("LoveByte <no-reply@lovebyte.app>"),
    RESEND_API_KEY: z.string().optional(),
    SMTP_HOST: z.string().default("smtp.gmail.com"),
    SMTP_PORT: z.coerce.number().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_SECURE: z
      .union([z.boolean(), z.string()])
      .optional()
      .transform((val) => val === true || val === "true" || val === "1")
      .default(false),
    OTP_EXPIRES_MINUTES: z.coerce.number().default(15),
    OTP_MAX_ATTEMPTS: z.coerce.number().default(5),
    OTP_COOLDOWN_SECONDS: z.coerce.number().default(60),
    OTP_PEPPER: z
      .string()
      .min(32, "OTP_PEPPER must be at least 32 characters long")
      .default(
        process.env.NODE_ENV === "production"
          ? (undefined as any)
          : "test-and-dev-otp-pepper-32-characters-min-secret!"
      ),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === "production") {
      if (
        !process.env.OTP_PEPPER ||
        process.env.OTP_PEPPER === "test-and-dev-otp-pepper-32-characters-min-secret!" ||
        data.OTP_PEPPER.length < 32
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "OTP_PEPPER must be explicitly configured in production and at least 32 characters long with high entropy (no fallback allowed)",
          path: ["OTP_PEPPER"],
        });
      }
    }

    if (data.NODE_ENV === "production" && data.JWT_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "JWT_SECRET must be at least 32 characters long in production (OWASP 256-bit entropy)",
        path: ["JWT_SECRET"],
      });
    }

    if (data.NODE_ENV === "production" && data.CORS_ORIGIN === "*") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "CORS_ORIGIN cannot be '*' in production (wildcard origin disallowed). Specify explicit comma-separated origins (e.g. 'https://lovebyte-real-time-chat-app.onrender.com')",
        path: ["CORS_ORIGIN"],
      });
    }

    if (data.NODE_ENV === "production" && data.EMAIL_PROVIDER === "smtp") {
      if (!data.SMTP_USER || !data.SMTP_USER.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "SMTP_USER must be configured in production when EMAIL_PROVIDER=smtp (e.g. your Gmail address)",
          path: ["SMTP_USER"],
        });
      }
      if (!data.SMTP_PASS || !data.SMTP_PASS.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "SMTP_PASS must be configured in production when EMAIL_PROVIDER=smtp (16-character Google App Password)",
          path: ["SMTP_PASS"],
        });
      }
    }

    if (data.NODE_ENV === "production" && data.EMAIL_PROVIDER === "resend") {
      if (!data.RESEND_API_KEY || !data.RESEND_API_KEY.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "RESEND_API_KEY must be configured in production when EMAIL_PROVIDER=resend",
          path: ["RESEND_API_KEY"],
        });
      }
    }
  });

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables:", parsedEnv.error.format());
  process.exit(1);
}

export const env = parsedEnv.data;

