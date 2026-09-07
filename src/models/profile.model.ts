import { Schema, model, type HydratedDocument, type Types } from "mongoose";
import {
  PROPERTY_CATEGORIES,
  PROPERTY_TYPES,
  type PropertyCategory,
  type PropertyType,
} from "../types/property.type.js";

const BIO_MAX = 600;

export type Gender = "Female" | "Male" | "Other" | "Prefer not to say";
export type AvailabilityStatus = "Available" | "Busy" | "Away";
export type ContactMeans = "Phone" | "WhatsApp" | "Email" | "Phone & WhatsApp";

// Exported so the schema's enum and the request validator read the same list.
export const GENDERS: Gender[] = ["Female", "Male", "Other", "Prefer not to say"];
export const AVAILABILITY_STATUSES: AvailabilityStatus[] = ["Available", "Busy", "Away"];
export const CONTACT_MEANS: ContactMeans[] = [
  "Phone",
  "WhatsApp",
  "Email",
  "Phone & WhatsApp",
];

export interface IProfile {
  user: Types.ObjectId;

  firstName: string;
  lastName: string;
  middleName: string;
  bio: string;
  gender?: Gender;
  address: string;
  city: string;
  state: string;
  country: string;
  whatsapp: string;
  language: string;

  jobTitle: string;
  agencyName: string;
  agencyAddress: string;
  region: string;
  experience: string;
  specialization: string[];
  availabilityStatus: AvailabilityStatus;
  contactMeans: ContactMeans;
  socials: {
    instagram: string;
    linkedin: string;
    facebook: string;
    x: string;
  };
  certified: boolean;

  preferredCity: string;
  propertyCategories: PropertyCategory[];
  propertyInterests: PropertyType[];

  createdAt: Date;
  updatedAt: Date;
}

const text = () => ({ type: String, trim: true, default: "" });

const profileSchema = new Schema<IProfile>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "A profile must belong to a user"],
      unique: true,
    },

    // Core: every role has these.
    firstName: text(),
    lastName: text(),
    middleName: text(),
    bio: {
      type: String,
      trim: true,
      maxLength: [BIO_MAX, `Keep it under ${BIO_MAX} characters`],
      default: "",
    },
    
    gender: {
      type: String,
      enum: {
        values: GENDERS,
        message: "{VALUE} is not a valid gender",
      },
    },
    address: text(),
    city: text(),
    state: text(),
    country: text(),
    whatsapp: text(),
    language: text(),

    jobTitle: text(),
    agencyName: text(),
    agencyAddress: text(),
    region: text(),
    experience: text(),
    specialization: { type: [String], default: [] },
    availabilityStatus: {
      type: String,
      enum: {
        values: AVAILABILITY_STATUSES,
        message: "{VALUE} is not a valid availability status",
      },
      default: "Available",
    },
    contactMeans: {
      type: String,
      enum: {
        values: CONTACT_MEANS,
        message: "{VALUE} is not a valid contact means",
      },
      default: "Email",
    },
    socials: {
      instagram: text(),
      linkedin: text(),
      facebook: text(),
      x: text(),
    },
    certified: { type: Boolean, default: false },

    // Seeker: left at defaults for other roles.
    preferredCity: text(),
    propertyCategories: {
      type: [String],
      enum: {
        values: PROPERTY_CATEGORIES,
        message: "{VALUE} is not a valid property category",
      },
      default: [],
    },
    propertyInterests: {
      type: [String],
      enum: {
        values: PROPERTY_TYPES,
        message: "{VALUE} is not a valid property type",
      },
      default: [],
    },
  },
  { timestamps: true },
);

export type ProfileDoc = HydratedDocument<IProfile>;

/** Response allowlist: the schema has no toJSON transform, so shape it here.
 *  `user` stays out; it is the link back to the account, not part of the profile. */
export const publicProfile = (profile: ProfileDoc) => ({
  id: profile._id,
  firstName: profile.firstName,
  lastName: profile.lastName,
  middleName: profile.middleName,
  bio: profile.bio,
  gender: profile.gender,
  address: profile.address,
  city: profile.city,
  state: profile.state,
  country: profile.country,
  whatsapp: profile.whatsapp,
  language: profile.language,
  jobTitle: profile.jobTitle,
  agencyName: profile.agencyName,
  agencyAddress: profile.agencyAddress,
  region: profile.region,
  experience: profile.experience,
  specialization: profile.specialization,
  availabilityStatus: profile.availabilityStatus,
  contactMeans: profile.contactMeans,
  socials: profile.socials,
  certified: profile.certified,
  preferredCity: profile.preferredCity,
  propertyCategories: profile.propertyCategories,
  propertyInterests: profile.propertyInterests,
  createdAt: profile.createdAt,
  updatedAt: profile.updatedAt,
});

const Profile = model<IProfile>("Profile", profileSchema);

export default Profile;
