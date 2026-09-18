import { Router } from "express";
import rateLimit from "express-rate-limit";
import { cancelMyPayment, flutterwaveWebhook, getMyPayment, listMyPayments, startSubscriptionCheckout, verifyPayment, } from "../controllers/payment.controller.js";
import AppError from "../error/app.error.js";
import { protect, restrictTo } from "../middlewares/auth.middleware.js";
import validate from "../middlewares/validate.middleware.js";
import { checkoutSchema, verifyPaymentSchema } from "../validators/payment.validator.js";
const tooManyCheckouts = (_req, _res, next) => next(new AppError("Too many payment attempts. Please try again later.", 429));
// Every checkout opens a live transaction at Flutterwave, so it is the one route here
// worth capping. Verifying is not: the redirect and a refresh of it both land on that
// one legitimately, and the handler is idempotent anyway.
const checkoutLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 15,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: tooManyCheckouts,
});
const router = Router();
// Above the gate, deliberately: Flutterwave carries no session. The verif-hash header
// is its authentication, and the handler re-reads every amount from Flutterwave rather
// than believing the body. Not rate limited either, because it retries.
router.post("/webhook", flutterwaveWebhook);
router.use(protect);
// A seeker never buys a plan. The only money they will ever move is an inspection fee,
// and that is a different route on a different router when it lands.
router.use(restrictTo("realtor"));
// Declared above "/:reference", which would otherwise swallow it.
router.get("/me", listMyPayments);
router.post("/subscription", checkoutLimiter, validate(checkoutSchema), startSubscriptionCheckout);
router.post("/:reference/verify", validate(verifyPaymentSchema), verifyPayment);
router.get("/:reference", getMyPayment);
router.patch("/:reference/cancel", cancelMyPayment);
export default router;
//# sourceMappingURL=payment.route.js.map