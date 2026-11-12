import { Request, Response, NextFunction } from "express";
import { authService } from "./auth.service";
import { logger } from "../../utils/logger";

export class AuthController {
  /**
   * Handle user registration.
   */
  async register(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.register(req.body);
      logger.info("User registered successfully", { userId: result.user.id });
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Handle user login.
   */
  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.login(req.body, {
        ipAddress: req.ip,
        deviceInfo: req.headers["user-agent"],
      });
      logger.info("User logged in successfully", { userId: result.user.id });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Handle refresh token rotation.
   */
  async refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.refresh(req.body.refreshToken, {
        ipAddress: req.ip,
        deviceInfo: req.headers["user-agent"],
      });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Handle user logout and session revocation.
   * Requires verified authentication; resolves userId and sessionId from verified token.
   */
  async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ error: "Access token required" });
        return;
      }

      const sessionId = req.user?.sessionId;
      const refreshToken = req.body?.refreshToken;

      const result = await authService.logout({
        userId,
        sessionId,
        refreshToken,
      });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get authenticated user's profile.
   * Identity is strictly read from verified token payload (req.user).
   */
  async getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const user = await authService.getProfile(userId);
      res.status(200).json({ user });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Change authenticated user's password.
   * Revokes all active sessions.
   */
  async changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const result = await authService.changePassword(userId, req.body);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Verify email using 6-digit OTP.
   */
  async verifyEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.verifyEmail(req.body);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Resend OTP code for email verification or password reset.
   */
  async resendOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.resendOtp(req.body);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Request password reset code.
   */
  async forgotPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.forgotPassword(req.body);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Reset password with 6-digit OTP and new password.
   */
  async resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.resetPassword(req.body);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
}

export const authController = new AuthController();
