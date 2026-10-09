import type { Request, Response } from "express";
import { trusted, type Types } from "mongoose";

import AppError from "../error/app.error.js";
import PropertyRequest, {
  ACTIVE_REQUESTS_MAX,
  requestCard,
  requestExpiry,
  type PropertyRequestDoc,
} from "../models/request.model.js";
import User from "../models/user.model.js";
import {
  sendRequestReceived,
  sendVerifyEmail,
  type RequestBrief,
} from "../services/email.service.js";
import {
  requestIdSchema,
  type CreateRequestInput,
  type JoinInput,
  type UpdateRequestInput,
} from "../validators/request.validator.js";
import { createAccount } from "./auth.controller.js";

const brief = (request: PropertyRequestDoc): RequestBrief => ({
  id: String(request._id),
  intent: request.intent,
  category: request.category,
  type: request.type,
  city: request.city,
  areas: request.areas,
  budgetMin: request.budgetMin,
  budgetMax: request.budgetMax,
  bedrooms: request.bedrooms,
  timeline: request.timeline,
});

/** Live means active and not yet expired. Expired requests do not hold a slot. */
const liveCount = (seeker: Types.ObjectId): Promise<number> =>
  PropertyRequest.countDocuments({
    seeker,
    status: "active",
    expiresAt: trusted({ $gt: new Date() }),
  });

const assertRoom = async (seeker: Types.ObjectId): Promise<void> => {
  if ((await liveCount(seeker)) >= ACTIVE_REQUESTS_MAX)
    throw new AppError(
      `You can have ${ACTIVE_REQUESTS_MAX} active requests at a time. Close one to add another.`,
      409,
    );
};

/** Not a secret, just not yours: a 403, the way an inquiry thread answers. */
const findOwn = async (req: Request): Promise<PropertyRequestDoc> => {
  const { id } = requestIdSchema.parse(req.params);
  const request = await PropertyRequest.findById(id);

  if (!request) throw new AppError("No request with that id.", 404);
  if (!request.seeker.equals(req.user!._id))
    throw new AppError("This request is not yours.", 403);

  return request;
};

const assertOpen = (request: PropertyRequestDoc): void => {
  if (request.status === "closed")
    throw new AppError("This request is closed. File a new one instead.", 409);
};

/**
 * Signed out: a seeker account and its first request in one submit. Everything is
 * validated before the first write, and both are saved before any mail goes out, so a
 * failed send leaves a whole account the seeker can re-verify from sign in.
 */
export const joinWaitlist = async (req: Request, res: Response): Promise<void> => {
  const { fullname, email, password, phone, contactMeans, request: fields }: JoinInput =
    req.body;

  // Ahead of the write, for a message that says what to do. The unique index still
  // catches a race, as a 409 from the global handler.
  if (await User.exists({ email }))
    throw new AppError(
      "An account with this email already exists. Sign in to add your request.",
      409,
    );

  const { user, profile, verifyUrl } = await createAccount({
    fullname,
    email,
    password,
    phone,
    role: "seeker",
  });

  profile.whatsapp = phone;
  profile.contactMeans = contactMeans;
  await profile.save();

  const request = await PropertyRequest.create({
    ...fields,
    seeker: user._id,
    consentedAt: new Date(),
  });

  await sendVerifyEmail(user.email, verifyUrl);
  sendRequestReceived(user.email, brief(request));

  res.status(201).json({
    status: "success",
    message: "You're on the waitlist. Check your email to verify your address.",
    data: { request: requestCard(request) },
  });
};

export const createRequest = async (req: Request, res: Response): Promise<void> => {
  const { request: fields }: CreateRequestInput = req.body;
  const seeker = req.user!;

  await assertRoom(seeker._id);

  const request = await PropertyRequest.create({
    ...fields,
    seeker: seeker._id,
    consentedAt: new Date(),
  });

  sendRequestReceived(seeker.email, brief(request));

  res.status(201).json({ status: "success", data: { request: requestCard(request) } });
};

/** A seeker holds a handful at most, so the whole history comes back unpaged. */
export const listMyRequests = async (req: Request, res: Response): Promise<void> => {
  const requests = await PropertyRequest.find({ seeker: req.user!._id }).sort({
    createdAt: -1,
    _id: -1,
  });

  res.status(200).json({
    status: "success",
    data: { requests: requests.map(requestCard) },
  });
};

export const getMyRequest = async (req: Request, res: Response): Promise<void> => {
  const request = await findOwn(req);

  res.status(200).json({ status: "success", data: { request: requestCard(request) } });
};

/** A whole replacement. The optional fields are named so leaving one out clears it. */
export const updateMyRequest = async (req: Request, res: Response): Promise<void> => {
  const { type, budgetMin, bedrooms, ...rest }: UpdateRequestInput = req.body;
  const request = await findOwn(req);

  assertOpen(request);

  request.set({ ...rest, type, budgetMin, bedrooms });
  await request.save();

  res.status(200).json({ status: "success", data: { request: requestCard(request) } });
};

/**
 * "Still looking": another 90 days from today. An expired request is not holding a
 * slot, so bringing one back has to fit under the cap; a live one already counts.
 */
export const renewMyRequest = async (req: Request, res: Response): Promise<void> => {
  const request = await findOwn(req);

  assertOpen(request);

  if (request.expiresAt.getTime() <= Date.now()) await assertRoom(request.seeker);

  request.expiresAt = requestExpiry();
  request.remindedAt = undefined;
  await request.save();

  res.status(200).json({ status: "success", data: { request: requestCard(request) } });
};

/** Found a place, or stopped looking. Final: a changed mind files a new request. */
export const closeMyRequest = async (req: Request, res: Response): Promise<void> => {
  const request = await findOwn(req);

  request.status = "closed";
  await request.save();

  res.status(200).json({ status: "success", data: { request: requestCard(request) } });
};
