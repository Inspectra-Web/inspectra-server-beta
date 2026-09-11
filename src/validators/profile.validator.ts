import { z } from "zod";

import {
  AVAILABILITY_STATUSES,
  CONTACT_MEANS,
  GENDERS,
} from "../models/profile.model.js";
import { PROPERTY_CATEGORIES, PROPERTY_TYPES } from "../types/property.type.js";

// Mirrors client/src/lib/accountSchema.ts so the two ends agree on the rules.

const TAGS_MAX = 20;

const line = z.string("Required").trim();

const phone = line.refine(
  (value) => value === "" || value.length >= 7,
  "Enter a valid phone number",
);

export const updateProfileSchema = z
  .strictObject({
    // Recomposed into User.fullname, so these two cannot be blanked.
    firstName: line.min(1, "Enter your first name"),
    lastName: line.min(1, "Enter your last name"),
    middleName: line,
    // Uncapped, as on the model: the realtor writes their own trust copy.
    bio: line,
    gender: z.enum(GENDERS),
    address: line,
    city: line,
    state: line,
    country: line,
    // Lives on User, not the profile. The controller routes it there.
    phone,
    whatsapp: phone,
    language: line,

    jobTitle: line,
    agencyName: line,
    agencyAddress: line,
    region: line,
    experience: line,
    specialization: z
      .array(line.min(1, "A specialty cannot be blank"))
      .max(TAGS_MAX, `Pick at most ${TAGS_MAX} specialties`),
    availabilityStatus: z.enum(AVAILABILITY_STATUSES),
    contactMeans: z.enum(CONTACT_MEANS),
    // Sent whole: a partial object would clear the handles it omits.
    socials: z.strictObject({
      instagram: line,
      linkedin: line,
      facebook: line,
      x: line,
    }),

    preferredCity: line,
    propertyCategories: z.array(z.enum(PROPERTY_CATEGORIES)),
    propertyInterests: z.array(z.enum(PROPERTY_TYPES)),
  })
  .partial()
  .refine(
    (body) => Object.keys(body).length > 0,
    "Send at least one field to update",
  );

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

type ProfileField = keyof UpdateProfileInput;

// Typed against the schema, so renaming a field breaks the build rather than
// quietly leaving it ungated.

/** Meaningless on a seeker account, and refused there. */
export const REALTOR_FIELDS: ProfileField[] = [
  "jobTitle",
  "agencyName",
  "agencyAddress",
  "region",
  "experience",
  "specialization",
  "availabilityStatus",
  "contactMeans",
  "socials",
];

/** Meaningless on a realtor account, and refused there. */
export const SEEKER_FIELDS: ProfileField[] = [
  "preferredCity",
  "propertyCategories",
  "propertyInterests",
];

/** The listing being saved or unsaved. A param, so it is parsed in the controller. */
export const savedListingSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/i, "That is not a valid listing id"),
});
