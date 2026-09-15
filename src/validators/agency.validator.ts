import { z } from "zod";

import { COMPANY_TYPES } from "../models/agency.model.js";

// No fixed length: real registrations run roughly 5 to 8 digits, so a .length() would
// reject valid ones. These bounds are a sanity check, not a format claim.
const RC_MIN = 4;
const RC_MAX = 10;

export const verifyCacSchema = z.strictObject({
  rcNumber: z
    .string("Required")
    .trim()
    .regex(/^\d+$/, "Numbers only, without the RC or BN prefix")
    .min(RC_MIN, "That is too short for an RC number")
    .max(RC_MAX, "That is too long for an RC number"),
  companyType: z.enum(COMPANY_TYPES),
});

export type VerifyCacInput = z.infer<typeof verifyCacSchema>;

/**
 * A meter number is the one thing on a Nigerian utility bill that identifies the supply
 * rather than a person, so it is what the reviewer keys on. Length is left open: prepaid
 * meter numbers run 11 to 13 digits across the discos, and a postpaid account number is a
 * different shape again.
 */
export const submitAddressSchema = z.strictObject({
  meterNumber: z
    .string("Required")
    .trim()
    .regex(/^[A-Za-z0-9-]+$/, "Letters, numbers and dashes only")
    .min(4, "That is too short for a meter or account number")
    .max(20, "That is too long for a meter or account number"),
});

export type SubmitAddressInput = z.infer<typeof submitAddressSchema>;

/** The reviewer's verdict. A flag has to say why, mirroring the listing document rule. */
export const reviewAddressSchema = z
  .strictObject({
    status: z.enum(["verified", "flagged"]),
    reason: z.string().trim().max(400, "That reason is too long").optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === "flagged" && !value.reason)
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Say why the bill was not accepted.",
      });
  });

export type ReviewAddressInput = z.infer<typeof reviewAddressSchema>;
