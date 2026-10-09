import { z } from "zod";
import { CONTACT_MEANS } from "../models/profile.model.js";
import { REQUEST_CITIES, REQUEST_INTENTS, REQUEST_TIMELINES, } from "../models/request.model.js";
import { PROPERTY_CATEGORIES, PROPERTY_TYPES, PROPERTY_TYPES_BY_CATEGORY, } from "../types/property.type.js";
import { email, password, passwordsMatch } from "./auth.validator.js";
// Mirrors AREAS_MAX and NOTES_MAX in request.model.ts.
const AREAS_MAX = 5;
const AREA_MAX = 60;
const NOTES_MAX = 500;
const BEDROOMS_MAX = 20;
const line = z.string("Required").trim();
const naira = z.number("Enter an amount").int("Use whole naira").min(0, "An amount cannot be negative");
/**
 * What the seeker is looking for, and nothing else. Strict, which is what keeps the
 * platform's own fields (`seeker`, `status`, `expiresAt`, `remindedAt`) out of a write.
 */
const requestFields = z
    .strictObject({
    intent: z.enum(REQUEST_INTENTS, "Say whether you want to rent, buy, lease or shortlet"),
    category: z.enum(PROPERTY_CATEGORIES, "Choose a property category"),
    type: z.enum(PROPERTY_TYPES, "Choose a property type").optional(),
    city: z.enum(REQUEST_CITIES, "Choose Lagos, Port Harcourt or Abuja"),
    areas: z
        .array(line.min(1, "Name the area").max(AREA_MAX, "Keep an area name short"))
        .max(AREAS_MAX, `Name at most ${AREAS_MAX} areas`)
        .default([]),
    budgetMin: naira.optional(),
    budgetMax: naira.min(1, "Set a budget"),
    bedrooms: z
        .number("Enter a number")
        .int()
        .min(0, "Bedrooms cannot be negative")
        .max(BEDROOMS_MAX, `At most ${BEDROOMS_MAX} bedrooms`)
        .optional(),
    timeline: z.enum(REQUEST_TIMELINES, "Say when you need it"),
    notes: line.max(NOTES_MAX, `Keep it under ${NOTES_MAX} characters`).default(""),
})
    .refine((v) => v.budgetMin == null || v.budgetMin <= v.budgetMax, {
    path: ["budgetMin"],
    message: "The minimum cannot be above the maximum",
})
    .refine((v) => !v.type || PROPERTY_TYPES_BY_CATEGORY[v.category].includes(v.type), {
    path: ["type"],
    message: "That type does not belong to this category",
});
const consent = z.literal(true, "Agree to be contacted about matching homes");
/** A signed-in seeker filing a request. Their contact details are already on the account. */
export const createRequestSchema = z.strictObject({ request: requestFields, consent });
/** An edit replaces the request whole: the form always sends every field. */
export const updateRequestSchema = requestFields;
/**
 * Signed out: the account and the first request in one submit. Validated as one schema
 * so nothing is written unless all of it is good. The role is not taken from the body:
 * joining the waitlist only ever makes a seeker.
 */
export const joinSchema = z
    .strictObject({
    fullname: line.min(2, "Enter your full name"),
    email,
    password,
    confirmPassword: z.string("Required").min(1, "Confirm your password"),
    phone: line.min(7, "Enter a valid phone number"),
    contactMeans: z.enum(CONTACT_MEANS, "Choose how we should reach you"),
    request: requestFields,
    consent,
})
    .refine((v) => v.password === v.confirmPassword, passwordsMatch);
export const requestIdSchema = z.object({
    id: z.string().regex(/^[0-9a-f]{24}$/i, "That is not a valid request id"),
});
//# sourceMappingURL=request.validator.js.map