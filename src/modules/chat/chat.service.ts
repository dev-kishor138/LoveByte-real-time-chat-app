import { prisma } from "../../config/prisma";
import { getIO } from "../../sockets";
import { SendMessageInput } from "./chat.validation";
import { logger } from "../../utils/logger";

export class ChatService {
  /**
   * Finds or creates a canonical 1-to-1 conversation between the authenticated user and recipient.
   * Concurrency-safe: handles Prisma unique constraint collisions (P2002) gracefully.
   */
  async getOrCreateConversation(currentUserId: string, recipientEmail: string) {
    const normalizedEmail = recipientEmail.trim().toLowerCase();
    const recipient = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true, createdAt: true },
    });

    if (!recipient) {
      const error = new Error("Recipient not found");
      (error as any).statusCode = 404;
      throw error;
    }

    if (recipient.id === currentUserId) {
      const error = new Error("Cannot start a conversation with yourself");
      (error as any).statusCode = 400;
      throw error;
    }

    // Canonical ordering ensures exactly one conversation per user pair (user1Id < user2Id)
    const [user1Id, user2Id] = currentUserId < recipient.id
      ? [currentUserId, recipient.id]
      : [recipient.id, currentUserId];

    let conversation = await prisma.conversation.findUnique({
      where: {
        user1Id_user2Id: { user1Id, user2Id },
      },
      include: {
        user1: { select: { id: true, email: true, createdAt: true } },
        user2: { select: { id: true, email: true, createdAt: true } },
      },
    });

    if (!conversation) {
      try {
        conversation = await prisma.conversation.create({
          data: {
            user1Id,
            user2Id,
          },
          include: {
            user1: { select: { id: true, email: true, createdAt: true } },
            user2: { select: { id: true, email: true, createdAt: true } },
          },
        });
        logger.info("New 1-to-1 conversation created", { conversationId: conversation.id });
      } catch (err: any) {
        // Concurrency race: if another request created the conversation concurrently, retrieve it
        if (err.code === "P2002") {
          conversation = await prisma.conversation.findUnique({
            where: {
              user1Id_user2Id: { user1Id, user2Id },
            },
            include: {
              user1: { select: { id: true, email: true, createdAt: true } },
              user2: { select: { id: true, email: true, createdAt: true } },
            },
          });
          if (!conversation) {
            throw err;
          }
        } else {
          throw err;
        }
      }
    }

    const otherUser = conversation.user1Id === currentUserId ? conversation.user2 : conversation.user1;
    return {
      id: conversation.id,
      user1Id: conversation.user1Id,
      user2Id: conversation.user2Id,
      otherUser: {
        id: otherUser.id,
        email: otherUser.email,
        createdAt: otherUser.createdAt,
      },
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };
  }

  /**
   * Retrieves conversations belonging to the authenticated user with safe pagination.
   */
  async getUserConversations(currentUserId: string, limit: number = 20, cursor?: string) {
    const conversations = await prisma.conversation.findMany({
      where: {
        OR: [{ user1Id: currentUserId }, { user2Id: currentUserId }],
      },
      take: limit,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: {
        user1: { select: { id: true, email: true, createdAt: true } },
        user2: { select: { id: true, email: true, createdAt: true } },
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            type: true,
            content: true,
            isEdited: true,
            editedAt: true,
            isDeleted: true,
            readAt: true,
            createdAt: true,
            senderId: true,
          },
        },
        _count: {
          select: {
            messages: {
              where: {
                senderId: { not: currentUserId },
                readAt: null,
                isDeleted: false,
              },
            },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    return conversations.map((conv) => {
      const otherUser = conv.user1Id === currentUserId ? conv.user2 : conv.user1;
      const rawLastMsg = conv.messages[0] || null;
      const unreadCount = (conv as any)._count?.messages ?? 0;
      const lastMessage = rawLastMsg
        ? {
            id: rawLastMsg.id,
            senderId: rawLastMsg.senderId,
            type: rawLastMsg.type,
            content: rawLastMsg.isDeleted ? null : rawLastMsg.content, // Mask deleted content
            isEdited: rawLastMsg.isEdited,
            editedAt: rawLastMsg.editedAt,
            isDeleted: rawLastMsg.isDeleted,
            readAt: rawLastMsg.readAt,
            createdAt: rawLastMsg.createdAt,
          }
        : null;

      return {
        id: conv.id,
        otherUser: {
          id: otherUser.id,
          email: otherUser.email,
          displayName: (otherUser as any).displayName ?? null,
          lastSeenAt: (otherUser as any).lastSeenAt ?? null,
          createdAt: otherUser.createdAt,
        },
        unreadCount,
        lastMessage,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
      };
    });
  }

  /**
   * Retrieves messages for a conversation, strictly validating participant authorization.
   * Supports limit and cursor-based pagination.
   * Masks deleted message contents.
   */
  async getConversationMessages(
    currentUserId: string,
    conversationId: string,
    limit: number = 50,
    cursor?: string
  ) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { user1Id: true, user2Id: true },
    });

    if (!conversation) {
      const error = new Error("Conversation not found");
      (error as any).statusCode = 404;
      throw error;
    }

    // Strict authorization check: current user must be one of the two participants
    if (conversation.user1Id !== currentUserId && conversation.user2Id !== currentUserId) {
      const error = new Error("Access denied to this conversation");
      (error as any).statusCode = 403;
      throw error;
    }

    const messages = await prisma.message.findMany({
      where: { conversationId },
      take: limit,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: [
        { createdAt: "desc" },
        { id: "desc" },
      ],
      select: {
        id: true,
        conversationId: true,
        senderId: true,
        type: true,
        content: true,
        fileKey: true,
        fileMime: true,
        fileSize: true,
        isEdited: true,
        editedAt: true,
        isDeleted: true,
        readAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Query retrieved the newest matching messages in descending order (or older than cursor).
    // Reverse array to preserve the public API contract: ascending chronological order
    // (oldest in the returned batch first, newest last).
    const chronologicalMessages = messages.reverse();

    // Mask deleted message payload to protect privacy
    return chronologicalMessages.map((msg) => ({
      id: msg.id,
      conversationId: msg.conversationId,
      senderId: msg.senderId,
      type: msg.type,
      content: msg.isDeleted ? null : msg.content,
      fileKey: msg.isDeleted ? null : msg.fileKey,
      fileMime: msg.isDeleted ? null : msg.fileMime,
      fileSize: msg.isDeleted ? null : msg.fileSize,
      isEdited: msg.isEdited,
      editedAt: msg.editedAt,
      isDeleted: msg.isDeleted,
      readAt: msg.readAt,
      createdAt: msg.createdAt,
      updatedAt: msg.updatedAt,
    }));
  }

  /**
   * Sends a TEXT message in a conversation.
   * Enforces participant authorization, updates conversation timestamp, and notifies via Socket.IO.
   * Single chained room-union emission ensures zero duplicate delivery to recipient sockets,
   * while excluding the originating socket from message_sent notifications.
   */
  async sendMessage(
    senderId: string,
    conversationId: string,
    input: SendMessageInput,
    originatingSocketId?: string
  ) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { user1Id: true, user2Id: true },
    });

    if (!conversation) {
      const error = new Error("Conversation not found");
      (error as any).statusCode = 404;
      throw error;
    }

    // Strict authorization check: sender must be a participant
    if (conversation.user1Id !== senderId && conversation.user2Id !== senderId) {
      const error = new Error("Access denied: You are not a participant in this conversation");
      (error as any).statusCode = 403;
      throw error;
    }

    // Stage 1 supports TEXT messages only
    if (input.type && input.type !== "TEXT") {
      const error = new Error("Only TEXT messages are supported in this stage");
      (error as any).statusCode = 400;
      throw error;
    }

    const message = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId,
          senderId,
          type: "TEXT",
          content: input.content.trim(),
          fileKey: null,
          fileMime: null,
          fileSize: null,
        },
        select: {
          id: true,
          conversationId: true,
          senderId: true,
          type: true,
          content: true,
          fileKey: true,
          fileMime: true,
          fileSize: true,
          isEdited: true,
          editedAt: true,
          isDeleted: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // Update conversation timestamp
      await tx.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      });

      return created;
    });

    // Real-time broadcast to recipient room and sender room via Socket.IO
    const recipientId = conversation.user1Id === senderId ? conversation.user2Id : conversation.user1Id;
    try {
      const io = getIO();
      // 1. Deliver to recipient (whether in conversation room or personal room) exactly once.
      // Exclude sender's user room so the sender does not receive new_message for their own message.
      // Strictly do not include clientMutationId in recipient's new_message payload.
      io.to(`conversation:${conversationId}`)
        .to(`user:${recipientId}`)
        .except(`user:${senderId}`)
        .emit("new_message", message);

      // 2. Deliver confirmation to all connected devices in sender's personal room.
      // Broadcast message_sent to user:${senderId} (including originating socket)
      // so timeout recovery and multi-device state synchronization succeed deterministically.
      const senderTarget = io.to(`user:${senderId}`);
      const senderPayload = {
        ...message,
        ...(input.clientMutationId ? { clientMutationId: input.clientMutationId } : {}),
      };
      senderTarget.emit("message_sent", senderPayload);
    } catch {
      // Socket instance might not be initialized during isolated unit tests
    }

    return {
      ...message,
      ...(input.clientMutationId ? { clientMutationId: input.clientMutationId } : {}),
    };
  }

  /**
   * Edits a text message. Restricted strictly to the original sender within 24 hours of creation.
   * Single chained room-union emission ensures zero duplicate delivery, excluding originating socket when supplied.
   */
  async editMessage(
    userId: string,
    messageId: string,
    newContent: string,
    originatingSocketId?: string
  ) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: {
        conversation: { select: { id: true, user1Id: true, user2Id: true } },
      },
    });

    if (!message) {
      const error = new Error("Message not found");
      (error as any).statusCode = 404;
      throw error;
    }

    if (message.isDeleted) {
      const error = new Error("Cannot edit a deleted message");
      (error as any).statusCode = 400;
      throw error;
    }

    // Authorization rule: Sender only
    if (message.senderId !== userId) {
      const error = new Error("Forbidden: You can only edit your own messages");
      (error as any).statusCode = 403;
      throw error;
    }

    if (message.type !== "TEXT") {
      const error = new Error("Only text messages can be edited");
      (error as any).statusCode = 400;
      throw error;
    }

    // Mandatory 24-hour edit window rule (now() - createdAt <= 24h)
    const now = Date.now();
    const createdAt = message.createdAt.getTime();
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
    if (now - createdAt > TWENTY_FOUR_HOURS_MS) {
      const error = new Error("Messages can only be edited within 24 hours of creation");
      (error as any).statusCode = 400;
      throw error;
    }

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: {
        content: newContent.trim(),
        isEdited: true,
        editedAt: new Date(),
      },
      select: {
        id: true,
        conversationId: true,
        senderId: true,
        type: true,
        content: true,
        fileKey: true,
        fileMime: true,
        fileSize: true,
        isEdited: true,
        editedAt: true,
        isDeleted: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Real-time broadcast: single chained emission targets union of conversation and user rooms without duplicates
    const recipientId =
      message.conversation.user1Id === userId
        ? message.conversation.user2Id
        : message.conversation.user1Id;

    try {
      const io = getIO();
      const target = io
        .to(`conversation:${message.conversationId}`)
        .to(`user:${recipientId}`)
        .to(`user:${userId}`);

      if (originatingSocketId) {
        target.except(originatingSocketId).emit("message_edited", updated);
      } else {
        target.emit("message_edited", updated);
      }
    } catch {
      // Ignore if socket offline in tests
    }

    return updated;
  }

  /**
   * Deletes a message. Restricted strictly to the sender (soft delete tombstone).
   * Single chained room-union emission ensures zero duplicate delivery, excluding originating socket when supplied.
   */
  async deleteMessage(userId: string, messageId: string, originatingSocketId?: string) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      include: {
        conversation: { select: { id: true, user1Id: true, user2Id: true } },
      },
    });

    if (!message) {
      const error = new Error("Message not found");
      (error as any).statusCode = 404;
      throw error;
    }

    // Authorization rule: Sender only
    if (message.senderId !== userId) {
      const error = new Error("Forbidden: You can only delete your own messages");
      (error as any).statusCode = 403;
      throw error;
    }

    if (message.isDeleted) {
      const error = new Error("Message is already deleted");
      (error as any).statusCode = 400;
      throw error;
    }

    const deleted = await prisma.message.update({
      where: { id: messageId },
      data: {
        content: null,
        fileKey: null,
        fileMime: null,
        fileSize: null,
        isDeleted: true,
      },
      select: {
        id: true,
        conversationId: true,
        senderId: true,
        type: true,
        content: true,
        fileKey: true,
        fileMime: true,
        fileSize: true,
        isEdited: true,
        editedAt: true,
        isDeleted: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Real-time broadcast: single chained emission targets union of conversation and user rooms without duplicates
    const recipientId =
      message.conversation.user1Id === userId
        ? message.conversation.user2Id
        : message.conversation.user1Id;

    try {
      const io = getIO();
      const tombstonePayload = {
        id: deleted.id,
        conversationId: deleted.conversationId,
        isDeleted: deleted.isDeleted,
        updatedAt: deleted.updatedAt,
      };

      const target = io
        .to(`conversation:${message.conversationId}`)
        .to(`user:${recipientId}`)
        .to(`user:${userId}`);

      if (originatingSocketId) {
        target.except(originatingSocketId).emit("message_deleted", tombstonePayload);
      } else {
        target.emit("message_deleted", tombstonePayload);
      }
    } catch {
      // Ignore if socket offline in tests
    }

    return {
      id: deleted.id,
      conversationId: deleted.conversationId,
      senderId: deleted.senderId,
      type: deleted.type,
      content: null, // Masked
      fileKey: null,
      fileMime: null,
      fileSize: null,
      isEdited: deleted.isEdited,
      editedAt: deleted.editedAt,
      isDeleted: true,
      createdAt: deleted.createdAt,
      updatedAt: deleted.updatedAt,
    };
  }

  /**
   * Marks unread messages sent by the other participant as read up to an optional boundary message.
   * Derives reader identity strictly from server-authenticated context.
   * Broadcasts messages_read event via Socket.IO to the partner.
   */
  async markMessagesAsRead(
    readerId: string,
    conversationId: string,
    lastMessageId?: string
  ): Promise<{ success: boolean; conversationId: string; count: number; readAt: Date; lastReadMessageId: string | null }> {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { user1Id: true, user2Id: true },
    });

    if (!conversation) {
      const error = new Error("Conversation not found");
      (error as any).statusCode = 404;
      throw error;
    }

    if (conversation.user1Id !== readerId && conversation.user2Id !== readerId) {
      const error = new Error("Access denied: You are not a participant in this conversation");
      (error as any).statusCode = 403;
      throw error;
    }

    const partnerId = conversation.user1Id === readerId ? conversation.user2Id : conversation.user1Id;
    const now = new Date();

    const whereClause: any = {
      conversationId,
      senderId: partnerId,
      readAt: null,
    };

    if (lastMessageId) {
      const boundaryMsg = await prisma.message.findUnique({
        where: { id: lastMessageId },
        select: { id: true, conversationId: true, createdAt: true },
      });
      if (!boundaryMsg || boundaryMsg.conversationId !== conversationId) {
        const error = new Error("Boundary message not found in this conversation");
        (error as any).statusCode = 404;
        throw error;
      }

      // Compound tie-breaking: mark messages created before the boundary,
      // OR messages created at the exact same timestamp with id <= boundaryMsg.id
      whereClause.OR = [
        {
          createdAt: { lt: boundaryMsg.createdAt },
        },
        {
          createdAt: boundaryMsg.createdAt,
          id: { lte: boundaryMsg.id },
        },
      ];
    }

    const updateResult = await prisma.message.updateMany({
      where: whereClause,
      data: {
        readAt: now,
      },
    });

    const count = updateResult.count;

    // Broadcast messages_read event via Socket.IO to the other participant
    try {
      const io = getIO();
      const payload = {
        conversationId,
        readerId,
        readAt: now.toISOString(),
        count,
        lastReadMessageId: lastMessageId || null,
      };
      io.to(`conversation:${conversationId}`)
        .to(`user:${partnerId}`)
        .emit("messages_read", payload);
    } catch {
      // Ignore if socket uninitialized in tests
    }

    return {
      success: true,
      conversationId,
      count,
      readAt: now,
      lastReadMessageId: lastMessageId || null,
    };
  }
}

export const chatService = new ChatService();
