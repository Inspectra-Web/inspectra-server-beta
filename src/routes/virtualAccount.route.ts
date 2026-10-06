import { Router } from "express";

import {
  getMyVirtualAccount,
  openMyVirtualAccount,
} from "../controllers/virtualAccount.controller.js";
import { protect, restrictTo } from "../middlewares/auth.middleware.js";
import validate from "../middlewares/validate.middleware.js";
import { openVirtualAccountSchema } from "../validators/virtualAccount.validator.js";

const router = Router();

router.use(protect, restrictTo("realtor"));

router.get("/me", getMyVirtualAccount);
router.post("/", validate(openVirtualAccountSchema), openMyVirtualAccount);

export default router;
