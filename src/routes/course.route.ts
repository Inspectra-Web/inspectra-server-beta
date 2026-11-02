import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";

import {
  enroll,
  finishCourse,
  getCourse,
  getInvite,
  getLearnerCourse,
  verifyEnrollment,
} from "../controllers/course.controller.js";
import AppError from "../error/app.error.js";
import validate from "../middlewares/validate.middleware.js";
import { enrollSchema, verifyEnrollmentSchema } from "../validators/course.validator.js";

const tooManyRequests: RequestHandler = (_req, _res, next) =>
  next(new AppError("Too many attempts. Please try again later.", 429));

// Enrolling opens a checkout and can send an email, so it is held to the sign-up rate.
const enrollLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: tooManyRequests,
});

// The link and invite lookups are guessing surfaces, so they are throttled too.
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: tooManyRequests,
});

// All public: the buyer is a guest. Possession of the link or invite is the credential.
const router = Router();

router.get("/", getCourse);
router.post("/enroll", enrollLimiter, validate(enrollSchema), enroll);
router.post("/enroll/:reference/verify", validate(verifyEnrollmentSchema), verifyEnrollment);
router.get("/learn/:access", lookupLimiter, getLearnerCourse);
router.post("/learn/:access/finish", lookupLimiter, finishCourse);
router.get("/invites/:invite", lookupLimiter, getInvite);

export default router;
