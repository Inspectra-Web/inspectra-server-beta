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

export const words = (value: string): string[] =>
  value
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .split(" ")
    .filter(Boolean);

/** Every name on the record has to appear on the account. Middle names are ignored. */
export const namesMatch = (record: string[], fullname: string): boolean => {
  const account = words(fullname);

  return record.length > 0 && record.every((name) => account.includes(name));
};

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
 * a verified property hanging off a blank profile is half a promise kept. agencyName is
 * deliberately out, because an independent realtor has no agency to name.
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
  const missing = profileGaps(user, profile);

  if (!identity?.verified) missing.push("a verified identity");

  return { ready: missing.length === 0, missing };
};

/**
 * What a realtor's profile still lacks. It gates identity verification as well as
 * listing: the check matches the NIN against these names and date of birth, and a
 * verified badge on a blank profile tells a buyer nothing. One list, so the two gates
 * cannot drift.
 */
export const profileGaps = (user: UserDoc, profile: ProfileDoc): string[] => {
  const missing: string[] = [];

  if (!profile.firstName.trim()) missing.push("your first name");
  if (!profile.lastName.trim()) missing.push("your last name");
  if (!profile.dateOfBirth) missing.push("your date of birth");
  if (!user.phone?.trim()) missing.push("a phone number");
  if (!profile.city.trim()) missing.push("your city");
  if (!profile.state.trim()) missing.push("your state");
  if (!profile.bio.trim()) missing.push("a short bio");

  return missing;
};

/** "a, b and c": the gaps as one readable clause. */
export const listOf = (items: string[]): string =>
  items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
