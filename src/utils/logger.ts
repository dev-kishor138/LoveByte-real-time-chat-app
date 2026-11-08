type LogLevel = "info" | "warn" | "error" | "debug";

const SENSITIVE_KEYS = new Set([
  "password",
  "token",
  "refreshtoken",
  "accesstoken",
  "authorization",
  "secret",
  "content",
  "message",
]);

/**
 * Recursively redacts sensitive keys to avoid leaking passwords, tokens, or message content.
 */
function sanitize(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === "string" || typeof data === "number" || typeof data === "boolean") {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitize(item));
  }

  if (typeof data === "object") {
    const sanitizedObj: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        sanitizedObj[key] = "[REDACTED]";
      } else {
        sanitizedObj[key] = sanitize(value);
      }
    }
    return sanitizedObj;
  }

  return "[UNSERIALIZABLE]";
}

function logMessage(level: LogLevel, message: string, meta?: unknown) {
  const timestamp = new Date().toISOString();
  const safeMeta = meta !== undefined ? sanitize(meta) : "";

  if (level === "error") {
    // eslint-disable-next-line no-console
    console.error(`[${timestamp}] [ERROR] ${message}`, safeMeta ? JSON.stringify(safeMeta) : "");
  } else if (level === "warn") {
    // eslint-disable-next-line no-console
    console.warn(`[${timestamp}] [WARN] ${message}`, safeMeta ? JSON.stringify(safeMeta) : "");
  } else {
    // eslint-disable-next-line no-console
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`, safeMeta ? JSON.stringify(safeMeta) : "");
  }
}

export const logger = {
  info: (msg: string, meta?: unknown) => logMessage("info", msg, meta),
  warn: (msg: string, meta?: unknown) => logMessage("warn", msg, meta),
  error: (msg: string, meta?: unknown) => logMessage("error", msg, meta),
  debug: (msg: string, meta?: unknown) => logMessage("debug", msg, meta),
};

