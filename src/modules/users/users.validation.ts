import { z } from "zod";

/**
 * Validation schema for updating user profile.
 * Display name is trimmed, 1-50 characters, and sanitized against HTML/script injection.
 */
export const updateProfileSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, "Display name must be at least 1 character")
    .max(50, "Display name cannot exceed 50 characters")
    .regex(/^[^<>]*$/, "Display name cannot contain HTML or angle brackets"),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const userIdParamSchema = z.object({
  id: z.string().uuid("Invalid user ID format"),
});

export type UserIdParam = z.infer<typeof userIdParamSchema>;

