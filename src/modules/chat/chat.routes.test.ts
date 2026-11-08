import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { app, resetHealthCheckCache } from "../../app";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { chatService } from "./chat.service";

describe("Chat Module - REST Controller & Route Layer (HTTP Integration)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(prisma.session, "findUnique").mockResolvedValue({
      id: "00000000-0000-0000-0000-000000000002",
      userId: "00000000-0000-0000-0000-000000000001",
      isRevoked: false,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    } as any);
  });

  const testUser = {
    userId: "00000000-0000-0000-0000-000000000001",
    email: "test.user@gmail.com",
    sessionId: "00000000-0000-0000-0000-000000000002",
  };

  const validToken = jwt.sign(testUser, env.JWT_SECRET);
  const authHeader = `Bearer ${validToken}`;

  const conversationId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e5f";
  const messageId = "a1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c";

  // 1. Unauthenticated requests are rejected for all six endpoints
  describe("1. Authentication Enforcement (401 Unauthorized)", () => {
    it("rejects unauthenticated POST /api/chat/conversations", async () => {
      const res = await request(app)
        .post("/api/chat/conversations")
        .send({ recipientEmail: "friend@gmail.com" });
      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("error", "Access token required");
    });

    it("rejects unauthenticated GET /api/chat/conversations", async () => {
      const res = await request(app).get("/api/chat/conversations");
      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("error", "Access token required");
    });

    it("rejects unauthenticated GET /api/chat/conversations/:id/messages", async () => {
      const res = await request(app).get(
        `/api/chat/conversations/${conversationId}/messages`
      );
      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("error", "Access token required");
    });

    it("rejects unauthenticated POST /api/chat/messages", async () => {
      const res = await request(app)
        .post("/api/chat/messages")
        .send({ conversationId, content: "Hello!" });
      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("error", "Access token required");
    });

    it("rejects unauthenticated PATCH /api/chat/messages/:id", async () => {
      const res = await request(app)
        .patch(`/api/chat/messages/${messageId}`)
        .send({ content: "Updated" });
      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("error", "Access token required");
    });

    it("rejects unauthenticated DELETE /api/chat/messages/:id", async () => {
      const res = await request(app).delete(
        `/api/chat/messages/${messageId}`
      );
      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("error", "Access token required");
    });

    it("rejects invalid or expired token with 401", async () => {
      const res = await request(app)
        .get("/api/chat/conversations")
        .set("Authorization", "Bearer invalid.token.payload");
      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("error", "Invalid or expired token");
    });
  });

  // 2. Valid authenticated conversation creation & retrieval
  describe("2. POST /api/chat/conversations", () => {
    it("creates or retrieves conversation successfully and returns 200", async () => {
      const mockConversation = {
        id: conversationId,
        user1Id: testUser.userId,
        user2Id: "00000000-0000-0000-0000-000000000002",
        otherUser: {
          id: "00000000-0000-0000-0000-000000000002",
          email: "friend@gmail.com",
          createdAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(chatService, "getOrCreateConversation").mockResolvedValueOnce(
        mockConversation as any
      );

      const res = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", authHeader)
        .send({ recipientEmail: "friend@gmail.com" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockConversation);
      expect(chatService.getOrCreateConversation).toHaveBeenCalledWith(
        testUser.userId,
        "friend@gmail.com"
      );
    });

    it("rejects invalid email with 400", async () => {
      const res = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", authHeader)
        .send({ recipientEmail: "not-an-email" });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Validation failed");
    });

    it("rejects non-Gmail address with 400", async () => {
      const res = await request(app)
        .post("/api/chat/conversations")
        .set("Authorization", authHeader)
        .send({ recipientEmail: "friend@yahoo.com" });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Validation failed");
    });
  });

  // 3. Conversation listing with pagination
  describe("3. GET /api/chat/conversations", () => {
    it("lists user conversations with default pagination parameters", async () => {
      const mockList = [
        {
          id: conversationId,
          otherUser: {
            id: "00000000-0000-0000-0000-000000000002",
            email: "partner@gmail.com",
            createdAt: new Date().toISOString(),
          },
          lastMessage: {
            id: messageId,
            senderId: testUser.userId,
            type: "TEXT",
            content: "Hello",
            isEdited: false,
            editedAt: null,
            isDeleted: false,
            createdAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      vi.spyOn(chatService, "getUserConversations").mockResolvedValueOnce(
        mockList as any
      );

      const res = await request(app)
        .get("/api/chat/conversations")
        .set("Authorization", authHeader);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockList);
      expect(chatService.getUserConversations).toHaveBeenCalledWith(
        testUser.userId,
        20,
        undefined
      );
    });

    it("lists user conversations with custom limit and cursor", async () => {
      const cursor = "123e4567-e89b-12d3-a456-426614174000";
      vi.spyOn(chatService, "getUserConversations").mockResolvedValueOnce([]);

      const res = await request(app)
        .get(`/api/chat/conversations?limit=15&cursor=${cursor}`)
        .set("Authorization", authHeader);

      expect(res.status).toBe(200);
      expect(chatService.getUserConversations).toHaveBeenCalledWith(
        testUser.userId,
        15,
        cursor
      );
    });

    it("rejects invalid cursor format with 400", async () => {
      const res = await request(app)
        .get("/api/chat/conversations?cursor=invalid-uuid")
        .set("Authorization", authHeader);

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Validation failed");
    });

    it("rejects limit exceeding maximum with 400", async () => {
      const res = await request(app)
        .get("/api/chat/conversations?limit=51")
        .set("Authorization", authHeader);

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Validation failed");
    });
  });

  // 4. Message history retrieval with pagination
  describe("4. GET /api/chat/conversations/:conversationId/messages", () => {
    it("retrieves paginated messages for valid participant with default pagination", async () => {
      const mockMessages = [
        {
          id: messageId,
          conversationId,
          senderId: testUser.userId,
          type: "TEXT",
          content: "First message",
          fileKey: null,
          fileMime: null,
          fileSize: null,
          isEdited: false,
          editedAt: null,
          isDeleted: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      vi.spyOn(chatService, "getConversationMessages").mockResolvedValueOnce(
        mockMessages as any
      );

      const res = await request(app)
        .get(`/api/chat/conversations/${conversationId}/messages`)
        .set("Authorization", authHeader);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockMessages);
      expect(chatService.getConversationMessages).toHaveBeenCalledWith(
        testUser.userId,
        conversationId,
        50,
        undefined
      );
    });

    it("retrieves paginated messages for valid participant with custom limit and cursor", async () => {
      const cursor = "123e4567-e89b-12d3-a456-426614174000";
      const mockMessages: any[] = [];

      vi.spyOn(chatService, "getConversationMessages").mockResolvedValueOnce(
        mockMessages
      );

      const res = await request(app)
        .get(
          `/api/chat/conversations/${conversationId}/messages?limit=30&cursor=${cursor}`
        )
        .set("Authorization", authHeader);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockMessages);
      expect(chatService.getConversationMessages).toHaveBeenCalledWith(
        testUser.userId,
        conversationId,
        30,
        cursor
      );
    });

    it("rejects invalid conversation UUID parameter with 400", async () => {
      const res = await request(app)
        .get("/api/chat/conversations/not-a-valid-uuid/messages")
        .set("Authorization", authHeader);

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Validation failed");
    });

    it("rejects invalid cursor format in message query with 400", async () => {
      const res = await request(app)
        .get(`/api/chat/conversations/${conversationId}/messages?cursor=invalid-uuid`)
        .set("Authorization", authHeader);

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Validation failed");
    });

    it("rejects limit exceeding maximum (100) with 400", async () => {
      const res = await request(app)
        .get(`/api/chat/conversations/${conversationId}/messages?limit=101`)
        .set("Authorization", authHeader);

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Validation failed");
    });

    it("returns 403 when user is not a conversation participant", async () => {
      const forbiddenError: any = new Error("Access denied to this conversation");
      forbiddenError.statusCode = 403;
      vi.spyOn(chatService, "getConversationMessages").mockRejectedValueOnce(
        forbiddenError
      );

      const res = await request(app)
        .get(`/api/chat/conversations/${conversationId}/messages`)
        .set("Authorization", authHeader);

      expect(res.status).toBe(403);
      expect(res.body).toHaveProperty("error", "Access denied to this conversation");
    });

    it("returns 404 when conversation does not exist", async () => {
      const notFoundError: any = new Error("Conversation not found");
      notFoundError.statusCode = 404;
      vi.spyOn(chatService, "getConversationMessages").mockRejectedValueOnce(
        notFoundError
      );

      const res = await request(app)
        .get(`/api/chat/conversations/${conversationId}/messages`)
        .set("Authorization", authHeader);

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty("error", "Conversation not found");
    });
  });

  // 5. Send message
  describe("5. POST /api/chat/messages", () => {
    it("creates a text message successfully and returns 201 Created", async () => {
      const mockCreated = {
        id: messageId,
        conversationId,
        senderId: testUser.userId,
        type: "TEXT",
        content: "Hello world!",
        fileKey: null,
        fileMime: null,
        fileSize: null,
        isEdited: false,
        editedAt: null,
        isDeleted: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(chatService, "sendMessage").mockResolvedValueOnce(
        mockCreated as any
      );

      const res = await request(app)
        .post("/api/chat/messages")
        .set("Authorization", authHeader)
        .send({
          conversationId,
          content: "Hello world!",
          type: "TEXT",
        });

      expect(res.status).toBe(201);
      expect(res.body).toEqual(mockCreated);
      expect(chatService.sendMessage).toHaveBeenCalledWith(
        testUser.userId,
        conversationId,
        {
          conversationId,
          content: "Hello world!",
          type: "TEXT",
        }
      );
    });

    it("rejects message with missing conversationId with 400", async () => {
      const res = await request(app)
        .post("/api/chat/messages")
        .set("Authorization", authHeader)
        .send({
          content: "Hello without conversationId",
        });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Validation failed");
    });

    it("rejects empty message content with 400", async () => {
      const res = await request(app)
        .post("/api/chat/messages")
        .set("Authorization", authHeader)
        .send({
          conversationId,
          content: "   ",
        });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Validation failed");
    });

    it("rejects non-TEXT message types with 400", async () => {
      const res = await request(app)
        .post("/api/chat/messages")
        .set("Authorization", authHeader)
        .send({
          conversationId,
          content: "Check this out",
          type: "IMAGE",
        });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Validation failed");
    });

    it("rejects oversized message content (>5000 characters) with 400", async () => {
      const res = await request(app)
        .post("/api/chat/messages")
        .set("Authorization", authHeader)
        .send({
          conversationId,
          content: "a".repeat(5001),
        });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Validation failed");
    });

    it("returns 403 when non-participant attempts to send message", async () => {
      const forbiddenError: any = new Error(
        "Access denied: You are not a participant in this conversation"
      );
      forbiddenError.statusCode = 403;
      vi.spyOn(chatService, "sendMessage").mockRejectedValueOnce(
        forbiddenError
      );

      const res = await request(app)
        .post("/api/chat/messages")
        .set("Authorization", authHeader)
        .send({
          conversationId,
          content: "Intruder message",
        });

      expect(res.status).toBe(403);
      expect(res.body).toHaveProperty(
        "error",
        "Access denied: You are not a participant in this conversation"
      );
    });
  });

  // 6. Edit message
  describe("6. PATCH /api/chat/messages/:messageId", () => {
    it("edits own text message within 24 hours and returns 200 OK", async () => {
      const mockUpdated = {
        id: messageId,
        conversationId,
        senderId: testUser.userId,
        type: "TEXT",
        content: "Corrected message text",
        fileKey: null,
        fileMime: null,
        fileSize: null,
        isEdited: true,
        editedAt: new Date().toISOString(),
        isDeleted: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(chatService, "editMessage").mockResolvedValueOnce(
        mockUpdated as any
      );

      const res = await request(app)
        .patch(`/api/chat/messages/${messageId}`)
        .set("Authorization", authHeader)
        .send({ content: "Corrected message text" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockUpdated);
      expect(chatService.editMessage).toHaveBeenCalledWith(
        testUser.userId,
        messageId,
        "Corrected message text"
      );
    });

    it("rejects invalid messageId UUID with 400", async () => {
      const res = await request(app)
        .patch("/api/chat/messages/invalid-uuid-format")
        .set("Authorization", authHeader)
        .send({ content: "Some edit" });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Validation failed");
    });

    it("rejects empty edit content with 400", async () => {
      const res = await request(app)
        .patch(`/api/chat/messages/${messageId}`)
        .set("Authorization", authHeader)
        .send({ content: "   " });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Validation failed");
    });

    it("returns 403 when editing another user's message", async () => {
      const forbiddenError: any = new Error(
        "Forbidden: You can only edit your own messages"
      );
      forbiddenError.statusCode = 403;
      vi.spyOn(chatService, "editMessage").mockRejectedValueOnce(
        forbiddenError
      );

      const res = await request(app)
        .patch(`/api/chat/messages/${messageId}`)
        .set("Authorization", authHeader)
        .send({ content: "Tampering attempt" });

      expect(res.status).toBe(403);
      expect(res.body).toHaveProperty(
        "error",
        "Forbidden: You can only edit your own messages"
      );
    });

    it("returns 400 when editing past 24 hours", async () => {
      const expiredError: any = new Error(
        "Messages can only be edited within 24 hours of creation"
      );
      expiredError.statusCode = 400;
      vi.spyOn(chatService, "editMessage").mockRejectedValueOnce(
        expiredError
      );

      const res = await request(app)
        .patch(`/api/chat/messages/${messageId}`)
        .set("Authorization", authHeader)
        .send({ content: "Late edit" });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty(
        "error",
        "Messages can only be edited within 24 hours of creation"
      );
    });

    it("returns 400 when editing a deleted message", async () => {
      const deletedError: any = new Error("Cannot edit a deleted message");
      deletedError.statusCode = 400;
      vi.spyOn(chatService, "editMessage").mockRejectedValueOnce(
        deletedError
      );

      const res = await request(app)
        .patch(`/api/chat/messages/${messageId}`)
        .set("Authorization", authHeader)
        .send({ content: "Revive attempt" });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty(
        "error",
        "Cannot edit a deleted message"
      );
    });
  });

  // 7. Delete message
  describe("7. DELETE /api/chat/messages/:messageId", () => {
    it("soft-deletes own message and returns 200 OK with tombstone", async () => {
      const mockTombstone = {
        id: messageId,
        conversationId,
        senderId: testUser.userId,
        type: "TEXT",
        content: null,
        fileKey: null,
        fileMime: null,
        fileSize: null,
        isEdited: false,
        editedAt: null,
        isDeleted: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.spyOn(chatService, "deleteMessage").mockResolvedValueOnce(
        mockTombstone as any
      );

      const res = await request(app)
        .delete(`/api/chat/messages/${messageId}`)
        .set("Authorization", authHeader);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockTombstone);
      expect(res.body.content).toBeNull();
      expect(res.body.isDeleted).toBe(true);
      expect(chatService.deleteMessage).toHaveBeenCalledWith(
        testUser.userId,
        messageId
      );
    });

    it("rejects invalid messageId UUID parameter with 400", async () => {
      const res = await request(app)
        .delete("/api/chat/messages/not-a-valid-uuid")
        .set("Authorization", authHeader);

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Validation failed");
    });

    it("returns 403 when deleting another user's message", async () => {
      const forbiddenError: any = new Error(
        "Forbidden: You can only delete your own messages"
      );
      forbiddenError.statusCode = 403;
      vi.spyOn(chatService, "deleteMessage").mockRejectedValueOnce(
        forbiddenError
      );

      const res = await request(app)
        .delete(`/api/chat/messages/${messageId}`)
        .set("Authorization", authHeader);

      expect(res.status).toBe(403);
      expect(res.body).toHaveProperty(
        "error",
        "Forbidden: You can only delete your own messages"
      );
    });

    it("returns 400 when deleting an already deleted message", async () => {
      const alreadyDeletedError: any = new Error(
        "Message is already deleted"
      );
      alreadyDeletedError.statusCode = 400;
      vi.spyOn(chatService, "deleteMessage").mockRejectedValueOnce(
        alreadyDeletedError
      );

      const res = await request(app)
        .delete(`/api/chat/messages/${messageId}`)
        .set("Authorization", authHeader);

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Message is already deleted");
    });
  });

  // 7b. Read receipts endpoint (Stage A)
  describe("7b. POST /api/chat/conversations/:conversationId/read", () => {
    it("successfully marks messages as read and returns 200 with count", async () => {
      vi.spyOn(chatService, "markMessagesAsRead").mockResolvedValueOnce({
        success: true,
        conversationId,
        count: 4,
        readAt: new Date(),
        lastReadMessageId: messageId,
      });

      const res = await request(app)
        .post(`/api/chat/conversations/${conversationId}/read`)
        .set("Authorization", authHeader)
        .send({ lastMessageId: messageId });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.count).toBe(4);
      expect(res.body.lastReadMessageId).toBe(messageId);
    });

    it("rejects invalid lastMessageId non-UUID format with 400", async () => {
      const res = await request(app)
        .post(`/api/chat/conversations/${conversationId}/read`)
        .set("Authorization", authHeader)
        .send({ lastMessageId: "not-a-valid-uuid" });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Validation failed");
    });

    it("returns 403 when user is not a participant", async () => {
      const forbiddenError: any = new Error("Access denied: You are not a participant in this conversation");
      forbiddenError.statusCode = 403;
      vi.spyOn(chatService, "markMessagesAsRead").mockRejectedValueOnce(forbiddenError);

      const res = await request(app)
        .post(`/api/chat/conversations/${conversationId}/read`)
        .set("Authorization", authHeader)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Access denied");
    });

    it("returns 404 when conversation does not exist", async () => {
      const notFoundError: any = new Error("Conversation not found");
      notFoundError.statusCode = 404;
      vi.spyOn(chatService, "markMessagesAsRead").mockRejectedValueOnce(notFoundError);

      const res = await request(app)
        .post(`/api/chat/conversations/${conversationId}/read`)
        .set("Authorization", authHeader)
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Conversation not found");
    });
  });

  // 8. Health check preservation
  describe("8. Health Endpoint Preservation", () => {
    it("GET /health continues to return 200 OK with status ok", async () => {
      vi.spyOn(prisma, "$queryRaw").mockResolvedValueOnce([{ 1: 1 }] as any);
      resetHealthCheckCache();
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("status", "ok");
      expect(res.body).toHaveProperty("timestamp");
    });
  });

  // 9. Centralized Error Handling & Unexpected 500 Responses
  describe("9. Centralized Error Handling & Unexpected 500 Responses", () => {
    it("handles unexpected service failure, forwards to errorHandler, and returns HTTP 500 without leaking secrets", async () => {
      vi.spyOn(chatService, "getUserConversations").mockRejectedValueOnce(
        new Error("Unexpected database connection crash or I/O failure")
      );

      const res = await request(app)
        .get("/api/chat/conversations")
        .set("Authorization", authHeader);

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty("error");

      // Verify no sensitive credentials, secrets, or raw auth tokens leaked
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(env.JWT_SECRET);
      expect(serialized).not.toContain("password");
      expect(serialized).not.toContain(validToken);
    });

    it("masks internal error message with 'Internal Server Error' in production mode", async () => {
      const originalEnv = env.NODE_ENV;
      try {
        (env as any).NODE_ENV = "production";

        vi.spyOn(chatService, "getUserConversations").mockRejectedValueOnce(
          new Error("Sensitive internal driver connection dump: 192.168.1.1:5432")
        );

        const res = await request(app)
          .get("/api/chat/conversations")
          .set("Authorization", authHeader);

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
          error: "Internal Server Error",
        });
        expect(res.body).not.toHaveProperty("stack");
      } finally {
        (env as any).NODE_ENV = originalEnv;
      }
    });
  });

  // 10. Shared Validation Middleware Behavior & Query Propagation
  describe("10. Shared Validation Middleware Behavior & Query Propagation", () => {
    it("safely propagates validated and transformed query parameters without mutating req.query accessor", async () => {
      vi.spyOn(chatService, "getUserConversations").mockResolvedValueOnce([]);

      const res = await request(app)
        .get("/api/chat/conversations?limit=25")
        .set("Authorization", authHeader);

      expect(res.status).toBe(200);
      // Validates that integer transform occurred and limit was passed as a number (25)
      expect(chatService.getUserConversations).toHaveBeenCalledWith(
        testUser.userId,
        25,
        undefined
      );
    });

    it("rejects non-numeric limit parameter with 400 Validation failed", async () => {
      const res = await request(app)
        .get("/api/chat/conversations?limit=abc")
        .set("Authorization", authHeader);

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "Validation failed");
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "limit",
          }),
        ])
      );
    });
  });
});
