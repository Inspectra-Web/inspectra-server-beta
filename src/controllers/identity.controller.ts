import type { Request, Response } from "express";
import { trusted, type Types } from "mongoose";

import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";
import Identity, { MAX_ATTEMPTS, publicIdentity } from "../models/identity.model.js";
import { encrypt, fingerprint } from "../services/crypto.service.js";
import {
  composeName,
  ensureProfile,
  listOf,
  profileGaps,
  words,
} from "../services/profile.service.js";
import { uploadAvatar } from "../services/upload.service.js";
import type { VerifyBvnInput, VerifyNinInput } from "../validators/identity.validator.js";

interface DojahPerson {
  first_name?: string;
  middle_name?: string;
  last_name?: string;
  date_of_birth?: string;
}

interface DojahLiveness {
  liveness?: { liveness_check?: boolean; spoof?: boolean };
}

interface Name {
  first: string;
  middle: string;
  last: string;
}

const UNREACHABLE = "We could not reach the verification service. Try again.";

const dojah = async (path: string, init?: RequestInit): Promise<globalThis.Response> => {
  try {
    return await fetch(`${envConfig.DOJAH_BASE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        AppId: envConfig.DOJAH_APP_ID,
        Authorization: envConfig.DOJAH_SECRET_KEY,
      },
    });
  } catch {
    throw new AppError(UNREACHABLE, 502);
  }
};

const entityOf = async <T>(response: globalThis.Response): Promise<T | undefined> =>
  ((await response.json().catch(() => ({}))) as { entity?: T }).entity;

/**
 * Passes only on an explicit live verdict. The published shape is `liveness_check`, the
 * sandbox answers `spoof`; anything else is unreadable and fails closed.
 */
const checkLiveness = async (selfie: Buffer): Promise<void> => {
  const response = await dojah("/api/v1/ml/liveness", {
    method: "POST",
    body: JSON.stringify({ image: selfie.toString("base64") }),
  });

  if (!response.ok) throw new AppError(UNREACHABLE, 502);

  const verdict = (await entityOf<DojahLiveness>(response))?.liveness;
  const live =
    typeof verdict?.liveness_check === "boolean"
      ? verdict.liveness_check
      : typeof verdict?.spoof === "boolean"
        ? !verdict.spoof
        : undefined;

  if (live === undefined) throw new AppError(UNREACHABLE, 502);

  if (!live)
    throw new AppError(
      "We could not confirm a live person in that selfie. Use your own face, not a photo or a screen.",
      400,
    );
};

const notFound = (label: string) => new AppError(`That ${label} could not be found.`, 404);

// A missing number is a 404 on the NIN endpoint and a 400 on the BVN one.
const lookupFailed = (response: globalThis.Response, label: string): AppError =>
  response.status === 404 || response.status === 400 ? notFound(label) : new AppError(UNREACHABLE, 502);

// The basic lookup, no selfie: liveness is its own call, and the selfie variant bills more.
const lookupNin = async (nin: string): Promise<DojahPerson> => {
  const response = await dojah(`/api/v1/kyc/nin?nin=${encodeURIComponent(nin)}`);

  if (!response.ok) throw lookupFailed(response, "NIN");

  const entity = await entityOf<DojahPerson>(response);
  if (!entity) throw notFound("NIN");

  return entity;
};

const lookupBvn = async (bvn: string): Promise<DojahPerson> => {
  const response = await dojah(`/api/v1/kyc/bvn/full?bvn=${encodeURIComponent(bvn)}`);

  if (!response.ok) throw lookupFailed(response, "BVN");

  const entity = await entityOf<DojahPerson>(response);
  if (!entity) throw notFound("BVN");

  return entity;
};

const normalise = (value?: string): string => words(value ?? "").join(" ");

const nameOf = (person: DojahPerson): Name => ({
  first: normalise(person.first_name),
  middle: normalise(person.middle_name),
  last: normalise(person.last_name),
});

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A record's date of birth as "YYYY-MM-DD", or "" when it is missing or unreadable. */
const dayOf = (value?: string): string => {
  const raw = value?.trim() ?? "";
  // "1990-05-14", with or without a time after it.
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  // "14-05-1990", "14/05/1990", "14-May-1990".
  const dmy = raw.match(/^(\d{1,2})[-/](\d{1,2}|[a-z]{3,})[-/](\d{4})$/i);

  const monthOf = (part: string) =>
    /^\d+$/.test(part) ? part : String(MONTHS.indexOf(part.slice(0, 3).toLowerCase()) + 1);

  const [year, month, day] = iso
    ? [iso[1], iso[2], iso[3]]
    : dmy
      ? [dmy[3], monthOf(dmy[2]!), dmy[1]]
      : [];

  if (!year || !month || !day || month === "0") return "";

  const date = new Date(Date.UTC(+year, +month - 1, +day));
  // Rolled over means it was not a real day, such as 31 April.
  if (date.getUTCMonth() !== +month - 1 || date.getUTCDate() !== +day) return "";

  return date.toISOString().slice(0, 10);
};

// A blank date is the provider's gap, not the realtor's mismatch: a 502 gives the attempt back.
const recordDay = (person: DojahPerson, label: string): string => {
  const day = dayOf(person.date_of_birth);

  if (!day)
    throw new AppError(
      `We could not read the date of birth on your ${label} record. Try again, or contact support.`,
      502,
    );

  return day;
};

const attemptsNote = (left: number): string =>
  left === 0
    ? "That was your last attempt. Contact support to review your identity."
    : `You have ${left} attempt${left === 1 ? "" : "s"} left.`;

/** Identity verification only opens on a complete profile. Checked before any attempt is claimed. */
const requireCompleteProfile = async (user: NonNullable<Request["user"]>) => {
  const profile = await ensureProfile(user);
  const missing = profileGaps(user, profile);

  if (missing.length)
    throw new AppError(
      `Complete your profile before verifying your identity: add ${listOf(missing)}.`,
      403,
    );

  return profile;
};

export const getMyIdentity = async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;
  const [identity, profile] = await Promise.all([
    Identity.findOneAndUpdate(
      { user: user._id },
      {},
      { upsert: true, returnDocument: "after", runValidators: true },
    ),
    ensureProfile(user),
  ]);

  res.status(200).json({
    status: "success",
    data: {
      identity: publicIdentity(identity),
      // What stands between this realtor and starting the check, so the tab can say so.
      profileMissing: profileGaps(user, profile),
    },
  });
};

const PARTS: (keyof Name)[] = ["first", "middle", "last"];

const plural = (count: number, one: string, many: string) => (count > 1 ? many : one);

const startedIdentity = (userId: Types.ObjectId) =>
  Identity.findOneAndUpdate(
    { user: userId },
    {},
    { upsert: true, returnDocument: "after", runValidators: true },
  );

/**
 * Runs one step against the shared budget of MAX_ATTEMPTS. The attempt is claimed before
 * any billed call, and conditionally, so parallel requests cannot pass the cap. An answered
 * failure keeps it; a provider outage or our own fault gives it back.
 */
const withAttempt = async <T>(userId: Types.ObjectId, step: () => Promise<T>): Promise<T> => {
  const claimed = await Identity.findOneAndUpdate(
    { user: userId, verified: false, attempts: trusted({ $lt: MAX_ATTEMPTS }) },
    { $inc: { attempts: 1 } },
    { returnDocument: "after" },
  );

  if (!claimed)
    throw new AppError(
      `You have used all ${MAX_ATTEMPTS} attempts. Contact support to review your identity.`,
      403,
    );

  const refund = () =>
    Identity.updateOne(
      { user: userId, attempts: trusted({ $gt: 0 }) },
      { $inc: { attempts: -1 } },
    );

  try {
    const result = await step();
    // Only a failed check spends an attempt; a passed step gives its claim back.
    await refund();
    return result;
  } catch (error) {
    if (error instanceof AppError && error.statusCode < 500)
      throw new AppError(
        `${error.message} ${attemptsNote(MAX_ATTEMPTS - claimed.attempts)}`,
        error.statusCode,
      );

    await refund();

    if ((error as { code?: number }).code === 11000)
      throw new AppError("This number is already verified on another account.", 409);
    throw error;
  }
};

/** Step one: the profile's names and date of birth against the NIN, then liveness on the selfie. */
export const verifyMyNin = async (req: Request, res: Response): Promise<void> => {
  const { nin }: VerifyNinInput = req.body;
  const user = req.user!;

  if (!req.file) throw new AppError("Add a selfie.", 400);
  const selfie = req.file.buffer;

  const profile = await requireCompleteProfile(user);

  const existing = await startedIdentity(user._id);

  if (existing.verified) throw new AppError("Your identity is already verified.", 409);
  if (existing.ninVerified) throw new AppError("Your NIN is already verified.", 409);

  await withAttempt(user._id, async () => {
    // Cheapest first: a wrong NIN costs nothing, so liveness is billed only once all else passes.
    const ninHash = fingerprint(nin);

    if (await Identity.exists({ user: trusted({ $ne: user._id }), ninHash }))
      throw new AppError("This NIN is already verified on another account.", 409);

    const record = await lookupNin(nin);

    const fromNin = nameOf(record);
    const mine: Name = {
      first: normalise(profile.firstName),
      middle: normalise(profile.middleName),
      last: normalise(profile.lastName),
    };
    const mismatched = PARTS.filter((part) => mine[part] !== fromNin[part]);

    if (mismatched.length)
      throw new AppError(
        `Your ${mismatched.join(" and ")} ${plural(mismatched.length, "name", "names")} on your Profile ${plural(mismatched.length, "does", "do")} not match your NIN. Correct ${plural(mismatched.length, "it", "them")} in your Profile, then try again.`,
        400,
      );

    const ninDay = recordDay(record, "NIN");

    if (dayOf(profile.dateOfBirth?.toISOString()) !== ninDay)
      throw new AppError(
        "Your date of birth on your Profile does not match your NIN. Correct it in your Profile, then try again.",
        400,
      );

    await checkLiveness(selfie);

    const { url, publicId } = await uploadAvatar(selfie);

    await Identity.updateOne(
      { user: user._id },
      {
        firstName: profile.firstName.trim(),
        middleName: profile.middleName.trim(),
        lastName: profile.lastName.trim(),
        legalName: composeName(profile),
        dateOfBirth: ninDay,
        nin: encrypt(nin),
        ninHash,
        ninLast4: nin.slice(-4),
        face: { url, publicId },
        ninVerified: true,
      },
      { runValidators: true },
    );
  });

  const identity = await startedIdentity(user._id);

  res.status(200).json({
    status: "success",
    message: "Your NIN is verified. Now add your BVN.",
    data: { identity: publicIdentity(identity) },
  });
};

/** Step two: the BVN's name and date of birth against what the NIN step already matched. */
export const verifyMyBvn = async (req: Request, res: Response): Promise<void> => {
  const { bvn }: VerifyBvnInput = req.body;
  const user = req.user!;

  const existing = await startedIdentity(user._id);

  if (existing.verified) throw new AppError("Your identity is already verified.", 409);
  if (!existing.ninVerified) throw new AppError("Verify your NIN first.", 409);

  const profile = await requireCompleteProfile(user);
  // A NIN verified before the date was checked carries a raw or blank one; the profile's stands in.
  const ninDay = dayOf(existing.dateOfBirth) || dayOf(profile.dateOfBirth?.toISOString());

  await withAttempt(user._id, async () => {
    // Dojah bills a BVN lookup even when the number is not found, so the free check goes first.
    const bvnHash = fingerprint(bvn);

    if (await Identity.exists({ user: trusted({ $ne: user._id }), bvnHash }))
      throw new AppError("This BVN is already verified on another account.", 409);

    const record = await lookupBvn(bvn);
    const fromBvn = nameOf(record);
    const fromNin: Name = {
      first: normalise(existing.firstName),
      middle: normalise(existing.middleName),
      last: normalise(existing.lastName),
    };

    if (
      fromNin.first !== fromBvn.first ||
      fromNin.last !== fromBvn.last ||
      (fromNin.middle && fromBvn.middle && fromNin.middle !== fromBvn.middle)
    )
      throw new AppError("The name on your BVN does not match the name on your NIN.", 400);

    if (recordDay(record, "BVN") !== ninDay)
      throw new AppError("The date of birth on your BVN does not match your NIN.", 400);

    await Identity.updateOne(
      { user: user._id },
      {
        bvn: encrypt(bvn),
        bvnHash,
        bvnLast4: bvn.slice(-4),
        verified: true,
        verifiedAt: new Date(),
      },
      { runValidators: true },
    );
  });

  const identity = await startedIdentity(user._id);

  res.status(200).json({
    status: "success",
    message: "Your identity is verified.",
    data: { identity: publicIdentity(identity) },
  });
};
