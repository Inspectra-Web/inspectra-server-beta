import { Router } from "express";
import rateLimit from "express-rate-limit";
import { getMyIdentity, verifyMyIdentity } from "../controllers/identity.controller.js";
import AppError from "../error/app.error.js";
import { protect, restrictTo } from "../middlewares/auth.middleware.js";
import validate from "../middlewares/validate.middleware.js";
import { avatarUpload } from "../services/upload.service.js";
import { verifyIdentitySchema } from "../validators/identity.validator.js";
const tooManyAttempts = (_req, _res, next) => next(new AppError("Too many attempts. Please try again later.", 429));
// Every attempt is a billed call to the provider, so the budget is tight.
const verifyLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: tooManyAttempts,
});
const router = Router();
router.use(protect, restrictTo("realtor"));
router.get("/me", getMyIdentity);
router.post("/me", verifyLimiter, avatarUpload.single("selfie"), validate(verifyIdentitySchema), verifyMyIdentity);
export default router;
//# sourceMappingURL=identity.route.js.map