import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";

import {
  closeMyRequest,
  createRequest,
  getMyRequest,
  joinWaitlist,
  listMyRequests,
  renewMyRequest,
  updateMyRequest,
} from "../controllers/request.controller.js";
import AppError from "../error/app.error.js";
import { protect, restrictTo } from "../middlewares/auth.middleware.js";
import validate from "../middlewares/validate.middleware.js";
import {
  createRequestSchema,
  joinSchema,
  updateRequestSchema,
} from "../validators/request.validator.js";

const tooManyRequests: RequestHandler = (_req, _res, next) =>
  next(new AppError("Too many attempts. Please try again later.", 429));

// Joining creates an account and sends two emails, so it is held to the sign-up rate.
const joinLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: tooManyRequests,
});

const router = Router();

// Public, and above the session gate: the signed-out door onto the waitlist.
router.post("/join", joinLimiter, validate(joinSchema), joinWaitlist);

router.use(protect, restrictTo("seeker"));

router.post("/", validate(createRequestSchema), createRequest);

router.get("/me", listMyRequests);
router.get("/me/:id", getMyRequest);
router.patch("/me/:id", validate(updateRequestSchema), updateMyRequest);
router.post("/me/:id/renew", renewMyRequest);
router.patch("/me/:id/close", closeMyRequest);

export default router;
