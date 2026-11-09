import { z } from "zod";

const gmailRegex = /^[a-zA-Z0-9._%+-]+@gmail\.com$/;

/**
 * Validates creation of a one-to-one conversation by recipient Gmail address.
 * Normalizes email by trimming and lowercasing.
 */
export const createConversationSchema = z.object({
  recipientEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email format")
    .regex(gmailRegex, "Recipient must be a valid @gmail.com address"),
});

/**
 * Validates conversationId URL parameter.
 */
export const conversationIdParamSchema = z.object({
  conversationId: z.string().uuid("Invalid conversation ID format"),
});

/**
 * Validates messageId URL parameter.
 */
export const messageIdParamSchema = z.object({
  messageId: z.string().uuid("Invalid message ID format"),
});

/**
 * Validates safe pagination parameters for listing conversations.
 */
export const listConversationsQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 20))
    .pipe(
      z
        .number()
        .int("Limit must be an integer")
        .min(1, "Limit must be at least 1")
        .max(50, "Limit cannot exceed 50")
    ),
  cursor: z.string().uuid("Invalid cursor UUID format").optional(),
});

/**
 * Validates safe pagination parameters for retrieving messages.
 */
export const getMessagesQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 50))
    .pipe(
      z
        .number()
        .int("Limit must be an integer")
        .min(1, "Limit must be at least 1")
        .max(100, "Limit cannot exceed 100")
    ),
  cursor: z.string().uuid("Invalid cursor UUID format").optional(),
});

/**
 * Validates sending a text message.
 * Stage 1 restriction: TEXT messages only. Media types (IMAGE, VOICE) and media metadata are rejected.
 * Enforces non-empty content and maximum 5,000 characters.
 */
export const sendMessageSchema = z.object({
  conversationId: z.string().uuid("Invalid conversation ID format").optional(),
  type: z.literal("TEXT").default("TEXT"),
  content: z
    .string()
    .trim()
    .min(1, "Message content cannot be empty")
    .max(5000, "Message content cannot exceed 5000 characters"),
  clientMutationId: z.string().uuid("Invalid clientMutationId UUID format").optional(),
});

/**
 * Validates editing a text message.
 * Enforces non-empty content and maximum 5,000 characters.
 */
export const editMessageSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "Message content cannot be empty")
    .max(5000, "Message content cannot exceed 5000 characters"),
});

/**
 * Validates marking messages as read in a conversation.
 * Optional lastMessageId: boundary message up to which messages are marked as read.
 */
export const markReadSchema = z.object({
  lastMessageId: z.string().uuid("Invalid lastMessageId UUID format").optional(),
});

// Type definitions inferred from Zod schemas
export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type ConversationIdParamInput = z.infer<typeof conversationIdParamSchema>;
export type MessageIdParamInput = z.infer<typeof messageIdParamSchema>;
export type ListConversationsQueryInput = z.infer<typeof listConversationsQuerySchema>;
export type GetMessagesQueryInput = z.infer<typeof getMessagesQuerySchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type EditMessageInput = z.infer<typeof editMessageSchema>;
export type MarkReadInput = z.infer<typeof markReadSchema>;
