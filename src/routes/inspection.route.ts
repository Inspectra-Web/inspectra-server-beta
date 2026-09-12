import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";

import {
  cancelInspection,
  createInspection,
  decideInspection,
  getMyInspection,
  getRealtorInspection,
  listMyInspections,
  listRealtorInspections,
  rescheduleInspection,
} from "../controllers/inspection.controller.js";
import AppError from "../error/app.error.js";
import { protect, restrictTo } from "../middlewares/auth.middleware.js";
import validate from "../middlewares/validate.middleware.js";
import {
  createInspectionSchema,
  decisionSchema,
  rescheduleSchema,
} from "../validators/inspection.validator.js";

const tooManyBookings: RequestHandler = (_req, _res, next) =>
  next(new AppError("Too many viewing requests. Please try again later.", 429));

// Booking mails a realtor and puts a commitment in their diary, so it is the one
// spam vector here. Answering and cancelling are uncapped: the model already caps
// how many bookings can be live at once, one per listing.
const bookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: tooManyBookings,
});

const router = Router();

// One record with two views, so both roles share this router and each route says
// which end it answers to. Every literal path here sits above no param route of the
// same depth, so nothing needs the notMe guard the property router carries.
router.use(protect);

// Either party, on a booking they belong to. The handler checks which end they are
// and stamps it, so a cancelled viewing says who called it off.
router.patch("/:id/cancel", cancelInspection);

router.post(
  "/",
  restrictTo("seeker"),
  bookingLimiter,
  validate(createInspectionSchema),
  createInspection,
);

router.get("/me", restrictTo("seeker"), listMyInspections);
router.get("/me/:id", restrictTo("seeker"), getMyInspection);

// Only the buyer sets the time. A realtor who cannot make it declines with a reason
// and the buyer proposes another, which is one direction of travel instead of two
// halves of a negotiation neither console could show.
router.patch(
  "/me/:id/slot",
  restrictTo("seeker"),
  validate(rescheduleSchema),
  rescheduleInspection,
);

router.get("/realtor", restrictTo("realtor"), listRealtorInspections);
router.get("/realtor/:id", restrictTo("realtor"), getRealtorInspection);

router.patch(
  "/realtor/:id/status",
  restrictTo("realtor"),
  validate(decisionSchema),
  decideInspection,
);

export default router;
