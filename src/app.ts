import express from "express";
import helmet from "helmet";
import cors from "cors";
import { env } from "./config/env";
import { parseCorsOrigins, createCorsOriginResolver } from "./config/cors";
import { errorHandler } from "./middlewares/errorHandler";
import { apiRateLimiter } from "./middlewares/rateLimiter";
import { authRoutes } from "./modules/auth/auth.routes";
import { chatRoutes } from "./modules/chat/chat.routes";
import { userRoutes } from "./modules/users/users.routes";
import { prisma } from "./config/prisma";
import { logger } from "./utils/logger";
import { isShutdownInProgress } from "./utils/shutdown";

export const app = express();

// When running in production behind a reverse proxy (e.g. Cloudflare / Nginx / AWS ALB),
// trust the first fronting proxy hop to read client IP safely without blind header trust.
if (env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// Security headers with Helmet
app.use(helmet());

const allowedCorsOrigins = parseCorsOrigins(env.CORS_ORIGIN);
const corsOriginResolver = createCorsOriginResolver(allowedCorsOrigins);

// Strict fail-closed CORS configuration (SEC-02)
app.use(
  cors({
    origin: corsOriginResolver,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Body parsing with safe payload size limit
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// General Rate Limiting
app.use(apiRateLimiter);

// Health check state cache to prevent connection pool exhaustion from unauthenticated spam
let lastHealthCheckTime = 0;
let lastHealthCheckStatus = 200;
let lastHealthCheckBody: { status: string; database?: string; timestamp: string; error?: string } = {
  status: "ok",
  database: "connected",
  timestamp: new Date().toISOString(),
};

export function resetHealthCheckCache(): void {
  lastHealthCheckTime = 0;
  lastHealthCheckStatus = 200;
}

// Enhanced health check endpoint verifying database connectivity
app.get("/health", async (_req, res) => {
  if (isShutdownInProgress()) {
    return res.status(503).json({
      status: "shutting_down",
      timestamp: new Date().toISOString(),
    });
  }

  const now = Date.now();
  if (now - lastHealthCheckTime < 2000) {
    return res.status(lastHealthCheckStatus).json(lastHealthCheckBody);
  }

  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("Health check query timeout")), 2000);
      timeoutHandle.unref();
    });

    try {
      // 2-second timeout guard for database ping
      await Promise.race([
        prisma.$queryRaw`SELECT 1`,
        timeoutPromise,
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }

    lastHealthCheckTime = now;
    lastHealthCheckStatus = 200;
    lastHealthCheckBody = {
      status: "ok",
      database: "connected",
      timestamp: new Date().toISOString(),
    };
    return res.status(200).json(lastHealthCheckBody);
  } catch (err: any) {
    lastHealthCheckTime = now;
    lastHealthCheckStatus = 503;
    lastHealthCheckBody = {
      status: "unhealthy",
      error: "Database unavailable",
      timestamp: new Date().toISOString(),
    };
    logger.warn("Health check failed", { error: err?.message });
    return res.status(503).json(lastHealthCheckBody);
  }
});

// Authentication module routes
app.use("/api/auth", authRoutes);

// Chat module routes
app.use("/api/chat", chatRoutes);

// User module routes
app.use("/api/users", userRoutes);

// Global Error Handler
app.use(errorHandler);
