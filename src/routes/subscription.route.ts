import { Router } from "express";

import {
  cancelMySubscription,
  getMySubscription,
  listPlans,
} from "../controllers/subscription.controller.js";
import { protect, restrictTo } from "../middlewares/auth.middleware.js";

const router = Router();

// Above the gate: the catalogue is what the public pricing page reads, and a visitor
// pricing the platform has no session yet.
router.get("/plans", listPlans);

router.use(protect);

// Only a realtor holds a plan. A seeker never pays for anything but a viewing.
router.get("/me", restrictTo("realtor"), getMySubscription);

// No body: cancelling says one thing, and the period it stops at is already on record.
router.patch("/me/cancel", restrictTo("realtor"), cancelMySubscription);

export default router;
