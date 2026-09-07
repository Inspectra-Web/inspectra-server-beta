import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";

import {
  adminLogin,
  getAdminSession,
  getUser,
  listUsers,
  updateUserStatus,
} from "../controllers/admin.controller.js";
import AppError from "../error/app.error.js";
import { protect, restrictTo } from "../middlewares/auth.middleware.js";
import validate from "../middlewares/validate.middleware.js";
import { userStatusSchema } from "../validators/admin.validator.js";
import { loginSchema } from "../validators/auth.validator.js";

const tooManyAttempts: RequestHandler = (_req, _res, next) =>
  next(new AppError("Too many attempts. Please try again later.", 429));

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: tooManyAttempts,
});

const router = Router();

router.post("/login", adminLimiter, validate(loginSchema), adminLogin);

router.get("/session", protect, restrictTo("admin"), getAdminSession);

router.get("/users", protect, restrictTo("admin"), listUsers);

router.get("/users/:id", protect, restrictTo("admin"), getUser);

router.patch(
  "/users/:id/status",
  protect,
  restrictTo("admin"),
  validate(userStatusSchema),
  updateUserStatus,
);

export default router;
