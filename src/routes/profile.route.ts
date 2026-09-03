import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";

import {
  deleteMyAvatar,
  getMyProfile,
  updateMyAvatar,
  updateMyProfile,
} from "../controllers/profile.controller.js";
import AppError from "../error/app.error.js";
import { protect } from "../middlewares/auth.middleware.js";
import validate from "../middlewares/validate.middleware.js";
import { avatarUpload } from "../services/upload.service.js";
import { updateProfileSchema } from "../validators/profile.validator.js";

const tooManyAttempts: RequestHandler = (_req, _res, next) =>
  next(new AppError("Too many attempts. Please try again later.", 429));

// Uploads cost a Cloudinary round trip, so they get their own budget.
const avatarLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: tooManyAttempts,
});

const router = Router();

router.get("/me", protect, getMyProfile);
router.patch("/me", protect, validate(updateProfileSchema), updateMyProfile);

router.post(
  "/me/avatar",
  protect,
  avatarLimiter,
  avatarUpload.single("avatar"),
  updateMyAvatar,
);
router.delete("/me/avatar", protect, deleteMyAvatar);

export default router;
