import { Router } from "express";
import rateLimit from "express-rate-limit";
import { getMyAgency, submitMyAddress, verifyMyCac, } from "../controllers/agency.controller.js";
import AppError from "../error/app.error.js";
import { protect, restrictTo } from "../middlewares/auth.middleware.js";
import validate from "../middlewares/validate.middleware.js";
import { billUpload } from "../services/upload.service.js";
import { submitAddressSchema, verifyCacSchema, } from "../validators/agency.validator.js";
const tooManyAttempts = (_req, _res, next) => next(new AppError("Too many attempts. Please try again later.", 429));
// One limiter each, so burning through RC lookups cannot lock a realtor out of sending
// a bill. The CAC budget is tight because every attempt is a billed provider call; the
// bill is read by a person, so its cap is only there to stop upload abuse.
const limiter = (limit) => rateLimit({
    windowMs: 60 * 60 * 1000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: tooManyAttempts,
});
const router = Router();
router.use(protect, restrictTo("realtor"));
router.get("/me", getMyAgency);
router.post("/me/cac", limiter(5), validate(verifyCacSchema), verifyMyCac);
// multer first: it is what puts the text fields on req.body for validate() to read.
router.post("/me/address", limiter(10), billUpload.single("bill"), validate(submitAddressSchema), submitMyAddress);
export default router;
//# sourceMappingURL=agency.route.js.map