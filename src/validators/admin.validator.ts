import { z } from "zod";

const SEARCH_MAX = 100;
const PAGE_SIZE = 20;
const PAGE_SIZE_MAX = 100;

/**
 * Query for the user directory. "all" is kept as a real value rather than an
 * omitted param because the admin filters send it as their resting state.
 *
 * Not strict, unlike the update bodies: strictness there keeps privileged fields
 * out of a write, but on a read-only query string it only turns a stray param
 * (a cache buster, a utm_*) into a 422. Unknown keys are stripped instead.
 */
export const listUsersSchema = z.object({
  q: z.string().trim().max(SEARCH_MAX, "Search is too long").default(""),
  role: z.enum(["all", "seeker", "realtor", "admin"]).default("all"),
  status: z.enum(["all", "active", "suspended", "pending"]).default("all"),
  page: z.coerce.number().int().min(1, "Page starts at 1").default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_SIZE_MAX, `Ask for at most ${PAGE_SIZE_MAX} per page`)
    .default(PAGE_SIZE),
});

export type ListUsersQuery = z.infer<typeof listUsersSchema>;

/** Checked here so a junk id is a 422, not a Mongoose CastError. */
export const userIdSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/i, "That is not a valid user id"),
});

export type UserIdParams = z.infer<typeof userIdSchema>;
