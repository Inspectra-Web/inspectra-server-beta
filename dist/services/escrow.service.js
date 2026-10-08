import { trusted } from "mongoose";
import Inspection from "../models/inspection.model.js";
import LedgerEntry from "../models/ledgerEntry.model.js";
import Property from "../models/property.model.js";
import User from "../models/user.model.js";
import VirtualAccount from "../models/virtualAccount.model.js";
import { sendInspectionUnpaid } from "./email.service.js";
/** INSPECTRA's commission, added on top of the realtor's fee. Mirrored on the client. */
export const COMMISSION_RATE = 0.2;
const HOUR = 60 * 60 * 1000;
const PAY_WINDOW = 24 * HOUR;
const PAY_BEFORE_SLOT = 2 * HOUR;
export const commissionOn = (fee) => Math.round(fee * COMMISSION_RATE);
/** The seeker pays within 24h of confirmation and at least 2h before the slot. */
export const payByFor = (slot, from = new Date()) => new Date(Math.min(from.getTime() + PAY_WINDOW, slot.getTime() - PAY_BEFORE_SLOT));
/**
 * Locks the price onto a booking as the realtor confirms it. A booking that already
 * carries a price keeps it, so editing the listing cannot reprice a viewing in flight;
 * an unpaid one only gets a fresh deadline for its new time. Held money is left alone.
 * Returns false when a paid viewing is too close to its slot to collect in time.
 */
export const priceOnConfirm = (inspection, listingFee) => {
    const { escrow } = inspection;
    if (escrow.status === "none") {
        if (listingFee <= 0)
            return true;
        escrow.fee = listingFee;
        escrow.commission = commissionOn(listingFee);
        escrow.status = "unpaid";
    }
    if (escrow.status !== "unpaid")
        return true;
    const payBy = payByFor(inspection.slot);
    if (payBy.getTime() <= Date.now())
        return false;
    escrow.payBy = payBy;
    return true;
};
/** The ledger book seekers' money sits in. Never opened on Planbok (section 3). */
const escrowBook = async () => (await VirtualAccount.findOneAndUpdate({ refId: "inspectra-escrow" }, { $setOnInsert: { kind: "escrow", refId: "inspectra-escrow", status: "active" } }, { upsert: true, returnDocument: "after" }));
const DUPLICATE_KEY = 11000;
/**
 * Moves a paid booking's escrow to `held` and books the money in, exactly once.
 *
 * Both writes are safe to repeat, which is what lets the redirect and the webhook both
 * call this. The hold is conditional on `unpaid`; the deposit is keyed on the payment,
 * so a second post hits the unique index and is ignored.
 *
 * Money that lands on a booking no longer waiting for it (cancelled for not paying in
 * time, say) is still deposited, because it is in our balance either way, and the
 * booking is flagged for a refund rather than silently held.
 */
export const holdEscrow = async (payment) => {
    const held = await Inspection.findOneAndUpdate({ _id: payment.inspection, status: "confirmed", "escrow.status": "unpaid" }, {
        $set: {
            "escrow.status": "held",
            "escrow.paidAt": payment.paidAt ?? new Date(),
            "escrow.payment": payment._id,
        },
    }, { returnDocument: "after" });
    const inspection = held ?? (await Inspection.findById(payment.inspection));
    if (!held && !inspection?.escrow.payment?.equals(payment._id))
        console.error(`Payment ${payment.reference} arrived for inspection ${String(payment.inspection)} ` +
            `in escrow state "${inspection?.escrow.status ?? "missing"}". Needs a refund.`);
    const book = await escrowBook();
    try {
        await LedgerEntry.create({
            account: book._id,
            direction: "credit",
            kind: "deposit",
            amount: payment.amount * 100,
            idempotencyKey: `deposit:${payment.reference}`,
            inspection: payment.inspection,
            payment: payment._id,
            narration: `Inspection payment ${payment.reference}`,
        });
    }
    catch (error) {
        if (error.code !== DUPLICATE_KEY)
            throw error;
    }
    return inspection;
};
/* ------------------------------------------------------------------ *
 * The sweep: the escrow's clock. Each job finds what is due and moves it with a
 * conditional update on the state it expects, so a second sweep, a second instance
 * or a seeker acting at the same moment cannot apply it twice.
 * ------------------------------------------------------------------ */
/**
 * Cancels confirmed viewings whose fee was not paid by the deadline. `cancelledBy` is
 * left unset: neither party called it off. The escrow stays `unpaid` with its price, so
 * a payment that lands later is not held but deposited and flagged for a refund.
 */
export const expireUnpaid = async (now = new Date()) => {
    const due = {
        status: "confirmed",
        "escrow.status": "unpaid",
        "escrow.payBy": trusted({ $lte: now }),
    };
    const candidates = await Inspection.find(due).select("_id");
    let expired = 0;
    for (const { _id } of candidates) {
        const inspection = await Inspection.findOneAndUpdate({ ...due, _id }, { $set: { status: "cancelled", decidedAt: now } }, { returnDocument: "after" });
        if (!inspection)
            continue;
        expired += 1;
        const [property, seeker, realtor] = await Promise.all([
            Property.findById(inspection.property).select("ref title"),
            User.findById(inspection.seeker).select("email fullname"),
            User.findById(inspection.realtor).select("email fullname"),
        ]);
        if (!property || !seeker || !realtor)
            continue;
        const brief = (person) => ({
            id: String(inspection._id),
            ref: property.ref,
            property: property.title,
            person,
            slot: inspection.slot,
            message: "",
        });
        sendInspectionUnpaid(seeker.email, brief(realtor.fullname), "seeker");
        sendInspectionUnpaid(realtor.email, brief(seeker.fullname), "realtor");
    }
    return expired;
};
const SWEEP_EVERY = 15 * 60 * 1000;
let sweeping = false;
const sweep = async () => {
    // One at a time: a slow run must not overlap the next tick.
    if (sweeping)
        return;
    sweeping = true;
    try {
        const expired = await expireUnpaid();
        if (expired)
            console.log(`Escrow sweep: ${expired} unpaid viewing(s) cancelled.`);
    }
    catch (error) {
        console.error("Escrow sweep failed:", error);
    }
    finally {
        sweeping = false;
    }
};
/**
 * Runs once at boot, then every 15 minutes. In-process rather than a cron service:
 * if the host sleeps, the first run on waking catches up on everything that fell due,
 * so a deadline is only ever late, never missed.
 */
export const startEscrowSweep = () => {
    void sweep();
    setInterval(() => void sweep(), SWEEP_EVERY).unref();
};
//# sourceMappingURL=escrow.service.js.map