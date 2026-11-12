import { Router } from "express";
import { authController } from "./auth.controller";
import { validateRequest } from "../../middlewares/validate";
import {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
  logoutSchema,
  changePasswordSchema,
  verifyEmailSchema,
  resendOtpSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "./auth.validation";
import {
  authRateLimiter,
  refreshRateLimiter,
  otpRateLimiter,
} from "../../middlewares/rateLimiter";
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

// Email verification route
router.post(
  "/verify-email",
  otpRateLimiter,
  validateRequest({ body: verifyEmailSchema }),
  (req, res, next) => authController.verifyEmail(req, res, next)
);

// Resend OTP route
router.post(
  "/resend-otp",
  otpRateLimiter,
  validateRequest({ body: resendOtpSchema }),
  (req, res, next) => authController.resendOtp(req, res, next)
);

// Forgot password route
router.post(
  "/forgot-password",
  otpRateLimiter,
  validateRequest({ body: forgotPasswordSchema }),
  (req, res, next) => authController.forgotPassword(req, res, next)
);

// Reset password route
router.post(
  "/reset-password",
  otpRateLimiter,
  validateRequest({ body: resetPasswordSchema }),
  (req, res, next) => authController.resetPassword(req, res, next)
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
