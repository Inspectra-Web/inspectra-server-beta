import { z } from "zod";
export const openVirtualAccountSchema = z.strictObject({
    consent: z.literal(true, "Agree to open the account with your BVN and NIN"),
});
const EARNINGS_PAGE_SIZE = 10;
const EARNINGS_PAGE_MAX = 50;
/** A query, so it is parsed inline in the controller rather than through validate(). */
export const listEarningsSchema = z.object({
    page: z.coerce.number().int().min(1, "Page starts at 1").default(1),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(EARNINGS_PAGE_MAX, `Ask for at most ${EARNINGS_PAGE_MAX} per page`)
        .default(EARNINGS_PAGE_SIZE),
});
//# sourceMappingURL=virtualAccount.validator.js.map