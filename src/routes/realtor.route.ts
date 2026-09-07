import { Router } from "express";

import { getRealtor, listRealtors } from "../controllers/realtor.controller.js";

const router = Router();

// Public: the marketplace directory, no auth.
router.get("/", listRealtors);

router.get("/:id", getRealtor);

export default router;
