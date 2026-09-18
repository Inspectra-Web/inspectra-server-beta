import { z } from "zod";

import { CADENCES, TIERS } from "../models/subscription.model.js";

// Mirrors the note field on the schema in subscription.model.ts.
const NOTE_MAX = 200;

/**
 * An admin putting a realtor on a plan, which is how a paid tier is granted until there
 * is a gateway to take the money itself.
 *
 * The period is derived from the cadence in the controller rather than accepted here.
 * A request that could name its own expiry is a request that could name one in 2099,
 * and strict bodies are the whole reason a privileged field cannot arrive by accident.
 */
export const setSubscriptionSchema = z.strictObject({
  tier: z.enum(TIERS, "Choose a plan"),
  cadence: z.enum(CADENCES, "Choose a billing cadence"),
  note: z
    .string()
    .trim()
    .max(NOTE_MAX, `Keep the note under ${NOTE_MAX} characters`)
    .optional(),
});

export type SetSubscriptionInput = z.infer<typeof setSubscriptionSchema>;
