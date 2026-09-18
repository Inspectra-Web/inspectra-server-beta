import { Schema, model } from "mongoose";
// Exported so the schema's enum and the request validator read the same list.
export const TIERS = ["starter", "professional", "business", "elite"];
export const CADENCES = ["monthly", "quarterly", "annual"];
export const SUBSCRIPTION_STATUSES = [
    "active",
    "past_due",
    "canceled",
];
/** Months billed up front per cadence. */
export const CADENCE_MONTHS = {
    monthly: 1,
    quarterly: 3,
    annual: 12,
};
/** Discount taken off the undiscounted multi-month total. */
export const CADENCE_DISCOUNT = {
    monthly: 0,
    quarterly: 0.1,
    annual: 0.2,
};
/** How long a lapsed plan keeps its entitlements before it drops to Starter. */
export const GRACE_DAYS = 7;
export const PLANS = {
    starter: {
        tier: "starter",
        name: "Starter",
        monthly: 0,
        listings: 3,
        refreshes: 0,
        leadReply: false,
        leadContact: false,
        analytics: "none",
        reviewPriority: "standard",
    },
    professional: {
        tier: "professional",
        name: "Professional",
        monthly: 15_000,
        listings: 30,
        refreshes: 2,
        leadReply: true,
        leadContact: true,
        analytics: "basic",
        reviewPriority: "priority",
    },
    business: {
        tier: "business",
        name: "Business",
        monthly: 35_000,
        listings: 60,
        refreshes: 4,
        leadReply: true,
        leadContact: true,
        analytics: "conversion",
        reviewPriority: "top",
    },
    elite: {
        tier: "elite",
        name: "Elite",
        monthly: 60_000,
        listings: 100,
        refreshes: 8,
        leadReply: true,
        leadContact: true,
        analytics: "advanced",
        reviewPriority: "top",
    },
};
/** What one charge costs: the months up front, less that cadence's discount. */
export const planPrice = (tier, cadence) => {
    const full = PLANS[tier].monthly * CADENCE_MONTHS[cadence];
    return full - full * CADENCE_DISCOUNT[cadence];
};
/** Naira saved against paying the same span monthly. 0 at the monthly cadence. */
export const planSavings = (tier, cadence) => PLANS[tier].monthly * CADENCE_MONTHS[cadence] - planPrice(tier, cadence);
export const isPaid = (tier) => PLANS[tier].monthly > 0;
const subscriptionSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: [true, "A subscription must belong to a user"],
        unique: true,
    },
    // Every realtor is on Starter until something says otherwise, so the document can
    // be created empty on first read and still describe a real plan.
    tier: {
        type: String,
        enum: {
            values: TIERS,
            message: "{VALUE} is not a valid plan",
        },
        default: "starter",
    },
    cadence: {
        type: String,
        enum: {
            values: CADENCES,
            message: "{VALUE} is not a valid billing cadence",
        },
        default: "monthly",
    },
    status: {
        type: String,
        enum: {
            values: SUBSCRIPTION_STATUSES,
            message: "{VALUE} is not a valid subscription status",
        },
        default: "active",
    },
    startedAt: { type: Date },
    currentPeriodStart: { type: Date },
    currentPeriodEnd: { type: Date },
    graceEndsAt: { type: Date },
    canceledAt: { type: Date },
    refreshesUsed: { type: Number, default: 0, min: 0 },
    refreshPeriodStart: { type: Date },
    // Why an admin put this account on this plan: a transfer reference, or a comp.
    note: { type: String, trim: true, default: "" },
}, { timestamps: true });
/** Response allowlist: the schema has no toJSON transform, so shape it here.
 *  `note` stays out. It is the admin's record of how the plan was paid for, not
 *  something the realtor's own console has any use for. */
export const publicSubscription = (subscription) => ({
    id: subscription._id,
    tier: subscription.tier,
    cadence: subscription.cadence,
    status: subscription.status,
    startedAt: subscription.startedAt,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    graceEndsAt: subscription.graceEndsAt,
    canceledAt: subscription.canceledAt,
    refreshesUsed: subscription.refreshesUsed,
});
const Subscription = model("Subscription", subscriptionSchema);
export default Subscription;
//# sourceMappingURL=subscription.model.js.map