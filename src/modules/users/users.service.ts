import { prisma } from "../../config/prisma";
import { UpdateProfileInput } from "./users.validation";
import { logger } from "../../utils/logger";

export interface PublicUserProfile {
  id: string;
  email: string;
  displayName: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
}

export class UserService {
  /**
   * Updates authenticated user's display name.
   */
  async updateProfile(userId: string, input: UpdateProfileInput): Promise<PublicUserProfile> {
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        displayName: input.displayName,
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        lastSeenAt: true,
        createdAt: true,
      },
    });

    logger.info("User profile updated", { userId });
    return updatedUser;
  }

  /**
   * Retrieves user profile.
   * A user may retrieve their own profile or their actual conversation partner's profile only.
   */
  async getUserProfile(currentUserId: string, targetUserId: string): Promise<PublicUserProfile> {
    // If requesting own profile
    if (currentUserId === targetUserId) {
      const user = await prisma.user.findUnique({
        where: { id: currentUserId },
        select: {
          id: true,
          email: true,
          displayName: true,
          lastSeenAt: true,
          createdAt: true,
        },
      });

      if (!user) {
        const error = new Error("User not found");
        (error as any).statusCode = 404;
        throw error;
      }

      return user;
    }

    // Verify target user is a conversation partner
    const conversation = await prisma.conversation.findFirst({
      where: {
        OR: [
          { user1Id: currentUserId, user2Id: targetUserId },
          { user1Id: targetUserId, user2Id: currentUserId },
        ],
      },
    });

    if (!conversation) {
      const error = new Error("Access denied: You can only view your conversation partner's profile");
      (error as any).statusCode = 403;
      throw error;
    }

    const partner = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        email: true,
        displayName: true,
        lastSeenAt: true,
        createdAt: true,
      },
    });

    if (!partner) {
      const error = new Error("User not found");
      (error as any).statusCode = 404;
      throw error;
    }

    return partner;
  }
}

export const userService = new UserService();

