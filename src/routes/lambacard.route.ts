import express, { Router } from "express";

import { lambacardWebhook } from "../controllers/lambacard.controller.js";

const router = Router();

// Raw, not JSON: the signature covers the exact bytes sent. Mounted before the global
// express.json() for that reason.
router.post("/webhooks", express.raw({ type: "application/json", limit: "64kb" }), lambacardWebhook);

export default router;
