import type { Request, Response } from "express";

import AppError from "../error/app.error.js";
import Profile, { publicProfile } from "../models/profile.model.js";
import User, { publicUser } from "../models/user.model.js";
import { composeName, ensureProfile } from "../services/profile.service.js";
import { destroyAvatar, uploadAvatar } from "../services/upload.service.js";
import {
  REALTOR_FIELDS,
  SEEKER_FIELDS,
  type UpdateProfileInput,
} from "../validators/profile.validator.js";

const forbiddenFor = (role: string) => {
  if (role === "realtor") return SEEKER_FIELDS;
  if (role === "seeker") return REALTOR_FIELDS;
  return [...REALTOR_FIELDS, ...SEEKER_FIELDS];
};

export const getMyProfile = async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;
  const profile = await ensureProfile(user);

  res.status(200).json({
    status: "success",
    data: { user: publicUser(user), profile: publicProfile(profile) },
  });
};

export const updateMyProfile = async (req: Request, res: Response): Promise<void> => {
  const body: UpdateProfileInput = req.body;
  const user = req.user!;

  const offending = forbiddenFor(user.role).filter((field) => field in body);

  if (offending.length)
    throw new AppError(
      `These fields are not available on your account: ${offending.join(", ")}`,
      403,
    );

  const profile = await ensureProfile(user);

  const { phone, ...profileFields } = body;

  const updated = await Profile.findOneAndUpdate({ user: user._id }, profileFields, {
    returnDocument: "after",
    runValidators: true,
  });

  if (!updated) throw new AppError("Your profile could not be found.", 404);

  const userFields: Record<string, unknown> = {};

  if (phone !== undefined) userFields.phone = phone;

  if (["firstName", "middleName", "lastName"].some((part) => part in body))
    userFields.fullname = composeName({
      firstName: body.firstName ?? profile.firstName,
      middleName: body.middleName ?? profile.middleName,
      lastName: body.lastName ?? profile.lastName,
    });

  // Read back rather than assigning in memory: the schema lowercases fullname.
  const nextUser = Object.keys(userFields).length
    ? ((await User.findByIdAndUpdate(user._id, userFields, {
        returnDocument: "after",
        runValidators: true,
      })) ?? user)
    : user;

  res.status(200).json({
    status: "success",
    message: "Profile updated.",
    data: { user: publicUser(nextUser), profile: publicProfile(updated) },
  });
};

export const updateMyAvatar = async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;

  if (!req.file) throw new AppError("Choose an image to upload.", 400);

  const { url, publicId } = await uploadAvatar(req.file.buffer);
  const replaced = user.avatarId;

  const updated = await User.findByIdAndUpdate(
    user._id,
    { avatar: url, avatarId: publicId },
    { returnDocument: "after", runValidators: true },
  );

  // Only once the new image is stored: a failed delete must not leave the
  // account pointing at nothing.
  if (replaced) await destroyAvatar(replaced);

  res.status(200).json({
    status: "success",
    message: "Photo updated.",
    data: { user: publicUser(updated ?? user) },
  });
};

export const deleteMyAvatar = async (req: Request, res: Response): Promise<void> => {
  const user = req.user!;
  const replaced = user.avatarId;

  const updated = await User.findByIdAndUpdate(
    user._id,
    { avatar: "", avatarId: "" },
    { returnDocument: "after", runValidators: true },
  );

  if (replaced) await destroyAvatar(replaced);

  res.status(200).json({
    status: "success",
    message: "Photo removed.",
    data: { user: publicUser(updated ?? user) },
  });
};
