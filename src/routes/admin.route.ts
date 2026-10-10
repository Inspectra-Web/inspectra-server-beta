import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";

import {
  adminLogin,
  decideDisputeHandler,
  getDispute,
  getAdminSession,
  getUser,
  getListing,
  listListings,
  getPayment,
  getRealtorVirtualAccount,
  getRealtorWallet,
  getRealtorWalletBalances,
  getRequest,
  getRequestDemand,
  listDisputes,
  listPayments,
  listRealtors,
  listRequests,
  listUsers,
  listVirtualAccounts,
  listWallets,
  reviewListing,
  setRealtorSubscription,
  updateUserStatus,
} from "../controllers/admin.controller.js";
import AppError from "../error/app.error.js";
import { protect, restrictTo } from "../middlewares/auth.middleware.js";
import validate from "../middlewares/validate.middleware.js";
import {
  decideDisputeSchema,
  reviewListingSchema,
  userStatusSchema,
} from "../validators/admin.validator.js";
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

router.get("/payments", protect, restrictTo("admin"), listPayments);

router.get("/virtual-accounts", protect, restrictTo("admin"), listVirtualAccounts);

router.get("/wallets", protect, restrictTo("admin"), listWallets);

router.get("/requests", protect, restrictTo("admin"), listRequests);
router.get("/requests/demand", protect, restrictTo("admin"), getRequestDemand);
router.get("/requests/:id", protect, restrictTo("admin"), getRequest);

router.get("/disputes", protect, restrictTo("admin"), listDisputes);
router.get("/disputes/:id", protect, restrictTo("admin"), getDispute);
router.patch(
  "/disputes/:id",
  protect,
  restrictTo("admin"),
  validate(decideDisputeSchema),
  decideDisputeHandler,
);

// Below the literal above, and keyed on the reference rather than an id: that is the
// string on the realtor's receipt and in Flutterwave.
router.get("/payments/:reference", protect, restrictTo("admin"), getPayment);

router.get("/listings/:id", protect, restrictTo("admin"), getListing);

router.get("/users/:id", protect, restrictTo("admin"), getUser);

router.get(
  "/realtors/:id/virtual-account",
  protect,
  restrictTo("admin"),
  getRealtorVirtualAccount,
);

router.get("/realtors/:id/wallet", protect, restrictTo("admin"), getRealtorWallet);

router.get(
  "/realtors/:id/wallet/balances",
  protect,
  restrictTo("admin"),
  getRealtorWalletBalances,
);

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

export default router;
