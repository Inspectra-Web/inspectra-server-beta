import type { HydratedDocument } from "mongoose";

import Profile, { type IProfile } from "../models/profile.model.js";
import User, { type UserDoc } from "../models/user.model.js";

export type ProfileDoc = HydratedDocument<IProfile>;

const capitalize = (word: string): string =>
  word ? `${word[0]!.toUpperCase()}${word.slice(1)}` : "";

export const splitName = (
  fullname: string,
): { firstName: string; middleName: string; lastName: string } => {
  const parts = fullname.split(/\s+/).filter(Boolean).map(capitalize);

  if (parts.length === 0) return { firstName: "", middleName: "", lastName: "" };

  return {
    firstName: parts[0]!,
    middleName: parts.slice(1, -1).join(" "),
    lastName: parts.length > 1 ? parts[parts.length - 1]! : "",
  };
};

export const composeName = (parts: {
  firstName: string;
  middleName: string;
  lastName: string;
}): string =>
  [parts.firstName, parts.middleName, parts.lastName]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");

export const ensureProfile = async (user: UserDoc): Promise<ProfileDoc> => {
  const existing = await Profile.findOne({ user: user._id });
  if (existing) return existing;

  let profile: ProfileDoc;

  try {
    profile = await Profile.create({ user: user._id, ...splitName(user.fullname) });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const raced = await Profile.findOne({ user: user._id });
      if (raced) return raced;
    }

    throw error;
  }

  await User.updateOne({ _id: user._id }, { $set: { profile: profile._id } });
  user.profile = profile._id;

  return profile;
};
