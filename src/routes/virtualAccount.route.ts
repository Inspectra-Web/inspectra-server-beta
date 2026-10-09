import { Router } from "express";

import {
  getMyVirtualAccount,
  listMyEarnings,
  openMyVirtualAccount,
} from "../controllers/virtualAccount.controller.js";
import { protect, restrictTo } from "../middlewares/auth.middleware.js";
import validate from "../middlewares/validate.middleware.js";
import { openVirtualAccountSchema } from "../validators/virtualAccount.validator.js";

const router = Router();

router.use(protect, restrictTo("realtor"));

router.get("/me", getMyVirtualAccount);
router.get("/me/earnings", listMyEarnings);
router.post("/", validate(openVirtualAccountSchema), openMyVirtualAccount);

export default router;
