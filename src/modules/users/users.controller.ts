import { Request, Response, NextFunction } from "express";
import { userService } from "./users.service";

export class UserController {
  async updateProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).user.userId;
      const user = await userService.updateProfile(userId, req.body);
      res.status(200).json({ user });
    } catch (error) {
      next(error);
    }
  }

  async getUserProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const currentUserId = (req as any).user.userId;
      const targetUserId = req.params.id as string;
      const user = await userService.getUserProfile(currentUserId, targetUserId);
      res.status(200).json({ user });
    } catch (error) {
      next(error);
    }
  }
}

export const userController = new UserController();
