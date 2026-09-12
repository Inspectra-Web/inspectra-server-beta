import { z } from "zod";
const SEARCH_MAX = 100;
const CITY_MAX = 80;
const PAGE_SIZE = 12;
const PAGE_SIZE_MAX = 48;
export const REALTOR_SORTS = ["recommended", "newest", "name"];
export const listRealtorsSchema = z.object({
    q: z.string().trim().max(SEARCH_MAX, "Search is too long").default(""),
    city: z.string().trim().max(CITY_MAX, "City is too long").default("all"),
    sort: z.enum(REALTOR_SORTS).default("recommended"),
    page: z.coerce.number().int().min(1, "Page starts at 1").default(1),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(PAGE_SIZE_MAX, `Ask for at most ${PAGE_SIZE_MAX} per page`)
        .default(PAGE_SIZE),
});
export const realtorIdSchema = z.object({
    id: z.string().regex(/^[0-9a-f]{24}$/i, "That is not a valid realtor id"),
});
//# sourceMappingURL=realtor.validator.js.map