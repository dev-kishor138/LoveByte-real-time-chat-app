import { z } from "zod";

/**
 * Validates that an email address is a valid Gmail address.
 */
const gmailRegex = /^[a-zA-Z0-9._%+-]+@gmail\.com$/;

export const registerSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email format")
    .regex(gmailRegex, "Registration is restricted to valid @gmail.com addresses"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be at most 128 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[a-z]/, "Password must contain at least one lowercase letter")
    .regex(/[0-9]/, "Password must contain at least one digit")
    .regex(/[^A-Za-z0-9]/, "Password must contain at least one special character"),
});

export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email format")
    .regex(gmailRegex, "Login is restricted to valid @gmail.com addresses"),
  password: z.string().min(1, "Password is required"),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().trim().min(1, "Refresh token is required"),
});

export const logoutSchema = z.object({
  refreshToken: z.string().trim().min(1, "Refresh token is required").optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z
    .string()
    .min(8, "New password must be at least 8 characters")
    .max(128, "New password must be at most 128 characters")
    .regex(/[A-Z]/, "New password must contain at least one uppercase letter")
    .regex(/[a-z]/, "New password must contain at least one lowercase letter")
    .regex(/[0-9]/, "New password must contain at least one digit")
    .regex(/[^A-Za-z0-9]/, "New password must contain at least one special character"),
});

export const verifyEmailSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email format")
    .regex(gmailRegex, "Must be a valid @gmail.com address"),
  code: z
    .string()
    .trim()
    .length(6, "Verification code must be exactly 6 digits")
    .regex(/^\d{6}$/, "Verification code must contain digits only"),
});

export const resendOtpSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email format")
    .regex(gmailRegex, "Must be a valid @gmail.com address"),
  type: z.enum(["EMAIL_VERIFICATION", "PASSWORD_RESET"]),
});

export const forgotPasswordSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email format")
    .regex(gmailRegex, "Must be a valid @gmail.com address"),
});

export const resetPasswordSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email format")
    .regex(gmailRegex, "Must be a valid @gmail.com address"),
  code: z
    .string()
    .trim()
    .length(6, "Reset code must be exactly 6 digits")
    .regex(/^\d{6}$/, "Reset code must contain digits only"),
  newPassword: z
    .string()
    .min(8, "New password must be at least 8 characters")
    .max(128, "New password must be at most 128 characters")
    .regex(/[A-Z]/, "New password must contain at least one uppercase letter")
    .regex(/[a-z]/, "New password must contain at least one lowercase letter")
    .regex(/[0-9]/, "New password must contain at least one digit")
    .regex(/[^A-Za-z0-9]/, "New password must contain at least one special character"),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
export type LogoutInput = z.infer<typeof logoutSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type ResendOtpInput = z.infer<typeof resendOtpSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

