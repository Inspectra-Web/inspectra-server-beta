import Inspection from "../models/inspection.model.js";
import LedgerEntry from "../models/ledgerEntry.model.js";
import VirtualAccount from "../models/virtualAccount.model.js";
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
    const held = await Inspection.findOneAndUpdate({ _id: payment.inspection, "escrow.status": "unpaid" }, {
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
//# sourceMappingURL=escrow.service.js.map