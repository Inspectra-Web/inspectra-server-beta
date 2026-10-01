import { Router } from "express";
import rateLimit from "express-rate-limit";
import { getMyIdentity, verifyMyBvn, verifyMyNin } from "../controllers/identity.controller.js";
import AppError from "../error/app.error.js";
import { protect, restrictTo } from "../middlewares/auth.middleware.js";
import validate from "../middlewares/validate.middleware.js";
import { avatarUpload } from "../services/upload.service.js";
import { verifyBvnSchema, verifyNinSchema } from "../validators/identity.validator.js";
const tooManyAttempts = (_req, _res, next) => next(new AppError("Too many attempts. Please try again later.", 429));
// A spend guard only: MAX_ATTEMPTS on the model is the real cap. Keyed by realtor, so a
// shared office address cannot lock out everyone behind it.
const verifyLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    keyGenerator: (req) => req.user._id.toString(),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: tooManyAttempts,
});
const router = Router();
router.use(protect, restrictTo("realtor"));
router.get("/me", getMyIdentity);
router.post("/me/nin", verifyLimiter, avatarUpload.single("selfie"), validate(verifyNinSchema), verifyMyNin);
router.post("/me/bvn", verifyLimiter, validate(verifyBvnSchema), verifyMyBvn);
export default router;
//# sourceMappingURL=identity.route.js.map