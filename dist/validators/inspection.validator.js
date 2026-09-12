import { z } from "zod";
import { INSPECTION_STATUSES, } from "../models/inspection.model.js";
// Mirrors NOTE_MAX / RESPONSE_MAX on the schema in inspection.model.ts.
const NOTE_MAX = 500;
const RESPONSE_MAX = 500;
// How far ahead a viewing may be booked. A date beyond this is a typo, not a plan.
const HORIZON_DAYS = 90;
const PAGE_SIZE = 12;
const PAGE_SIZE_MAX = 48;
const line = z.string("Required").trim();
const id = (label) => z.string().regex(/^[0-9a-f]{24}$/i, `That is not a valid ${label} id`);
/**
 * The appointment, as one timestamp. Both ends of the window are checked here rather
 * than in the controller because they are facts about the request, not about the
 * booking: a viewing in the past cannot be attended, and one two years out is a slip.
 */
const slot = z.coerce
    .date("Pick a date and time")
    .refine((value) => value.getTime() > Date.now(), "Pick a time in the future")
    .refine((value) => value.getTime() < Date.now() + HORIZON_DAYS * 24 * 60 * 60 * 1000, `Book within the next ${HORIZON_DAYS} days`);
const note = line.max(NOTE_MAX, `Keep your note under ${NOTE_MAX} characters`);
/**
 * Strict, which is what keeps the platform's own fields out of a buyer's write:
 * `seeker`, `realtor`, `status`, `response` and `cancelledBy` are all absent here on
 * purpose. The realtor is read off the property, never claimed by the sender.
 */
export const createInspectionSchema = z.strictObject({
    property: id("listing"),
    slot,
    note: note.optional(),
});
/** Moving a booking. Only the buyer sets the time, so only they send this. */
export const rescheduleSchema = z.strictObject({ slot });
export const INSPECTION_DECISIONS = [
    "confirmed",
    "declined",
    "completed",
];
export const decisionSchema = z
    .strictObject({
    status: z.enum(INSPECTION_DECISIONS, "Choose what to do with this booking"),
    // On a confirmation this is the realtor's note to the buyer, and for a virtual
    // tour it is where the meeting link goes.
    response: line.max(RESPONSE_MAX, `Keep it under ${RESPONSE_MAX} characters`).optional(),
})
    .superRefine((body, ctx) => {
    // A refusal the buyer cannot act on is worse than no answer at all, which is the
    // same rule a disputed listing carries in admin.validator.ts.
    if (body.status === "declined" && !body.response)
        ctx.addIssue({
            code: "custom",
            path: ["response"],
            message: "Say why you cannot make this viewing",
        });
});
export const INSPECTION_WINDOWS = ["all", "upcoming", "past"];
export const INSPECTION_SORTS = ["soonest", "latest"];
// "all" is the sentinel the controller checks, as on the listings and inquiry lists.
const STATUS_FILTERS = ["all", ...INSPECTION_STATUSES];
/**
 * Deliberately `z.object`, not `z.strictObject`, and parsed inline in the controller:
 * `validate()` assigns to `req.body`, and Express 5 exposes `req.query` as a getter
 * only. Shared by both sides, since one booking is one record.
 */
export const listInspectionsSchema = z.object({
    window: z.enum(INSPECTION_WINDOWS).default("upcoming"),
    status: z.enum(STATUS_FILTERS).default("all"),
    sort: z.enum(INSPECTION_SORTS).default("soonest"),
    page: z.coerce.number().int().min(1, "Page starts at 1").default(1),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(PAGE_SIZE_MAX, `Ask for at most ${PAGE_SIZE_MAX} per page`)
        .default(PAGE_SIZE),
});
export const inspectionIdSchema = z.object({ id: id("inspection") });
//# sourceMappingURL=inspection.validator.js.map