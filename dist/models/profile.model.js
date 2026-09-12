import { Schema, model } from "mongoose";
import { PROPERTY_CATEGORIES, PROPERTY_TYPES, } from "../types/property.type.js";
// Exported so the schema's enum and the request validator read the same list.
export const GENDERS = ["Female", "Male", "Other", "Prefer not to say"];
export const AVAILABILITY_STATUSES = ["Available", "Busy", "Away"];
export const CONTACT_MEANS = [
    "Phone",
    "WhatsApp",
    "Email",
    "Phone & WhatsApp",
];
const text = () => ({ type: String, trim: true, default: "" });
const profileSchema = new Schema({
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
    // Uncapped: a realtor's own description of how they work is the trust copy a buyer
    // reads, and a character ceiling is the platform editing it for them.
    bio: { type: String, trim: true, default: "" },
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
    // The shortlist, in the order it was built. Kept on the profile rather than in its
    // own collection: it is a handful of ids that only their owner ever reads, and it
    // stays out of publicProfile because nothing but the saved endpoints wants it.
    savedListings: {
        type: [{ type: Schema.Types.ObjectId, ref: "Property" }],
        default: [],
    },
}, { timestamps: true });
/** Response allowlist: the schema has no toJSON transform, so shape it here.
 *  `user` stays out; it is the link back to the account, not part of the profile. */
export const publicProfile = (profile) => ({
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
const Profile = model("Profile", profileSchema);
export default Profile;
//# sourceMappingURL=profile.model.js.map