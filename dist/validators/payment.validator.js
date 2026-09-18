import { z } from "zod";
import { PAYMENT_STATUSES } from "../models/payment.model.js";
import { CADENCES, TIERS, isPaid } from "../models/subscription.model.js";
const PAGE_SIZE = 12;
const PAGE_SIZE_MAX = 48;
// Starter costs nothing, so there is nothing to send anyone to a checkout for.
const PAID_TIERS = TIERS.filter(isPaid);
/**
 * Starting a checkout. Strict, and deliberately carrying no amount: the price is read
 * from the catalogue on the server. A body that could name its own amount is a body
 * that could name ten naira, which is the whole reason this schema is this short.
 */
export const checkoutSchema = z.strictObject({
    tier: z.enum(PAID_TIERS, "Choose a paid plan"),
    cadence: z.enum(CADENCES, "Choose a billing cadence"),
});
/**
 * The transaction id Flutterwave puts on the redirect back. It is a claim by the
 * browser, not proof of anything, which is why the controller re-reads the transaction
 * from Flutterwave rather than believing what came back in the URL.
 */
export const verifyPaymentSchema = z.strictObject({
    transactionId: z.coerce
        .number("That is not a valid transaction id")
        .int()
        .positive("That is not a valid transaction id"),
});
/**
 * Deliberately `z.object`, not `z.strictObject`, and parsed inline in the controller:
 * `validate()` assigns to `req.body`, and Express 5 exposes `req.params`/`req.query` as
 * getters only.
 */
export const paymentReferenceSchema = z.object({
    reference: z
        .string()
        .regex(/^INS-PAY-[0-9A-F]{8}$/i, "That is not a valid payment reference"),
});
// "all" is the sentinel the controller checks, as on every other list here.
const STATUS_FILTERS = ["all", ...PAYMENT_STATUSES];
export const listPaymentsSchema = z.object({
    status: z.enum(STATUS_FILTERS).default("all"),
    page: z.coerce.number().int().min(1, "Page starts at 1").default(1),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(PAGE_SIZE_MAX, `Ask for at most ${PAGE_SIZE_MAX} per page`)
        .default(PAGE_SIZE),
});
//# sourceMappingURL=payment.validator.js.map