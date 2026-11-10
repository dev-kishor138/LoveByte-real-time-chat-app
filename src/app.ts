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

// Explicitly warn in production if wildcard or empty configuration results in fail-closed CORS
if (env.NODE_ENV === "production" && allowedCorsOrigins.length === 0) {
  logger.warn(
    "CORS: No web origins configured for production (CORS_ORIGIN is empty or '*'). " +
    "Requests with an Origin header will be rejected. Native mobile clients without an Origin header remain permitted."
  );
}

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

// Health check configuration constants
export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 5000;
export const HEALTH_CHECK_CACHE_TTL_MS = 2000;
export const HEALTH_CHECK_ERROR_CACHE_TTL_MS = 1000;

export let healthCheckTimeoutMs = DEFAULT_HEALTH_CHECK_TIMEOUT_MS;

export function setHealthCheckTimeoutForTesting(ms: number): void {
  healthCheckTimeoutMs = ms;
}

export function resetHealthCheckTimeoutForTesting(): void {
  healthCheckTimeoutMs = DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
}

interface HealthCheckResult {
  status: number;
  body: {
    status: string;
    database?: string;
    timestamp: string;
    error?: string;
  };
}

// In-flight query promise to coalesce concurrent health checks (single-flight pattern)
let activeHealthCheckPromise: Promise<HealthCheckResult> | null = null;
let lastHealthCheckTime = 0;
let lastHealthCheckStatus = 200;
let lastHealthCheckBody: HealthCheckResult["body"] = {
  status: "ok",
  database: "connected",
  timestamp: new Date().toISOString(),
};

export function resetHealthCheckCache(): void {
  lastHealthCheckTime = 0;
  lastHealthCheckStatus = 200;
  activeHealthCheckPromise = null;
  healthCheckTimeoutMs = DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
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
  const ttl =
    lastHealthCheckStatus === 200
      ? HEALTH_CHECK_CACHE_TTL_MS
      : HEALTH_CHECK_ERROR_CACHE_TTL_MS;

  if (now - lastHealthCheckTime < ttl) {
    return res.status(lastHealthCheckStatus).json(lastHealthCheckBody);
  }

  if (activeHealthCheckPromise) {
    const inFlightResult = await activeHealthCheckPromise;
    return res.status(inFlightResult.status).json(inFlightResult.body);
  }

  activeHealthCheckPromise = (async (): Promise<HealthCheckResult> => {
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error("Health check query timeout")),
          healthCheckTimeoutMs
        );
        timeoutHandle.unref();
      });

      const queryPromise = prisma.$queryRaw`SELECT 1`;
      // Safeguard: absorb late rejection if query outlives timeoutPromise
      queryPromise.catch(() => {});

      try {
        await Promise.race([queryPromise, timeoutPromise]);
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }

      const completedTime = Date.now();
      const body = {
        status: "ok",
        database: "connected",
        timestamp: new Date(completedTime).toISOString(),
      };
      lastHealthCheckTime = completedTime;
      lastHealthCheckStatus = 200;
      lastHealthCheckBody = body;
      return { status: 200, body };
    } catch (err: any) {
      const completedTime = Date.now();
      const body = {
        status: "unhealthy",
        error: "Database unavailable",
        timestamp: new Date(completedTime).toISOString(),
      };
      lastHealthCheckTime = completedTime;
      lastHealthCheckStatus = 503;
      lastHealthCheckBody = body;
      logger.warn("Health check failed", { error: err?.message });
      return { status: 503, body };
    } finally {
      activeHealthCheckPromise = null;
    }
  })();

  const result = await activeHealthCheckPromise;
  return res.status(result.status).json(result.body);
});

// Authentication module routes
app.use("/api/auth", authRoutes);

// Chat module routes
app.use("/api/chat", chatRoutes);

// User module routes
app.use("/api/users", userRoutes);

// Global Error Handler
app.use(errorHandler);
