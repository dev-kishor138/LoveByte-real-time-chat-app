import { Router } from "express";
import { authController } from "./auth.controller";
import { validateRequest } from "../../middlewares/validate";
import {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
  logoutSchema,
  changePasswordSchema,
} from "./auth.validation";
import { authRateLimiter, refreshRateLimiter } from "../../middlewares/rateLimiter";
import { authenticateToken } from "../../middlewares/auth";

const router = Router();

// Registration route with rate limiting and schema validation
router.post(
  "/register",
  authRateLimiter,
  validateRequest({ body: registerSchema }),
  (req, res, next) => authController.register(req, res, next)
);

// Login route with rate limiting and schema validation
router.post(
  "/login",
  authRateLimiter,
  validateRequest({ body: loginSchema }),
  (req, res, next) => authController.login(req, res, next)
);

// Refresh token rotation route with dedicated rate limiting
router.post(
  "/refresh",
  refreshRateLimiter,
  validateRequest({ body: refreshTokenSchema }),
  (req, res, next) => authController.refresh(req, res, next)
);

// Logout route - requires verified JWT authentication
router.post(
  "/logout",
  authenticateToken,
  validateRequest({ body: logoutSchema }),
  (req, res, next) => authController.logout(req, res, next)
);

// Profile route requiring valid JWT token
router.get("/me", authenticateToken, (req, res, next) =>
  authController.getMe(req, res, next)
);

// Password change route - requires verified JWT authentication
router.post(
  "/change-password",
  authenticateToken,
  validateRequest({ body: changePasswordSchema }),
  (req, res, next) => authController.changePassword(req, res, next)
);

export const authRoutes = router;
