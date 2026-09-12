import { z } from "zod";
import { INQUIRY_STATUSES } from "../models/inquiry.model.js";
// Mirrors BODY_MAX on the message sub-schema in inquiry.model.ts.
const MESSAGE_MAX = 1000;
const PAGE_SIZE = 12;
const PAGE_SIZE_MAX = 48;
const line = z.string("Required").trim();
const id = (label) => z.string().regex(/^[0-9a-f]{24}$/i, `That is not a valid ${label} id`);
const message = line
    .min(1, "Write a message")
    .max(MESSAGE_MAX, `Keep it under ${MESSAGE_MAX} characters`);
/**
 * Strict, which is what keeps the platform's own fields out of a seeker's write:
 * `seeker`, `realtor`, `status` and `lastMessageAt` are all absent here on purpose.
 * The realtor is read off the property, never claimed by the sender.
 */
export const createInquirySchema = z.strictObject({
    property: id("listing"),
    message,
});
/** A reply on a thread that already exists. Either party sends this one. */
export const addMessageSchema = z.strictObject({ message });
export const INQUIRY_STATUS_ACTIONS = ["closed", "open"];
export const inquiryStatusSchema = z.strictObject({
    status: z.enum(INQUIRY_STATUS_ACTIONS, "Choose whether to close or reopen this thread"),
});
export const INQUIRY_SORTS = ["newest", "oldest"];
// "all" is the sentinel the controller checks, as on the listings and realtor lists.
const STATUS_FILTERS = ["all", ...INQUIRY_STATUSES];
/**
 * Deliberately `z.object`, not `z.strictObject`, and parsed inline in the controller:
 * `validate()` assigns to `req.body`, and Express 5 exposes `req.query` as a getter
 * only. Shared by both sides, since a lead and an inquiry are one record.
 */
export const listInquiriesSchema = z.object({
    status: z.enum(STATUS_FILTERS).default("all"),
    sort: z.enum(INQUIRY_SORTS).default("newest"),
    page: z.coerce.number().int().min(1, "Page starts at 1").default(1),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(PAGE_SIZE_MAX, `Ask for at most ${PAGE_SIZE_MAX} per page`)
        .default(PAGE_SIZE),
});
export const inquiryIdSchema = z.object({ id: id("inquiry") });
//# sourceMappingURL=inquiry.validator.js.map