import { z } from "zod";

import {
  DOCUMENT_STATUSES,
  VERIFICATION_STATUSES,
  type VerificationStatus,
} from "../models/property.model.js";

const line = z.string("Required").trim();

const SEARCH_MAX = 100;
const CITY_MAX = 80;
const NOTE_MAX = 300;
const REASON_MAX = 200;
const DOCUMENTS_MAX = 5;
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

// "all" is the sentinel the controller checks, as on the other admin directories. "open"
// is the review queue's own: everything still undecided, which is pending plus disputed.
const STATUS_FILTERS: (VerificationStatus | "all" | "open")[] = [
  "all",
  "open",
  ...VERIFICATION_STATUSES,
];

export const listListingsSchema = z.object({
  q: z.string().trim().max(SEARCH_MAX, "Search is too long").default(""),
  status: z.enum(STATUS_FILTERS).default("all"),
  city: z.string().trim().max(CITY_MAX, "City is too long").default("all"),
  // A review queue works oldest-first; every other listing surface reads newest-first.
  sort: z.enum(["newest", "oldest"]).default("newest"),
  page: z.coerce.number().int().min(1, "Page starts at 1").default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_SIZE_MAX, `Ask for at most ${PAGE_SIZE_MAX} per page`)
    .default(PAGE_SIZE),
});

export type ListListingsQuery = z.infer<typeof listListingsSchema>;

export const listingIdSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/i, "That is not a valid listing id"),
});

export type ListingIdParams = z.infer<typeof listingIdSchema>;

/**
 * One review, submitted whole: every document decision plus the listing's own verdict.
 * Strict, so a request cannot reach past the two fields a reviewer owns. Documents are
 * addressed by their subdocument id, since a listing may legitimately carry two
 * documents under the same name.
 */
export const reviewListingSchema = z
  .strictObject({
    status: z.enum(VERIFICATION_STATUSES, "Choose a verification status"),
    note: line.max(NOTE_MAX, `Keep the note under ${NOTE_MAX} characters`).default(""),
    documents: z
      .array(
        z.strictObject({
          id: line.regex(/^[0-9a-f]{24}$/i, "That is not a valid document id"),
          status: z.enum(DOCUMENT_STATUSES, "Choose a document status"),
          reason: line.max(REASON_MAX, `Keep the reason under ${REASON_MAX} characters`).default(""),
        }),
      )
      .max(DOCUMENTS_MAX, `A listing carries at most ${DOCUMENTS_MAX} documents`)
      .default([]),
  })
  .superRefine((body, ctx) => {
    // A dispute the realtor cannot act on is worse than no dispute at all.
    if (body.status === "disputed" && !body.note)
      ctx.addIssue({
        code: "custom",
        path: ["note"],
        message: "Say why the listing is disputed",
      });

    body.documents.forEach((doc, index) => {
      if (doc.status === "flagged" && !doc.reason)
        ctx.addIssue({
          code: "custom",
          path: ["documents", index, "reason"],
          message: "Say why this document was flagged",
        });
    });
  });

export type ReviewListingInput = z.infer<typeof reviewListingSchema>;
