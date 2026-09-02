import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";

import {
  forgotPassword,
  getMe,
  login,
  logout,
  register,
  resendVerification,
  resetPassword,
  updatePassword,
  verifyEmail,
} from "../controllers/auth.controller.js";
import AppError from "../error/app.error.js";
import { protect } from "../middlewares/auth.middleware.js";
import validate from "../middlewares/validate.middleware.js";
import {
  emailOnlySchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updatePasswordSchema,
  verifyTokenSchema,
} from "../validators/auth.validator.js";

// The rate-limit handler matters: without it the limiter answers in plain text
// and skips the { status, message } envelope every other response uses.
const tooManyAttempts: RequestHandler = (_req, _res, next) =>
  next(new AppError("Too many attempts. Please try again later.", 429));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: tooManyAttempts,
});

// Tighter on anything that sends mail.
const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: tooManyAttempts,
});

const router = Router();

router.post("/register", authLimiter, validate(registerSchema), register);
router.post("/verify-email", validate(verifyTokenSchema), verifyEmail);
router.post("/resend-verification", strictLimiter, validate(emailOnlySchema), resendVerification);
router.post("/login", authLimiter, validate(loginSchema), login);
router.post("/logout", logout);
router.post("/forgot-password", strictLimiter, validate(emailOnlySchema), forgotPassword);
router.patch("/reset-password", strictLimiter, validate(resetPasswordSchema), resetPassword);

// protect per route, not router.use: a gate would answer 401 on unknown
// /api/v1/auth paths instead of letting them fall through to notFound.
router.get("/me", protect, getMe);
router.patch(
  "/update-password",
  protect,
  validate(updatePasswordSchema),
  updatePassword,
);

export default router;
