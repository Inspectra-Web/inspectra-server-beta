import { Router } from "express";
import rateLimit from "express-rate-limit";
import { checkoutCourse, getCourse, getInvite, getLearnerCourse, getMyEnrollment, getReferrer, joinCourse, verifyEnrollment, } from "../controllers/course.controller.js";
import AppError from "../error/app.error.js";
import { protect } from "../middlewares/auth.middleware.js";
import validate from "../middlewares/validate.middleware.js";
import { checkoutCourseSchema, joinCourseSchema, verifyEnrollmentSchema, } from "../validators/course.validator.js";
const tooManyRequests = (_req, _res, next) => next(new AppError("Too many attempts. Please try again later.", 429));
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
// Public, bar the signed-in pair: possession of the link or invite is the credential.
// /me and /checkout use protect alone, not restrictTo("realtor"), which refuses the
// course-locked realtors they exist for.
const router = Router();
router.get("/", getCourse);
router.post("/join", enrollLimiter, validate(joinCourseSchema), joinCourse);
router.get("/me", protect, getMyEnrollment);
router.post("/checkout", protect, enrollLimiter, validate(checkoutCourseSchema), checkoutCourse);
router.post("/enroll/:reference/verify", validate(verifyEnrollmentSchema), verifyEnrollment);
router.get("/learn/:access", lookupLimiter, getLearnerCourse);
router.get("/invites/:invite", lookupLimiter, getInvite);
router.get("/referrers/:code", lookupLimiter, getReferrer);
export default router;
//# sourceMappingURL=course.route.js.map