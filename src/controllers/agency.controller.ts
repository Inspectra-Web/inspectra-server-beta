import type { Request, Response } from "express";

import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";
import Agency, { publicAgency, type CompanyType } from "../models/agency.model.js";
import Identity, { type IdentityDoc } from "../models/identity.model.js";
import { namesMatch, words } from "../services/profile.service.js";
import { destroyAsset, uploadBill } from "../services/upload.service.js";
import type {
  SubmitAddressInput,
  VerifyCacInput,
} from "../validators/agency.validator.js";

interface CacAffiliate {
  first_name?: string;
  last_name?: string;
  affiliate_type?: string;
}

interface CacEntity {
  company_name?: string;
  rc_number?: string;
  address?: string;
  state?: string;
  city?: string;
  type_of_company?: string;
  date_of_registration?: string;
  status?: string;
  affiliates?: CacAffiliate[];
}

const dojahHeaders = {
  AppId: envConfig.DOJAH_APP_ID,
  Authorization: envConfig.DOJAH_SECRET_KEY,
};

/**
 * Identity comes first, and that is load-bearing rather than policy: without it the
 * affiliate match below would run against user.fullname, which the realtor edits in
 * Settings. Anyone could rename themselves to a listed director and pass.
 */
const verifiedIdentity = async (
  user: Request["user"],
  what: string,
): Promise<IdentityDoc> => {
  const identity = await Identity.findOne({ user: user!._id });

  if (!identity?.verified)
    throw new AppError(`Verify your identity before adding your ${what}.`, 403);

  return identity;
};

/** Mongoose would cast these, but an unparseable string should land as empty, not Invalid Date. */
const asDate = (value?: string): Date | undefined => {
  if (!value) return undefined;

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const cacCheck = async (
  rcNumber: string,
  companyType: CompanyType,
): Promise<CacEntity> => {
  const query = new URLSearchParams({ rc_number: rcNumber, company_type: companyType });

  const response = await fetch(
    `${envConfig.DOJAH_BASE_URL}/api/v1/kyc/cac/advance?${query.toString()}`,
    { headers: dojahHeaders },
  );

  // The type is part of the lookup, so the wrong pick misses a real company. Name both.
  if (response.status === 404)
    throw new AppError(
      "We could not find that number under that registration type. Check both.",
      404,
    );

  if (!response.ok)
    throw new AppError("We could not reach the verification service. Try again.", 502);

  const { entity } = (await response.json()) as { entity?: CacEntity };

  if (!entity)
    throw new AppError(
      "We could not find that number under that registration type. Check both.",
      404,
    );

  return entity;
};

export const getMyAgency = async (req: Request, res: Response): Promise<void> => {
  const agency = await Agency.findOneAndUpdate(
    { user: req.user!._id },
    {},
    { upsert: true, returnDocument: "after", runValidators: true },
  );

  res.status(200).json({ status: "success", data: { agency: publicAgency(agency) } });
};

export const verifyMyCac = async (req: Request, res: Response): Promise<void> => {
  const { rcNumber, companyType }: VerifyCacInput = req.body;
  const user = req.user!;

  const identity = await verifiedIdentity(user, "business");
  const existing = await Agency.findOne({ user: user._id });

  if (existing?.cac.verified)
    throw new AppError("Your business registration is already verified.", 409);

  const entity = await cacCheck(rcNumber, companyType);

  // The advance lookup does not document a status field, so this only bites when one
  // comes back. Never store the absence as though it meant active.
  if (entity.status && !/active/i.test(entity.status))
    throw new AppError("That registration is not active.", 400);

  const affiliates = entity.affiliates ?? [];

  if (affiliates.length === 0)
    throw new AppError(
      "That registration lists no directors we can match you to.",
      400,
    );

  const mine = affiliates.some((affiliate) =>
    namesMatch(
      [...words(affiliate.first_name ?? ""), ...words(affiliate.last_name ?? "")],
      identity.legalName,
    ),
  );

  if (!mine)
    throw new AppError("Your name is not listed on that registration.", 400);

  const agency = await Agency.findOneAndUpdate(
    { user: user._id },
    {
      cac: {
        // The provider's echo wins where it has one, same rule as the company type.
        rcNumber: entity.rc_number ?? rcNumber,
        companyName: entity.company_name ?? "",
        // The response, never the request echo: what we sent proves nothing.
        companyType: entity.type_of_company ?? "",
        registeredAddress: [entity.address, entity.city, entity.state]
          .filter(Boolean)
          .join(", "),
        registeredOn: asDate(entity.date_of_registration),
        verified: true,
        verifiedAt: new Date(),
      },
    },
    { upsert: true, returnDocument: "after", runValidators: true },
  );

  res.status(200).json({
    status: "success",
    message: "Your business registration is verified.",
    data: { agency: publicAgency(agency) },
  });
};

export const submitMyAddress = async (req: Request, res: Response): Promise<void> => {
  const { meterNumber }: SubmitAddressInput = req.body;
  const user = req.user!;

  if (!req.file) throw new AppError("Add your utility bill.", 400);

  await verifiedIdentity(user, "address");
  const existing = await Agency.findOne({ user: user._id });

  if (existing?.address.status === "verified")
    throw new AppError("Your address is already verified.", 409);

  if (existing?.address.status === "in-review")
    throw new AppError("Your bill is already with our team for review.", 409);

  // No provider call: a person reads this one, so a resubmission costs an upload and
  // nothing more. The old bill goes as soon as the new one lands.
  const uploaded = await uploadBill(req.file.buffer);

  await destroyAsset(existing?.address.document.publicId ?? "");

  const agency = await Agency.findOneAndUpdate(
    { user: user._id },
    {
      address: {
        meterNumber,
        // Filled in by the reviewer on approval: they are the one who reads the bill.
        line: "",
        document: uploaded,
        status: "in-review",
        reason: "",
        submittedAt: new Date(),
      },
    },
    { upsert: true, returnDocument: "after", runValidators: true },
  );

  res.status(200).json({
    status: "success",
    message: "Your bill is with our team. We will let you know once it is checked.",
    data: { agency: publicAgency(agency) },
  });
};

