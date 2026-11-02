import { z } from "zod";
import { COURSE_STATUSES } from "../models/course.model.js";
import { ENROLLMENT_STATUSES } from "../models/enrollment.model.js";
import { email } from "./auth.validator.js";
const PAGE_SIZE = 10;
const PAGE_SIZE_MAX = 48;
const SEARCH_MAX = 80;
const TEXT_MAX = 2000;
// The raw secrets are 64 hex characters (randomBytes(32)).
const secret = (label) => z.string().regex(/^[0-9a-f]{64}$/i, `That ${label} is not valid`);
/**
 * A guest buying the course. Strict, and carrying no amount: the price is read off the
 * course document, so the body has no way to name its own.
 */
export const enrollSchema = z.strictObject({
    fullname: z.string("Required").trim().min(3, "Enter your full name").max(120),
    email,
    phone: z.string("Required").trim().min(7, "Enter a valid phone number").max(20),
});
/** The transaction id on Flutterwave's redirect: a claim to check, not proof. */
export const verifyEnrollmentSchema = z.strictObject({
    transactionId: z.coerce
        .number("That is not a valid transaction id")
        .int()
        .positive("That is not a valid transaction id"),
});
const url = z.union([z.literal(""), z.url("Enter a full link starting with https://")]);
/** The admin saving the course whole. Status has its own write, so it is not here. */
export const saveCourseSchema = z.strictObject({
    title: z.string().trim().max(200),
    subtitle: z.string().trim().max(300),
    description: z.string().trim().max(TEXT_MAX),
    cover: url,
    videoUrl: url,
    minutes: z.number().int("Whole minutes only").min(0).max(600),
    price: z.number().int("Whole naira only").min(100, "The course costs at least ₦100"),
});
export const courseStatusSchema = z.strictObject({
    status: z.enum(COURSE_STATUSES, "Choose draft or published"),
});
/* Params and queries: z.object, parsed inline in the controller. ------------------ */
export const enrollmentReferenceSchema = z.object({
    reference: z.string().regex(/^INS-CRS-[0-9A-F]{8}$/i, "That is not a valid course reference"),
});
export const accessSchema = z.object({ access: secret("course link") });
export const inviteSchema = z.object({ invite: secret("registration link") });
export const courseUploadSchema = z.object({
    kind: z.enum(["cover", "video"], "Upload a cover or a video"),
});
const STATUS_FILTERS = ["all", ...ENROLLMENT_STATUSES];
export const listEnrollmentsSchema = z.object({
    q: z.string().trim().max(SEARCH_MAX, "Search is too long").default(""),
    status: z.enum(STATUS_FILTERS).default("all"),
    page: z.coerce.number().int().min(1, "Page starts at 1").default(1),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(PAGE_SIZE_MAX, `Ask for at most ${PAGE_SIZE_MAX} per page`)
        .default(PAGE_SIZE),
});
//# sourceMappingURL=course.validator.js.map