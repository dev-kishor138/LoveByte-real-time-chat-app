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
import * as sockets from "../../sockets";

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

  // 7b. clientMutationId validation
  it("7b. Validates optional clientMutationId canonical UUID format in sendMessage validation", () => {
    const validUuid = "123e4567-e89b-12d3-a456-426614174000";
    // Valid canonical UUID passes
    expect(sendMessageSchema.safeParse({ content: "Hello", clientMutationId: validUuid }).success).toBe(true);
    // Missing clientMutationId passes (optional)
    expect(sendMessageSchema.safeParse({ content: "Hello" }).success).toBe(true);
    // Malformed clientMutationId fails
    expect(sendMessageSchema.safeParse({ content: "Hello", clientMutationId: "invalid-uuid" }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ content: "Hello", clientMutationId: 12345 as any }).success).toBe(false);
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

    const mockMessagesDesc = [
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
        createdAt: new Date("2026-11-09T05:01:00Z"),
        updatedAt: new Date("2026-11-09T05:01:00Z"),
      },
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
        createdAt: new Date("2026-11-09T05:00:00Z"),
        updatedAt: new Date("2026-11-09T05:00:00Z"),
      },
    ];

    vi.spyOn(prisma.message, "findMany").mockResolvedValueOnce(mockMessagesDesc as any);

    const result = await chatService.getConversationMessages(user1Id, conversationId, 50);
    expect(result.length).toBe(2);

    // Reversed to ascending order: Active message m-1 first, deleted m-2 second
    expect(result[0].id).toBe("m-1");
    expect(result[0].content).toBe("Active visible message");
    expect(result[0].isDeleted).toBe(false);

    // Deleted message payload is strictly masked
    expect(result[1].id).toBe("m-2");
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

  // 15d. Echoes clientMutationId in return value and message_sent event, while omitting from recipient new_message
  it("15d. Echoes clientMutationId in return value and message_sent event, while omitting from recipient new_message", async () => {
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const clientMutationId = "123e4567-e89b-12d3-a456-426614174000";
    const messageMock = {
      id: "msg-with-mutation-id",
      conversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "Hello with clientMutationId",
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
    vi.spyOn(prisma.conversation, "update").mockResolvedValueOnce({} as any);

    const emittedEvents: Array<{ event: string; payload: any; rooms: string[]; excluded: string[] }> = [];
    let currentRooms: string[] = [];
    let currentExcluded: string[] = [];
    const mockOperator: any = {
      to: vi.fn((r: string) => {
        currentRooms.push(r);
        return mockOperator;
      }),
      except: vi.fn((r: string) => {
        currentExcluded.push(r);
        return mockOperator;
      }),
      emit: vi.fn((event: string, payload: any) => {
        emittedEvents.push({
          event,
          payload,
          rooms: [...currentRooms],
          excluded: [...currentExcluded],
        });
        return true;
      }),
    };
    const mockIO: any = {
      to: vi.fn((r: string) => {
        currentRooms = [r];
        currentExcluded = [];
        return mockOperator;
      }),
    };

    vi.spyOn(sockets, "getIO").mockReturnValue(mockIO);

    const sent = await chatService.sendMessage(user1Id, conversationId, {
      content: "Hello with clientMutationId",
      type: "TEXT",
      clientMutationId,
    });

    // 1. Return value includes clientMutationId
    expect(sent.id).toBe("msg-with-mutation-id");
    expect((sent as any).clientMutationId).toBe(clientMutationId);

    // 2. Sender-side message_sent event includes clientMutationId
    const sentEvent = emittedEvents.find((e) => e.event === "message_sent");
    expect(sentEvent).toBeDefined();
    expect(sentEvent?.payload.clientMutationId).toBe(clientMutationId);
    expect(sentEvent?.rooms).toContain(`user:${user1Id}`);
    expect(sentEvent?.excluded).toEqual([]); // not excluded, reaches all sender sockets

    // 3. Recipient-side new_message event strictly OMITS clientMutationId
    const newMsgEvent = emittedEvents.find((e) => e.event === "new_message");
    expect(newMsgEvent).toBeDefined();
    expect(newMsgEvent?.payload.clientMutationId).toBeUndefined();
    expect(newMsgEvent?.rooms).toContain(`user:${user2Id}`);
    expect(newMsgEvent?.excluded).toContain(`user:${user1Id}`);
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

  // 24. Deterministic compound ordering in getConversationMessages (Stage 3.3 Remediation)
  it("24. getConversationMessages passes compound orderBy [{ createdAt: 'desc' }, { id: 'desc' }] to Prisma and reverses output to ascending", async () => {
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
          { createdAt: "desc" },
          { id: "desc" },
        ],
      })
    );
  });

  // 25. Equal-timestamp pagination determinism without skipped or duplicate messages (Stage 3.3 Remediation)
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

    // Page 1 query: limit = 2, no cursor -> Prisma queries newest records in DESC order: returns message4, message3
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const findManySpy = vi.spyOn(prisma.message, "findMany").mockResolvedValueOnce([message4, message3] as any);

    const page1 = await chatService.getConversationMessages(user1Id, conversationId, 2);

    expect(findManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      })
    );
    // Reversed by service to ascending chronological order
    expect(page1.length).toBe(2);
    expect(page1[0].id).toBe("00000000-0000-0000-0000-000000000003");
    expect(page1[1].id).toBe("00000000-0000-0000-0000-000000000004");

    // Page 2 query: limit = 2, cursor = oldest in page1 (message3.id) -> returns older messages in DESC order: message2, message1
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    findManySpy.mockResolvedValueOnce([message2, message1] as any);

    const page2 = await chatService.getConversationMessages(
      user1Id,
      conversationId,
      2,
      "00000000-0000-0000-0000-000000000003"
    );

    expect(findManySpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        take: 2,
        skip: 1,
        cursor: { id: "00000000-0000-0000-0000-000000000003" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      })
    );
    // Reversed by service to ascending chronological order
    expect(page2.length).toBe(2);
    expect(page2[0].id).toBe("00000000-0000-0000-0000-000000000001");
    expect(page2[1].id).toBe("00000000-0000-0000-0000-000000000002");

    // Prepending older page2 before page1 yields the complete ascending sequence with zero duplicates or skips
    const combinedIds = [...page2.map((m) => m.id), ...page1.map((m) => m.id)];
    expect(combinedIds).toEqual([
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
      "00000000-0000-0000-0000-000000000003",
      "00000000-0000-0000-0000-000000000004",
    ]);
    expect(new Set(combinedIds).size).toBe(4);
  });

  // 26. Soft-deleted messages masked properly across equal-timestamp pages (Stage 3.3 Remediation)
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

    // In descending DB order: deletedMsg (...11) comes first, activeMsg (...10) comes second
    vi.spyOn(prisma.message, "findMany").mockResolvedValueOnce([deletedMsg, activeMsg] as any);

    const result = await chatService.getConversationMessages(user1Id, conversationId, 10);

    expect(result.length).toBe(2);
    // Reversed by service: active message (...10) is first
    expect(result[0].id).toBe("00000000-0000-0000-0000-000000000010");
    expect(result[0].content).toBe("Visible message");
    expect(result[0].isDeleted).toBe(false);

    // Deleted tombstone (...11) is second
    expect(result[1].id).toBe("00000000-0000-0000-0000-000000000011");
    expect(result[1].content).toBeNull();
    expect(result[1].fileKey).toBeNull();
    expect(result[1].fileMime).toBeNull();
    expect(result[1].fileSize).toBeNull();
    expect(result[1].isDeleted).toBe(true);
    expect(result[1].createdAt).toEqual(timestamp);
  });

  // 27. Message pagination edge cases: initial load latest messages, older cursor, boundary page behavior (Stage 3.3 Remediation)
  it("27. Initial request returns latest limit messages in ascending order; older cursor returns strictly older messages", async () => {
    const t1 = new Date("2026-11-09T01:00:00Z");
    const t2 = new Date("2026-11-09T02:00:00Z");
    const t3 = new Date("2026-11-09T03:00:00Z");
    const t4 = new Date("2026-11-09T04:00:00Z");
    const t5 = new Date("2026-11-09T05:00:00Z");

    const m1 = { id: "m-01", conversationId, senderId: user1Id, type: "TEXT" as const, content: "Msg 1", isDeleted: false, createdAt: t1, updatedAt: t1 };
    const m2 = { id: "m-02", conversationId, senderId: user2Id, type: "TEXT" as const, content: "Msg 2", isDeleted: false, createdAt: t2, updatedAt: t2 };
    const m3 = { id: "m-03", conversationId, senderId: user1Id, type: "TEXT" as const, content: "Msg 3", isDeleted: false, createdAt: t3, updatedAt: t3 };
    const m4 = { id: "m-04", conversationId, senderId: user2Id, type: "TEXT" as const, content: "Msg 4", isDeleted: false, createdAt: t4, updatedAt: t4 };
    const m5 = { id: "m-05", conversationId, senderId: user1Id, type: "TEXT" as const, content: "Msg 5", isDeleted: false, createdAt: t5, updatedAt: t5 };

    // Initial page query: limit = 3, no cursor -> Prisma returns [m5, m4, m3] (the 3 newest)
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({ user1Id, user2Id } as any);
    const findManySpy = vi.spyOn(prisma.message, "findMany").mockResolvedValueOnce([m5, m4, m3] as any);

    const initialBatch = await chatService.getConversationMessages(user1Id, conversationId, 3);
    // Service returns [m3, m4, m5] in ascending chronological order
    expect(initialBatch.map((m) => m.id)).toEqual(["m-03", "m-04", "m-05"]);
    expect(initialBatch[0].createdAt).toEqual(t3);
    expect(initialBatch[2].createdAt).toEqual(t5);

    // Older cursor query: limit = 3, cursor = oldest from initialBatch ("m-03")
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({ user1Id, user2Id } as any);
    findManySpy.mockResolvedValueOnce([m2, m1] as any);

    const olderBatch = await chatService.getConversationMessages(user1Id, conversationId, 3, "m-03");
    // Service returns [m1, m2] in ascending chronological order
    expect(olderBatch.map((m) => m.id)).toEqual(["m-01", "m-02"]);
    expect(olderBatch[0].createdAt).toEqual(t1);
    expect(olderBatch[1].createdAt).toEqual(t2);

    // Prepending olderBatch before initialBatch gives full history [m1, m2, m3, m4, m5] without overlap
    const fullStream = [...olderBatch, ...initialBatch];
    expect(fullStream.map((m) => m.id)).toEqual(["m-01", "m-02", "m-03", "m-04", "m-05"]);

    // End-of-history query: cursor = oldest from olderBatch ("m-01") -> returns empty array
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({ user1Id, user2Id } as any);
    findManySpy.mockResolvedValueOnce([] as any);

    const emptyBatch = await chatService.getConversationMessages(user1Id, conversationId, 3, "m-01");
    expect(emptyBatch).toEqual([]);
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

// Stage 5: Persistent Message Idempotency & Safe Recovery
describe("Chat Module - Stage 5 Idempotency & Safe Recovery", () => {
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

  const conversationId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e5f";
  const user1Id = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e51";
  const user2Id = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e52";
  const outsiderId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e99";
  const mutationId1 = "123e4567-e89b-12d3-a456-426614174001";
  const mutationId2 = "123e4567-e89b-12d3-a456-426614174002";

    it("35. Persists clientMutationId in database when provided", async () => {
      vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
        user1Id,
        user2Id,
      } as any);

      const mockCreated = {
        id: "msg-idempotent-1",
        conversationId,
        senderId: user1Id,
        clientMutationId: mutationId1,
        type: "TEXT",
        content: "Idempotent text",
        fileKey: null,
        fileMime: null,
        fileSize: null,
        isEdited: false,
        editedAt: null,
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const createSpy = vi.spyOn(prisma.message, "create").mockResolvedValueOnce(mockCreated as any);
      vi.spyOn(prisma.conversation, "update").mockResolvedValueOnce({} as any);

      const result = await chatService.sendMessage(user1Id, conversationId, {
        content: "Idempotent text",
        type: "TEXT",
        clientMutationId: mutationId1,
      });

      expect(result.id).toBe("msg-idempotent-1");
      expect((result as any).clientMutationId).toBe(mutationId1);
      expect((result as any)._isDuplicate).toBeUndefined();
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            conversationId,
            senderId: user1Id,
            clientMutationId: mutationId1,
            content: "Idempotent text",
          }),
        })
      );
    });

    it("36. Idempotent retry with identical payload returns existing message without duplicate persistence", async () => {
      vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
        user1Id,
        user2Id,
      } as any);

      const p2002Error: any = new Error("Unique constraint failed on the fields: (conversationId, senderId, clientMutationId)");
      p2002Error.code = "P2002";

      vi.spyOn(prisma.message, "create").mockRejectedValueOnce(p2002Error);

      const existingMessage = {
        id: "existing-msg-id",
        conversationId,
        senderId: user1Id,
        clientMutationId: mutationId1,
        type: "TEXT",
        content: "Original message",
        fileKey: null,
        fileMime: null,
        fileSize: null,
        isEdited: false,
        editedAt: null,
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const findFirstSpy = vi.spyOn(prisma.message, "findFirst").mockResolvedValueOnce(existingMessage as any);

      const result = await chatService.sendMessage(user1Id, conversationId, {
        content: "Original message",
        type: "TEXT",
        clientMutationId: mutationId1,
      });

      expect(result.id).toBe("existing-msg-id");
      expect((result as any).clientMutationId).toBe(mutationId1);
      expect((result as any)._isDuplicate).toBe(true);
      expect(findFirstSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            conversationId,
            senderId: user1Id,
            clientMutationId: mutationId1,
          },
        })
      );
    });

    it("37. Suppresses recipient-facing new_message socket event on duplicate replay while emitting message_sent to sender", async () => {
      vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
        user1Id,
        user2Id,
      } as any);

      const p2002Error: any = new Error("Unique constraint failed");
      p2002Error.code = "P2002";

      vi.spyOn(prisma.message, "create").mockRejectedValueOnce(p2002Error);

      const existingMessage = {
        id: "existing-msg-id-2",
        conversationId,
        senderId: user1Id,
        clientMutationId: mutationId1,
        type: "TEXT",
        content: "Duplicate text",
        fileKey: null,
        fileMime: null,
        fileSize: null,
        isEdited: false,
        editedAt: null,
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.spyOn(prisma.message, "findFirst").mockResolvedValueOnce(existingMessage as any);

      const emittedEvents: Array<{ event: string; payload: any; rooms: string[]; excluded: string[] }> = [];
      let currentRooms: string[] = [];
      let currentExcluded: string[] = [];
      const mockOperator: any = {
        to: vi.fn((r: string) => {
          currentRooms.push(r);
          return mockOperator;
        }),
        except: vi.fn((r: string) => {
          currentExcluded.push(r);
          return mockOperator;
        }),
        emit: vi.fn((event: string, payload: any) => {
          emittedEvents.push({
            event,
            payload,
            rooms: [...currentRooms],
            excluded: [...currentExcluded],
          });
          return true;
        }),
      };
      const mockIO: any = {
        to: vi.fn((r: string) => {
          currentRooms = [r];
          currentExcluded = [];
          return mockOperator;
        }),
      };

      vi.spyOn(sockets, "getIO").mockReturnValue(mockIO);

      const result = await chatService.sendMessage(user1Id, conversationId, {
        content: "Duplicate text",
        type: "TEXT",
        clientMutationId: mutationId1,
      });

      expect(result.id).toBe("existing-msg-id-2");
      expect((result as any)._isDuplicate).toBe(true);

      // Verify new_message was strictly suppressed
      const newMsgEvent = emittedEvents.find((e) => e.event === "new_message");
      expect(newMsgEvent).toBeUndefined();

      // Verify message_sent was still emitted to sender room with clientMutationId
      const sentEvent = emittedEvents.find((e) => e.event === "message_sent");
      expect(sentEvent).toBeDefined();
      expect(sentEvent?.rooms).toContain(`user:${user1Id}`);
      expect(sentEvent?.payload.clientMutationId).toBe(mutationId1);
    });

    it("38. Rejects key reuse with different content with HTTP 409 Conflict", async () => {
      vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
        user1Id,
        user2Id,
      } as any);

      const p2002Error: any = new Error("Unique constraint failed");
      p2002Error.code = "P2002";

      vi.spyOn(prisma.message, "create").mockRejectedValueOnce(p2002Error);

      const existingMessage = {
        id: "existing-msg-id-3",
        conversationId,
        senderId: user1Id,
        clientMutationId: mutationId1,
        type: "TEXT",
        content: "First content version",
        fileKey: null,
        fileMime: null,
        fileSize: null,
        isEdited: false,
        editedAt: null,
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.spyOn(prisma.message, "findFirst").mockResolvedValueOnce(existingMessage as any);

      await expect(
        chatService.sendMessage(user1Id, conversationId, {
          content: "Second completely different content",
          type: "TEXT",
          clientMutationId: mutationId1,
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("Idempotency conflict"),
      });
    });

    it("39. Concurrent duplicate requests result in exactly one persisted message and zero duplicate broadcasts", async () => {
      vi.spyOn(prisma.conversation, "findUnique").mockResolvedValue({
        user1Id,
        user2Id,
      } as any);

      const persistedMessage = {
        id: "concurrent-msg-1",
        conversationId,
        senderId: user1Id,
        clientMutationId: mutationId2,
        type: "TEXT",
        content: "Concurrent test message",
        fileKey: null,
        fileMime: null,
        fileSize: null,
        isEdited: false,
        editedAt: null,
        isDeleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const p2002Error: any = new Error("Unique constraint failed");
      p2002Error.code = "P2002";

      // First call succeeds in creation, second call hits P2002 collision
      vi.spyOn(prisma.message, "create")
        .mockResolvedValueOnce(persistedMessage as any)
        .mockRejectedValueOnce(p2002Error);

      vi.spyOn(prisma.conversation, "update").mockResolvedValue({} as any);
      vi.spyOn(prisma.message, "findFirst").mockResolvedValueOnce(persistedMessage as any);

      const emittedEvents: Array<{ event: string; payload: any }> = [];
      const mockOperator: any = {
        to: vi.fn(() => mockOperator),
        except: vi.fn(() => mockOperator),
        emit: vi.fn((event: string, payload: any) => {
          emittedEvents.push({ event, payload });
          return true;
        }),
      };
      const mockIO: any = {
        to: vi.fn(() => mockOperator),
      };
      vi.spyOn(sockets, "getIO").mockReturnValue(mockIO);

      // Execute concurrently
      const [res1, res2] = await Promise.all([
        chatService.sendMessage(user1Id, conversationId, {
          content: "Concurrent test message",
          type: "TEXT",
          clientMutationId: mutationId2,
        }),
        chatService.sendMessage(user1Id, conversationId, {
          content: "Concurrent test message",
          type: "TEXT",
          clientMutationId: mutationId2,
        }),
      ]);

      expect(res1.id).toBe("concurrent-msg-1");
      expect(res2.id).toBe("concurrent-msg-1");
      expect((res1 as any)._isDuplicate).toBeUndefined();
      expect((res2 as any)._isDuplicate).toBe(true);

      // Exactly ONE new_message broadcast was emitted to recipient across both concurrent calls
      const newMsgBroadcasts = emittedEvents.filter((e) => e.event === "new_message");
      expect(newMsgBroadcasts.length).toBe(1);
    });

    it("40. Allows different senders in same conversation to use same clientMutationId independently", async () => {
      vi.spyOn(prisma.conversation, "findUnique").mockResolvedValue({
        user1Id,
        user2Id,
      } as any);

      const user1Message = {
        id: "user1-msg",
        conversationId,
        senderId: user1Id,
        clientMutationId: mutationId1,
        type: "TEXT",
        content: "User 1 message",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const user2Message = {
        id: "user2-msg",
        conversationId,
        senderId: user2Id,
        clientMutationId: mutationId1,
        type: "TEXT",
        content: "User 2 message",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const createSpy = vi.spyOn(prisma.message, "create")
        .mockResolvedValueOnce(user1Message as any)
        .mockResolvedValueOnce(user2Message as any);
      vi.spyOn(prisma.conversation, "update").mockResolvedValue({} as any);

      const res1 = await chatService.sendMessage(user1Id, conversationId, {
        content: "User 1 message",
        type: "TEXT",
        clientMutationId: mutationId1,
      });

      const res2 = await chatService.sendMessage(user2Id, conversationId, {
        content: "User 2 message",
        type: "TEXT",
        clientMutationId: mutationId1,
      });

      expect(res1.id).toBe("user1-msg");
      expect(res2.id).toBe("user2-msg");
      expect((res1 as any)._isDuplicate).toBeUndefined();
      expect((res2 as any)._isDuplicate).toBeUndefined();
      expect(createSpy).toHaveBeenCalledTimes(2);
    });

    it("41. Allows same sender to use same clientMutationId across different conversations independently", async () => {
      const conv2Id = "00000000-0000-0000-0000-000000000099";
      vi.spyOn(prisma.conversation, "findUnique")
        .mockResolvedValueOnce({ user1Id, user2Id } as any)
        .mockResolvedValueOnce({ user1Id, user2Id: outsiderId } as any);

      const conv1Msg = {
        id: "conv1-msg",
        conversationId,
        senderId: user1Id,
        clientMutationId: mutationId1,
        type: "TEXT",
        content: "Chat 1",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const conv2Msg = {
        id: "conv2-msg",
        conversationId: conv2Id,
        senderId: user1Id,
        clientMutationId: mutationId1,
        type: "TEXT",
        content: "Chat 2",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const createSpy = vi.spyOn(prisma.message, "create")
        .mockResolvedValueOnce(conv1Msg as any)
        .mockResolvedValueOnce(conv2Msg as any);
      vi.spyOn(prisma.conversation, "update").mockResolvedValue({} as any);

      const res1 = await chatService.sendMessage(user1Id, conversationId, {
        content: "Chat 1",
        type: "TEXT",
        clientMutationId: mutationId1,
      });

      const res2 = await chatService.sendMessage(user1Id, conv2Id, {
        content: "Chat 2",
        type: "TEXT",
        clientMutationId: mutationId1,
      });

      expect(res1.id).toBe("conv1-msg");
      expect(res2.id).toBe("conv2-msg");
      expect(createSpy).toHaveBeenCalledTimes(2);
    });

    it("42. Rejects unauthorized outsider before any idempotency lookup", async () => {
      vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
        user1Id,
        user2Id,
      } as any);

      const findFirstSpy = vi.spyOn(prisma.message, "findFirst");

      await expect(
        chatService.sendMessage(outsiderId, conversationId, {
          content: "Outsider spy",
          type: "TEXT",
          clientMutationId: mutationId1,
        })
      ).rejects.toMatchObject({
        statusCode: 403,
      });

      expect(findFirstSpy).not.toHaveBeenCalled();
    });

    it("43. getConversationMessages includes clientMutationId when present on message records", async () => {
      vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
        user1Id,
        user2Id,
      } as any);

      const mockDbMessages = [
        {
          id: "m-with-mutation",
          conversationId,
          senderId: user1Id,
          clientMutationId: mutationId1,
          type: "TEXT",
          content: "Has mutation ID",
          fileKey: null,
          fileMime: null,
          fileSize: null,
          isEdited: false,
          editedAt: null,
          isDeleted: false,
          readAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "m-legacy-null",
          conversationId,
          senderId: user1Id,
          clientMutationId: null,
          type: "TEXT",
          content: "Legacy message without mutation ID",
          fileKey: null,
          fileMime: null,
          fileSize: null,
          isEdited: false,
          editedAt: null,
          isDeleted: false,
          readAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      vi.spyOn(prisma.message, "findMany").mockResolvedValueOnce(mockDbMessages as any);

      const messages = await chatService.getConversationMessages(user1Id, conversationId, 10);
      expect(messages.length).toBe(2);

      const msgWithMutation = messages.find((m) => m.id === "m-with-mutation");
      expect(msgWithMutation?.clientMutationId).toBe(mutationId1);

      const legacyMsg = messages.find((m) => m.id === "m-legacy-null");
      expect(legacyMsg?.clientMutationId).toBeUndefined();
    });
  });
