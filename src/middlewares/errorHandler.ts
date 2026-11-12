import { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { logger } from "../utils/logger";

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
  email?: string;
  retryAfter?: number;
  details?: unknown;
}

/**
 * Global error handling middleware.
 * Ensures no stack traces leak in production.
 */
export function errorHandler(
  err: AppError,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  const statusCode = err.statusCode || 500;
  const isProd = env.NODE_ENV === "production";

  logger.error("Unhandled error encountered", {
    message: err.message,
    statusCode,
  });

  const responseBody: Record<string, unknown> = {
    error: statusCode === 500 && isProd ? "Internal Server Error" : err.message,
  };

  if (err.code) responseBody.code = err.code;
  if (err.email) responseBody.email = err.email;
  if (err.retryAfter !== undefined) responseBody.retryAfter = err.retryAfter;
  if (!isProd && err.stack) responseBody.stack = err.stack;

  res.status(statusCode).json(responseBody);
}

