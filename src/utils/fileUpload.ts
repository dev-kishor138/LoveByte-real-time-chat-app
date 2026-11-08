import fs from "fs";
import path from "path";
import crypto from "crypto";

export const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

export const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB max

export interface AllowedFileType {
  mime: string;
  ext: string;
  category: "IMAGE" | "VOICE";
  checkMagicBytes: (buffer: Buffer) => boolean;
}

/**
 * Supported MIME types with corresponding magic byte / file signature validators.
 */
export const ALLOWED_FILE_TYPES: Record<string, AllowedFileType> = {
  // Images
  "image/jpeg": {
    mime: "image/jpeg",
    ext: ".jpg",
    category: "IMAGE",
    checkMagicBytes: (buf: Buffer) =>
      buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  },
  "image/png": {
    mime: "image/png",
    ext: ".png",
    category: "IMAGE",
    checkMagicBytes: (buf: Buffer) =>
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a,
  },
  "image/gif": {
    mime: "image/gif",
    ext: ".gif",
    category: "IMAGE",
    checkMagicBytes: (buf: Buffer) =>
      buf.length >= 4 &&
      buf[0] === 0x47 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x38,
  },
  "image/webp": {
    mime: "image/webp",
    ext: ".webp",
    category: "IMAGE",
    checkMagicBytes: (buf: Buffer) =>
      buf.length >= 12 &&
      buf.toString("ascii", 0, 4) === "RIFF" &&
      buf.toString("ascii", 8, 12) === "WEBP",
  },
  // Audio / Voice
  "audio/mpeg": {
    mime: "audio/mpeg",
    ext: ".mp3",
    category: "VOICE",
    checkMagicBytes: (buf: Buffer) => {
      if (buf.length < 3) return false;
      // ID3 tag header: "ID3"
      if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
      // MPEG sync frame header (0xFF followed by 0xFB, 0xF3, or 0xF2)
      return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
    },
  },
  "audio/ogg": {
    mime: "audio/ogg",
    ext: ".ogg",
    category: "VOICE",
    checkMagicBytes: (buf: Buffer) =>
      buf.length >= 4 && buf.toString("ascii", 0, 4) === "OggS",
  },
  "audio/wav": {
    mime: "audio/wav",
    ext: ".wav",
    category: "VOICE",
    checkMagicBytes: (buf: Buffer) =>
      buf.length >= 12 &&
      buf.toString("ascii", 0, 4) === "RIFF" &&
      buf.toString("ascii", 8, 12) === "WAVE",
  },
  "audio/m4a": {
    mime: "audio/m4a",
    ext: ".m4a",
    category: "VOICE",
    checkMagicBytes: (buf: Buffer) =>
      buf.length >= 8 && buf.toString("ascii", 4, 8) === "ftyp",
  },
};

/**
 * Validates file buffer against allowed MIME types and magic bytes.
 * Throws an Error if invalid.
 */
export function validateFileMagicBytes(mimeType: string, buffer: Buffer): AllowedFileType {
  const allowed = ALLOWED_FILE_TYPES[mimeType.toLowerCase()];
  if (!allowed) {
    throw new Error(`Unsupported MIME type: ${mimeType}`);
  }

  if (!allowed.checkMagicBytes(buffer)) {
    throw new Error("File content signature (magic bytes) does not match reported MIME type");
  }

  return allowed;
}

/**
 * Generates a collision-resistant, randomized filename and safe absolute destination.
 * Defends strictly against path traversal attacks.
 */
export function getSafeFilePath(ext: string): { filename: string; absolutePath: string } {
  const sanitizedExt = ext.startsWith(".") ? ext : `.${ext}`;
  const filename = `${crypto.randomUUID()}${sanitizedExt}`;
  const absolutePath = path.resolve(UPLOAD_DIR, filename);

  // Guarantee that the resolved path is strictly inside the target upload directory
  if (!absolutePath.startsWith(UPLOAD_DIR)) {
    throw new Error("Path traversal detected");
  }

  return { filename, absolutePath };
}

