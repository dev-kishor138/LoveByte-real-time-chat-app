import { Request, Response, NextFunction } from "express";
import { chatService } from "./chat.service";
import {
  ListConversationsQueryInput,
  GetMessagesQueryInput,
} from "./chat.validation";

export class ChatController {
  /**
   * POST /api/chat/conversations
   * Create or retrieve a 1-to-1 conversation with recipient.
   */
  async createOrGetConversation(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ error: "Access token required" });
        return;
      }

      const { recipientEmail } = req.body;
      const conversation = await chatService.getOrCreateConversation(
        userId,
        recipientEmail
      );
      res.status(200).json(conversation);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/chat/conversations
   * List conversations belonging to the authenticated user with pagination.
   */
  async listConversations(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ error: "Access token required" });
        return;
      }

      const query = (req.validatedQuery || req.query) as unknown as ListConversationsQueryInput;
      const limit = query?.limit ?? 20;
      const cursor = query?.cursor;

      const conversations = await chatService.getUserConversations(
        userId,
        limit,
        cursor
      );
      res.status(200).json(conversations);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/chat/conversations/:conversationId/messages
   * Retrieve paginated messages for a conversation.
   */
  async getConversationMessages(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ error: "Access token required" });
        return;
      }

      const conversationId = req.params.conversationId as string;
      const query = (req.validatedQuery || req.query) as unknown as GetMessagesQueryInput;
      const limit = query?.limit ?? 50;
      const cursor = query?.cursor;

      const messages = await chatService.getConversationMessages(
        userId,
        conversationId,
        limit,
        cursor
      );
      res.status(200).json(messages);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/chat/messages
   * Send a text message to a conversation.
   */
  async sendMessage(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ error: "Access token required" });
        return;
      }

      const { conversationId, content, type, clientMutationId } = req.body;
      if (!conversationId) {
        res.status(400).json({
          error: "Validation failed",
          details: [
            {
              field: "conversationId",
              message: "Conversation ID is required",
            },
          ],
        });
        return;
      }

      const result = await chatService.sendMessage(userId, conversationId, {
        conversationId,
        content,
        type: type || "TEXT",
        clientMutationId,
      });

      const isDuplicate = (result as any)._isDuplicate === true;
      const { _isDuplicate, ...messagePayload } = result as any;
      res.status(isDuplicate ? 200 : 201).json(messagePayload);
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/chat/messages/:messageId
   * Edit a text message within 24 hours of creation.
   */
  async editMessage(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ error: "Access token required" });
        return;
      }

      const messageId = req.params.messageId as string;
      const { content } = req.body;

      const updated = await chatService.editMessage(userId, messageId, content);
      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/chat/messages/:messageId
   * Soft-delete a message (creates tombstone).
   */
  async deleteMessage(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ error: "Access token required" });
        return;
      }

      const messageId = req.params.messageId as string;
      const deleted = await chatService.deleteMessage(userId, messageId);
      res.status(200).json(deleted);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/chat/conversations/:conversationId/read
   * Mark messages as read up to optional lastMessageId boundary.
   */
  async markMessagesAsRead(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ error: "Access token required" });
        return;
      }

      const conversationId = req.params.conversationId as string;
      const { lastMessageId } = req.body || {};

      const result = await chatService.markMessagesAsRead(
        userId,
        conversationId,
        lastMessageId
      );
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
}

export const chatController = new ChatController();
