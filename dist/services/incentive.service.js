import { trusted } from "mongoose";
import envConfig from "../config/env.config.js";
import Enrollment, { INCENTIVE_PAYOUT, INCENTIVE_REFERENCE_PREFIX, } from "../models/enrollment.model.js";
import { createTransfer, getTransfer, TransferRejected, } from "./flutterwave.service.js";
/**
 * The course incentive: ₦10,000 of every paid course goes to LambaCard's account, which
 * funds the realtor's token reward. One Flutterwave transfer per enrollment, sent the moment
 * the payment is claimed, with the same discipline as an escrow release: a refusal is
 * retried, an unknown outcome is never resent blind.
 */
/** Only a price that clears the payout owes one; a checkout opened at ₦10,000 never does. */
export const incentiveFor = (amount) => amount > INCENTIVE_PAYOUT
    ? { amount: INCENTIVE_PAYOUT, status: "due", transferRef: "", attempts: 0 }
    : undefined;
export const startIncentive = async (id) => {
    const { LAMBACARD_BANK_CODE: bankCode, LAMBACARD_ACCOUNT_NUMBER: accountNumber } = envConfig;
    if (!bankCode || !accountNumber) {
        console.error(`Incentive for enrollment ${String(id)} waits: no LambaCard account is set.`);
        return false;
    }
    const current = await Enrollment.findOne({ _id: id, "incentive.status": "due" }).select("incentive");
    if (!current?.incentive)
        return false;
    const { attempts } = current.incentive;
    const reference = `${INCENTIVE_REFERENCE_PREFIX}${String(id).slice(-8).toUpperCase()}-${attempts + 1}`;
    // Conditional on the attempt count too, so two callers can never send under one reference.
    const claimed = await Enrollment.findOneAndUpdate({ _id: id, "incentive.status": "due", "incentive.attempts": attempts }, {
        $set: { "incentive.status": "sending", "incentive.transferRef": reference },
        $inc: { "incentive.attempts": 1 },
    }, { returnDocument: "after" });
    if (!claimed?.incentive)
        return false;
    try {
        const transfer = await createTransfer({
            bankCode,
            accountNumber,
            amount: claimed.incentive.amount,
            reference,
            narration: `INSPECTRA COURSE ${claimed.reference}`,
        });
        await Enrollment.updateOne({ _id: id, "incentive.transferRef": reference }, { $set: { "incentive.transferId": transfer.id } });
    }
    catch (error) {
        if (error instanceof TransferRejected) {
            // Refused outright, so nothing was sent: back to due for the next attempt. A low
            // balance lands here too, which is why there is no attempt limit.
            await Enrollment.updateOne({ _id: id, "incentive.status": "sending", "incentive.transferRef": reference }, { $set: { "incentive.status": "due", "incentive.transferRef": "" } });
            console.error(`Incentive ${reference} refused: ${error.message}`);
        }
        else {
            // Unknown whether it went out. Left sending with no transfer id: a blind retry could
            // pay twice. Needs an admin to check Flutterwave.
            console.error(`Incentive ${reference} outcome unknown, check Flutterwave:`, error);
        }
    }
    return true;
};
/**
 * Applies Flutterwave's verdict on an incentive transfer, once. Takes a transfer read back
 * from Flutterwave, never a webhook body.
 */
export const settleIncentive = async (transfer) => {
    const sending = {
        "incentive.status": "sending",
        "incentive.transferRef": transfer.reference,
    };
    if (transfer.status === "FAILED") {
        const failed = await Enrollment.findOneAndUpdate(sending, {
            $set: { "incentive.status": "due", "incentive.transferRef": "" },
            $unset: { "incentive.transferId": 1 },
        });
        if (failed)
            console.error(`Incentive ${transfer.reference} failed: ${transfer.complete_message ?? ""}`);
        return;
    }
    if (transfer.status !== "SUCCESSFUL")
        return;
    await Enrollment.updateOne(sending, {
        $set: { "incentive.status": "sent", "incentive.transferId": transfer.id, "incentive.sentAt": new Date() },
    });
};
/**
 * Catches up on what the moment of payment could not finish: asks Flutterwave about
 * transfers whose webhook never came, then sends every payout still due (refused, failed,
 * or waiting on a balance top-up). A `sending` row with no transfer id is left alone: its
 * outcome is unknown and only an admin checking Flutterwave can settle it.
 */
const sweep = async () => {
    const inFlight = await Enrollment.find({
        "incentive.status": "sending",
        "incentive.transferId": trusted({ $exists: true }),
    }).select("incentive.transferId");
    for (const { incentive } of inFlight) {
        try {
            await settleIncentive(await getTransfer(incentive.transferId));
        }
        catch (error) {
            console.error(`Could not read incentive transfer ${incentive?.transferId}:`, error);
        }
    }
    const due = await Enrollment.find({ "incentive.status": "due" }).select("_id");
    let started = 0;
    for (const { _id } of due)
        if (await startIncentive(_id))
            started += 1;
    if (started)
        console.log(`Incentive sweep: started ${started} payout(s).`);
};
const SWEEP_EVERY = 15 * 60 * 1000;
let sweeping = false;
const guardedSweep = async () => {
    if (sweeping)
        return;
    sweeping = true;
    try {
        await sweep();
    }
    catch (error) {
        console.error("Incentive sweep failed:", error);
    }
    finally {
        sweeping = false;
    }
};
/** Once at boot, then every 15 minutes, like the escrow sweep. */
export const startIncentiveSweep = () => {
    void guardedSweep();
    setInterval(() => void guardedSweep(), SWEEP_EVERY).unref();
};
//# sourceMappingURL=incentive.service.js.map