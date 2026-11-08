import http from "http";
import { app } from "./app";
import { env } from "./config/env";
import { initSocketIO, closeSocketIO } from "./sockets";
import { prisma } from "./config/prisma";
import { logger } from "./utils/logger";
import {
  isShutdownInProgress,
  setShutdownInProgress,
  resetShutdownState as resetSharedShutdownState,
} from "./utils/shutdown";

export { isShutdownInProgress } from "./utils/shutdown";

export const server = http.createServer(app);

// Initialize WebSockets
initSocketIO(server);

export interface ShutdownOptions {
  timeoutMs?: number;
  server?: http.Server;
  closeSockets?: () => Promise<void>;
  disconnectPrisma?: () => Promise<void>;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

let shutdownPromise: Promise<void> | null = null;

/**
 * Resets the shutdown state. Exposed for test isolation between test cases.
 */
export function resetShutdownState(): void {
  resetSharedShutdownState();
  shutdownPromise = null;
}

/**
 * Gracefully shuts down the HTTP server, Socket.IO server, and database connections.
 * Ensures in-flight operations have time to finish, disconnects clients cleanly,
 * and enforces a 10-second timeout guard to prevent hanging.
 */
export function gracefulShutdown(options?: ShutdownOptions): Promise<void> {
  if (isShutdownInProgress() && shutdownPromise) {
    logger.warn("Shutdown already in progress; returning active shutdown sequence");
    return shutdownPromise;
  }

  setShutdownInProgress(true);

  const timeoutMs = options?.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const targetServer = options?.server ?? server;
  const doCloseSockets = options?.closeSockets ?? closeSocketIO;
  const doDisconnectPrisma = options?.disconnectPrisma ?? (() => prisma.$disconnect());

  shutdownPromise = (async () => {
    let timeoutTimer: NodeJS.Timeout | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(new Error(`Graceful shutdown timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timeoutTimer.unref === "function") {
        timeoutTimer.unref();
      }
    });

    const executionPromise = (async () => {
      logger.info("Initiating graceful shutdown sequence...");

      // 1. Close Socket.IO cleanly and disconnect active client connections
      try {
        logger.info("Closing Socket.IO server and active client connections...");
        await doCloseSockets();
        logger.info("Socket.IO server closed cleanly");
      } catch (err) {
        logger.error("Error occurred while closing Socket.IO", { error: err });
      }

      // 2. Stop accepting new HTTP connections and close HTTP server
      try {
        if (targetServer && targetServer.listening) {
          logger.info("Closing HTTP server...");
          // Close idle keep-alive connections if supported by Node runtime
          if (typeof targetServer.closeIdleConnections === "function") {
            targetServer.closeIdleConnections();
          }

          await new Promise<void>((resolve, reject) => {
            targetServer.close((err) => {
              if (err && (err as any).code !== "ERR_SERVER_NOT_RUNNING") {
                reject(err);
              } else {
                resolve();
              }
            });
          });
          logger.info("HTTP server closed successfully");
        } else {
          logger.info("HTTP server was not listening; skipping server.close()");
        }
      } catch (err) {
        logger.error("Error occurred while closing HTTP server", { error: err });
      }

      // 3. Disconnect Prisma database client
      try {
        logger.info("Disconnecting Prisma database client...");
        await doDisconnectPrisma();
        logger.info("Prisma database client disconnected successfully");
      } catch (err) {
        logger.error("Error occurred while disconnecting Prisma Client", { error: err });
      }

      logger.info("Graceful shutdown completed successfully");
    })();

    try {
      await Promise.race([executionPromise, timeoutPromise]);
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    }
  })();

  return shutdownPromise;
}

/**
 * Registers process signal handlers (SIGTERM, SIGINT) for graceful shutdown.
 * Executed only in the main entry point to avoid polluting test environments.
 */
export function registerSignalHandlers(): void {
  const handleSignal = async (signal: string) => {
    logger.info(`Received ${signal} signal; initiating graceful shutdown`);
    try {
      await gracefulShutdown();
      process.exit(0);
    } catch (err) {
      logger.error(`Error during ${signal} graceful shutdown`, { error: err });
      process.exit(1);
    }
  };

  process.once("SIGTERM", () => {
    handleSignal("SIGTERM");
  });

  process.once("SIGINT", () => {
    handleSignal("SIGINT");
  });
}

// Start listening and register process signal handlers only when executed directly (not in unit test runner)
if (process.env.NODE_ENV !== "test") {
  server.listen(env.PORT, () => {
    logger.info(`Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);
  });

  registerSignalHandlers();
}

