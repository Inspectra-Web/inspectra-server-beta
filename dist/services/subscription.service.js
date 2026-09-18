import { trusted } from "mongoose";
import Property, { ACTIVE_LISTING_STATUSES } from "../models/property.model.js";
import Subscription, { CADENCE_MONTHS, GRACE_DAYS, PLANS, isPaid, } from "../models/subscription.model.js";
const DAY = 24 * 60 * 60 * 1000;
const addDays = (date, days) => new Date(date.getTime() + days * DAY);
/** Calendar months, clamped: the 31st plus one month is the end of February, not the 3rd of March. */
export const addMonths = (date, months) => {
    const next = new Date(date);
    const day = next.getDate();
    next.setDate(1);
    next.setMonth(next.getMonth() + months);
    const lastOfMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, lastOfMonth));
    return next;
};
/** The span one charge at this cadence buys, for whoever is putting an account on a plan. */
export const periodFor = (cadence, from = new Date()) => ({
    currentPeriodStart: from,
    currentPeriodEnd: addMonths(from, CADENCE_MONTHS[cadence]),
});
/** What a tier buys. Read through the catalogue, never off the document. */
export const entitlements = (subscription) => PLANS[subscription.tier];
/**
 * Fit the realtor's live listings inside their plan.
 *
 * Runs when a plan moves in either direction. Going down hides whatever no longer fits,
 * newest kept, because the newest listings are the ones a realtor is actually working;
 * going back up brings every one of them straight back. Nothing is ever deleted, which
 * is the promise the pricing page makes about a lapse.
 *
 * Two writes rather than one: clearing the flag across the whole portfolio first means
 * an upgrade needs no record of what a previous downgrade happened to touch.
 */
export const syncHiddenListings = async (userId, subscription) => {
    const limit = entitlements(subscription).listings;
    const active = await Property.find({
        user: userId,
        listingStatus: trusted({ $in: ACTIVE_LISTING_STATUSES }),
    })
        .sort({ refreshedAt: -1, _id: -1 })
        .select("_id")
        .lean();
    const overflow = active.slice(limit).map((row) => row._id);
    await Property.updateMany({ user: userId }, { $set: { hiddenByPlan: false } });
    if (overflow.length)
        await Property.updateMany({ _id: trusted({ $in: overflow }) }, { $set: { hiddenByPlan: true } });
};
/**
 * Moves a subscription to where the clock says it should be, and persists the move.
 *
 * Lazily, on read, rather than on a schedule: there is no cron, queue or scheduler
 * anywhere in this stack, and one added for this alone would be a moving part that can
 * stop without anyone noticing. Every read is a tick, and nothing reads a subscription
 * without going through here.
 */
const advance = async (subscription) => {
    const now = new Date();
    let changed = false;
    let lapsed = false;
    // A cancellation is the realtor saying they do not want the next period. The one
    // they already bought still runs, and then it simply stops: no grace window, because
    // grace exists to cover a payment in flight and there is not going to be one.
    if (subscription.status === "canceled" &&
        subscription.tier !== "starter" &&
        subscription.currentPeriodEnd &&
        subscription.currentPeriodEnd <= now) {
        subscription.tier = "starter";
        subscription.cadence = "monthly";
        subscription.status = "active";
        subscription.currentPeriodStart = undefined;
        subscription.currentPeriodEnd = undefined;
        subscription.graceEndsAt = undefined;
        changed = true;
        lapsed = true;
    }
    // A paid period that has run out enters its grace window rather than ending. The
    // realtor keeps everything they are paying for while a transfer clears.
    if (isPaid(subscription.tier) &&
        subscription.status === "active" &&
        subscription.currentPeriodEnd &&
        subscription.currentPeriodEnd <= now) {
        subscription.status = "past_due";
        subscription.graceEndsAt = addDays(subscription.currentPeriodEnd, GRACE_DAYS);
        changed = true;
    }
    // Grace spent. Dropping to Starter is the whole of the penalty: the account, the
    // profile and every listing stay exactly where they are, and the ones that no longer
    // fit are hidden below rather than removed.
    if (subscription.tier !== "starter" &&
        subscription.graceEndsAt &&
        subscription.graceEndsAt <= now) {
        subscription.tier = "starter";
        subscription.cadence = "monthly";
        subscription.status = "active";
        subscription.currentPeriodStart = undefined;
        subscription.currentPeriodEnd = undefined;
        subscription.graceEndsAt = undefined;
        changed = true;
        lapsed = true;
    }
    // The refresh allowance is monthly and does not roll over.
    if (subscription.refreshPeriodStart &&
        addMonths(subscription.refreshPeriodStart, 1) <= now) {
        subscription.refreshesUsed = 0;
        subscription.refreshPeriodStart = now;
        changed = true;
    }
    if (changed)
        await subscription.save({ validateModifiedOnly: true });
    if (lapsed)
        await syncHiddenListings(subscription.user, subscription);
    return subscription;
};
/**
 * The realtor's plan as of right now, created on first read.
 *
 * Every realtor has a subscription whether or not anyone has ever paid for one, so the
 * document is upserted the way an identity check is: the absence of a record and a free
 * Starter plan are the same state, and writing it down removes the special case.
 */
export const resolveSubscription = async (userId) => {
    // findOne then create, rather than an upsert with an empty update: Mongoose stamps
    // updatedAt on a findOneAndUpdate even when the update changes nothing, so the upsert
    // form turned every read into a write. That is a needless round trip on the cap check,
    // on every lead reply and on every page load of the console, and it left updatedAt
    // meaning "last looked at" rather than "last changed". Same shape as ensureProfile.
    const existing = await Subscription.findOne({ user: userId });
    if (existing)
        return advance(existing);
    try {
        return advance(await Subscription.create({ user: userId }));
    }
    catch (error) {
        // Two requests arriving together: the unique index refuses the second, and the
        // document the winner wrote is the one we wanted anyway.
        if (error.code === 11000) {
            const raced = await Subscription.findOne({ user: userId });
            if (raced)
                return advance(raced);
        }
        throw error;
    }
};
/**
 * How much of the plan's listing allowance is spoken for.
 *
 * Counts the listings that are actually on the market. A sold or rented one is a record
 * of a deal rather than an advert, so it gives its slot back, which is what lets a
 * working realtor turn stock over without paying for the history.
 */
export const listingAllowance = async (userId, subscription) => {
    const limit = entitlements(subscription).listings;
    // sanitizeFilter is on globally, so a deliberate operator has to be trusted().
    const used = await Property.countDocuments({
        user: userId,
        listingStatus: trusted({ $in: ACTIVE_LISTING_STATUSES }),
    });
    return { limit, used, remaining: Math.max(0, limit - used) };
};
//# sourceMappingURL=subscription.service.js.map