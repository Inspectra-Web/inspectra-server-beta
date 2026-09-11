import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";

import {
  addInquiryMessage,
  createInquiry,
  getLead,
  getMyInquiry,
  listLeads,
  listMyInquiries,
  updateLeadStatus,
} from "../controllers/inquiry.controller.js";
import AppError from "../error/app.error.js";
import { protect, restrictTo } from "../middlewares/auth.middleware.js";
import validate from "../middlewares/validate.middleware.js";
import {
  addMessageSchema,
  createInquirySchema,
  inquiryStatusSchema,
} from "../validators/inquiry.validator.js";

const tooManyInquiries: RequestHandler = (_req, _res, next) =>
  next(new AppError("Too many inquiries. Please try again later.", 429));

// Opening a thread mails a realtor, so it is the one spam vector here. Replies are
// uncapped on purpose: a live conversation is the point, and the model caps the thread.
const inquiryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: tooManyInquiries,
});

const router = Router();

// One record with two views, so both roles share this router and each route says
// which end it answers to. Every literal path here sits above no param route of the
// same depth, so nothing needs the notMe guard the property router carries.
router.use(protect);

// Either party, on a thread they belong to. The handler checks which end they are.
router.post("/:id/messages", validate(addMessageSchema), addInquiryMessage);

router.post(
  "/",
  restrictTo("seeker"),
  inquiryLimiter,
  validate(createInquirySchema),
  createInquiry,
);

router.get("/me", restrictTo("seeker"), listMyInquiries);
router.get("/me/:id", restrictTo("seeker"), getMyInquiry);

router.get("/leads", restrictTo("realtor"), listLeads);
router.get("/leads/:id", restrictTo("realtor"), getLead);

router.patch(
  "/leads/:id/status",
  restrictTo("realtor"),
  validate(inquiryStatusSchema),
  updateLeadStatus,
);

export default router;
