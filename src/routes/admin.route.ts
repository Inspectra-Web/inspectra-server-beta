import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";

import {
  adminLogin,
  getAdminSession,
  getUser,
  getListing,
  listListings,
  listRealtors,
  listUsers,
  reviewListing,
  reviewRealtorAddress,
  setRealtorSubscription,
  updateUserStatus,
} from "../controllers/admin.controller.js";
import AppError from "../error/app.error.js";
import { protect, restrictTo } from "../middlewares/auth.middleware.js";
import validate from "../middlewares/validate.middleware.js";
import { reviewListingSchema, userStatusSchema } from "../validators/admin.validator.js";
import { reviewAddressSchema } from "../validators/agency.validator.js";
import { loginSchema } from "../validators/auth.validator.js";
import { setSubscriptionSchema } from "../validators/subscription.validator.js";

const tooManyAttempts: RequestHandler = (_req, _res, next) =>
  next(new AppError("Too many attempts. Please try again later.", 429));

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: tooManyAttempts,
});

const router = Router();

router.post("/login", adminLimiter, validate(loginSchema), adminLogin);

router.get("/session", protect, restrictTo("admin"), getAdminSession);

router.get("/users", protect, restrictTo("admin"), listUsers);

router.get("/realtors", protect, restrictTo("admin"), listRealtors);

router.get("/listings", protect, restrictTo("admin"), listListings);

router.get("/listings/:id", protect, restrictTo("admin"), getListing);

router.get("/users/:id", protect, restrictTo("admin"), getUser);

// The review lives here, not on the property router: that one is realtor-only, so an
// admin cannot reach any route on it.
router.patch(
  "/listings/:id/verification",
  protect,
  restrictTo("admin"),
  validate(reviewListingSchema),
  reviewListing,
);

router.patch(
  "/users/:id/status",
  protect,
  restrictTo("admin"),
  validate(userStatusSchema),
  reviewRealtorAddress,
  updateUserStatus,
);

// Granting a plan lives here rather than on the subscription router, which answers to
// realtors only. Same reason the listing verdict sits on this one.
router.patch(
  "/realtors/:id/subscription",
  protect,
  restrictTo("admin"),
  validate(setSubscriptionSchema),
  setRealtorSubscription,
);

router.patch(
  "/realtors/:id/address",
  protect,
  restrictTo("admin"),
  validate(reviewAddressSchema),
  reviewRealtorAddress,
);

export default router;
