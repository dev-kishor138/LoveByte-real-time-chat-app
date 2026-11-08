import { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { logger } from "../utils/logger";

export interface AppError extends Error {
  statusCode?: number;
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

  res.status(statusCode).json({
    error: statusCode === 500 && isProd ? "Internal Server Error" : err.message,
    ...(isProd ? {} : { stack: err.stack }),
  });
}

