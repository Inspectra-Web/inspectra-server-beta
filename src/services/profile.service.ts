import type { IdentityDoc } from "../models/identity.model.js";
import Profile, { type ProfileDoc } from "../models/profile.model.js";
import User, { type UserDoc } from "../models/user.model.js";

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

/** Whether a realtor may put a property on the platform, and what is stopping them. */
export interface ListingEligibility {
  ready: boolean;
  missing: string[];
}

/**
 * The two gates on listing: a profile that has actually been filled in, and an
 * identity check that passed.
 *
 * The profile fields are not an arbitrary set. Each is something a buyer reads on the
 * listing or needs in order to reach the person behind it, which is the whole point:
 * a verified property hanging off a blank profile is half a promise kept. jobTitle is
 * deliberately out, because the UI already falls back to "Realtor", and so is
 * agencyName, because an independent realtor has no agency to name.
 *
 * Pure, and given everything it reads. The composer's gate and the profile endpoint
 * that renders it both call this, and a rule enforced in one place and described in
 * another is a rule that drifts.
 */
export const listingEligibility = (
  user: UserDoc,
  profile: ProfileDoc,
  identity: IdentityDoc | null,
): ListingEligibility => {
  const missing: string[] = [];

  if (!user.phone?.trim()) missing.push("a phone number");
  if (!profile.city.trim()) missing.push("your city");
  if (!profile.state.trim()) missing.push("your state");
  if (!profile.bio.trim()) missing.push("a short bio");
  if (!identity?.verified) missing.push("a verified identity");

  return { ready: missing.length === 0, missing };
};
