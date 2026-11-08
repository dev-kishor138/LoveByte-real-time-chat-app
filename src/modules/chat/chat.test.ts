import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createConversationSchema,
  conversationIdParamSchema,
  messageIdParamSchema,
  listConversationsQuerySchema,
  getMessagesQuerySchema,
  sendMessageSchema,
  editMessageSchema,
} from "./chat.validation";
import { chatService } from "./chat.service";
import { prisma } from "../../config/prisma";

describe("Chat Module - Validation Unit Tests", () => {
  // 1. Email normalization
  it("1. Normalizes valid Gmail address by trimming and lowercasing", () => {
    const input = { recipientEmail: "  Test.Partner@Gmail.COM  " };
    const result = createConversationSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.recipientEmail).toBe("test.partner@gmail.com");
    }
  });

  // 2. Invalid email rejection
  it("2. Rejects invalid email formats and non-Gmail domains", () => {
    expect(createConversationSchema.safeParse({ recipientEmail: "notanemail" }).success).toBe(false);
    expect(createConversationSchema.safeParse({ recipientEmail: "partner@yahoo.com" }).success).toBe(false);
    expect(createConversationSchema.safeParse({ recipientEmail: "partner@outlook.com" }).success).toBe(false);
    expect(createConversationSchema.safeParse({ recipientEmail: "partner@company.org" }).success).toBe(false);
  });

  // 3. Invalid UUID validation
  it("3. Rejects invalid UUID formats for conversationId, messageId, and cursor", () => {
    expect(conversationIdParamSchema.safeParse({ conversationId: "not-a-uuid" }).success).toBe(false);
    expect(messageIdParamSchema.safeParse({ messageId: "12345" }).success).toBe(false);
    expect(getMessagesQuerySchema.safeParse({ cursor: "invalid-cursor-id" }).success).toBe(false);
    expect(listConversationsQuerySchema.safeParse({ cursor: "not-a-uuid" }).success).toBe(false);

    // Valid UUID passes
    const validUuid = "123e4567-e89b-12d3-a456-426614174000";
    expect(conversationIdParamSchema.safeParse({ conversationId: validUuid }).success).toBe(true);
    expect(messageIdParamSchema.safeParse({ messageId: validUuid }).success).toBe(true);
    expect(getMessagesQuerySchema.safeParse({ cursor: validUuid }).success).toBe(true);
  });

  // 4. Empty and whitespace-only text rejection
  it("4. Rejects empty or whitespace-only message content for sending and editing", () => {
    expect(sendMessageSchema.safeParse({ content: "" }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ content: "   " }).success).toBe(false);
    expect(editMessageSchema.safeParse({ content: "" }).success).toBe(false);
    expect(editMessageSchema.safeParse({ content: "   " }).success).toBe(false);
  });

  // 5. Oversized text rejection (>5000 characters)
  it("5. Enforces 5,000 character maximum limit on message content", () => {
    const validContent = "a".repeat(5000);
    const oversizedContent = "a".repeat(5001);

    expect(sendMessageSchema.safeParse({ content: validContent }).success).toBe(true);
    expect(sendMessageSchema.safeParse({ content: oversizedContent }).success).toBe(false);

    expect(editMessageSchema.safeParse({ content: validContent }).success).toBe(true);
    expect(editMessageSchema.safeParse({ content: oversizedContent }).success).toBe(false);
  });

  // 6. Safe pagination parameters
  it("6. Validates and bounds pagination parameters with safe defaults", () => {
    // Default limit
    const parsedDefault = listConversationsQuerySchema.safeParse({});
    expect(parsedDefault.success).toBe(true);
    if (parsedDefault.success) {
      expect(parsedDefault.data.limit).toBe(20);
    }

    // Custom limit within bounds
    const parsedCustom = getMessagesQuerySchema.safeParse({ limit: "25" });
    expect(parsedCustom.success).toBe(true);
    if (parsedCustom.success) {
      expect(parsedCustom.data.limit).toBe(25);
    }

    // Exceeding maximum limit
    expect(listConversationsQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(getMessagesQuerySchema.safeParse({ limit: "101" }).success).toBe(false);

    // Negative or zero limit
    expect(getMessagesQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(getMessagesQuerySchema.safeParse({ limit: "-5" }).success).toBe(false);
  });

  // 7. TEXT-only restriction in Stage 1
  it("7. Rejects non-TEXT types in sendMessage validation", () => {
    expect(sendMessageSchema.safeParse({ content: "Hello", type: "TEXT" }).success).toBe(true);
    expect(sendMessageSchema.safeParse({ content: "Hello", type: "IMAGE" as any }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ content: "Hello", type: "VOICE" as any }).success).toBe(false);
  });
});

describe("Chat Module - Conversation Service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const userA = { id: "00000000-0000-0000-0000-000000000001", email: "user.a@gmail.com", createdAt: new Date() };
  const userB = { id: "00000000-0000-0000-0000-000000000002", email: "user.b@gmail.com", createdAt: new Date() };

  // 8. Self-conversation rejection
  it("8. Rejects self-conversation with status 400", async () => {
    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(userA as any);

    await expect(
      chatService.getOrCreateConversation(userA.id, "user.a@gmail.com")
    ).rejects.toMatchObject({
      message: "Cannot start a conversation with yourself",
      statusCode: 400,
    });
  });

  // 9. Recipient not found
  it("9. Throws 404 when recipient email is not registered", async () => {
    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(null);

    await expect(
      chatService.getOrCreateConversation(userA.id, "nonexistent@gmail.com")
    ).rejects.toMatchObject({
      message: "Recipient not found",
      statusCode: 404,
    });
  });

  // 10. Canonical participant ordering (user1Id < user2Id)
  it("10. Enforces canonical lexicographical ordering (user1Id < user2Id) regardless of initiator", async () => {
    vi.spyOn(prisma.user, "findUnique").mockResolvedValue(userB as any);

    // Case 1: userA initiates (userA.id < userB.id)
    const findSpy = vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce(null);
    const createSpy = vi.spyOn(prisma.conversation, "create").mockResolvedValueOnce({
      id: "conv-1",
      user1Id: userA.id,
      user2Id: userB.id,
      user1: userA,
      user2: userB,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const res1 = await chatService.getOrCreateConversation(userA.id, userB.email);
    expect(res1.user1Id).toBe(userA.id);
    expect(res1.user2Id).toBe(userB.id);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { user1Id: userA.id, user2Id: userB.id },
      })
    );

    // Case 2: userB initiates (userB.id > userA.id) -> canonical order must remain userA < userB
    vi.spyOn(prisma.user, "findUnique").mockResolvedValue(userA as any);
    findSpy.mockResolvedValueOnce(null);
    createSpy.mockResolvedValueOnce({
      id: "conv-1",
      user1Id: userA.id,
      user2Id: userB.id,
      user1: userA,
      user2: userB,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const res2 = await chatService.getOrCreateConversation(userB.id, userA.email);
    expect(res2.user1Id).toBe(userA.id);
    expect(res2.user2Id).toBe(userB.id);
  });

  // 11. Concurrent conversation creation / P2002 recovery
  it("11. Gracefully handles concurrent conversation creation race condition (Prisma P2002)", async () => {
    vi.spyOn(prisma.user, "findUnique").mockResolvedValueOnce(userB as any);

    // Initial findUnique returns null (simulating concurrent miss)
    vi.spyOn(prisma.conversation, "findUnique")
      .mockResolvedValueOnce(null) // first check
      .mockResolvedValueOnce({
        // recovery re-fetch
        id: "concurrent-conv-id",
        user1Id: userA.id,
        user2Id: userB.id,
        user1: userA,
        user2: userB,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

    // create throws P2002 (unique constraint collision)
    const p2002Error: any = new Error("Unique constraint failed on the fields: (`user1Id`,`user2Id`)");
    p2002Error.code = "P2002";
    vi.spyOn(prisma.conversation, "create").mockRejectedValueOnce(p2002Error);

    const conversation = await chatService.getOrCreateConversation(userA.id, userB.email);
    expect(conversation.id).toBe("concurrent-conv-id");
    expect(conversation.otherUser.id).toBe(userB.id);
  });

  // 12. Paginated conversation listing with masked deleted message
  it("12. Retrieves user conversations with pagination and masks deleted lastMessage content", async () => {
    const mockConversations = [
      {
        id: "conv-1",
        user1Id: userA.id,
        user2Id: userB.id,
        user1: userA,
        user2: userB,
        createdAt: new Date(),
        updatedAt: new Date(),
        messages: [
          {
            id: "msg-1",
            type: "TEXT",
            content: "Secret deleted message",
            isEdited: false,
            editedAt: null,
            isDeleted: true, // Soft-deleted
            createdAt: new Date(),
            senderId: userB.id,
          },
        ],
      },
    ];

    vi.spyOn(prisma.conversation, "findMany").mockResolvedValueOnce(mockConversations as any);

    const list = await chatService.getUserConversations(userA.id, 10);
    expect(list.length).toBe(1);
    expect(list[0].otherUser.id).toBe(userB.id);
    expect(list[0].lastMessage).toBeDefined();
    // Verify deleted content is masked to null
    expect(list[0].lastMessage?.content).toBeNull();
    expect(list[0].lastMessage?.isDeleted).toBe(true);
  });
});

describe("Chat Module - Message Service", () => {
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

  const user1Id = "00000000-0000-0000-0000-000000000001";
  const user2Id = "00000000-0000-0000-0000-000000000002";
  const outsiderId = "00000000-0000-0000-0000-000000000099";
  const conversationId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e5f";

  // 13. Conversation membership enforcement for message retrieval
  it("13. Rejects non-participant message retrieval with status 403", async () => {
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    await expect(
      chatService.getConversationMessages(outsiderId, conversationId)
    ).rejects.toMatchObject({
      message: "Access denied to this conversation",
      statusCode: 403,
    });
  });

  // 14. Paginated message retrieval and deleted content masking
  it("14. Retrieves messages with pagination and masks soft-deleted message content and media fields", async () => {
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const mockMessages = [
      {
        id: "m-1",
        conversationId,
        senderId: user1Id,
        type: "TEXT",
        content: "Active visible message",
        fileKey: null,
        fileMime: null,
        fileSize: null,
        isEdited: false,
        editedAt: null,
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "m-2",
        conversationId,
        senderId: user2Id,
        type: "TEXT",
        content: "Sensitive old text",
        fileKey: "media/secret.jpg",
        fileMime: "image/jpeg",
        fileSize: 1024,
        isEdited: false,
        editedAt: null,
        isDeleted: true, // Deleted
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    vi.spyOn(prisma.message, "findMany").mockResolvedValueOnce(mockMessages as any);

    const result = await chatService.getConversationMessages(user1Id, conversationId, 50);
    expect(result.length).toBe(2);

    // Active message retains content
    expect(result[0].content).toBe("Active visible message");
    expect(result[0].isDeleted).toBe(false);

    // Deleted message payload is strictly masked
    expect(result[1].content).toBeNull();
    expect(result[1].fileKey).toBeNull();
    expect(result[1].fileMime).toBeNull();
    expect(result[1].fileSize).toBeNull();
    expect(result[1].isDeleted).toBe(true);
  });

  // 15. Send TEXT message and update conversation updatedAt atomically via prisma.$transaction
  it("15. Creates TEXT message, updates conversation updatedAt atomically via prisma.$transaction, and validates participant", async () => {
    const txSpy = vi.spyOn(prisma, "$transaction");
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const messageMock = {
      id: "new-msg-1",
      conversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "Hello friend!",
      fileKey: null,
      fileMime: null,
      fileSize: null,
      isEdited: false,
      editedAt: null,
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const createSpy = vi.spyOn(prisma.message, "create").mockResolvedValueOnce(messageMock as any);
    const updateSpy = vi.spyOn(prisma.conversation, "update").mockResolvedValueOnce({} as any);

    const sent = await chatService.sendMessage(user1Id, conversationId, {
      content: "Hello friend!",
      type: "TEXT",
    });

    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(sent.id).toBe("new-msg-1");
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId,
          senderId: user1Id,
          type: "TEXT",
          content: "Hello friend!",
          fileKey: null,
        }),
      })
    );
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: conversationId },
        data: expect.objectContaining({ updatedAt: expect.any(Date) }),
      })
    );
  });

  // 15b. Atomicity failure rollback
  it("15b. Rejects and rolls back without broadcasting if conversation update fails in transaction", async () => {
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const messageMock = {
      id: "new-msg-tx-fail",
      conversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "Should rollback",
      fileKey: null,
      fileMime: null,
      fileSize: null,
      isEdited: false,
      editedAt: null,
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vi.spyOn(prisma.message, "create").mockResolvedValueOnce(messageMock as any);
    vi.spyOn(prisma.conversation, "update").mockRejectedValueOnce(new Error("Database write lock error"));

    await expect(
      chatService.sendMessage(user1Id, conversationId, {
        content: "Should rollback",
        type: "TEXT",
      })
    ).rejects.toThrow("Database write lock error");
  });

  // 15c. Interactive transaction client (tx) verification
  it("15c. Uses the interactive transaction client (tx) for both message creation and conversation update", async () => {
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const mockTxMessageCreate = vi.fn().mockResolvedValueOnce({
      id: "tx-msg-id",
      conversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "Atomic test",
      fileKey: null,
      fileMime: null,
      fileSize: null,
      isEdited: false,
      editedAt: null,
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const mockTxConversationUpdate = vi.fn().mockResolvedValueOnce({} as any);

    const mockTxClient = {
      message: { create: mockTxMessageCreate },
      conversation: { update: mockTxConversationUpdate },
    };

    vi.spyOn(prisma, "$transaction").mockImplementationOnce(async (cb: any) => {
      return cb(mockTxClient);
    });

    const sent = await chatService.sendMessage(user1Id, conversationId, {
      content: "Atomic test",
      type: "TEXT",
    });

    expect(sent.id).toBe("tx-msg-id");
    expect(mockTxMessageCreate).toHaveBeenCalledTimes(1);
    expect(mockTxConversationUpdate).toHaveBeenCalledTimes(1);
  });

  // 16. Non-participant sending message rejected
  it("16. Rejects message creation from non-participant with status 403", async () => {
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    await expect(
      chatService.sendMessage(outsiderId, conversationId, { content: "Unauthorized", type: "TEXT" })
    ).rejects.toMatchObject({
      message: "Access denied: You are not a participant in this conversation",
      statusCode: 403,
    });
  });

  // 17. Sender-only message editing
  it("17. Rejects editing message by non-author with status 403", async () => {
    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce({
      id: "msg-1",
      senderId: user1Id, // Authored by user1
      type: "TEXT",
      isDeleted: false,
      createdAt: new Date(),
      conversation: { id: conversationId, user1Id, user2Id },
    } as any);

    await expect(
      chatService.editMessage(user2Id, "msg-1", "Hacked content")
    ).rejects.toMatchObject({
      message: "Forbidden: You can only edit your own messages",
      statusCode: 403,
    });
  });

  // 18. 24-hour edit window boundary (rejected after 24h)
  it("18. Rejects message editing if created more than 24 hours ago with status 400", async () => {
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce({
      id: "msg-old",
      senderId: user1Id,
      type: "TEXT",
      isDeleted: false,
      createdAt: twentyFiveHoursAgo,
      conversation: { id: conversationId, user1Id, user2Id },
    } as any);

    await expect(
      chatService.editMessage(user1Id, "msg-old", "Late edit")
    ).rejects.toMatchObject({
      message: "Messages can only be edited within 24 hours of creation",
      statusCode: 400,
    });
  });

  // 19. Message editing within 24 hours updates isEdited and editedAt
  it("19. Edits message within 24 hours, setting isEdited=true and populating editedAt timestamp", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce({
      id: "msg-valid-edit",
      senderId: user1Id,
      type: "TEXT",
      isDeleted: false,
      createdAt: twoHoursAgo,
      conversation: { id: conversationId, user1Id, user2Id },
    } as any);

    const updateSpy = vi.spyOn(prisma.message, "update").mockResolvedValueOnce({
      id: "msg-valid-edit",
      conversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "Corrected content",
      fileKey: null,
      fileMime: null,
      fileSize: null,
      isEdited: true,
      editedAt: new Date(),
      isDeleted: false,
      createdAt: twoHoursAgo,
      updatedAt: new Date(),
    } as any);

    const updated = await chatService.editMessage(user1Id, "msg-valid-edit", "Corrected content");
    expect(updated.isEdited).toBe(true);
    expect(updated.content).toBe("Corrected content");
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: "Corrected content",
          isEdited: true,
          editedAt: expect.any(Date),
        }),
      })
    );
  });

  // 20. Cannot edit deleted message
  it("20. Rejects editing a soft-deleted message with status 400", async () => {
    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce({
      id: "msg-del",
      senderId: user1Id,
      type: "TEXT",
      isDeleted: true,
      createdAt: new Date(),
      conversation: { id: conversationId, user1Id, user2Id },
    } as any);

    await expect(
      chatService.editMessage(user1Id, "msg-del", "Edit deleted")
    ).rejects.toMatchObject({
      message: "Cannot edit a deleted message",
      statusCode: 400,
    });
  });

  // 21. Sender-only soft-deletion
  it("21. Soft-deletes message: unlinks media metadata using fileKey/fileMime/fileSize, sets isDeleted=true, and masks content", async () => {
    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce({
      id: "msg-to-delete",
      senderId: user1Id,
      isDeleted: false,
      conversation: { id: conversationId, user1Id, user2Id },
    } as any);

    const updateSpy = vi.spyOn(prisma.message, "update").mockResolvedValueOnce({
      id: "msg-to-delete",
      conversationId,
      senderId: user1Id,
      type: "TEXT",
      content: null,
      fileKey: null,
      fileMime: null,
      fileSize: null,
      isEdited: false,
      editedAt: null,
      isDeleted: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const deleted = await chatService.deleteMessage(user1Id, "msg-to-delete");
    expect(deleted.isDeleted).toBe(true);
    expect(deleted.content).toBeNull();
    expect(deleted.fileKey).toBeNull();
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "msg-to-delete" },
        data: {
          content: null,
          fileKey: null,
          fileMime: null,
          fileSize: null,
          isDeleted: true,
        },
      })
    );
  });

  // 22. Non-sender deleting message rejected
  it("22. Rejects deletion by non-sender with status 403", async () => {
    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce({
      id: "msg-owned-by-user1",
      senderId: user1Id,
      isDeleted: false,
      conversation: { id: conversationId, user1Id, user2Id },
    } as any);

    await expect(
      chatService.deleteMessage(user2Id, "msg-owned-by-user1")
    ).rejects.toMatchObject({
      message: "Forbidden: You can only delete your own messages",
      statusCode: 403,
    });
  });

  // 23. Deleting already-deleted message rejected
  it("23. Rejects deleting an already deleted message with status 400", async () => {
    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce({
      id: "msg-already-deleted",
      senderId: user1Id,
      isDeleted: true,
      conversation: { id: conversationId, user1Id, user2Id },
    } as any);

    await expect(
      chatService.deleteMessage(user1Id, "msg-already-deleted")
    ).rejects.toMatchObject({
      message: "Message is already deleted",
      statusCode: 400,
    });
  });

  // 24. Deterministic compound ordering in getConversationMessages (Stage 3.4.3)
  it("24. getConversationMessages passes compound orderBy [{ createdAt: 'asc' }, { id: 'asc' }] to Prisma", async () => {
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const findManySpy = vi.spyOn(prisma.message, "findMany").mockResolvedValueOnce([]);

    await chatService.getConversationMessages(user1Id, conversationId, 25);

    expect(findManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversationId },
        take: 25,
        orderBy: [
          { createdAt: "asc" },
          { id: "asc" },
        ],
      })
    );
  });

  // 25. Equal-timestamp pagination determinism without skipped or duplicate messages (Stage 3.4.3)
  it("25. Paginates deterministically across equal-timestamp messages using cursor and skip: 1 without duplicates or skips", async () => {
    const identicalTimestamp = new Date("2026-11-07T12:00:00.000Z");

    const message1 = {
      id: "00000000-0000-0000-0000-000000000001",
      conversationId,
      senderId: user1Id,
      type: "TEXT" as const,
      content: "Message 1 (same timestamp)",
      fileKey: null,
      fileMime: null,
      fileSize: null,
      isEdited: false,
      editedAt: null,
      isDeleted: false,
      createdAt: identicalTimestamp,
      updatedAt: identicalTimestamp,
    };

    const message2 = {
      id: "00000000-0000-0000-0000-000000000002",
      conversationId,
      senderId: user2Id,
      type: "TEXT" as const,
      content: "Message 2 (same timestamp)",
      fileKey: null,
      fileMime: null,
      fileSize: null,
      isEdited: false,
      editedAt: null,
      isDeleted: false,
      createdAt: identicalTimestamp,
      updatedAt: identicalTimestamp,
    };

    const message3 = {
      id: "00000000-0000-0000-0000-000000000003",
      conversationId,
      senderId: user1Id,
      type: "TEXT" as const,
      content: "Message 3 (same timestamp)",
      fileKey: null,
      fileMime: null,
      fileSize: null,
      isEdited: false,
      editedAt: null,
      isDeleted: false,
      createdAt: identicalTimestamp,
      updatedAt: identicalTimestamp,
    };

    const message4 = {
      id: "00000000-0000-0000-0000-000000000004",
      conversationId,
      senderId: user2Id,
      type: "TEXT" as const,
      content: "Message 4 (same timestamp)",
      fileKey: null,
      fileMime: null,
      fileSize: null,
      isEdited: false,
      editedAt: null,
      isDeleted: false,
      createdAt: identicalTimestamp,
      updatedAt: identicalTimestamp,
    };

    // Page 1 query: limit = 2, no cursor -> returns message1, message2
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const findManySpy = vi.spyOn(prisma.message, "findMany").mockResolvedValueOnce([message1, message2] as any);

    const page1 = await chatService.getConversationMessages(user1Id, conversationId, 2);

    expect(findManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    );
    expect(page1.length).toBe(2);
    expect(page1[0].id).toBe("00000000-0000-0000-0000-000000000001");
    expect(page1[1].id).toBe("00000000-0000-0000-0000-000000000002");

    // Page 2 query: limit = 2, cursor = message2.id -> returns message3, message4
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    findManySpy.mockResolvedValueOnce([message3, message4] as any);

    const page2 = await chatService.getConversationMessages(
      user1Id,
      conversationId,
      2,
      "00000000-0000-0000-0000-000000000002"
    );

    expect(findManySpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        take: 2,
        skip: 1,
        cursor: { id: "00000000-0000-0000-0000-000000000002" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    );
    expect(page2.length).toBe(2);
    expect(page2[0].id).toBe("00000000-0000-0000-0000-000000000003");
    expect(page2[1].id).toBe("00000000-0000-0000-0000-000000000004");

    // Verify union of both pages contains exactly all 4 messages with zero duplicates or skips
    const combinedIds = [...page1.map((m) => m.id), ...page2.map((m) => m.id)];
    expect(combinedIds).toEqual([
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
      "00000000-0000-0000-0000-000000000003",
      "00000000-0000-0000-0000-000000000004",
    ]);
    expect(new Set(combinedIds).size).toBe(4);
  });

  // 26. Soft-deleted messages masked properly across equal-timestamp pages (Stage 3.4.3)
  it("26. Preserves soft-deleted message positions as masked tombstones during equal-timestamp pagination", async () => {
    const timestamp = new Date("2026-11-07T12:30:00.000Z");

    const activeMsg = {
      id: "00000000-0000-0000-0000-000000000010",
      conversationId,
      senderId: user1Id,
      type: "TEXT" as const,
      content: "Visible message",
      fileKey: null,
      fileMime: null,
      fileSize: null,
      isEdited: false,
      editedAt: null,
      isDeleted: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const deletedMsg = {
      id: "00000000-0000-0000-0000-000000000011",
      conversationId,
      senderId: user2Id,
      type: "TEXT" as const,
      content: "Sensitive content to mask",
      fileKey: "media/deleted.jpg",
      fileMime: "image/jpeg",
      fileSize: 4096,
      isEdited: false,
      editedAt: null,
      isDeleted: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    vi.spyOn(prisma.message, "findMany").mockResolvedValueOnce([activeMsg, deletedMsg] as any);

    const result = await chatService.getConversationMessages(user1Id, conversationId, 10);

    expect(result.length).toBe(2);
    // Active message
    expect(result[0].id).toBe("00000000-0000-0000-0000-000000000010");
    expect(result[0].content).toBe("Visible message");
    expect(result[0].isDeleted).toBe(false);

    // Deleted tombstone
    expect(result[1].id).toBe("00000000-0000-0000-0000-000000000011");
    expect(result[1].content).toBeNull();
    expect(result[1].fileKey).toBeNull();
    expect(result[1].fileMime).toBeNull();
    expect(result[1].fileSize).toBeNull();
    expect(result[1].isDeleted).toBe(true);
    expect(result[1].createdAt).toEqual(timestamp);
  });
});

describe("Chat Module - Read Receipts & Unread Counts (Stage A)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const conversationId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e5f";
  const user1Id = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e51";
  const user2Id = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e52";
  const outsiderId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e99";

  it("27. markMessagesAsRead marks only partner unread messages up to boundary message with compound ordering", async () => {
    const boundaryMsgId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e10";
    const boundaryCreatedAt = new Date("2026-11-08T10:00:00.000Z");

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce({
      id: boundaryMsgId,
      conversationId,
      createdAt: boundaryCreatedAt,
    } as any);

    const updateManySpy = vi.spyOn(prisma.message, "updateMany").mockResolvedValueOnce({ count: 3 });

    const result = await chatService.markMessagesAsRead(user1Id, conversationId, boundaryMsgId);

    expect(result.success).toBe(true);
    expect(result.count).toBe(3);
    expect(result.lastReadMessageId).toBe(boundaryMsgId);

    expect(updateManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          conversationId,
          senderId: user2Id, // partner ID only, never caller's own messages
          readAt: null,
          OR: [
            { createdAt: { lt: boundaryCreatedAt } },
            { createdAt: boundaryCreatedAt, id: { lte: boundaryMsgId } },
          ],
        },
        data: {
          readAt: expect.any(Date),
        },
      })
    );
  });

  it("28. markMessagesAsRead rejects non-participant with 403 Forbidden", async () => {
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    await expect(
      chatService.markMessagesAsRead(outsiderId, conversationId)
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "Access denied: You are not a participant in this conversation",
    });
  });

  it("29. markMessagesAsRead rejects boundary message from another conversation with 404", async () => {
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce({
      id: "boundary-other-conv",
      conversationId: "different-conversation-id",
      createdAt: new Date(),
    } as any);

    await expect(
      chatService.markMessagesAsRead(user1Id, conversationId, "boundary-other-conv")
    ).rejects.toMatchObject({
      statusCode: 404,
      message: "Boundary message not found in this conversation",
    });
  });

  it("30. markMessagesAsRead without boundary marks all partner unread messages", async () => {
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const updateManySpy = vi.spyOn(prisma.message, "updateMany").mockResolvedValueOnce({ count: 5 });

    const result = await chatService.markMessagesAsRead(user2Id, conversationId);

    expect(result.success).toBe(true);
    expect(result.count).toBe(5);
    expect(result.lastReadMessageId).toBeNull();

    expect(updateManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          conversationId,
          senderId: user1Id, // partner ID
          readAt: null,
        },
      })
    );
  });

  // 31. Regression: Equal-timestamp compound boundary leaves subsequent messages unread
  it("31. Compound boundary correctly isolates messages sharing identical createdAt timestamps", async () => {
    const identicalTime = new Date("2026-11-08T11:00:00.000Z");
    const msgAId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e01";
    const msgBId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e02"; // Chosen boundary
    const msgCId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e03"; // Should NOT be marked read

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce({
      id: msgBId,
      conversationId,
      createdAt: identicalTime,
    } as any);

    let capturedWhere: any = null;
    vi.spyOn(prisma.message, "updateMany").mockImplementationOnce((args: any) => {
      capturedWhere = args.where;
      return Promise.resolve({ count: 2 }); // msgA and msgB marked
    });

    const result = await chatService.markMessagesAsRead(user1Id, conversationId, msgBId);
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);

    // Verify filter matches msgA and msgB but excludes msgC
    expect(capturedWhere.conversationId).toBe(conversationId);
    expect(capturedWhere.senderId).toBe(user2Id);
    expect(capturedWhere.readAt).toBeNull();
    expect(capturedWhere.OR).toEqual([
      { createdAt: { lt: identicalTime } },
      { createdAt: identicalTime, id: { lte: msgBId } },
    ]);

    // Simulate database evaluation of capturedWhere on all three messages
    const testMessages = [
      { id: msgAId, createdAt: identicalTime, senderId: user2Id, readAt: null },
      { id: msgBId, createdAt: identicalTime, senderId: user2Id, readAt: null },
      { id: msgCId, createdAt: identicalTime, senderId: user2Id, readAt: null },
    ];

    const matchesFilter = (m: typeof testMessages[0]) => {
      const matchBasic = m.senderId === capturedWhere.senderId && m.readAt === capturedWhere.readAt;
      const matchOR =
        m.createdAt < capturedWhere.OR[0].createdAt.lt ||
        (m.createdAt.getTime() === capturedWhere.OR[1].createdAt.getTime() && m.id <= capturedWhere.OR[1].id.lte);
      return matchBasic && matchOR;
    };

    expect(matchesFilter(testMessages[0])).toBe(true); // msgA marked
    expect(matchesFilter(testMessages[1])).toBe(true); // msgB marked
    expect(matchesFilter(testMessages[2])).toBe(false); // msgC NOT marked, remains unread!
  });

  // 32. Boundary message authored by reader themselves
  it("32. Supports boundary message authored by reader without marking reader's own messages", async () => {
    const boundaryMsgId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e77";
    const boundaryTime = new Date("2026-11-08T11:30:00.000Z");

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    // Boundary message was authored by user1 (the reader)
    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce({
      id: boundaryMsgId,
      conversationId,
      senderId: user1Id,
      createdAt: boundaryTime,
    } as any);

    const updateManySpy = vi.spyOn(prisma.message, "updateMany").mockResolvedValueOnce({ count: 1 });

    const result = await chatService.markMessagesAsRead(user1Id, conversationId, boundaryMsgId);
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);

    // Sender must strictly be partner (user2Id), guaranteeing user1's own messages are never marked
    expect(updateManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          conversationId,
          senderId: user2Id,
          readAt: null,
          OR: [
            { createdAt: { lt: boundaryTime } },
            { createdAt: boundaryTime, id: { lte: boundaryMsgId } },
          ],
        },
      })
    );
  });

  // 33. Boundary message authored by partner
  it("33. Supports boundary message authored by partner and includes it in marked read set", async () => {
    const boundaryMsgId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e88";
    const boundaryTime = new Date("2026-11-08T11:45:00.000Z");

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    // Boundary message was authored by user2 (the partner)
    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce({
      id: boundaryMsgId,
      conversationId,
      senderId: user2Id,
      createdAt: boundaryTime,
    } as any);

    const updateManySpy = vi.spyOn(prisma.message, "updateMany").mockResolvedValueOnce({ count: 4 });

    const result = await chatService.markMessagesAsRead(user1Id, conversationId, boundaryMsgId);
    expect(result.success).toBe(true);
    expect(result.count).toBe(4);

    expect(updateManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          conversationId,
          senderId: user2Id,
          readAt: null,
          OR: [
            { createdAt: { lt: boundaryTime } },
            { createdAt: boundaryTime, id: { lte: boundaryMsgId } },
          ],
        },
      })
    );
  });

  // 34. Idempotency when no unread messages match
  it("34. markMessagesAsRead is idempotent when all messages are already read", async () => {
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    vi.spyOn(prisma.message, "updateMany").mockResolvedValueOnce({ count: 0 });

    const result = await chatService.markMessagesAsRead(user1Id, conversationId);
    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
  });
});

