import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { logger } from "../utils/logger";
import { isCanonicalUuid } from "../utils/uuid";

export interface AuthenticatedUser {
  userId: string;
  email: string;
  sessionId: string;
}

// Extend Express Request type to include authenticated user
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * Middleware to authenticate requests using JWT and mandatory active Session verification (SEC-01).
 * 1. Cryptographically verifies JWT signature and expiration.
 * 2. Pre-database validation: verifies userId and sessionId are exact canonical 8-4-4-4-12 hex UUIDs,
 *    and email is a non-empty string.
 * 3. Mandatory active Session verification in Neon PostgreSQL: confirms session exists, belongs
 *    to token user, is not revoked, and has not expired.
 */
export async function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers["authorization"];
  const token =
    authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;

  if (!token) {
    res.status(401).json({ error: "Access token required" });
    return;
  }

  let decoded: Record<string, unknown>;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET) as Record<string, unknown>;
  } catch (error) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  // Pre-database claim presence & format validation (SEC-01)
  if (
    typeof decoded.userId !== "string" ||
    typeof decoded.email !== "string" ||
    typeof decoded.sessionId !== "string" ||
    !decoded.email.trim() ||
    !isCanonicalUuid(decoded.userId) ||
    !isCanonicalUuid(decoded.sessionId)
  ) {
    res.status(401).json({ error: "Invalid token payload" });
    return;
  }

  const userId = decoded.userId;
  const email = decoded.email;
  const sessionId = decoded.sessionId;

  // Mandatory database session verification
  try {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        userId: true,
        isRevoked: true,
        expiresAt: true,
      },
    });

    if (!session) {
      res.status(401).json({ error: "Session not found" });
      return;
    }

    if (session.userId !== userId) {
      logger.warn("Access token user mismatch with database session", {
        tokenUserId: userId,
        sessionUserId: session.userId,
        sessionId: sessionId,
      });
      res.status(401).json({ error: "Session does not belong to user" });
      return;
    }

    if (session.isRevoked) {
      res.status(401).json({ error: "Session has been revoked" });
      return;
    }

    if (session.expiresAt <= new Date()) {
      res.status(401).json({ error: "Session has expired" });
      return;
    }
  } catch (error) {
    logger.error("Failed to verify session in authenticateToken", {
      sessionId: sessionId,
    });
    res.status(500).json({ error: "Authentication verification failed" });
    return;
  }

  req.user = {
    userId,
    email,
    sessionId,
  };

  next();
}
