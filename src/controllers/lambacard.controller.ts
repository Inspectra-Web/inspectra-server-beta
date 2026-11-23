import type { Request, Response } from "express";

import AppError from "../error/app.error.js";
import { settlePurchase } from "../services/incentive.service.js";
import { getPurchase, verifyWebhook } from "../services/lambacard.service.js";

/**
 * LambaCard reporting on a purchase. The body only says which purchase moved: the purchase
 * itself is read back from LambaCard, so a delivery that repeats or arrives out of order
 * changes nothing.
 */
export const lambacardWebhook = async (req: Request, res: Response) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  if (!verifyWebhook(raw, req.get("lbt-webhook-signature")))
    throw new AppError("That request is not from LambaCard.", 401);

  let purchaseId: string | undefined;
  try {
    purchaseId = JSON.parse(raw.toString("utf8")).data?.purchaseId;
  } catch {
    throw new AppError("That request could not be read.", 400);
  }

  // Swallowed on purpose: a signed delivery is always acknowledged, and the sweep reads the
  // purchase again if this read fails.
  if (purchaseId) {
    try {
      await settlePurchase(await getPurchase(purchaseId));
    } catch (error) {
      console.error(`LambaCard webhook for purchase ${purchaseId}: ${(error as Error).message}`);
    }
  }

  res.status(200).json({ status: "success" });
};
