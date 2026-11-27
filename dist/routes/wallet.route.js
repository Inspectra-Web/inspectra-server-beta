import { Router } from "express";
import { getMyReferral, getMyRewards, getMyWallet, getMyWalletBalances, getTokenPrices, openMyWallet, } from "../controllers/wallet.controller.js";
import { protect, restrictTo } from "../middlewares/auth.middleware.js";
const router = Router();
router.use(protect, restrictTo("realtor"));
router.get("/me", getMyWallet);
router.get("/me/balances", getMyWalletBalances);
router.get("/me/rewards", getMyRewards);
router.get("/me/referral", getMyReferral);
router.get("/prices", getTokenPrices);
router.post("/", openMyWallet);
export default router;
//# sourceMappingURL=wallet.route.js.map