import { z } from "zod";
import { AuthenticatedSocket } from "./socket.middleware";
import { socketRateLimit } from "./index";
import { prisma } from "../config/prisma";
import { logger } from "../utils/logger";
import { chatService } from "../modules/chat/chat.service";

/**
 * Zod validation schema for conversation room management inbound payloads.
 */
export const conversationRoomPayloadSchema = z.object({
  conversationId: z.string().uuid("Invalid conversation ID"),
});

export type ConversationRoomPayload = z.infer<typeof conversationRoomPayloadSchema>;

export type RoomAckCallback = (response: {
  success: boolean;
  conversationId?: string;
  error?: string;
}) => void;

/**
 * Zod validation schema for send_message inbound payload.
 * Rejects whitespace-only content, non-TEXT types, oversized content, and invalid UUIDs.
 */
export const socketSendMessageSchema = z.object({
  conversationId: z.string().uuid("Invalid conversation ID format"),
  type: z.literal("TEXT", { message: "Only TEXT messages are supported" }).default("TEXT"),
  content: z
    .string()
    .trim()
    .min(1, "Message content cannot be empty")
    .max(5000, "Message content cannot exceed 5000 characters"),
  clientMutationId: z.string().uuid("Invalid clientMutationId UUID format").optional(),
});

export type SocketSendMessagePayload = z.infer<typeof socketSendMessageSchema>;

export type SendMessageAckCallback = (response: {
  success: boolean;
  message?: any;
  error?: string;
}) => void;

/**
 * Zod validation schema for edit_message inbound payload.
 * Rejects whitespace-only content, oversized content, and invalid UUIDs.
 */
export const socketEditMessageSchema = z.object({
  messageId: z.string().uuid("Invalid message ID format"),
  content: z
    .string()
    .trim()
    .min(1, "Message content cannot be empty")
    .max(5000, "Message content cannot exceed 5000 characters"),
});

export type SocketEditMessagePayload = z.infer<typeof socketEditMessageSchema>;

export type EditMessageAckCallback = (response: {
  success: boolean;
  message?: any;
  error?: string;
}) => void;

/**
 * Zod validation schema for delete_message inbound payload.
 */
export const socketDeleteMessageSchema = z.object({
  messageId: z.string().uuid("Invalid message ID format"),
});

export type SocketDeleteMessagePayload = z.infer<typeof socketDeleteMessageSchema>;

export type DeleteMessageAckCallback = (response: {
  success: boolean;
  messageId?: string;
  tombstone?: any;
  error?: string;
}) => void;

/**
 * Zod validation schema for mark_read inbound payload.
 */
export const socketMarkReadSchema = z.object({
  conversationId: z.string().uuid("Invalid conversation ID format"),
  lastMessageId: z.string().uuid("Invalid message ID format").optional(),
});

export type SocketMarkReadPayload = z.infer<typeof socketMarkReadSchema>;

export type MarkReadAckCallback = (response: {
  success: boolean;
  conversationId?: string;
  count?: number;
  readAt?: Date | string;
  lastReadMessageId?: string | null;
  error?: string;
}) => void;

export type TypingAckCallback = (response: {
  success: boolean;
  error?: string;
}) => void;

/**
 * Registers real-time conversation and message socket event handlers:
 * Stage 3.2: join_conversation, leave_conversation
 * Stage 3.3: send_message, edit_message, delete_message
 */
export function registerChatSocketHandlers(socket: AuthenticatedSocket): void {
  // 1. join_conversation (Stage 3.2)
  socket.on(
    "join_conversation",
    async (rawPayload: unknown, callback?: RoomAckCallback) => {
      // Per-socket event rate limit check
      if (!socketRateLimit(socket)) {
        if (typeof callback === "function") {
          callback({ success: false, error: "Rate limit exceeded" });
        }
        return;
      }

      // Input validation using Zod
      const parsed = conversationRoomPayloadSchema.safeParse(rawPayload);
      if (!parsed.success) {
        const errorMsg = "Invalid conversation ID";
        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        }
        socket.emit("error", { event: "join_conversation", error: errorMsg });
        return;
      }

      const { conversationId } = parsed.data;
      const currentUserId = socket.data?.user?.userId;

      // Fail closed if socket is unauthenticated or missing identity
      if (!currentUserId) {
        const errorMsg = "Access denied to this conversation";
        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        }
        socket.emit("error", { event: "join_conversation", error: errorMsg });
        return;
      }

      // Always verify participant authorization against PostgreSQL on every join request
      let conversation;
      try {
        conversation = await prisma.conversation.findUnique({
          where: { id: conversationId },
          select: { user1Id: true, user2Id: true },
        });
      } catch {
        logger.error("Database query failure during join_conversation", {
          conversationId,
          userId: currentUserId,
        });
        const errorMsg = "Unable to join conversation";
        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        }
        socket.emit("error", { event: "join_conversation", error: errorMsg });
        return;
      }

      // Uniform authorization denial for nonexistent conversations and non-participants
      if (
        !conversation ||
        (conversation.user1Id !== currentUserId && conversation.user2Id !== currentUserId)
      ) {
        logger.warn("Access denied to conversation room", {
          conversationId,
          userId: currentUserId,
        });
        const errorMsg = "Access denied to this conversation";
        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        }
        socket.emit("error", { event: "join_conversation", error: errorMsg });
        return;
      }

      const roomName = `conversation:${conversationId}`;

      // Only join room if not already in the room
      if (!socket.rooms?.has(roomName)) {
        await socket.join(roomName);
      }

      // Send acknowledgement callback if client provided one
      if (typeof callback === "function") {
        callback({ success: true, conversationId });
      }

      // Emit outbound success event
      socket.emit("conversation_joined", { conversationId });
    }
  );

  // 2. leave_conversation (Stage 3.2)
  socket.on(
    "leave_conversation",
    async (rawPayload: unknown, callback?: RoomAckCallback) => {
      // Per-socket event rate limit check
      if (!socketRateLimit(socket)) {
        if (typeof callback === "function") {
          callback({ success: false, error: "Rate limit exceeded" });
        }
        return;
      }

      // Input validation using Zod
      const parsed = conversationRoomPayloadSchema.safeParse(rawPayload);
      if (!parsed.success) {
        const errorMsg = "Invalid conversation ID";
        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        }
        socket.emit("error", { event: "leave_conversation", error: errorMsg });
        return;
      }

      const { conversationId } = parsed.data;
      const roomName = `conversation:${conversationId}`;

      // Leave the conversation room safely and idempotently
      await socket.leave(roomName);

      // Send acknowledgement callback if client provided one
      if (typeof callback === "function") {
        callback({ success: true, conversationId });
      }

      // Emit outbound success event
      socket.emit("conversation_left", { conversationId });
    }
  );

  // 3. send_message (Stage 3.3)
  socket.on(
    "send_message",
    async (rawPayload: unknown, callback?: SendMessageAckCallback) => {
      // Rate limit check
      if (!socketRateLimit(socket)) {
        if (typeof callback === "function") {
          callback({ success: false, error: "Rate limit exceeded" });
        }
        return;
      }

      // Input validation using dedicated socket schema
      const parsed = socketSendMessageSchema.safeParse(rawPayload);
      if (!parsed.success) {
        const errorMsg = parsed.error.issues[0]?.message || "Validation failed";
        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        }
        socket.emit("error", { event: "send_message", error: errorMsg });
        return;
      }

      const currentUserId = socket.data?.user?.userId;
      if (!currentUserId) {
        const errorMsg = "Authentication required";
        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        }
        socket.emit("error", { event: "send_message", error: errorMsg });
        return;
      }

      const { conversationId, content, type, clientMutationId } = parsed.data;

      try {
        const message = await chatService.sendMessage(
          currentUserId,
          conversationId,
          { conversationId, content, type, clientMutationId },
          socket.id
        );

        const { _isDuplicate, ...cleanMessage } = message as any;

        // Initiating socket receives primary acknowledgement only (no duplicate outbound event)
        if (typeof callback === "function") {
          callback({ success: true, message: cleanMessage });
        }
      } catch (err: any) {
        const statusCode = err?.statusCode;
        let errorMsg = "Unable to send message";

        if (statusCode === 403 || statusCode === 404) {
          errorMsg = "Access denied to this conversation";
        } else if (statusCode === 400 || statusCode === 409) {
          errorMsg = err.message || "Invalid message request";
        }

        logger.error("Failed to send message via socket", {
          conversationId,
          userId: currentUserId,
          statusCode,
        });

        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        }
        socket.emit("error", { event: "send_message", error: errorMsg });
      }
    }
  );

  // 4. edit_message (Stage 3.3)
  socket.on(
    "edit_message",
    async (rawPayload: unknown, callback?: EditMessageAckCallback) => {
      // Rate limit check
      if (!socketRateLimit(socket)) {
        if (typeof callback === "function") {
          callback({ success: false, error: "Rate limit exceeded" });
        }
        return;
      }

      // Input validation using dedicated socket schema
      const parsed = socketEditMessageSchema.safeParse(rawPayload);
      if (!parsed.success) {
        const errorMsg = parsed.error.issues[0]?.message || "Validation failed";
        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        }
        socket.emit("error", { event: "edit_message", error: errorMsg });
        return;
      }

      const currentUserId = socket.data?.user?.userId;
      if (!currentUserId) {
        const errorMsg = "Authentication required";
        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        }
        socket.emit("error", { event: "edit_message", error: errorMsg });
        return;
      }

      const { messageId, content } = parsed.data;

      try {
        const updated = await chatService.editMessage(
          currentUserId,
          messageId,
          content,
          socket.id
        );

        // Initiating socket receives primary acknowledgement only
        if (typeof callback === "function") {
          callback({ success: true, message: updated });
        }
      } catch (err: any) {
        const statusCode = err?.statusCode;
        let errorMsg = "Unable to edit message";

        if (statusCode === 403) {
          errorMsg = err.message || "Forbidden: You can only edit your own messages";
        } else if (statusCode === 404) {
          errorMsg = err.message || "Message not found";
        } else if (statusCode === 400) {
          errorMsg = err.message || "Invalid edit request";
        }

        logger.error("Failed to edit message via socket", {
          messageId,
          userId: currentUserId,
          statusCode,
        });

        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        }
        socket.emit("error", { event: "edit_message", error: errorMsg });
      }
    }
  );

  // 5. delete_message (Stage 3.3)
  socket.on(
    "delete_message",
    async (rawPayload: unknown, callback?: DeleteMessageAckCallback) => {
      // Rate limit check
      if (!socketRateLimit(socket)) {
        if (typeof callback === "function") {
          callback({ success: false, error: "Rate limit exceeded" });
        }
        return;
      }

      // Input validation using dedicated socket schema
      const parsed = socketDeleteMessageSchema.safeParse(rawPayload);
      if (!parsed.success) {
        const errorMsg = parsed.error.issues[0]?.message || "Validation failed";
        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        }
        socket.emit("error", { event: "delete_message", error: errorMsg });
        return;
      }

      const currentUserId = socket.data?.user?.userId;
      if (!currentUserId) {
        const errorMsg = "Authentication required";
        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        }
        socket.emit("error", { event: "delete_message", error: errorMsg });
        return;
      }

      const { messageId } = parsed.data;

      try {
        const deleted = await chatService.deleteMessage(
          currentUserId,
          messageId,
          socket.id
        );

        const tombstone = {
          id: deleted.id,
          conversationId: deleted.conversationId,
          isDeleted: deleted.isDeleted,
          updatedAt: deleted.updatedAt,
        };

        // Initiating socket receives primary acknowledgement only
        if (typeof callback === "function") {
          callback({ success: true, messageId: deleted.id, tombstone });
        }
      } catch (err: any) {
        const statusCode = err?.statusCode;
        let errorMsg = "Unable to delete message";

        if (statusCode === 403) {
          errorMsg = err.message || "Forbidden: You can only delete your own messages";
        } else if (statusCode === 404) {
          errorMsg = err.message || "Message not found";
        } else if (statusCode === 400) {
          errorMsg = err.message || "Invalid delete request";
        }

        logger.error("Failed to delete message via socket", {
          messageId,
          userId: currentUserId,
          statusCode,
        });

        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        }
        socket.emit("error", { event: "delete_message", error: errorMsg });
      }
    }
  );

  // 6. mark_read (Stage A)
  socket.on(
    "mark_read",
    async (rawPayload: unknown, callback?: MarkReadAckCallback) => {
      if (!socketRateLimit(socket)) {
        if (typeof callback === "function") {
          callback({ success: false, error: "Rate limit exceeded" });
        }
        return;
      }

      const parsed = socketMarkReadSchema.safeParse(rawPayload);
      if (!parsed.success) {
        const errorMsg = parsed.error.issues[0]?.message || "Validation failed";
        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        }
        socket.emit("error", { event: "mark_read", error: errorMsg });
        return;
      }

      const currentUserId = socket.data?.user?.userId;
      if (!currentUserId) {
        const errorMsg = "Authentication required";
        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        }
        socket.emit("error", { event: "mark_read", error: errorMsg });
        return;
      }

      const { conversationId, lastMessageId } = parsed.data;

      try {
        const result = await chatService.markMessagesAsRead(
          currentUserId,
          conversationId,
          lastMessageId
        );

        if (typeof callback === "function") {
          callback({
            success: true,
            conversationId: result.conversationId,
            count: result.count,
            readAt: result.readAt,
            lastReadMessageId: result.lastReadMessageId,
          });
        }
      } catch (err: any) {
        const statusCode = err?.statusCode;
        let errorMsg = "Unable to mark messages as read";
        if (statusCode === 403) {
          errorMsg = err.message || "Forbidden: You are not a participant in this conversation";
        } else if (statusCode === 404) {
          errorMsg = err.message || "Conversation or message not found";
        }

        logger.error("Failed to mark messages as read via socket", {
          conversationId,
          userId: currentUserId,
          statusCode,
        });

        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        }
        socket.emit("error", { event: "mark_read", error: errorMsg });
      }
    }
  );

  // 7. typing_start (Stage A)
  socket.on(
    "typing_start",
    async (rawPayload: unknown, callback?: TypingAckCallback) => {
      if (!socketRateLimit(socket)) {
        if (typeof callback === "function") {
          callback({ success: false, error: "Rate limit exceeded" });
        }
        return;
      }

      const parsed = conversationRoomPayloadSchema.safeParse(rawPayload);
      if (!parsed.success) {
        const errorMsg = parsed.error.issues[0]?.message || "Validation failed";
        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        }
        socket.emit("error", { event: "typing_start", error: errorMsg });
        return;
      }

      const currentUserId = socket.data?.user?.userId;
      if (!currentUserId) {
        if (typeof callback === "function") {
          callback({ success: false, error: "Authentication required" });
        }
        return;
      }

      const { conversationId } = parsed.data;

      // Verify conversation membership
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { user1Id: true, user2Id: true },
      });

      if (!conversation || (conversation.user1Id !== currentUserId && conversation.user2Id !== currentUserId)) {
        if (typeof callback === "function") {
          callback({ success: false, error: "Access denied to this conversation" });
        }
        socket.emit("error", { event: "typing_start", error: "Access denied to this conversation" });
        return;
      }

      // Broadcast user_typing to the conversation room, excluding the typing socket
      socket.to(`conversation:${conversationId}`).emit("user_typing", {
        conversationId,
        userId: currentUserId,
        isTyping: true,
      });

      if (typeof callback === "function") {
        callback({ success: true });
      }
    }
  );

  // 8. typing_stop (Stage A)
  socket.on(
    "typing_stop",
    async (rawPayload: unknown, callback?: TypingAckCallback) => {
      if (!socketRateLimit(socket)) {
        if (typeof callback === "function") {
          callback({ success: false, error: "Rate limit exceeded" });
        }
        return;
      }

      const parsed = conversationRoomPayloadSchema.safeParse(rawPayload);
      if (!parsed.success) {
        const errorMsg = parsed.error.issues[0]?.message || "Validation failed";
        if (typeof callback === "function") {
          callback({ success: false, error: errorMsg });
        }
        socket.emit("error", { event: "typing_stop", error: errorMsg });
        return;
      }

      const currentUserId = socket.data?.user?.userId;
      if (!currentUserId) {
        if (typeof callback === "function") {
          callback({ success: false, error: "Authentication required" });
        }
        return;
      }

      const { conversationId } = parsed.data;

      // Verify conversation membership
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { user1Id: true, user2Id: true },
      });

      if (!conversation || (conversation.user1Id !== currentUserId && conversation.user2Id !== currentUserId)) {
        if (typeof callback === "function") {
          callback({ success: false, error: "Access denied to this conversation" });
        }
        socket.emit("error", { event: "typing_stop", error: "Access denied to this conversation" });
        return;
      }

      // Broadcast user_typing to the conversation room, excluding the typing socket
      socket.to(`conversation:${conversationId}`).emit("user_typing", {
        conversationId,
        userId: currentUserId,
        isTyping: false,
      });

      if (typeof callback === "function") {
        callback({ success: true });
      }
    }
  );
}
