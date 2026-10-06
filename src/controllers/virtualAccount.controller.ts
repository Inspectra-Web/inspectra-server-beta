import type { Request, Response } from "express";

import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";
import Identity from "../models/identity.model.js";
import VirtualAccount, { publicVirtualAccount } from "../models/virtualAccount.model.js";
import { decrypt } from "../services/crypto.service.js";
import { createAccount, findAccount, getBalance } from "../services/planbok.service.js";
import { ensureProfile } from "../services/profile.service.js";

export const getMyVirtualAccount = async (req: Request, res: Response): Promise<void> => {
  const account = await VirtualAccount.findOne({ user: req.user!._id });

  const balance =
    account?.status === "active" && account.planbokId ? await getBalance(account.planbokId) : null;

  res.status(200).json({
    status: "success",
    data: { account: account && publicVirtualAccount(account), balance },
  });
};

export const openMyVirtualAccount = async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;

  const existing = await VirtualAccount.findOne({ user: user._id });

  if (existing?.status === "active") {
    res.status(200).json({ status: "success", data: { account: publicVirtualAccount(existing) } });
    return;
  }

  const identity = await Identity.findOne({ user: user._id }).select("+nin +bvn");

  if (!identity?.verified)
    throw new AppError("Verify your identity before opening a virtual account.", 403);

  if (!identity.nin || !identity.bvn)
    throw new AppError(
      `Your identity check is missing your NIN or BVN. Contact ${envConfig.SUPPORT_EMAIL} to add it.`,
      403,
    );

  const profile = await ensureProfile(user);

  if (!profile.address.trim())
    throw new AppError("Add your home address in your Profile before opening a virtual account.", 403);

  // Saved before Planbok is called, so a retry re-sends the same idempotency key.
  const account =
    existing ?? (await VirtualAccount.create({ kind: "realtor", user: user._id, consentedAt: new Date() }));

  const opened =
    (await createAccount(account.idempotencyKey, account.refId, identity.legalName, {
      firstName: identity.firstName,
      lastName: identity.lastName,
      phoneNumber: user.phone ?? "",
      email: user.email,
      address: [profile.address, profile.city, profile.state].filter(Boolean).join(", "),
      dateOfBirth: identity.dateOfBirth,
      bvn: decrypt(identity.bvn),
      nin: decrypt(identity.nin),
    })) ?? (await findAccount(account.refId));

  if (!opened) {
    // Planbok refused it. Dropping the row frees the idempotency key for a fresh attempt.
    await account.deleteOne();
    throw new AppError("We could not open your virtual account. Try again later.", 502);
  }

  account.planbokId = opened.id;
  account.accountNumber = opened.accountNumber;
  account.accountName = opened.accountName;
  account.bankName = opened.bankName;
  account.bankCode = opened.bankCode;
  account.status = "active";
  account.activatedAt = new Date();
  await account.save();

  res.status(201).json({ status: "success", data: { account: publicVirtualAccount(account) } });
};
