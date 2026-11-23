import { Router } from "express";

import {
  getMyRewards,
  getMyWallet,
  getMyWalletBalances,
  openMyWallet,
} from "../controllers/wallet.controller.js";
import { protect, restrictTo } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(protect, restrictTo("realtor"));

router.get("/me", getMyWallet);
router.get("/me/balances", getMyWalletBalances);
router.get("/me/rewards", getMyRewards);
router.post("/", openMyWallet);

export default router;
