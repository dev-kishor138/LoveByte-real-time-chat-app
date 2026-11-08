import http from "http";
import { AddressInfo } from "net";
import { app } from "../app";
import { initSocketIO, closeSocketIO, getIO } from "../sockets";
import { Server as SocketIOServer } from "socket.io";
import { logger } from "../utils/logger";

export interface RunningTestServer {
  server: http.Server;
  io: SocketIOServer;
  port: number;
  baseUrl: string;
  wsUrl: string;
  close: () => Promise<void>;
}

let activeTestServer: RunningTestServer | null = null;

/**
 * Starts an isolated HTTP server and Socket.IO real-time engine on an ephemeral port (0).
 * Binds strictly to 127.0.0.1 (loopback) to prevent exposing test ports on public networks.
 * Reusable across integration test suites with clean teardown.
 */
export async function startTestServer(): Promise<RunningTestServer> {
  if (activeTestServer && activeTestServer.server.listening) {
    return activeTestServer;
  }

  // Ensure any dangling socket or server instance is closed first
  try {
    await closeSocketIO();
  } catch {
    // Ignore if not initialized
  }

  const server = http.createServer(app);
  let io: SocketIOServer | null = null;

  try {
    // Initialize Socket.IO with the ephemeral server
    io = initSocketIO(server);

    // Start listening on dynamic OS-assigned port
    await new Promise<void>((resolve, reject) => {
      const errorHandler = (err: Error) => {
        server.removeListener("listening", listeningHandler);
        reject(err);
      };

      const listeningHandler = () => {
        server.removeListener("error", errorHandler);
        resolve();
      };

      server.once("error", errorHandler);
      server.listen(0, "127.0.0.1", listeningHandler);
    });
  } catch (initError) {
    // FINDING-03: Reliable cleanup on initialization failure
    if (io) {
      try {
        await closeSocketIO();
      } catch (err) {
        logger.warn("Error closing Socket.IO after test server startup failure", { error: err });
      }
    }

    try {
      if (server.listening) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      } else {
        server.close();
      }
    } catch (serverErr) {
      logger.warn("Error closing HTTP server after test server startup failure", { error: serverErr });
    }

    // Preserve and re-throw the original initialization failure
    throw initError;
  }

  const address = server.address() as AddressInfo;
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}`;

  logger.info(`Test HTTP/Socket.IO server listening on ephemeral port ${port}`);

  const close = async (): Promise<void> => {
    await stopTestServer();
  };

  activeTestServer = {
    server,
    io,
    port,
    baseUrl,
    wsUrl,
    close,
  };

  return activeTestServer;
}

/**
 * Cleanly closes the active test server, terminates active socket connections,
 * drains idle keep-alive connections, and resets singleton references.
 */
export async function stopTestServer(): Promise<void> {
  const current = activeTestServer;
  activeTestServer = null;

  // 1. Close Socket.IO cleanly
  try {
    await closeSocketIO();
  } catch (err) {
    logger.warn("Error closing Socket.IO in stopTestServer", { error: err });
  }

  // 2. Close HTTP Server if still listening
  const serverToClose = current?.server;
  if (serverToClose && serverToClose.listening) {
    if (typeof serverToClose.closeIdleConnections === "function") {
      serverToClose.closeIdleConnections();
    }

    await new Promise<void>((resolve) => {
      serverToClose.close(() => {
        resolve();
      });
    });
  }
}
