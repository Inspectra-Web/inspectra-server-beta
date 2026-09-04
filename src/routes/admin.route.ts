import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";

import { adminLogin, getAdminSession } from "../controllers/admin.controller.js";
import AppError from "../error/app.error.js";
import { protect, restrictTo } from "../middlewares/auth.middleware.js";
import validate from "../middlewares/validate.middleware.js";
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

export default router;
