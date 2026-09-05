import type { Request, Response } from "express";

import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";
import Identity, { publicIdentity, type IdDocument } from "../models/identity.model.js";
import { uploadAvatar } from "../services/upload.service.js";
import type { VerifyIdentityInput } from "../validators/identity.validator.js";

interface DojahEntity {
  first_name?: string;
  middle_name?: string;
  last_name?: string;
  selfie_verification?: { confidence_value: number; match: boolean };
}

const words = (value: string): string[] =>
  value
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .split(" ")
    .filter(Boolean);

/** Every name on the record has to appear on the account. Middle names are ignored. */
const namesMatch = (record: string[], fullname: string): boolean => {
  const account = words(fullname);

  return record.length > 0 && record.every((name) => account.includes(name));
};

const check = async (
  document: IdDocument,
  number: string,
  selfie: Buffer,
): Promise<DojahEntity> => {
  const response = await fetch(
    `${envConfig.DOJAH_BASE_URL}/api/v1/kyc/${document}/verify`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        AppId: envConfig.DOJAH_APP_ID,
        Authorization: envConfig.DOJAH_SECRET_KEY,
      },
      body: JSON.stringify({
        [document]: number,
        selfie_image: selfie.toString("base64"),
      }),
    },
  );

  if (response.status === 404)
    throw new AppError(`That ${document.toUpperCase()} could not be found.`, 404);

  if (!response.ok)
    throw new AppError("We could not reach the verification service. Try again.", 502);

  const { entity } = (await response.json()) as { entity?: DojahEntity };

  if (!entity)
    throw new AppError(`That ${document.toUpperCase()} could not be found.`, 404);

  return entity;
};

export const getMyIdentity = async (req: Request, res: Response): Promise<void> => {
  const identity = await Identity.findOneAndUpdate(
    { user: req.user!._id },
    {},
    { upsert: true, returnDocument: "after", runValidators: true },
  );

  res.status(200).json({ status: "success", data: { identity: publicIdentity(identity) } });
};

export const verifyMyIdentity = async (req: Request, res: Response): Promise<void> => {
  const { document, number }: VerifyIdentityInput = req.body;
  const user = req.user!;

  if (!req.file) throw new AppError("Add a selfie.", 400);

  const existing = await Identity.findOne({ user: user._id });

  if (existing?.verified) throw new AppError("Your identity is already verified.", 409);

  const entity = await check(document, number, req.file.buffer);
  const first = entity.first_name ?? "";
  const last = entity.last_name ?? "";

  if (!entity.selfie_verification?.match)
    throw new AppError("Your face does not match the photo on your ID.", 400);

  if (!namesMatch([...words(first), ...words(last)], user.fullname))
    throw new AppError("The name on your ID does not match the name on your account.", 400);

  const { url, publicId } = await uploadAvatar(req.file.buffer);

  const identity = await Identity.findOneAndUpdate(
    { user: user._id },
    {
      document,
      last4: number.slice(-4),
      legalName: [first, last].filter(Boolean).join(" "),
      face: { url, publicId },
      verified: true,
      verifiedAt: new Date(),
    },
    { upsert: true, returnDocument: "after", runValidators: true },
  );

  res.status(200).json({
    status: "success",
    message: "Your identity is verified.",
    data: { identity: publicIdentity(identity) },
  });
};
