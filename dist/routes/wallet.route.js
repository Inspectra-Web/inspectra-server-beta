import { Router } from "express";
import { getMyWallet, openMyWallet } from "../controllers/wallet.controller.js";
import { protect, restrictTo } from "../middlewares/auth.middleware.js";
const router = Router();
router.use(protect, restrictTo("realtor"));
router.get("/me", getMyWallet);
router.post("/", openMyWallet);
export default router;
//# sourceMappingURL=wallet.route.js.map