import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { app } from "../../app";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { userService } from "./users.service";

describe("Users Module - Profile Management (Stage A)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(prisma.session, "findUnique").mockResolvedValue({
      id: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4eaa",
      userId: userA.userId,
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    } as any);
  });

  const userA = {
    userId: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e51",
    email: "usera@gmail.com",
    displayName: "User A",
    lastSeenAt: null,
    createdAt: new Date(),
  };

  const userB = {
    userId: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e52",
    email: "userb@gmail.com",
    displayName: "User B",
    lastSeenAt: null,
    createdAt: new Date(),
  };

  const outsider = {
    userId: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e99",
    email: "outsider@gmail.com",
    displayName: "Outsider",
    lastSeenAt: null,
    createdAt: new Date(),
  };

  const authHeaderA = `Bearer ${jwt.sign(
    { userId: userA.userId, email: userA.email, sessionId: "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4eaa" },
    env.JWT_SECRET,
    { expiresIn: "15m" }
  )}`;

  describe("PATCH /api/users/profile", () => {
    it("1. Rejects unauthenticated request with 401", async () => {
      const res = await request(app)
        .patch("/api/users/profile")
        .send({ displayName: "New Name" });
      expect(res.status).toBe(401);
    });

    it("2. Successfully updates display name and returns public profile", async () => {
      vi.spyOn(prisma.user, "update").mockResolvedValueOnce({
        id: userA.userId,
        email: userA.email,
        displayName: "Honey",
        lastSeenAt: null,
        createdAt: userA.createdAt,
      } as any);

      const res = await request(app)
        .patch("/api/users/profile")
        .set("Authorization", authHeaderA)
        .send({ displayName: "Honey" });

      expect(res.status).toBe(200);
      expect(res.body.user).toHaveProperty("displayName", "Honey");
      expect(res.body.user).toHaveProperty("email", userA.email);
      expect(res.body.user).not.toHaveProperty("passwordHash");
    });

    it("3. Rejects empty or whitespace-only display name", async () => {
      const res = await request(app)
        .patch("/api/users/profile")
        .set("Authorization", authHeaderA)
        .send({ displayName: "   " });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("4. Rejects display name exceeding 50 characters", async () => {
      const res = await request(app)
        .patch("/api/users/profile")
        .set("Authorization", authHeaderA)
        .send({ displayName: "a".repeat(51) });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("5. Rejects HTML or script tag injection in display name", async () => {
      const res = await request(app)
        .patch("/api/users/profile")
        .set("Authorization", authHeaderA)
        .send({ displayName: "<script>alert(1)</script>" });

      expect(res.status).toBe(400);
      expect(res.body.details[0].message).toContain("cannot contain HTML or angle brackets");
    });
  });

  describe("GET /api/users/:id", () => {
    it("6. Rejects unauthenticated request with 401", async () => {
      const res = await request(app).get(`/api/users/${userA.userId}`);
      expect(res.status).toBe(401);
    });

    it("7. Allows user to retrieve their own profile", async () => {
      vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce({
        id: userA.userId,
        email: userA.email,
        displayName: userA.displayName,
        lastSeenAt: null,
        createdAt: userA.createdAt,
      } as any);

      const res = await request(app)
        .get(`/api/users/${userA.userId}`)
        .set("Authorization", authHeaderA);

      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(userA.userId);
      expect(res.body.user.email).toBe(userA.email);
    });

    it("8. Allows user to retrieve their conversation partner's profile", async () => {
      // Conversation between A and B exists
      vi.spyOn(prisma.conversation, "findFirst").mockResolvedValueOnce({
        id: "conv-1",
        user1Id: userA.userId,
        user2Id: userB.userId,
      } as any);

      vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce({
        id: userB.userId,
        email: userB.email,
        displayName: userB.displayName,
        lastSeenAt: new Date(),
        createdAt: userB.createdAt,
      } as any);

      const res = await request(app)
        .get(`/api/users/${userB.userId}`)
        .set("Authorization", authHeaderA);

      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(userB.userId);
      expect(res.body.user.displayName).toBe("User B");
      expect(res.body.user).not.toHaveProperty("passwordHash");
    });

    it("9. Rejects access with 403 when requesting profile of a non-partner", async () => {
      // No conversation between A and outsider
      vi.spyOn(prisma.conversation, "findFirst").mockResolvedValueOnce(null);

      const res = await request(app)
        .get(`/api/users/${outsider.userId}`)
        .set("Authorization", authHeaderA);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Access denied");
    });

    it("10. Returns 404 when target user is not found", async () => {
      vi.spyOn(prisma.conversation, "findFirst").mockResolvedValueOnce({
        id: "conv-1",
        user1Id: userA.userId,
        user2Id: userB.userId,
      } as any);

      vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(null);

      const res = await request(app)
        .get(`/api/users/${userB.userId}`)
        .set("Authorization", authHeaderA);

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("User not found");
    });

    it("11. Rejects invalid non-UUID user ID format with 400", async () => {
      const res = await request(app)
        .get("/api/users/not-a-valid-uuid")
        .set("Authorization", authHeaderA);

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });
  });
});
