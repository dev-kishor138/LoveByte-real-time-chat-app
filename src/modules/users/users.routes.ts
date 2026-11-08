import { Router } from "express";
import { userController } from "./users.controller";
import { authenticateToken } from "../../middlewares/auth";
import { validateRequest } from "../../middlewares/validate";
import { updateProfileSchema, userIdParamSchema } from "./users.validation";

const router = Router();

// All user routes require verified JWT authentication
router.use(authenticateToken);

/**
 * PATCH /api/users/profile
 * Update authenticated user's display name
 */
router.patch(
  "/profile",
  validateRequest({ body: updateProfileSchema }),
  (req, res, next) => userController.updateProfile(req, res, next)
);

/**
 * GET /api/users/:id
 * Retrieve profile of self or active conversation partner
 */
router.get(
  "/:id",
  validateRequest({ params: userIdParamSchema }),
  (req, res, next) => userController.getUserProfile(req, res, next)
);

export const userRoutes = router;

