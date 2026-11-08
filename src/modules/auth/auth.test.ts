import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { app } from "../../app";
import { registerSchema, loginSchema } from "./auth.validation";
import { authService } from "./auth.service";
import { prisma } from "../../config/prisma";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import * as sockets from "../../sockets";

describe("Auth Module - Validation", () => {
  it("should accept valid Gmail address and strong password", () => {
    const validData = {
      email: "testuser@gmail.com",
      password: "StrongPassword123!",
    };
    const result = registerSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it("should reject non-Gmail address", () => {
    const nonGmailData = {
      email: "testuser@yahoo.com",
      password: "StrongPassword123!",
    };
    const result = registerSchema.safeParse(nonGmailData);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain(
        "Registration is restricted to valid @gmail.com addresses"
      );
    }
  });

  it("should reject passwords that lack complexity", () => {
    const weakData = {
      email: "testuser@gmail.com",
      password: "weakpassword",
    };
    const result = registerSchema.safeParse(weakData);
    expect(result.success).toBe(false);
  });

  it("should validate login credentials properly", () => {
    const validLogin = {
      email: "testuser@gmail.com",
      password: "anyPassword",
    };
    expect(loginSchema.safeParse(validLogin).success).toBe(true);

    const invalidLogin = {
      email: "notagmail@outlook.com",
      password: "anyPassword",
    };
    expect(loginSchema.safeParse(invalidLogin).success).toBe(false);
  });
});

describe("Auth Module - Password Hashing (Argon2id)", () => {
  it("should hash passwords using Argon2id with OWASP parameters", async () => {
    const password = "SuperSecretPassword123!";
    const hash = await authService.hashPassword(password);
    expect(hash).not.toBe(password);
    expect(hash.startsWith("$argon2id$")).toBe(true);

    const isMatch = await authService.verifyPassword(password, hash);
    expect(isMatch).toBe(true);

    const isWrong = await authService.verifyPassword("WrongPassword123!", hash);
    expect(isWrong).toBe(false);
  });

  it("should generate valid JWT tokens with configured expiration from env.JWT_EXPIRES_IN (SEC-01)", () => {
    const validUserId = "11111111-1111-4111-8111-111111111111";
    const validSessionId = "22222222-2222-4222-8222-222222222222";
    const token = authService.generateToken(validUserId, "test@gmail.com", validSessionId);
    expect(typeof token).toBe("string");

    const decoded = jwt.verify(token, env.JWT_SECRET) as {
      userId: string;
      email: string;
      sessionId: string;
      iat: number;
      exp: number;
    };
    expect(decoded.userId).toBe(validUserId);
    expect(decoded.email).toBe("test@gmail.com");
    expect(decoded.sessionId).toBe(validSessionId);
    // Verify that token lifetime matches configured env.JWT_EXPIRES_IN
    const expectedSeconds = env.JWT_EXPIRES_IN === "15m" ? 900 : 86400;
    expect(decoded.exp - decoded.iat).toBe(expectedSeconds);
  });

  it("rejects token generation when userId or sessionId is not a canonical UUID (SEC-01)", () => {
    const validUuid = "11111111-1111-4111-8111-111111111111";

    expect(() =>
      authService.generateAccessToken("not-a-uuid", "test@gmail.com", validUuid)
    ).toThrow("Cannot issue access token: userId must be a canonical UUID");

    expect(() =>
      authService.generateAccessToken(validUuid, "test@gmail.com", "not-a-uuid")
    ).toThrow("Cannot issue access token: sessionId must be a canonical UUID");

    expect(() =>
      authService.generateAccessToken(` ${validUuid}`, "test@gmail.com", validUuid)
    ).toThrow("Cannot issue access token: userId must be a canonical UUID");

    expect(() =>
      authService.generateAccessToken(validUuid, "test@gmail.com", `${validUuid} `)
    ).toThrow("Cannot issue access token: sessionId must be a canonical UUID");

    // Legacy method must enforce the same validation
    expect(() =>
      authService.generateToken("not-a-uuid", "test@gmail.com", validUuid)
    ).toThrow("Cannot issue access token: userId must be a canonical UUID");

    expect(() =>
      authService.generateToken(validUuid, "test@gmail.com", "not-a-uuid")
    ).toThrow("Cannot issue access token: sessionId must be a canonical UUID");
  });

  it("should generate access tokens with 15m (900s) expiration when configured to 15m", () => {
    const originalExpiresIn = env.JWT_EXPIRES_IN;
    const validUserId = "11111111-1111-4111-8111-111111111111";
    const validSessionId = "22222222-2222-4222-8222-222222222222";
    try {
      (env as any).JWT_EXPIRES_IN = "15m";
      const token = authService.generateAccessToken(
        validUserId,
        "test@gmail.com",
        validSessionId
      );
      expect(typeof token).toBe("string");

      const decoded = jwt.verify(token, env.JWT_SECRET) as {
        userId: string;
        email: string;
        sessionId: string;
        iat: number;
        exp: number;
      };
      expect(decoded.userId).toBe(validUserId);
      expect(decoded.email).toBe("test@gmail.com");
      expect(decoded.sessionId).toBe(validSessionId);
      // 15 minutes = 900 seconds
      expect(decoded.exp - decoded.iat).toBe(900);
    } finally {
      (env as any).JWT_EXPIRES_IN = originalExpiresIn;
    }
  });
});

describe("Auth Module - User Registration (HTTP)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Successful registration
  it("1. Successful registration returns 201 and safe user data", async () => {
    const mockCreatedUser = {
      id: "uuid-1234-abcd",
      email: "newuser@gmail.com",
      createdAt: new Date(),
    };

    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(null);
    vi.spyOn(prisma.user, "create").mockResolvedValueOnce(mockCreatedUser as any);

    const res = await request(app).post("/api/auth/register").send({
      email: "newuser@gmail.com",
      password: "StrongPassword123!",
    });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("user");
    expect(res.body.user.id).toBe(mockCreatedUser.id);
    expect(res.body.user.email).toBe(mockCreatedUser.email);
    expect(res.body.user).toHaveProperty("createdAt");
  });

  // 2. Invalid Gmail rejection
  it("2. Invalid Gmail rejection returns 400", async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: "user@notgmail.com",
      password: "StrongPassword123!",
    });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "Validation failed");
    expect(res.body.details[0].message).toContain(
      "Registration is restricted to valid @gmail.com addresses"
    );
  });

  // 3. Invalid request body rejection
  it("3. Invalid request body rejection returns 400", async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: 12345,
      password: true,
    });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "Validation failed");
  });

  // 4. Missing required fields rejection
  it("4. Missing required fields returns 400", async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: "valid@gmail.com",
    });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "Validation failed");
  });

  // 5. Password validation failure
  it("5. Password validation failure returns 400", async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: "valid@gmail.com",
      password: "short",
    });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "Validation failed");
    expect(
      res.body.details.some((d: any) =>
        d.message.includes("Password must be at least 8 characters")
      )
    ).toBe(true);
  });

  // 6. Duplicate Gmail rejection
  it("6. Duplicate Gmail rejection returns 409 Conflict", async () => {
    const existingUser = {
      id: "existing-id",
      email: "existing@gmail.com",
      passwordHash: "$argon2id$mockhash",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(existingUser as any);

    const res = await request(app).post("/api/auth/register").send({
      email: "existing@gmail.com",
      password: "StrongPassword123!",
    });

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty(
      "error",
      "An account with this email already exists"
    );
  });

  // 7. Password is hashed before storage
  it("7. Password is hashed before storage with Argon2id", async () => {
    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(null);
    const createSpy = vi.spyOn(prisma.user, "create").mockResolvedValueOnce({
      id: "uuid-test-hash",
      email: "hasheduser@gmail.com",
      createdAt: new Date(),
    } as any);

    const res = await request(app).post("/api/auth/register").send({
      email: "hasheduser@gmail.com",
      password: "StrongPassword123!",
    });

    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalled();
    const createArgs = createSpy.mock.calls[0][0];
    expect(createArgs.data.passwordHash).toBeDefined();
    expect(createArgs.data.passwordHash.startsWith("$argon2id$")).toBe(true);
  });

  // 8. Plaintext password is not stored
  it("8. Plaintext password is not stored", async () => {
    const rawPassword = "StrongPassword123!";
    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(null);
    const createSpy = vi.spyOn(prisma.user, "create").mockResolvedValueOnce({
      id: "uuid-plain-check",
      email: "plaincheck@gmail.com",
      createdAt: new Date(),
    } as any);

    await request(app).post("/api/auth/register").send({
      email: "plaincheck@gmail.com",
      password: rawPassword,
    });

    const createArgs = createSpy.mock.calls[0][0];
    expect((createArgs.data as any).password).toBeUndefined();
    expect(createArgs.data.passwordHash).not.toBe(rawPassword);
  });

  // 9. Password hash is not returned in the response
  it("9. Password hash is not returned in the response", async () => {
    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(null);
    vi.spyOn(prisma.user, "create").mockResolvedValueOnce({
      id: "uuid-no-hash-return",
      email: "nohashreturn@gmail.com",
      createdAt: new Date(),
    } as any);

    const res = await request(app).post("/api/auth/register").send({
      email: "nohashreturn@gmail.com",
      password: "StrongPassword123!",
    });

    expect(res.status).toBe(201);
    expect(res.body.user).toBeDefined();
    expect((res.body.user as any).passwordHash).toBeUndefined();
    expect((res.body.user as any).password).toBeUndefined();
    expect((res.body as any).passwordHash).toBeUndefined();
  });

  // 10. Safe handling of database errors
  it("10. Safe handling of database errors returns 500 without leaking internals", async () => {
    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(null);
    vi.spyOn(prisma.user, "create").mockRejectedValueOnce(
      new Error("FATAL: Neon connection pool connection timeout: 5432")
    );

    const res = await request(app).post("/api/auth/register").send({
      email: "dberror@gmail.com",
      password: "StrongPassword123!",
    });

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });

  // 11. Safe handling of unexpected errors
  it("11. Safe handling of unexpected errors", async () => {
    vi.spyOn(authService, "register").mockRejectedValueOnce(
      new Error("Unexpected runtime failure")
    );

    const res = await request(app).post("/api/auth/register").send({
      email: "unexpected@gmail.com",
      password: "StrongPassword123!",
    });

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
  });

  // 12. Concurrent race condition (Prisma P2002) returns 409 Conflict safely
  it("12. Concurrent race condition (Prisma P2002) returns 409 Conflict safely", async () => {
    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(null);
    const p2002Error: any = new Error(
      "Unique constraint failed on the constraint: `User_email_key`"
    );
    p2002Error.code = "P2002";
    p2002Error.meta = { target: ["email"] };
    vi.spyOn(prisma.user, "create").mockRejectedValueOnce(p2002Error);

    const res = await request(app).post("/api/auth/register").send({
      email: "concurrent@gmail.com",
      password: "StrongPassword123!",
    });

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty(
      "error",
      "An account with this email already exists"
    );
    expect(res.body.error).not.toContain("P2002");
    expect(res.body.error).not.toContain("User_email_key");
    expect(res.body).not.toHaveProperty("meta");
  });
});

describe("Auth Module - Profile & Token Verification", () => {
  it("GET /api/auth/me should reject requests without token", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Access token required");
  });

  it("GET /api/auth/me should reject requests with invalid token", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer invalidtokenhere");
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Invalid or expired token");
  });

  it("GET /api/auth/me rejects token missing mandatory sessionId (SEC-01)", async () => {
    const prismaSpy = vi.spyOn(prisma.session, "findUnique");
    const token = jwt.sign(
      { userId: "11111111-1111-4111-8111-111111111111", email: "valid@gmail.com" },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Invalid token payload");
    expect(prismaSpy).not.toHaveBeenCalled();
  });

  it("GET /api/auth/me rejects token with malformed or non-canonical UUID userId (SEC-01)", async () => {
    const prismaSpy = vi.spyOn(prisma.session, "findUnique");
    const token = jwt.sign(
      {
        userId: "not-a-canonical-uuid",
        email: "valid@gmail.com",
        sessionId: "22222222-2222-4222-8222-222222222222",
      },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Invalid token payload");
    expect(prismaSpy).not.toHaveBeenCalled();
  });

  it("GET /api/auth/me rejects token with malformed or non-canonical UUID sessionId (SEC-01)", async () => {
    const prismaSpy = vi.spyOn(prisma.session, "findUnique");
    const token = jwt.sign(
      {
        userId: "11111111-1111-4111-8111-111111111111",
        email: "valid@gmail.com",
        sessionId: "not-a-canonical-uuid",
      },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Invalid token payload");
    expect(prismaSpy).not.toHaveBeenCalled();
  });

  it("GET /api/auth/me rejects token with whitespace-padded sessionId before querying DB (SEC-01)", async () => {
    const prismaSpy = vi.spyOn(prisma.session, "findUnique");
    const token = jwt.sign(
      {
        userId: "11111111-1111-4111-8111-111111111111",
        email: "valid@gmail.com",
        sessionId: " 22222222-2222-4222-8222-222222222222 ",
      },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Invalid token payload");
    expect(prismaSpy).not.toHaveBeenCalled();
  });

  it("GET /api/auth/me rejects token with whitespace-padded userId before querying DB (SEC-01)", async () => {
    const prismaSpy = vi.spyOn(prisma.session, "findUnique");
    const token = jwt.sign(
      {
        userId: " 11111111-1111-4111-8111-111111111111 ",
        email: "valid@gmail.com",
        sessionId: "22222222-2222-4222-8222-222222222222",
      },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Invalid token payload");
    expect(prismaSpy).not.toHaveBeenCalled();
  });

  it("GET /api/auth/me rejects token with empty or whitespace email (SEC-01)", async () => {
    const prismaSpy = vi.spyOn(prisma.session, "findUnique");
    const token = jwt.sign(
      {
        userId: "11111111-1111-4111-8111-111111111111",
        email: "   ",
        sessionId: "22222222-2222-4222-8222-222222222222",
      },
      env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Invalid token payload");
    expect(prismaSpy).not.toHaveBeenCalled();
  });

  it("GET /api/auth/me verifies active database session when valid sessionId is in payload (SEC-01)", async () => {
    const mockUser = {
      id: "11111111-1111-4111-8111-111111111111",
      email: "valid@gmail.com",
      createdAt: new Date(),
    };

    const mockSession = {
      id: "22222222-2222-4222-8222-222222222222",
      userId: mockUser.id,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    };

    vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce(mockSession as any);
    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(mockUser as any);

    const token = jwt.sign(
      { userId: mockUser.id, email: mockUser.email, sessionId: mockSession.id },
      env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toHaveProperty("id", mockUser.id);
  });

  it("GET /api/auth/me rejects access token if database session is revoked (SEC-01)", async () => {
    const mockSession = {
      id: "22222222-2222-4222-8222-222222222222",
      userId: "11111111-1111-4111-8111-111111111111",
      isRevoked: true,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    };

    vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce(mockSession as any);

    const token = jwt.sign(
      { userId: "11111111-1111-4111-8111-111111111111", email: "user@gmail.com", sessionId: mockSession.id },
      env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Session has been revoked");
  });

  it("GET /api/auth/me rejects access token if database session is expired (SEC-01)", async () => {
    const mockSession = {
      id: "22222222-2222-4222-8222-222222222222",
      userId: "11111111-1111-4111-8111-111111111111",
      isRevoked: false,
      expiresAt: new Date(Date.now() - 1000 * 60), // Expired 1 min ago
    };

    vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce(mockSession as any);

    const token = jwt.sign(
      { userId: "11111111-1111-4111-8111-111111111111", email: "user@gmail.com", sessionId: mockSession.id },
      env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Session has expired");
  });

  it("GET /api/auth/me rejects access token if database session belongs to different user (cross-user check with DB spy) (SEC-01)", async () => {
    const victimUserId = "33333333-3333-4333-8333-333333333333";
    const attackerUserId = "44444444-4444-4444-8444-444444444444";
    const sessionOfVictimId = "55555555-5555-4555-8555-555555555555";

    const mockSession = {
      id: sessionOfVictimId,
      userId: victimUserId,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    };

    const sessionSpy = vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce(mockSession as any);

    const token = jwt.sign(
      { userId: attackerUserId, email: "attacker@gmail.com", sessionId: sessionOfVictimId },
      env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Session does not belong to user");
    expect(sessionSpy).toHaveBeenCalledWith({
      where: { id: sessionOfVictimId },
      select: expect.any(Object),
    });
  });

  it("GET /api/auth/me rejects access token if database session is not found (SEC-01)", async () => {
    const sessionSpy = vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce(null);

    const token = jwt.sign(
      {
        userId: "11111111-1111-4111-8111-111111111111",
        email: "user@gmail.com",
        sessionId: "22222222-2222-4222-8222-222222222222",
      },
      env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Session not found");
    expect(sessionSpy).toHaveBeenCalled();
  });

  it("GET /api/auth/me returns 500 when database query fails during session lookup (SEC-01)", async () => {
    vi.spyOn(prisma.session, "findUnique").mockRejectedValueOnce(
      new Error("Database connection dropped")
    );

    const token = jwt.sign(
      {
        userId: "11111111-1111-4111-8111-111111111111",
        email: "user@gmail.com",
        sessionId: "22222222-2222-4222-8222-222222222222",
      },
      env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error", "Authentication verification failed");
  });
});

describe("Auth Module - User Login (HTTP)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("1. Successful login with Argon2id returns 200, tokens, and creates Session", async () => {
    const rawPassword = "StrongPassword123!";
    const passwordHash = await authService.hashPassword(rawPassword);
    const mockUser = {
      id: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e01",
      email: "loginuser@gmail.com",
      passwordHash,
      createdAt: new Date(),
    };

    const mockSession = {
      id: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e02",
      userId: mockUser.id,
      tokenHash: "hashed-token-123",
      familyId: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e03",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      isRevoked: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(mockUser as any);
    const sessionSpy = vi.spyOn(prisma.session, "create").mockResolvedValueOnce(mockSession as any);

    const res = await request(app).post("/api/auth/login").send({
      email: "loginuser@gmail.com",
      password: rawPassword,
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("accessToken");
    expect(res.body).toHaveProperty("refreshToken");
    expect(res.body).toHaveProperty("user");
    expect(res.body.user.id).toBe(mockUser.id);
    expect(res.body.user.email).toBe(mockUser.email);
    expect(res.body.user).not.toHaveProperty("passwordHash");
    expect(res.body.user).not.toHaveProperty("password");

    // Verify session creation called with SHA-256 hash
    expect(sessionSpy).toHaveBeenCalled();
    const sessionArgs = sessionSpy.mock.calls[0][0];
    expect(sessionArgs.data.userId).toBe(mockUser.id);
    expect(sessionArgs.data.tokenHash).toHaveLength(64); // SHA-256 hex length

    // Verify access token payload
    const decoded = jwt.verify(res.body.accessToken, env.JWT_SECRET) as any;
    expect(decoded.userId).toBe(mockUser.id);
    expect(decoded.sessionId).toBe(mockSession.id);
  });

  it("2. Successful login with legacy bcrypt password returns 200 and tokens", async () => {
    const rawPassword = "LegacyPassword123!";
    const bcryptHash = await bcrypt.hash(rawPassword, 10);
    const mockUser = {
      id: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e04",
      email: "legacy@gmail.com",
      passwordHash: bcryptHash,
      createdAt: new Date(),
    };

    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(mockUser as any);
    vi.spyOn(prisma.session, "create").mockResolvedValueOnce({
      id: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e05",
      userId: mockUser.id,
    } as any);

    const res = await request(app).post("/api/auth/login").send({
      email: "legacy@gmail.com",
      password: rawPassword,
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("accessToken");
    expect(res.body).toHaveProperty("refreshToken");
  });

  it("3. Login with wrong password returns 401 Unauthorized", async () => {
    const passwordHash = await authService.hashPassword("CorrectPassword123!");
    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce({
      id: "uuid-wrong-pw",
      email: "wrongpw@gmail.com",
      passwordHash,
    } as any);

    const res = await request(app).post("/api/auth/login").send({
      email: "wrongpw@gmail.com",
      password: "WrongPassword123!",
    });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Invalid email or password");
  });

  it("4. Login with non-existent user returns generic 401 Unauthorized", async () => {
    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(null);

    const res = await request(app).post("/api/auth/login").send({
      email: "nonexistent@gmail.com",
      password: "AnyPassword123!",
    });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Invalid email or password");
  });

  it("5. Login with invalid non-Gmail address returns 400 Bad Request", async () => {
    const res = await request(app).post("/api/auth/login").send({
      email: "invalid@outlook.com",
      password: "Password123!",
    });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "Validation failed");
  });

  it("6. Login with missing password returns 400 Bad Request", async () => {
    const res = await request(app).post("/api/auth/login").send({
      email: "test@gmail.com",
    });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "Validation failed");
  });
});

describe("Auth Module - Refresh Token Rotation & Concurrency / Race Condition (HTTP)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => {
      if (typeof callback === "function") {
        return callback(prisma);
      }
      if (Array.isArray(callback)) {
        return Promise.all(callback);
      }
      return callback;
    });
  });

  it("1. Successful refresh creates exactly one replacement session with atomic claim", async () => {
    const rawRefreshToken = "a".repeat(128);
    const oldSession = {
      id: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e06",
      userId: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e07",
      tokenHash: authService.hashRefreshToken(rawRefreshToken),
      familyId: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e08",
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 10),
    };

    const newSession = {
      id: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e09",
      userId: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e07",
      tokenHash: "new-token-hash",
      familyId: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e08",
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
    };

    vi.spyOn(prisma.session, "findFirst").mockResolvedValueOnce(oldSession as any);
    const claimSpy = vi.spyOn(prisma.session, "updateMany").mockResolvedValueOnce({ count: 1 } as any);
    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce({
      id: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e07",
      email: "user@gmail.com",
    } as any);
    const createSpy = vi.spyOn(prisma.session, "create").mockResolvedValueOnce(newSession as any);

    const res = await request(app).post("/api/auth/refresh").send({
      refreshToken: rawRefreshToken,
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("accessToken");
    expect(res.body).toHaveProperty("refreshToken");
    expect(res.body.refreshToken).not.toBe(rawRefreshToken);
    expect(claimSpy).toHaveBeenCalledWith({
      where: { id: oldSession.id, isRevoked: false },
      data: { isRevoked: true },
    });
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("2. Failed conditional claim does not create replacement session, persists family revocation, and returns 401", async () => {
    const rawRefreshToken = "concurrent".repeat(12);
    const session = {
      id: "session-concurrent",
      userId: "user-concurrent-123",
      tokenHash: authService.hashRefreshToken(rawRefreshToken),
      familyId: "family-concurrent-123",
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 10),
    };

    vi.spyOn(prisma.session, "findFirst").mockResolvedValueOnce(session as any);
    const disconnectFamilySpy = vi.spyOn(sockets, "disconnectSocketsByFamilyId");

    // 1st updateMany inside tx: conditional claim returns count 0 (another concurrent request claimed it)
    // 2nd updateMany post-tx: standalone family revocation executes and commits
    const updateManySpy = vi.spyOn(prisma.session, "updateMany")
      .mockResolvedValueOnce({ count: 0 } as any) // claim attempt fails
      .mockResolvedValueOnce({ count: 2 } as any); // family revocation succeeds

    const createSpy = vi.spyOn(prisma.session, "create");

    const res = await request(app).post("/api/auth/refresh").send({
      refreshToken: rawRefreshToken,
    });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Invalid or expired refresh token");

    // Confirms NO replacement session was created
    expect(createSpy).not.toHaveBeenCalled();

    // Confirms standalone family revocation executed after transaction
    expect(updateManySpy).toHaveBeenNthCalledWith(2, {
      where: { familyId: session.familyId },
      data: { isRevoked: true },
    });
    expect(disconnectFamilySpy).toHaveBeenCalledWith(session.familyId);
  });

  it("3. Sequential replay of already-revoked session executes committed family revocation before throwing 401", async () => {
    const disconnectFamilySpy = vi.spyOn(sockets, "disconnectSocketsByFamilyId");
    const replayedToken = "b".repeat(128);
    const revokedSession = {
      id: "session-stolen",
      userId: "victim-user-123",
      tokenHash: authService.hashRefreshToken(replayedToken),
      familyId: "family-compromised",
      isRevoked: true, // ALREADY REVOKED!
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 10),
    };

    vi.spyOn(prisma.session, "findFirst").mockResolvedValueOnce(revokedSession as any);
    const updateManySpy = vi.spyOn(prisma.session, "updateMany").mockResolvedValueOnce({ count: 3 } as any);
    const createSpy = vi.spyOn(prisma.session, "create");

    const res = await request(app).post("/api/auth/refresh").send({
      refreshToken: replayedToken,
    });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Invalid or expired refresh token");
    expect(createSpy).not.toHaveBeenCalled();
    expect(updateManySpy).toHaveBeenCalledWith({
      where: { familyId: revokedSession.familyId },
      data: { isRevoked: true },
    });
    expect(disconnectFamilySpy).toHaveBeenCalledWith(revokedSession.familyId);
  });

  it("4. Unrelated database errors roll back transaction and do NOT trigger token-family revocation", async () => {
    const rawRefreshToken = "txfail".repeat(20);
    const session = {
      id: "session-tx-fail",
      userId: "user-123",
      tokenHash: authService.hashRefreshToken(rawRefreshToken),
      familyId: "family-healthy-123",
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 10),
    };

    vi.spyOn(prisma.session, "findFirst").mockResolvedValueOnce(session as any);
    const disconnectFamilySpy = vi.spyOn(sockets, "disconnectSocketsByFamilyId");
    const updateManySpy = vi.spyOn(prisma.session, "updateMany").mockResolvedValueOnce({ count: 1 } as any);
    vi.spyOn(prisma.user, "findUnique").mockRejectedValueOnce(
      new Error("FATAL: Neon connection pool connection timeout: 5432")
    );

    const res = await request(app).post("/api/auth/refresh").send({
      refreshToken: rawRefreshToken,
    });

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");

    // Confirms healthy family was NOT revoked on an unrelated database error
    expect(updateManySpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: { familyId: session.familyId },
      })
    );
  });

  it("5. Expired refresh token returns 401 Unauthorized without revoking family", async () => {
    const expiredToken = "c".repeat(128);
    const expiredSession = {
      id: "session-expired",
      userId: "user-123",
      tokenHash: authService.hashRefreshToken(expiredToken),
      familyId: "family-123",
      isRevoked: false,
      expiresAt: new Date(Date.now() - 1000 * 60),
    };

    vi.spyOn(prisma.session, "findFirst").mockResolvedValueOnce(expiredSession as any);
    const updateManySpy = vi.spyOn(prisma.session, "updateMany");

    const res = await request(app).post("/api/auth/refresh").send({
      refreshToken: expiredToken,
    });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Session expired, please login again");
    expect(updateManySpy).not.toHaveBeenCalled();
  });

  it("6. Non-existent refresh token returns 401 Unauthorized", async () => {
    vi.spyOn(prisma.session, "findFirst").mockResolvedValueOnce(null);

    const res = await request(app).post("/api/auth/refresh").send({
      refreshToken: "non-existent-refresh-token",
    });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Invalid or expired refresh token");
  });
});

describe("Auth Module - Logout & Session Revocation (HTTP)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("1. Logout without access token returns 401 Access token required", async () => {
    const res = await request(app).post("/api/auth/logout").send({});
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Access token required");
  });

  it("2. Authenticated logout with sessionId revokes session and returns 200", async () => {
    const mockUser = { id: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e10", email: "logout1@gmail.com" };
    const sessionId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e11";

    const token = jwt.sign(
      { userId: mockUser.id, email: mockUser.email, sessionId },
      env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    // authenticateToken check
    vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce({
      id: sessionId,
      userId: mockUser.id,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    } as any);

    // logout updateMany
    const updateManySpy = vi.spyOn(prisma.session, "updateMany").mockResolvedValueOnce({ count: 1 } as any);

    const res = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("message", "Logged out successfully");
    expect(updateManySpy).toHaveBeenCalledWith({
      where: {
        id: sessionId,
        userId: mockUser.id,
        isRevoked: false,
      },
      data: { isRevoked: true },
    });
  });

  it("3. Authenticated logout with matching refreshToken revokes session and returns 200", async () => {
    const mockUser = { id: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e12", email: "logout2@gmail.com" };
    const sessionId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e13";
    const rawRefreshToken = "logouttoken".repeat(10);
    const tokenHash = authService.hashRefreshToken(rawRefreshToken);

    const token = jwt.sign(
      { userId: mockUser.id, email: mockUser.email, sessionId },
      env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    // authenticateToken check
    vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce({
      id: sessionId,
      userId: mockUser.id,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    } as any);

    // logout: findFirst for refreshToken
    vi.spyOn(prisma.session, "findFirst").mockResolvedValueOnce({
      id: sessionId,
      userId: mockUser.id,
      tokenHash,
      isRevoked: false,
    } as any);

    const updateManySpy = vi.spyOn(prisma.session, "updateMany").mockResolvedValueOnce({ count: 1 } as any);

    const res = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${token}`)
      .send({ refreshToken: rawRefreshToken });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("message", "Logged out successfully");
  });

  it("4. Logout attempt on already-revoked session returns 401 Session already revoked", async () => {
    const mockUser = { id: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e14", email: "logout3@gmail.com" };
    const sessionId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e15";

    const token = jwt.sign(
      { userId: mockUser.id, email: mockUser.email, sessionId },
      env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    // 1. authenticateToken check passes when session was active
    vi.spyOn(prisma.session, "findUnique")
      .mockResolvedValueOnce({
        id: sessionId,
        userId: mockUser.id,
        isRevoked: false,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      } as any)
      // 2. logout check confirms session was already revoked
      .mockResolvedValueOnce({
        id: sessionId,
        userId: mockUser.id,
        isRevoked: true,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      } as any);

    // Concurrent revocation occurred: updateMany returns count: 0
    vi.spyOn(prisma.session, "updateMany").mockResolvedValueOnce({ count: 0 } as any);

    const res = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "Session already revoked");
  });

  it("5. Cross-user logout attempt (using another user's refreshToken) returns 403 Forbidden", async () => {
    const victimUserId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e17";
    const attackerUserId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e18";
    const attackerSessionId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e19";

    const token = jwt.sign(
      { userId: attackerUserId, email: "attacker@gmail.com", sessionId: attackerSessionId },
      env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    // authenticateToken check passes for attacker
    vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce({
      id: attackerSessionId,
      userId: attackerUserId,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    } as any);

    const rawRefreshToken = "victimrefreshtoken".repeat(7);
    const tokenHash = authService.hashRefreshToken(rawRefreshToken);

    // Refresh token belongs to VICTIM
    vi.spyOn(prisma.session, "findFirst").mockResolvedValueOnce({
      id: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e20",
      userId: victimUserId,
      tokenHash,
      isRevoked: false,
    } as any);

    const res = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${token}`)
      .send({ refreshToken: rawRefreshToken });

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty(
      "error",
      "Forbidden: Session does not belong to authenticated user"
    );
  });

  it("6. Authenticated logout triggers disconnectSocketsBySessionId for the revoked session", async () => {
    const mockUser = { id: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e21", email: "logout6@gmail.com" };
    const sessionId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e22";

    const token = jwt.sign(
      { userId: mockUser.id, email: mockUser.email, sessionId },
      env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce({
      id: sessionId,
      userId: mockUser.id,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    } as any);

    vi.spyOn(prisma.session, "updateMany").mockResolvedValueOnce({ count: 1 } as any);
    const disconnectSessionSpy = vi.spyOn(sockets, "disconnectSocketsBySessionId");

    const res = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(disconnectSessionSpy).toHaveBeenCalledWith(sessionId);
  });

  it("7. Failed database revocation does not call disconnectSocketsBySessionId", async () => {
    const mockUser = { id: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e23", email: "logout7@gmail.com" };
    const sessionId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e24";

    const token = jwt.sign(
      { userId: mockUser.id, email: mockUser.email, sessionId },
      env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    vi.spyOn(prisma.session, "findUnique").mockResolvedValueOnce({
      id: sessionId,
      userId: mockUser.id,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    } as any);

    // updateMany throws database failure
    vi.spyOn(prisma.session, "updateMany").mockRejectedValueOnce(new Error("DB failure"));
    const disconnectSessionSpy = vi.spyOn(sockets, "disconnectSocketsBySessionId");

    const res = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(500);
    expect(disconnectSessionSpy).not.toHaveBeenCalled();
  });
});

describe("Auth Module - Password Change (Stage A)", () => {
  const mockUser = {
    id: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e51",
    email: "pwchange@gmail.com",
    displayName: "Password User",
    lastSeenAt: null,
    createdAt: new Date(),
  };

  const mockSession = {
    id: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e25",
    userId: mockUser.id,
    isRevoked: false,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(prisma.session, "findUnique").mockResolvedValue(mockSession as any);
  });

  const token = jwt.sign(
    { userId: mockUser.id, email: mockUser.email, sessionId: mockSession.id },
    env.JWT_SECRET,
    { expiresIn: "15m" }
  );

  it("1. Rejects unauthenticated change password request with 401", async () => {
    const res = await request(app).post("/api/auth/change-password").send({
      currentPassword: "OldPassword123!",
      newPassword: "NewPassword456!",
    });
    expect(res.status).toBe(401);
  });

  it("2. Successfully updates password with Argon2id, revokes all sessions, and disconnects user sockets", async () => {
    const oldHash = await authService.hashPassword("OldPassword123!");

    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce({
      id: mockUser.id,
      passwordHash: oldHash,
    } as any);

    const txMock = {
      user: { update: vi.fn().mockResolvedValueOnce({}) },
      session: { updateMany: vi.fn().mockResolvedValueOnce({ count: 3 }) },
    };
    vi.spyOn(prisma, "$transaction").mockImplementationOnce(async (cb: any) => cb(txMock));
    const disconnectUserSpy = vi.spyOn(sockets, "disconnectSocketsByUserId");

    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({
        currentPassword: "OldPassword123!",
        newPassword: "BrandNewPassword123!",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain("All active sessions have been revoked");

    // Verify user update called with new Argon2id hash
    expect(txMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: mockUser.id },
        data: expect.objectContaining({
          passwordHash: expect.stringMatching(/^\$argon2id\$/),
        }),
      })
    );

    // Verify all active sessions were revoked
    expect(txMock.session.updateMany).toHaveBeenCalledWith({
      where: { userId: mockUser.id, isRevoked: false },
      data: { isRevoked: true },
    });

    // Verify socket disconnection invoked post-commit
    expect(disconnectUserSpy).toHaveBeenCalledWith(
      mockUser.id,
      expect.stringContaining("Password changed")
    );
  });

  it("3. Rejects incorrect current password with 401 Unauthorized", async () => {
    const oldHash = await authService.hashPassword("CorrectPassword123!");

    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce({
      id: mockUser.id,
      passwordHash: oldHash,
    } as any);

    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({
        currentPassword: "WrongPassword999!",
        newPassword: "NewPassword123!",
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Current password is incorrect");
  });

  it("4. Rejects new password that fails policy complexity requirements with 400", async () => {
    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({
        currentPassword: "OldPassword123!",
        newPassword: "weak", // fails min length and complexity
      });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "Validation failed");
  });

  it("5. Database transaction failure does not call disconnectSocketsByUserId", async () => {
    const oldHash = await authService.hashPassword("OldPassword123!");

    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce({
      id: mockUser.id,
      passwordHash: oldHash,
    } as any);

    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("Database crash"));
    const disconnectUserSpy = vi.spyOn(sockets, "disconnectSocketsByUserId");

    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({
        currentPassword: "OldPassword123!",
        newPassword: "BrandNewPassword123!",
      });

    expect(res.status).toBe(500);
    expect(disconnectUserSpy).not.toHaveBeenCalled();
  });
});

describe("Auth Module - Expired Session Purge Utility (Stage A)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("6. purgeExpiredSessions deletes expired or revoked sessions older than 30 days and protects active sessions", async () => {
    const deleteManySpy = vi.spyOn(prisma.session, "deleteMany").mockResolvedValueOnce({ count: 5 });

    const result = await authService.purgeExpiredSessions({ retentionDays: 30 });

    expect(result.deletedCount).toBe(5);
    expect(result.cutoffDate).toBeInstanceOf(Date);

    expect(deleteManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({
              OR: [{ isRevoked: true }, { expiresAt: { lt: expect.any(Date) } }],
            }),
            expect.objectContaining({
              updatedAt: { lt: expect.any(Date) },
            }),
          ]),
        }),
      })
    );
  });
});
