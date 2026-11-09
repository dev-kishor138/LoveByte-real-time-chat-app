import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import {
  registerChatSocketHandlers,
  socketSendMessageSchema,
  socketEditMessageSchema,
  socketDeleteMessageSchema,
} from "./chat.socket";
import { AuthenticatedSocket } from "./socket.middleware";
import { prisma } from "../config/prisma";
import * as socketModule from "./index";
import { chatService } from "../modules/chat/chat.service";

function createMockSocket(
  userId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e5f",
  email = "alice.test@gmail.com",
  sessionId = "d2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f6a",
  socketId = "mock-socket-001"
): AuthenticatedSocket {
  const socket: any = new EventEmitter();
  socket.id = socketId;
  socket.connected = true;
  socket.rooms = new Set<string>([socketId, `user:${userId}`]);
  socket.data = {
    user: { userId, email, sessionId },
    tokenExp: Date.now() + 15 * 60 * 1000,
  };

  socket.on("error", () => {});

  const originalEmit = socket.emit.bind(socket);
  socket.emit = vi.fn((event: string, ...args: any[]) => {
    return originalEmit(event, ...args);
  });

  socket.join = vi.fn(async (room: string) => {
    socket.rooms.add(room);
  });

  socket.leave = vi.fn(async (room: string) => {
    socket.rooms.delete(room);
  });

  socket.disconnect = vi.fn((close?: boolean) => {
    socket.connected = false;
    socket.emit("disconnect");
    return socket;
  });

  socket.to = vi.fn().mockReturnValue({
    emit: vi.fn(),
  });

  return socket as AuthenticatedSocket;
}

function createMockIO() {
  const targetedRooms: string[] = [];
  const excludedRooms: string[] = [];
  const emittedEvents: Array<{
    event: string;
    payload: any;
    rooms: string[];
    excluded: string[];
  }> = [];

  const operator: any = {
    to: vi.fn((room: string) => {
      targetedRooms.push(room);
      return operator;
    }),
    except: vi.fn((room: string) => {
      excludedRooms.push(room);
      return operator;
    }),
    emit: vi.fn((event: string, payload: any) => {
      emittedEvents.push({
        event,
        payload,
        rooms: [...targetedRooms],
        excluded: [...excludedRooms],
      });
      return true;
    }),
  };

  const io: any = {
    to: vi.fn((room: string) => {
      targetedRooms.length = 0;
      excludedRooms.length = 0;
      targetedRooms.push(room);
      return operator;
    }),
    emit: vi.fn((event: string, payload: any) => {
      emittedEvents.push({ event, payload, rooms: [], excluded: [] });
      return true;
    }),
    _operator: operator,
    _emitted: emittedEvents,
    _targetedRooms: targetedRooms,
    _excludedRooms: excludedRooms,
  };

  return io;
}

describe("Chat Socket Handlers — Stage 3.2 Conversation Room Management", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const user1Id = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e5f";
  const user2Id = "d2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f6a";
  const nonParticipantId = "e3f4a5b6-c7d8-4e9f-a0b1-2c3d4e5f6a7b";
  const validConversationId = "f4a5b6c7-d8e9-4f0a-b1c2-3d4e5f6a7b8c";

  // 1. Participant user1 successfully joins
  it("1. Participant user1 successfully joins conversation room", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const ack = vi.fn();
    socket.emit("join_conversation", { conversationId: validConversationId }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(prisma.conversation.findUnique).toHaveBeenCalledWith({
      where: { id: validConversationId },
      select: { user1Id: true, user2Id: true },
    });
    expect(socket.join).toHaveBeenCalledWith(`conversation:${validConversationId}`);
    expect(socket.rooms.has(`conversation:${validConversationId}`)).toBe(true);
    expect(ack).toHaveBeenCalledWith({ success: true, conversationId: validConversationId });
    expect(socket.emit).toHaveBeenCalledWith("conversation_joined", {
      conversationId: validConversationId,
    });
  });

  // 2. Participant user2 successfully joins
  it("2. Participant user2 successfully joins conversation room", async () => {
    const socket = createMockSocket(user2Id);
    registerChatSocketHandlers(socket);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const ack = vi.fn();
    socket.emit("join_conversation", { conversationId: validConversationId }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(socket.join).toHaveBeenCalledWith(`conversation:${validConversationId}`);
    expect(socket.rooms.has(`conversation:${validConversationId}`)).toBe(true);
    expect(ack).toHaveBeenCalledWith({ success: true, conversationId: validConversationId });
    expect(socket.emit).toHaveBeenCalledWith("conversation_joined", {
      conversationId: validConversationId,
    });
  });

  // 3. Nonexistent conversation is rejected
  it("3. Nonexistent conversation is rejected with generic 'Access denied to this conversation'", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce(null);

    const ack = vi.fn();
    socket.emit("join_conversation", { conversationId: validConversationId }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(socket.join).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Access denied to this conversation",
    });
    expect(socket.emit).toHaveBeenCalledWith("error", {
      event: "join_conversation",
      error: "Access denied to this conversation",
    });
  });

  // 4. Non-participant is rejected
  it("4. Non-participant is rejected with the same generic 'Access denied to this conversation'", async () => {
    const socket = createMockSocket(nonParticipantId);
    registerChatSocketHandlers(socket);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const ack = vi.fn();
    socket.emit("join_conversation", { conversationId: validConversationId }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(socket.join).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Access denied to this conversation",
    });
    expect(socket.emit).toHaveBeenCalledWith("error", {
      event: "join_conversation",
      error: "Access denied to this conversation",
    });
  });

  // 5. Invalid UUID is rejected
  it("5. Invalid conversation UUID is rejected before database query", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const findSpy = vi.spyOn(prisma.conversation, "findUnique");

    const ack = vi.fn();
    socket.emit("join_conversation", { conversationId: "not-a-valid-uuid" }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(findSpy).not.toHaveBeenCalled();
    expect(socket.join).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({ success: false, error: "Invalid conversation ID" });
    expect(socket.emit).toHaveBeenCalledWith("error", {
      event: "join_conversation",
      error: "Invalid conversation ID",
    });
  });

  // 6. Ignores client-supplied userId
  it("6. Ignores client-supplied userId and relies strictly on socket.data.user.userId", async () => {
    const socket = createMockSocket(nonParticipantId);
    registerChatSocketHandlers(socket);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const ack = vi.fn();
    socket.emit(
      "join_conversation",
      { conversationId: validConversationId, userId: user1Id },
      ack
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(socket.join).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Access denied to this conversation",
    });
  });

  // 7. Ignores client-supplied roomName
  it("7. Ignores client-supplied roomName and constructs server-verified conversation:<id>", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const ack = vi.fn();
    socket.emit(
      "join_conversation",
      { conversationId: validConversationId, roomName: "arbitrary-injected-room" },
      ack
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(socket.join).toHaveBeenCalledWith(`conversation:${validConversationId}`);
    expect(socket.join).not.toHaveBeenCalledWith("arbitrary-injected-room");
  });

  // 8. Re-verifies on duplicate join
  it("8. Re-verifies authorization on duplicate join without redundantly calling socket.join()", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValue({
      user1Id,
      user2Id,
    } as any);

    socket.rooms.add(`conversation:${validConversationId}`);

    const ack = vi.fn();
    socket.emit("join_conversation", { conversationId: validConversationId }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(prisma.conversation.findUnique).toHaveBeenCalledTimes(1);
    expect(socket.join).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({ success: true, conversationId: validConversationId });
  });

  // 9. Re-checks database authorization on duplicate join
  it("9. Re-checks database authorization on duplicate join and rejects if participant access was revoked", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    socket.rooms.add(`conversation:${validConversationId}`);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce(null);

    const ack = vi.fn();
    socket.emit("join_conversation", { conversationId: validConversationId }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(prisma.conversation.findUnique).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Access denied to this conversation",
    });
  });

  // 10. Database failure safely fails closed
  it("10. Database failure safely fails closed and rejects with 'Unable to join conversation'", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    vi.spyOn(prisma.conversation, "findUnique").mockRejectedValueOnce(
      new Error("PostgreSQL connection timeout")
    );

    const ack = vi.fn();
    socket.emit("join_conversation", { conversationId: validConversationId }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(socket.join).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Unable to join conversation",
    });
    expect(socket.emit).toHaveBeenCalledWith("error", {
      event: "join_conversation",
      error: "Unable to join conversation",
    });
  });

  // 11. Successfully leaves conversation
  it("11. Successfully leaves conversation room via leave_conversation without database query", async () => {
    const socket = createMockSocket(user1Id);
    socket.rooms.add(`conversation:${validConversationId}`);
    registerChatSocketHandlers(socket);

    const findSpy = vi.spyOn(prisma.conversation, "findUnique");

    const ack = vi.fn();
    socket.emit("leave_conversation", { conversationId: validConversationId }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(findSpy).not.toHaveBeenCalled();
    expect(socket.leave).toHaveBeenCalledWith(`conversation:${validConversationId}`);
    expect(socket.rooms.has(`conversation:${validConversationId}`)).toBe(false);
    expect(ack).toHaveBeenCalledWith({ success: true, conversationId: validConversationId });
    expect(socket.emit).toHaveBeenCalledWith("conversation_left", {
      conversationId: validConversationId,
    });
  });

  // 12. Repeated leave operations
  it("12. Repeated leave operations are safe and idempotent", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const ack = vi.fn();
    socket.emit("leave_conversation", { conversationId: validConversationId }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(socket.leave).toHaveBeenCalledWith(`conversation:${validConversationId}`);
    expect(ack).toHaveBeenCalledWith({ success: true, conversationId: validConversationId });
  });

  // 13. Invalid UUID in leave_conversation
  it("13. Invalid UUID in leave_conversation is rejected", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const ack = vi.fn();
    socket.emit("leave_conversation", { conversationId: "invalid-uuid" }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(socket.leave).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({ success: false, error: "Invalid conversation ID" });
    expect(socket.emit).toHaveBeenCalledWith("error", {
      event: "leave_conversation",
      error: "Invalid conversation ID",
    });
  });

  // 14. Leaving conversation room preserves personal user room
  it("14. Leaving conversation room preserves personal user room and socket.id personal room", async () => {
    const socket = createMockSocket(user1Id, "alice.test@gmail.com", "sess-1", "mock-sock-1");
    socket.rooms.add(`conversation:${validConversationId}`);
    registerChatSocketHandlers(socket);

    socket.emit("leave_conversation", { conversationId: validConversationId });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(socket.rooms.has(`user:${user1Id}`)).toBe(true);
    expect(socket.rooms.has("mock-sock-1")).toBe(true);
    expect(socket.rooms.has(`conversation:${validConversationId}`)).toBe(false);
  });

  // 15. One socket leaving does not affect another socket
  it("15. One socket leaving a room does not affect another socket belonging to the same user", async () => {
    const socketA = createMockSocket(user1Id, "alice.test@gmail.com", "sess-1", "socket-phone");
    const socketB = createMockSocket(user1Id, "alice.test@gmail.com", "sess-1", "socket-laptop");

    socketA.rooms.add(`conversation:${validConversationId}`);
    socketB.rooms.add(`conversation:${validConversationId}`);

    registerChatSocketHandlers(socketA);
    registerChatSocketHandlers(socketB);

    socketA.emit("leave_conversation", { conversationId: validConversationId });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(socketA.rooms.has(`conversation:${validConversationId}`)).toBe(false);
    expect(socketB.rooms.has(`conversation:${validConversationId}`)).toBe(true);
  });

  // 16. Acknowledgement callback shapes
  it("16. Acknowledgement callback receives expected success and failure payloads", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const successAck = vi.fn();
    socket.emit("join_conversation", { conversationId: validConversationId }, successAck);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(successAck).toHaveBeenCalledWith({ success: true, conversationId: validConversationId });

    const failAck = vi.fn();
    socket.emit("join_conversation", { conversationId: "bad-id" }, failAck);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(failAck).toHaveBeenCalledWith({ success: false, error: "Invalid conversation ID" });
  });

  // 17. Emits conversation_joined, conversation_left, error
  it("17. Emits conversation_joined, conversation_left, and error events matching contract", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    socket.emit("join_conversation", { conversationId: validConversationId });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(socket.emit).toHaveBeenCalledWith("conversation_joined", {
      conversationId: validConversationId,
    });

    socket.emit("leave_conversation", { conversationId: validConversationId });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(socket.emit).toHaveBeenCalledWith("conversation_left", {
      conversationId: validConversationId,
    });

    socket.emit("join_conversation", { conversationId: "invalid" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(socket.emit).toHaveBeenCalledWith("error", {
      event: "join_conversation",
      error: "Invalid conversation ID",
    });
  });

  // 18. Rate limiting
  it("18. Rate limiting returns failure acknowledgement and emits error when limit is exceeded", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValue({
      user1Id,
      user2Id,
    } as any);

    for (let i = 0; i < 10; i++) {
      socket.emit("join_conversation", { conversationId: validConversationId });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));

    const ack = vi.fn();
    socket.emit("join_conversation", { conversationId: validConversationId }, ack);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ack).toHaveBeenCalledWith({ success: false, error: "Rate limit exceeded" });
    expect(socket.emit).toHaveBeenCalledWith("error", { error: "Rate limit exceeded" });
  });

  // 19. No Stage 3.3 message event is emitted by room handlers
  it("19. Confirms no Stage 3.3 message event is emitted by room handlers", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValue({
      user1Id,
      user2Id,
    } as any);

    socket.emit("join_conversation", { conversationId: validConversationId });
    socket.emit("leave_conversation", { conversationId: validConversationId });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(socket.emit).not.toHaveBeenCalledWith("new_message", expect.anything());
    expect(socket.emit).not.toHaveBeenCalledWith("message_sent", expect.anything());
    expect(socket.emit).not.toHaveBeenCalledWith("message_edited", expect.anything());
    expect(socket.emit).not.toHaveBeenCalledWith("message_deleted", expect.anything());
  });

  // 20. Rejects when unauthenticated
  it("20. Rejects join_conversation when socket has no authenticated user identity", async () => {
    const socket = createMockSocket(user1Id);
    delete (socket.data as any).user;
    registerChatSocketHandlers(socket);

    const ack = vi.fn();
    socket.emit("join_conversation", { conversationId: validConversationId }, ack);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(socket.join).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Access denied to this conversation",
    });
    expect(socket.emit).toHaveBeenCalledWith("error", {
      event: "join_conversation",
      error: "Access denied to this conversation",
    });
  });
});

describe("Chat Socket Handlers — Stage 3.3 Real-Time Message Event Handlers", () => {
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

  const user1Id = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e5f";
  const user2Id = "d2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f6a";
  const nonParticipantId = "e3f4a5b6-c7d8-4e9f-a0b1-2c3d4e5f6a7b";
  const validConversationId = "f4a5b6c7-d8e9-4f0a-b1c2-3d4e5f6a7b8c";
  const validMessageId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

  // === PART 1: send_message ===

  // 1. Valid message succeeds
  it("1. Valid message succeeds, persists to database, calls ack callback, and broadcasts to recipient", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const mockIO = createMockIO();
    vi.spyOn(socketModule, "getIO").mockReturnValue(mockIO as any);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const messageMock = {
      id: validMessageId,
      conversationId: validConversationId,
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

    vi.spyOn(prisma.message, "create").mockResolvedValueOnce(messageMock as any);
    vi.spyOn(prisma.conversation, "update").mockResolvedValueOnce({} as any);

    const ack = vi.fn();
    socket.emit(
      "send_message",
      { conversationId: validConversationId, type: "TEXT", content: "Hello friend!" },
      ack
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ack).toHaveBeenCalledWith({ success: true, message: messageMock });

    // Verify recipient notification
    const recipientEmission = mockIO._emitted.find((e) => e.event === "new_message");
    expect(recipientEmission).toBeDefined();
    expect(recipientEmission?.rooms).toContain(`conversation:${validConversationId}`);
    expect(recipientEmission?.rooms).toContain(`user:${user2Id}`);
    expect(recipientEmission?.excluded).toContain(`user:${user1Id}`);

    // Verify sender notification reaches all sockets of the user (including originating socket)
    const senderEmission = mockIO._emitted.find((e) => e.event === "message_sent");
    expect(senderEmission).toBeDefined();
    expect(senderEmission?.rooms).toContain(`user:${user1Id}`);
    expect(senderEmission?.excluded).toEqual([]);
  });

  // 2. Non-participant cannot send
  it("2. Non-participant cannot send, returns access denied error", async () => {
    const socket = createMockSocket(nonParticipantId);
    registerChatSocketHandlers(socket);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const createSpy = vi.spyOn(prisma.message, "create");

    const ack = vi.fn();
    socket.emit(
      "send_message",
      { conversationId: validConversationId, content: "Intruder message" },
      ack
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(createSpy).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Access denied to this conversation",
    });
    expect(socket.emit).toHaveBeenCalledWith("error", {
      event: "send_message",
      error: "Access denied to this conversation",
    });
  });

  // 3. Invalid conversation UUID rejected before service call
  it("3. Invalid conversation UUID rejected before service call", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const findSpy = vi.spyOn(prisma.conversation, "findUnique");
    const ack = vi.fn();
    socket.emit(
      "send_message",
      { conversationId: "not-a-valid-uuid", content: "Hello" },
      ack
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(findSpy).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Invalid conversation ID format",
    });
    expect(socket.emit).toHaveBeenCalledWith("error", {
      event: "send_message",
      error: "Invalid conversation ID format",
    });
  });

  // 4. Empty and whitespace-only content rejected
  it("4. Empty and whitespace-only content rejected", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const ack1 = vi.fn();
    socket.emit("send_message", { conversationId: validConversationId, content: "" }, ack1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ack1).toHaveBeenCalledWith({
      success: false,
      error: "Message content cannot be empty",
    });

    const ack2 = vi.fn();
    socket.emit(
      "send_message",
      { conversationId: validConversationId, content: "     " },
      ack2
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ack2).toHaveBeenCalledWith({
      success: false,
      error: "Message content cannot be empty",
    });
  });

  // 5. Content over 5000 characters rejected
  it("5. Content over 5000 characters rejected", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const ack = vi.fn();
    socket.emit(
      "send_message",
      { conversationId: validConversationId, content: "a".repeat(5001) },
      ack
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Message content cannot exceed 5000 characters",
    });
  });

  // 6. Client-supplied senderId/userId cannot impersonate another user
  it("6. Client-supplied senderId/userId cannot impersonate another user", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const createSpy = vi.spyOn(prisma.message, "create").mockResolvedValueOnce({
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "Spoofed?",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    vi.spyOn(prisma.conversation, "update").mockResolvedValueOnce({} as any);

    const ack = vi.fn();
    socket.emit(
      "send_message",
      {
        conversationId: validConversationId,
        content: "Spoofed?",
        senderId: user2Id,
        userId: user2Id,
      },
      ack
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          senderId: user1Id, // Cryptographically verified identity strictly used
        }),
      })
    );
  });

  // 7. IMAGE and VOICE rejected
  it("7. IMAGE and VOICE types rejected in Stage 3.3", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const ack1 = vi.fn();
    socket.emit(
      "send_message",
      { conversationId: validConversationId, type: "IMAGE", content: "img" },
      ack1
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ack1).toHaveBeenCalledWith({
      success: false,
      error: "Only TEXT messages are supported",
    });

    const ack2 = vi.fn();
    socket.emit(
      "send_message",
      { conversationId: validConversationId, type: "VOICE", content: "voice" },
      ack2
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ack2).toHaveBeenCalledWith({
      success: false,
      error: "Only TEXT messages are supported",
    });
  });

  // 8. Rate-limited request never reaches service
  it("8. Rate-limited request never reaches service", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const findSpy = vi.spyOn(prisma.conversation, "findUnique");

    // Flood 10 events
    for (let i = 0; i < 10; i++) {
      socket.emit("send_message", {
        conversationId: validConversationId,
        content: `Msg ${i}`,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 11th event exceeds rate limit
    const ack = vi.fn();
    socket.emit(
      "send_message",
      { conversationId: validConversationId, content: "11th message" },
      ack
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ack).toHaveBeenCalledWith({ success: false, error: "Rate limit exceeded" });
    expect(socket.emit).toHaveBeenCalledWith("error", { error: "Rate limit exceeded" });
  });

  // 9. Database/service failure produces no success notification
  it("9. Database/service failure produces no success notification and fails closed", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const mockIO = createMockIO();
    vi.spyOn(socketModule, "getIO").mockReturnValue(mockIO as any);

    vi.spyOn(prisma.conversation, "findUnique").mockRejectedValueOnce(
      new Error("Postgres connection dropped")
    );

    const ack = vi.fn();
    socket.emit(
      "send_message",
      { conversationId: validConversationId, content: "Crash test" },
      ack
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ack).toHaveBeenCalledWith({ success: false, error: "Unable to send message" });
    expect(socket.emit).toHaveBeenCalledWith("error", {
      event: "send_message",
      error: "Unable to send message",
    });
    expect(mockIO._emitted.length).toBe(0);
  });

  // 10. Initiating socket receives acknowledgement only
  it("10. Initiating socket receives acknowledgement only (no duplicate outbound event)", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const mockIO = createMockIO();
    vi.spyOn(socketModule, "getIO").mockReturnValue(mockIO as any);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    vi.spyOn(prisma.message, "create").mockResolvedValueOnce({
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "Ack check",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    vi.spyOn(prisma.conversation, "update").mockResolvedValueOnce({} as any);

    const ack = vi.fn();
    socket.emit(
      "send_message",
      { conversationId: validConversationId, content: "Ack check" },
      ack
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, message: expect.anything() })
    );

    // Verify initiating socket itself did NOT receive new_message or message_sent
    expect(socket.emit).not.toHaveBeenCalledWith("new_message", expect.anything());
    expect(socket.emit).not.toHaveBeenCalledWith("message_sent", expect.anything());
  });

  // 11. Recipient in both user and conversation rooms receives exactly one notification
  it("11. Recipient in both user and conversation rooms receives exactly one notification via chained union", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const mockIO = createMockIO();
    vi.spyOn(socketModule, "getIO").mockReturnValue(mockIO as any);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    vi.spyOn(prisma.message, "create").mockResolvedValueOnce({
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "Union test",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    vi.spyOn(prisma.conversation, "update").mockResolvedValueOnce({} as any);

    socket.emit("send_message", { conversationId: validConversationId, content: "Union test" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Exactly one new_message emission was dispatched by the server
    const newMessageEmissions = mockIO._emitted.filter((e) => e.event === "new_message");
    expect(newMessageEmissions.length).toBe(1);
    expect(newMessageEmissions[0].rooms).toEqual([
      `conversation:${validConversationId}`,
      `user:${user2Id}`,
    ]);
    expect(newMessageEmissions[0].excluded).toEqual([`user:${user1Id}`]);
  });

  // 12. Sender's devices receive message_sent (including originating socket for timeout reconciliation)
  it("12. Sender's devices receive message_sent (including originating socket)", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const mockIO = createMockIO();
    vi.spyOn(socketModule, "getIO").mockReturnValue(mockIO as any);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    vi.spyOn(prisma.message, "create").mockResolvedValueOnce({
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "Secondary device test",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    vi.spyOn(prisma.conversation, "update").mockResolvedValueOnce({} as any);

    socket.emit("send_message", {
      conversationId: validConversationId,
      content: "Secondary device test",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const messageSentEmissions = mockIO._emitted.filter((e) => e.event === "message_sent");
    expect(messageSentEmissions.length).toBe(1);
    expect(messageSentEmissions[0].rooms).toEqual([`user:${user1Id}`]);
    expect(messageSentEmissions[0].excluded).toEqual([]);
  });

  // === PART 2: edit_message ===

  // 13. Author can edit within 24 hours
  it("13. Author can edit text message within 24 hours", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const mockIO = createMockIO();
    vi.spyOn(socketModule, "getIO").mockReturnValue(mockIO as any);

    const existingMessage = {
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "Original text",
      isDeleted: false,
      createdAt: new Date(Date.now() - 3600000), // 1 hour ago
      conversation: { id: validConversationId, user1Id, user2Id },
    };

    const updatedMessage = {
      ...existingMessage,
      content: "Edited text",
      isEdited: true,
      editedAt: new Date(),
    };

    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce(existingMessage as any);
    vi.spyOn(prisma.message, "update").mockResolvedValueOnce(updatedMessage as any);

    const ack = vi.fn();
    socket.emit(
      "edit_message",
      { messageId: validMessageId, content: "Edited text" },
      ack
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ack).toHaveBeenCalledWith({ success: true, message: updatedMessage });

    const editEmission = mockIO._emitted.find((e) => e.event === "message_edited");
    expect(editEmission).toBeDefined();
    expect(editEmission?.rooms).toContain(`conversation:${validConversationId}`);
    expect(editEmission?.rooms).toContain(`user:${user2Id}`);
    expect(editEmission?.rooms).toContain(`user:${user1Id}`);
    expect(editEmission?.excluded).toContain(socket.id);
  });

  // 14. Non-author cannot edit
  it("14. Non-author cannot edit another user's message", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const existingMessage = {
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user2Id, // Owned by user2
      type: "TEXT",
      content: "User2 original",
      isDeleted: false,
      createdAt: new Date(Date.now() - 3600000),
      conversation: { id: validConversationId, user1Id, user2Id },
    };

    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce(existingMessage as any);
    const updateSpy = vi.spyOn(prisma.message, "update");

    const ack = vi.fn();
    socket.emit(
      "edit_message",
      { messageId: validMessageId, content: "Malicious edit" },
      ack
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(updateSpy).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Forbidden: You can only edit your own messages",
    });
    expect(socket.emit).toHaveBeenCalledWith("error", {
      event: "edit_message",
      error: "Forbidden: You can only edit your own messages",
    });
  });

  // 15. Expired edit window rejected
  it("15. Expired edit window (>24h) rejected", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const existingMessage = {
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "Old message",
      isDeleted: false,
      createdAt: new Date(Date.now() - 25 * 3600000), // 25 hours ago
      conversation: { id: validConversationId, user1Id, user2Id },
    };

    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce(existingMessage as any);

    const ack = vi.fn();
    socket.emit(
      "edit_message",
      { messageId: validMessageId, content: "Late edit" },
      ack
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Messages can only be edited within 24 hours of creation",
    });
  });

  // 16. Deleted message cannot be edited
  it("16. Deleted message cannot be edited", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const existingMessage = {
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user1Id,
      type: "TEXT",
      content: null,
      isDeleted: true, // Already soft-deleted
      createdAt: new Date(Date.now() - 3600000),
      conversation: { id: validConversationId, user1Id, user2Id },
    };

    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce(existingMessage as any);

    const ack = vi.fn();
    socket.emit(
      "edit_message",
      { messageId: validMessageId, content: "Revive message" },
      ack
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Cannot edit a deleted message",
    });
  });

  // 17. Non-TEXT message cannot be edited
  it("17. Non-TEXT message cannot be edited", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const existingMessage = {
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user1Id,
      type: "IMAGE",
      content: null,
      isDeleted: false,
      createdAt: new Date(Date.now() - 3600000),
      conversation: { id: validConversationId, user1Id, user2Id },
    };

    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce(existingMessage as any);

    const ack = vi.fn();
    socket.emit(
      "edit_message",
      { messageId: validMessageId, content: "Edit image text" },
      ack
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Only text messages can be edited",
    });
  });

  // 18. Invalid content rejected
  it("18. Invalid content rejected (empty, whitespace-only, >5000 chars, invalid messageId UUID)", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const ack1 = vi.fn();
    socket.emit("edit_message", { messageId: "invalid-uuid", content: "Valid text" }, ack1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ack1).toHaveBeenCalledWith({
      success: false,
      error: "Invalid message ID format",
    });

    const ack2 = vi.fn();
    socket.emit("edit_message", { messageId: validMessageId, content: "" }, ack2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ack2).toHaveBeenCalledWith({
      success: false,
      error: "Message content cannot be empty",
    });

    const ack3 = vi.fn();
    socket.emit("edit_message", { messageId: validMessageId, content: "   " }, ack3);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ack3).toHaveBeenCalledWith({
      success: false,
      error: "Message content cannot be empty",
    });

    const ack4 = vi.fn();
    socket.emit(
      "edit_message",
      { messageId: validMessageId, content: "a".repeat(5001) },
      ack4
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ack4).toHaveBeenCalledWith({
      success: false,
      error: "Message content cannot exceed 5000 characters",
    });
  });

  // 19. Rate limiting works on edit_message
  it("19. Rate limiting works on edit_message", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    for (let i = 0; i < 10; i++) {
      socket.emit("edit_message", { messageId: validMessageId, content: `Edit ${i}` });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));

    const ack = vi.fn();
    socket.emit(
      "edit_message",
      { messageId: validMessageId, content: "11th edit" },
      ack
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ack).toHaveBeenCalledWith({ success: false, error: "Rate limit exceeded" });
  });

  // 20. Initiating socket receives acknowledgement only for edit_message
  it("20. Initiating socket receives acknowledgement only for edit_message", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const mockIO = createMockIO();
    vi.spyOn(socketModule, "getIO").mockReturnValue(mockIO as any);

    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce({
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "Original",
      isDeleted: false,
      createdAt: new Date(),
      conversation: { id: validConversationId, user1Id, user2Id },
    } as any);

    vi.spyOn(prisma.message, "update").mockResolvedValueOnce({
      id: validMessageId,
      conversationId: validConversationId,
      content: "Updated",
      isEdited: true,
      editedAt: new Date(),
    } as any);

    const ack = vi.fn();
    socket.emit("edit_message", { messageId: validMessageId, content: "Updated" }, ack);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, message: expect.anything() })
    );
    expect(socket.emit).not.toHaveBeenCalledWith("message_edited", expect.anything());
  });

  // 21. Both participants' other devices receive one notification each
  it("21. Both participants' other devices receive one notification each via chained union", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const mockIO = createMockIO();
    vi.spyOn(socketModule, "getIO").mockReturnValue(mockIO as any);

    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce({
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "Original",
      isDeleted: false,
      createdAt: new Date(),
      conversation: { id: validConversationId, user1Id, user2Id },
    } as any);

    vi.spyOn(prisma.message, "update").mockResolvedValueOnce({
      id: validMessageId,
      conversationId: validConversationId,
      content: "Updated",
      isEdited: true,
      editedAt: new Date(),
    } as any);

    socket.emit("edit_message", { messageId: validMessageId, content: "Updated" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const editEmissions = mockIO._emitted.filter((e) => e.event === "message_edited");
    expect(editEmissions.length).toBe(1);
    expect(editEmissions[0].rooms).toEqual([
      `conversation:${validConversationId}`,
      `user:${user2Id}`,
      `user:${user1Id}`,
    ]);
    expect(editEmissions[0].excluded).toEqual([socket.id]);
  });

  // === PART 3: delete_message ===

  // 22. Author can soft-delete
  it("22. Author can soft-delete message", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const mockIO = createMockIO();
    vi.spyOn(socketModule, "getIO").mockReturnValue(mockIO as any);

    const existingMessage = {
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "To be deleted",
      isDeleted: false,
      createdAt: new Date(),
      conversation: { id: validConversationId, user1Id, user2Id },
    };

    const deletedMessage = {
      ...existingMessage,
      content: null,
      isDeleted: true,
      updatedAt: new Date(),
    };

    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce(existingMessage as any);
    vi.spyOn(prisma.message, "update").mockResolvedValueOnce(deletedMessage as any);

    const ack = vi.fn();
    socket.emit("delete_message", { messageId: validMessageId }, ack);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ack).toHaveBeenCalledWith({
      success: true,
      messageId: validMessageId,
      tombstone: {
        id: validMessageId,
        conversationId: validConversationId,
        isDeleted: true,
        updatedAt: expect.any(Date),
      },
    });

    const deleteEmission = mockIO._emitted.find((e) => e.event === "message_deleted");
    expect(deleteEmission).toBeDefined();
    expect(deleteEmission?.rooms).toContain(`conversation:${validConversationId}`);
    expect(deleteEmission?.rooms).toContain(`user:${user2Id}`);
    expect(deleteEmission?.rooms).toContain(`user:${user1Id}`);
    expect(deleteEmission?.excluded).toContain(socket.id);
  });

  // 23. Non-author cannot delete
  it("23. Non-author cannot delete message", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const existingMessage = {
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user2Id, // Owned by user2
      type: "TEXT",
      content: "User2 message",
      isDeleted: false,
      conversation: { id: validConversationId, user1Id, user2Id },
    };

    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce(existingMessage as any);
    const updateSpy = vi.spyOn(prisma.message, "update");

    const ack = vi.fn();
    socket.emit("delete_message", { messageId: validMessageId }, ack);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(updateSpy).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Forbidden: You can only delete your own messages",
    });
  });

  // 24. Already deleted message rejected
  it("24. Already deleted message rejected", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const existingMessage = {
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user1Id,
      type: "TEXT",
      content: null,
      isDeleted: true,
      conversation: { id: validConversationId, user1Id, user2Id },
    };

    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce(existingMessage as any);

    const ack = vi.fn();
    socket.emit("delete_message", { messageId: validMessageId }, ack);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Message is already deleted",
    });
  });

  // 25. Tombstone contains no plaintext content
  it("25. Tombstone contains no plaintext content and masks all media metadata", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const mockIO = createMockIO();
    vi.spyOn(socketModule, "getIO").mockReturnValue(mockIO as any);

    const existingMessage = {
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "Sensitive secret plaintext",
      isDeleted: false,
      createdAt: new Date(),
      conversation: { id: validConversationId, user1Id, user2Id },
    };

    const deletedMessage = {
      id: validMessageId,
      conversationId: validConversationId,
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
    };

    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce(existingMessage as any);
    vi.spyOn(prisma.message, "update").mockResolvedValueOnce(deletedMessage as any);

    const ack = vi.fn();
    socket.emit("delete_message", { messageId: validMessageId }, ack);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ack).toHaveBeenCalledWith({
      success: true,
      messageId: validMessageId,
      tombstone: {
        id: validMessageId,
        conversationId: validConversationId,
        isDeleted: true,
        updatedAt: expect.any(Date),
      },
    });

    const deleteEmission = mockIO._emitted.find((e) => e.event === "message_deleted");
    expect(deleteEmission?.payload.content).toBeUndefined();
    expect(deleteEmission?.payload.isDeleted).toBe(true);
  });

  // 26. Rate limiting works on delete_message
  it("26. Rate limiting works on delete_message", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    for (let i = 0; i < 10; i++) {
      socket.emit("delete_message", { messageId: validMessageId });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));

    const ack = vi.fn();
    socket.emit("delete_message", { messageId: validMessageId }, ack);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ack).toHaveBeenCalledWith({ success: false, error: "Rate limit exceeded" });
  });

  // 27. Initiating socket receives acknowledgement only for delete_message
  it("27. Initiating socket receives acknowledgement only for delete_message", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const mockIO = createMockIO();
    vi.spyOn(socketModule, "getIO").mockReturnValue(mockIO as any);

    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce({
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "Hello",
      isDeleted: false,
      createdAt: new Date(),
      conversation: { id: validConversationId, user1Id, user2Id },
    } as any);

    vi.spyOn(prisma.message, "update").mockResolvedValueOnce({
      id: validMessageId,
      conversationId: validConversationId,
      content: null,
      isDeleted: true,
      updatedAt: new Date(),
    } as any);

    const ack = vi.fn();
    socket.emit("delete_message", { messageId: validMessageId }, ack);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, messageId: validMessageId })
    );
    expect(socket.emit).not.toHaveBeenCalledWith("message_deleted", expect.anything());
  });

  // 28. Both participants' other devices receive one notification each for delete_message
  it("28. Both participants' other devices receive one notification each for delete_message", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const mockIO = createMockIO();
    vi.spyOn(socketModule, "getIO").mockReturnValue(mockIO as any);

    vi.spyOn(prisma.message, "findUnique").mockResolvedValueOnce({
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "Hello",
      isDeleted: false,
      createdAt: new Date(),
      conversation: { id: validConversationId, user1Id, user2Id },
    } as any);

    vi.spyOn(prisma.message, "update").mockResolvedValueOnce({
      id: validMessageId,
      conversationId: validConversationId,
      content: null,
      isDeleted: true,
      updatedAt: new Date(),
    } as any);

    socket.emit("delete_message", { messageId: validMessageId });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const deleteEmissions = mockIO._emitted.filter((e) => e.event === "message_deleted");
    expect(deleteEmissions.length).toBe(1);
    expect(deleteEmissions[0].rooms).toEqual([
      `conversation:${validConversationId}`,
      `user:${user2Id}`,
      `user:${user1Id}`,
    ]);
    expect(deleteEmissions[0].excluded).toEqual([socket.id]);
  });

  // === PART 4: Regression and isolation ===

  // 29. Existing REST service calls still work without an originating socket ID
  it("29. Existing REST service calls still work without an originating socket ID", async () => {
    const mockIO = createMockIO();
    vi.spyOn(socketModule, "getIO").mockReturnValue(mockIO as any);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    vi.spyOn(prisma.message, "create").mockResolvedValueOnce({
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "REST originated",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    vi.spyOn(prisma.conversation, "update").mockResolvedValueOnce({} as any);

    // REST call without originatingSocketId
    const result = await chatService.sendMessage(user1Id, validConversationId, {
      type: "TEXT",
      content: "REST originated",
    });

    expect(result.id).toBe(validMessageId);

    // message_sent should notify all sender devices without excluding any socket
    const messageSentEmission = mockIO._emitted.find((e) => e.event === "message_sent");
    expect(messageSentEmission?.rooms).toEqual([`user:${user1Id}`]);
    expect(messageSentEmission?.excluded).toEqual([]);
  });

  // 30. Chained room-union broadcasts do not duplicate events
  it("30. Chained room-union broadcasts do not duplicate events across overlapping rooms", async () => {
    const mockIO = createMockIO();
    vi.spyOn(socketModule, "getIO").mockReturnValue(mockIO as any);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    vi.spyOn(prisma.message, "create").mockResolvedValueOnce({
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "No dups",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    vi.spyOn(prisma.conversation, "update").mockResolvedValueOnce({} as any);

    await chatService.sendMessage(user1Id, validConversationId, {
      type: "TEXT",
      content: "No dups",
    });

    // Exactly one new_message event emitted, with both rooms targeted in that single emission
    const newMessageEmissions = mockIO._emitted.filter((e) => e.event === "new_message");
    expect(newMessageEmissions.length).toBe(1);
    expect(newMessageEmissions[0].rooms.length).toBe(2);
  });

  // 31. Unrelated sockets receive no private message notifications
  it("31. Unrelated sockets receive no private message notifications", async () => {
    const mockIO = createMockIO();
    vi.spyOn(socketModule, "getIO").mockReturnValue(mockIO as any);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    vi.spyOn(prisma.message, "create").mockResolvedValueOnce({
      id: validMessageId,
      conversationId: validConversationId,
      senderId: user1Id,
      type: "TEXT",
      content: "Private message",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    vi.spyOn(prisma.conversation, "update").mockResolvedValueOnce({} as any);

    await chatService.sendMessage(user1Id, validConversationId, {
      type: "TEXT",
      content: "Private message",
    });

    for (const emission of mockIO._emitted) {
      expect(emission.rooms).not.toContain(`user:${nonParticipantId}`);
      expect(emission.rooms).not.toContain(`conversation:different-conv-id`);
    }
  });

  // 32. Schema parsing validation directly
  it("32. Dedicated socket schemas validate payloads and reject malformed inputs", () => {
    // socketSendMessageSchema
    expect(
      socketSendMessageSchema.safeParse({
        conversationId: validConversationId,
        type: "TEXT",
        content: "Valid",
      }).success
    ).toBe(true);
    expect(
      socketSendMessageSchema.safeParse({
        conversationId: "invalid",
        content: "Valid",
      }).success
    ).toBe(false);
    expect(
      socketSendMessageSchema.safeParse({
        conversationId: validConversationId,
        content: "   ",
      }).success
    ).toBe(false);

    // socketEditMessageSchema
    expect(
      socketEditMessageSchema.safeParse({
        messageId: validMessageId,
        content: "Valid edit",
      }).success
    ).toBe(true);
    expect(
      socketEditMessageSchema.safeParse({
        messageId: "not-a-uuid",
        content: "Valid edit",
      }).success
    ).toBe(false);

    // socketDeleteMessageSchema
    expect(
      socketDeleteMessageSchema.safeParse({
        messageId: validMessageId,
      }).success
    ).toBe(true);
    expect(
      socketDeleteMessageSchema.safeParse({
        messageId: "bad-id",
      }).success
    ).toBe(false);
  });

  // === PART 5: Missing socket identity authentication tests ===

  // 33. Rejects send_message with 'Authentication required' when socket lacks authenticated identity
  it("33. Rejects send_message with 'Authentication required' when socket lacks authenticated identity", async () => {
    const socket = createMockSocket(user1Id);
    delete (socket.data as any).user;
    registerChatSocketHandlers(socket);

    const ack = vi.fn();
    socket.emit(
      "send_message",
      { conversationId: validConversationId, type: "TEXT", content: "Unauthenticated send" },
      ack
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Authentication required",
    });
    expect(socket.emit).toHaveBeenCalledWith("error", {
      event: "send_message",
      error: "Authentication required",
    });
  });

  // 34. Rejects edit_message with 'Authentication required' when socket lacks authenticated identity
  it("34. Rejects edit_message with 'Authentication required' when socket lacks authenticated identity", async () => {
    const socket = createMockSocket(user1Id);
    delete (socket.data as any).user;
    registerChatSocketHandlers(socket);

    const ack = vi.fn();
    socket.emit(
      "edit_message",
      { messageId: validMessageId, content: "Unauthenticated edit" },
      ack
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Authentication required",
    });
    expect(socket.emit).toHaveBeenCalledWith("error", {
      event: "edit_message",
      error: "Authentication required",
    });
  });

  // 35. Rejects delete_message with 'Authentication required' when socket lacks authenticated identity
  it("35. Rejects delete_message with 'Authentication required' when socket lacks authenticated identity", async () => {
    const socket = createMockSocket(user1Id);
    delete (socket.data as any).user;
    registerChatSocketHandlers(socket);

    const ack = vi.fn();
    socket.emit("delete_message", { messageId: validMessageId }, ack);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Authentication required",
    });
    expect(socket.emit).toHaveBeenCalledWith("error", {
      event: "delete_message",
      error: "Authentication required",
    });
  });
});

describe("Chat Socket Handlers — Stage 3.4.3 Reconnection & Room Restoration Contracts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const user1Id = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e5f";
  const user2Id = "d2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f6a";
  const nonParticipantId = "e3f4a5b6-c7d8-4e9f-a0b1-2c3d4e5f6a7b";
  const conversationId = "f4a5b6c7-d8e9-4f0a-b1c2-3d4e5f6a7b8c";

  // 1. Reconnected socket successfully rejoins an authorized conversation
  it("1. Reconnected socket successfully rejoins an authorized conversation using existing join_conversation", async () => {
    // Fresh reconnected socket has a new socketId and only default personal room
    const reconnectedSocket = createMockSocket(user1Id, "alice@test.com", "session-new", "reconnected-socket-002");
    registerChatSocketHandlers(reconnectedSocket);

    expect(reconnectedSocket.rooms.has(`conversation:${conversationId}`)).toBe(false);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const ack = vi.fn();
    reconnectedSocket.emit("join_conversation", { conversationId }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(prisma.conversation.findUnique).toHaveBeenCalledWith({
      where: { id: conversationId },
      select: { user1Id: true, user2Id: true },
    });
    expect(reconnectedSocket.join).toHaveBeenCalledWith(`conversation:${conversationId}`);
    expect(reconnectedSocket.rooms.has(`conversation:${conversationId}`)).toBe(true);
    expect(ack).toHaveBeenCalledWith({ success: true, conversationId });
    expect(reconnectedSocket.emit).toHaveBeenCalledWith("conversation_joined", { conversationId });
  });

  // 2. Membership is checked again on every join during reconnection
  it("2. Membership is rechecked against database on reconnection and rejects if access was revoked during downtime", async () => {
    const reconnectedSocket = createMockSocket(user1Id, "alice@test.com", "session-new", "reconnected-socket-003");
    registerChatSocketHandlers(reconnectedSocket);

    // Database indicates user is no longer in this conversation
    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id: "other-user-1",
      user2Id: "other-user-2",
    } as any);

    const ack = vi.fn();
    reconnectedSocket.emit("join_conversation", { conversationId }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(reconnectedSocket.join).not.toHaveBeenCalled();
    expect(reconnectedSocket.rooms.has(`conversation:${conversationId}`)).toBe(false);
    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Access denied to this conversation",
    });
    expect(reconnectedSocket.emit).toHaveBeenCalledWith("error", {
      event: "join_conversation",
      error: "Access denied to this conversation",
    });
  });

  // 3. Nonparticipant socket remains denied
  it("3. Reconnected socket for non-participant remains denied with generic error", async () => {
    const nonPartSocket = createMockSocket(nonParticipantId, "mallory@test.com", "session-new", "reconnected-socket-004");
    registerChatSocketHandlers(nonPartSocket);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const ack = vi.fn();
    nonPartSocket.emit("join_conversation", { conversationId }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(nonPartSocket.join).not.toHaveBeenCalled();
    expect(nonPartSocket.rooms.has(`conversation:${conversationId}`)).toBe(false);
    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Access denied to this conversation",
    });
  });

  // 4. Derives identity strictly from server-side socket data, ignoring client-sent userId
  it("4. Ignores client-supplied userId during reconnection join and relies strictly on socket.data.user.userId", async () => {
    const reconnectedSocket = createMockSocket(user1Id, "alice@test.com", "session-new", "reconnected-socket-005");
    registerChatSocketHandlers(reconnectedSocket);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const ack = vi.fn();
    // Spoofed userId in payload
    reconnectedSocket.emit(
      "join_conversation",
      { conversationId, userId: nonParticipantId },
      ack
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Joins room because socket.data.user.userId is user1Id (participant), ignoring the payload
    expect(reconnectedSocket.join).toHaveBeenCalledWith(`conversation:${conversationId}`);
    expect(ack).toHaveBeenCalledWith({ success: true, conversationId });
  });

  // 5. Preserves existing event names and acknowledgment contracts
  it("5. Preserves exact approved event names (join_conversation, conversation_joined) and callback shape", async () => {
    const reconnectedSocket = createMockSocket(user2Id, "bob@test.com", "session-new", "reconnected-socket-006");
    registerChatSocketHandlers(reconnectedSocket);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const ack = vi.fn();
    reconnectedSocket.emit("join_conversation", { conversationId }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ack).toHaveBeenCalledWith({
      success: true,
      conversationId,
    });
    expect(reconnectedSocket.emit).toHaveBeenCalledWith("conversation_joined", {
      conversationId,
    });
  });
});

describe("Chat Socket Handlers — Read Receipts & Typing Indicators (Stage A)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const conversationId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e5f";
  const user1Id = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e51";
  const user2Id = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e52";
  const outsiderId = "c1f2e3d4-b5a6-4c7d-8e9f-0a1b2c3d4e99";
  const messageId = "a1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c";

  // 1. mark_read success
  it("1. mark_read validates payload, invokes chatService.markMessagesAsRead, and invokes ack callback", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const markReadSpy = vi.spyOn(chatService, "markMessagesAsRead").mockResolvedValueOnce({
      success: true,
      conversationId,
      count: 3,
      readAt: new Date("2026-11-08T12:00:00.000Z"),
      lastReadMessageId: messageId,
    });

    const ack = vi.fn();
    socket.emit("mark_read", { conversationId, lastMessageId: messageId }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(markReadSpy).toHaveBeenCalledWith(user1Id, conversationId, messageId);
    expect(ack).toHaveBeenCalledWith({
      success: true,
      conversationId,
      count: 3,
      readAt: expect.any(Date),
      lastReadMessageId: messageId,
    });
  });

  // 2. mark_read validation failure
  it("2. mark_read rejects non-UUID conversationId with validation error", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    const ack = vi.fn();
    socket.emit("mark_read", { conversationId: "not-a-uuid" }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Invalid conversation ID format",
    });
    expect(socket.emit).toHaveBeenCalledWith("error", {
      event: "mark_read",
      error: "Invalid conversation ID format",
    });
  });

  // 3. typing_start broadcasts to conversation room
  it("3. typing_start verifies participant and broadcasts user_typing true to conversation room", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const roomEmitMock = vi.fn();
    (socket.to as any).mockReturnValue({ emit: roomEmitMock });

    const ack = vi.fn();
    socket.emit("typing_start", { conversationId }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(socket.to).toHaveBeenCalledWith(`conversation:${conversationId}`);
    expect(roomEmitMock).toHaveBeenCalledWith("user_typing", {
      conversationId,
      userId: user1Id,
      isTyping: true,
    });
    expect(ack).toHaveBeenCalledWith({ success: true });
  });

  // 4. typing_start rejects non-participant
  it("4. typing_start rejects non-participant with access denied", async () => {
    const socket = createMockSocket(outsiderId);
    registerChatSocketHandlers(socket);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const ack = vi.fn();
    socket.emit("typing_start", { conversationId }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ack).toHaveBeenCalledWith({
      success: false,
      error: "Access denied to this conversation",
    });
    expect(socket.emit).toHaveBeenCalledWith("error", {
      event: "typing_start",
      error: "Access denied to this conversation",
    });
  });

  // 5. typing_stop broadcasts to conversation room
  it("5. typing_stop broadcasts user_typing false to conversation room", async () => {
    const socket = createMockSocket(user1Id);
    registerChatSocketHandlers(socket);

    vi.spyOn(prisma.conversation, "findUnique").mockResolvedValueOnce({
      user1Id,
      user2Id,
    } as any);

    const roomEmitMock = vi.fn();
    (socket.to as any).mockReturnValue({ emit: roomEmitMock });

    const ack = vi.fn();
    socket.emit("typing_stop", { conversationId }, ack);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(socket.to).toHaveBeenCalledWith(`conversation:${conversationId}`);
    expect(roomEmitMock).toHaveBeenCalledWith("user_typing", {
      conversationId,
      userId: user1Id,
      isTyping: false,
    });
    expect(ack).toHaveBeenCalledWith({ success: true });
  });
});
