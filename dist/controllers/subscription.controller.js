import AppError from "../error/app.error.js";
import { CADENCES, CADENCE_DISCOUNT, CADENCE_MONTHS, PLANS, TIERS, isPaid, planPrice, planSavings, publicSubscription, } from "../models/subscription.model.js";
import { entitlements, listingAllowance, resolveSubscription, } from "../services/subscription.service.js";
/**
 * The plan catalogue, priced at every cadence.
 *
 * Public, and declared above the session gate, because the pricing page is a marketing
 * page read by people with no account. The client keeps the taglines and the feature
 * bullets for these tiers; what a plan costs and what it allows comes from here, so a
 * card can never quote a price the API would not charge.
 */
export const listPlans = async (_req, res) => {
    const plans = TIERS.map((tier) => ({
        ...PLANS[tier],
        prices: CADENCES.map((cadence) => ({
            cadence,
            months: CADENCE_MONTHS[cadence],
            discount: CADENCE_DISCOUNT[cadence],
            amount: planPrice(tier, cadence),
            savings: planSavings(tier, cadence),
        })),
    }));
    res.status(200).json({ status: "success", data: { plans } });
};
/**
 * The realtor's own plan, what it entitles them to, and how much of it is spent.
 *
 * There is no companion PATCH. Nothing here can take money yet, and a route that moved
 * an account onto Elite for free would be a control claiming to have done a job it
 * cannot do. A paid tier is granted by an admin, against a payment they have seen.
 */
export const getMySubscription = async (req, res) => {
    const user = req.user;
    const subscription = await resolveSubscription(user._id);
    const allowance = await listingAllowance(user._id, subscription);
    res.status(200).json({
        status: "success",
        data: {
            subscription: publicSubscription(subscription),
            plan: entitlements(subscription),
            allowance,
        },
    });
};
/**
 * Stop at the end of the period already paid for.
 *
 * Not a refund and not an eviction. The period was bought, so it runs; what cancelling
 * says is that there will not be another one, and the lifecycle honours that by dropping
 * the account to Starter at the period end with no grace window. Grace exists to cover a
 * payment in flight, and cancelling is the realtor saying there is not going to be one.
 *
 * Listings past the Starter cap are hidden at that point, never deleted, so paying again
 * brings the whole portfolio straight back.
 */
export const cancelMySubscription = async (req, res) => {
    const user = req.user;
    const subscription = await resolveSubscription(user._id);
    if (!isPaid(subscription.tier))
        throw new AppError("You are on the free plan, so there is nothing to cancel.", 409);
    if (subscription.status === "canceled")
        throw new AppError("That plan is already cancelled.", 409);
    subscription.status = "canceled";
    subscription.canceledAt = new Date();
    subscription.graceEndsAt = undefined;
    await subscription.save({ validateModifiedOnly: true });
    const allowance = await listingAllowance(user._id, subscription);
    res.status(200).json({
        status: "success",
        message: subscription.currentPeriodEnd
            ? "Your plan is cancelled. It stays active until the period you have paid for ends."
            : "Your plan is cancelled.",
        data: {
            subscription: publicSubscription(subscription),
            plan: entitlements(subscription),
            allowance,
        },
    });
};
//# sourceMappingURL=subscription.controller.js.map