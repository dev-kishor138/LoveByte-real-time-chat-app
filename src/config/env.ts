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
  })
  .superRefine((data, ctx) => {
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
  });

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables:", parsedEnv.error.format());
  process.exit(1);
}

export const env = parsedEnv.data;

