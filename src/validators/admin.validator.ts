import { z } from "zod";

const SEARCH_MAX = 100;
const PAGE_SIZE = 20;
const PAGE_SIZE_MAX = 100;

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

export const userIdSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/i, "That is not a valid user id"),
});

export type UserIdParams = z.infer<typeof userIdSchema>;

export const userStatusSchema = z.strictObject({
  status: z.enum(["active", "suspended"]),
});

export type UserStatusInput = z.infer<typeof userStatusSchema>;

export const listRealtorsSchema = z.object({
  q: z.string().trim().max(SEARCH_MAX, "Search is too long").default(""),
  certified: z.enum(["all", "yes", "no"]).default("all"),
  identity: z.enum(["all", "verified", "unverified"]).default("all"),
  status: z.enum(["all", "active", "suspended", "pending"]).default("all"),
  page: z.coerce.number().int().min(1, "Page starts at 1").default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_SIZE_MAX, `Ask for at most ${PAGE_SIZE_MAX} per page`)
    .default(PAGE_SIZE),
});

export type ListRealtorsQuery = z.infer<typeof listRealtorsSchema>;
