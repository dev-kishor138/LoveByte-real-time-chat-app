import { Router } from "express";
import { chatController } from "./chat.controller";
import { authenticateToken } from "../../middlewares/auth";
import { validateRequest } from "../../middlewares/validate";
import {
  createConversationSchema,
  listConversationsQuerySchema,
  conversationIdParamSchema,
  getMessagesQuerySchema,
  sendMessageSchema,
  messageIdParamSchema,
  editMessageSchema,
  markReadSchema,
} from "./chat.validation";

const router = Router();

// All chat routes strictly require verified JWT authentication
router.use(authenticateToken);

/**
 * POST /api/chat/conversations
 * Create or retrieve a one-to-one conversation
 */
router.post(
  "/conversations",
  validateRequest({ body: createConversationSchema }),
  (req, res, next) => chatController.createOrGetConversation(req, res, next)
);

/**
 * GET /api/chat/conversations
 * List authenticated user's conversations with pagination
 */
router.get(
  "/conversations",
  validateRequest({ query: listConversationsQuerySchema }),
  (req, res, next) => chatController.listConversations(req, res, next)
);

/**
 * GET /api/chat/conversations/:conversationId/messages
 * Retrieve paginated messages for a conversation
 */
router.get(
  "/conversations/:conversationId/messages",
  validateRequest({
    params: conversationIdParamSchema,
    query: getMessagesQuerySchema,
  }),
  (req, res, next) => chatController.getConversationMessages(req, res, next)
);

/**
 * POST /api/chat/conversations/:conversationId/read
 * Mark messages in a conversation as read
 */
router.post(
  "/conversations/:conversationId/read",
  validateRequest({
    params: conversationIdParamSchema,
    body: markReadSchema,
  }),
  (req, res, next) => chatController.markMessagesAsRead(req, res, next)
);

/**
 * POST /api/chat/messages
 * Send a text message
 */
router.post(
  "/messages",
  validateRequest({ body: sendMessageSchema }),
  (req, res, next) => chatController.sendMessage(req, res, next)
);

/**
 * PATCH /api/chat/messages/:messageId
 * Edit own text message within 24 hours of creation
 */
router.patch(
  "/messages/:messageId",
  validateRequest({
    params: messageIdParamSchema,
    body: editMessageSchema,
  }),
  (req, res, next) => chatController.editMessage(req, res, next)
);

/**
 * DELETE /api/chat/messages/:messageId
 * Soft-delete own message
 */
router.delete(
  "/messages/:messageId",
  validateRequest({ params: messageIdParamSchema }),
  (req, res, next) => chatController.deleteMessage(req, res, next)
);

export const chatRoutes = router;
