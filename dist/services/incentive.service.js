import { randomUUID } from "node:crypto";
import { trusted } from "mongoose";
import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";
import Enrollment, { INSPECTRA_SHARE, LEGACY_PAYOUT, PLANBOK_TRANSFER_FEE, toTokenAmount, INCENTIVE_REFERENCE_PREFIX, } from "../models/enrollment.model.js";
import Wallet from "../models/wallet.model.js";
import { createTransfer, getTransfer, getTransferFee, TransferRejected, } from "./flutterwave.service.js";
import User from "../models/user.model.js";
import { sendReferralReward, sendTokenReward } from "./email.service.js";
import { createPurchase, getPurchase } from "./lambacard.service.js";
import { findTransfer, getBalance, PlanbokRefused, toKobo, transfer } from "./planbok.service.js";
/**
 * The course incentive: what is left of every paid course after INSPECTRA's share and
 * Flutterwave's fees buys the realtor's LambaCard tokens. Its first hop is one Flutterwave
 * transfer into our Planbok account, sent the moment the payment is claimed, with the same
 * discipline as an escrow release: a refusal is retried, an unknown outcome is never resent
 * blind.
 */
const toNaira = (kobo) => kobo / 100;
/**
 * INSPECTRA's share is fixed when the payment is claimed: 30% of the price, 25% when a
 * realtor referred the buyer. The transfer fee is not known yet, so the amount is not.
 */
export const incentiveFor = (enrollment, flw) => {
    const share = enrollment.referral ? INSPECTRA_SHARE.referred : INSPECTRA_SHARE.direct;
    return {
        status: "due",
        kept: toNaira(Math.round(toKobo(enrollment.amount) * share)),
        ...(typeof flw.app_fee === "number" && { collectionFee: flw.app_fee }),
        funding: { reference: "", attempts: 0 },
    };
};
/**
 * What Flutterwave sends to Planbok: the price, less INSPECTRA's share, the collection fee
 * and the transfer fee, which Flutterwave debits on top. An amount already fixed (a retry,
 * or a row from before the shares) is sent again as it is. Null when it cannot be worked
 * out: never guessed.
 */
const fundingAmount = async (row) => {
    const incentive = row.incentive;
    if (incentive.amount)
        return { amount: incentive.amount };
    if (incentive.kept === undefined || incentive.collectionFee === undefined) {
        console.error(`Incentive for ${row.reference} waits: its share or Flutterwave's fee was not recorded.`);
        return null;
    }
    const budget = toKobo(row.amount) - toKobo(incentive.kept) - toKobo(incentive.collectionFee);
    let fee;
    try {
        fee = await getTransferFee(toNaira(budget));
    }
    catch (error) {
        console.error(`Incentive for ${row.reference} waits on the transfer fee: ${error.message}`);
        return null;
    }
    const amount = budget - Math.ceil(fee * 100);
    if (amount <= PLANBOK_TRANSFER_FEE * 100) {
        console.error(`Incentive for ${row.reference} leaves nothing to forward: check the course price.`);
        return null;
    }
    return { amount: toNaira(amount), transferFee: toNaira(Math.ceil(fee * 100)) };
};
export const startIncentive = async (id) => {
    const { PLANBOK_BANK_CODE: bankCode, PLANBOK_ACCOUNT_NUMBER: accountNumber } = envConfig;
    if (!bankCode || !accountNumber) {
        console.error(`Incentive for enrollment ${String(id)} waits: no Planbok account is set.`);
        return false;
    }
    const current = await Enrollment.findOne({ _id: id, "incentive.status": "due" }).select("incentive amount reference");
    if (!current?.incentive)
        return false;
    const funded = await fundingAmount(current);
    if (!funded)
        return false;
    const { attempts } = current.incentive.funding;
    const reference = `${INCENTIVE_REFERENCE_PREFIX}${String(id).slice(-8).toUpperCase()}-${attempts + 1}`;
    // Conditional on the attempt count too, so two callers can never send under one reference.
    // A row due before the stages existed has no funding record yet, so a first attempt
    // matches a missing count as well as 0.
    const claimed = await Enrollment.findOneAndUpdate({
        _id: id,
        "incentive.status": "due",
        "incentive.funding.attempts": attempts || trusted({ $in: [0, null] }),
    }, {
        $set: {
            "incentive.status": "funding",
            "incentive.funding.reference": reference,
            "incentive.amount": funded.amount,
            ...(funded.transferFee !== undefined && { "incentive.transferFee": funded.transferFee }),
        },
        $inc: { "incentive.funding.attempts": 1 },
    }, { returnDocument: "after" });
    if (!claimed?.incentive)
        return false;
    try {
        const transfer = await createTransfer({
            bankCode,
            accountNumber,
            amount: funded.amount,
            reference,
            narration: `INSPECTRA COURSE ${claimed.reference}`,
        });
        // What Flutterwave actually charged replaces the quote.
        await Enrollment.updateOne({ _id: id, "incentive.funding.reference": reference }, {
            $set: {
                "incentive.funding.transferId": transfer.id,
                ...(typeof transfer.fee === "number" && { "incentive.transferFee": transfer.fee }),
            },
        });
    }
    catch (error) {
        if (error instanceof TransferRejected) {
            // Refused outright, so nothing was sent: back to due for the next attempt. A low
            // balance lands here too, which is why there is no attempt limit.
            await Enrollment.updateOne({ _id: id, "incentive.status": "funding", "incentive.funding.reference": reference }, { $set: { "incentive.status": "due", "incentive.funding.reference": "" } });
            console.error(`Incentive ${reference} refused: ${error.message}`);
        }
        else {
            // Unknown whether it went out. Left funding with no transfer id: a blind retry could
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
    const funding = {
        "incentive.status": "funding",
        "incentive.funding.reference": transfer.reference,
    };
    if (transfer.status === "FAILED") {
        const failed = await Enrollment.findOneAndUpdate(funding, {
            $set: { "incentive.status": "due", "incentive.funding.reference": "" },
            $unset: { "incentive.funding.transferId": 1 },
        });
        if (failed)
            console.error(`Incentive ${transfer.reference} failed: ${transfer.complete_message ?? ""}`);
        return;
    }
    if (transfer.status !== "SUCCESSFUL")
        return;
    // Landed in our Planbok account: forward it to LambaCard straight away.
    const landed = await Enrollment.findOneAndUpdate(funding, {
        $set: {
            "incentive.status": "forwarding",
            "incentive.funding.transferId": transfer.id,
            "incentive.funding.sentAt": new Date(),
            "incentive.forwarding": { reference: "", attempts: 0 },
        },
    });
    if (landed)
        await startForwarding(landed._id);
};
/**
 * The second hop: Planbok sends what reached our account, less its ₦15 transfer fee, to
 * LambaCard's. Planbok's
 * reference for it is what the LambaCard purchase is made with. A refusal is retried; an
 * unknown outcome (sent, no reference back) waits for an admin to check Planbok.
 */
export const startForwarding = async (id, byAdmin = false) => {
    const { PLANBOK_ACCOUNT_ID: accountId, PLANBOK_BANK_CODE: ourBankCode, LAMBACARD_BANK_CODE: sortCode, LAMBACARD_ACCOUNT_NUMBER: accountNumber, LAMBACARD_ACCOUNT_NAME: accountName, } = envConfig;
    if (!accountId || !sortCode || !accountNumber || (sortCode !== ourBankCode && !accountName)) {
        console.error(`Incentive for enrollment ${String(id)} waits: no LambaCard account is set.`);
        return false;
    }
    const waiting = {
        _id: id,
        "incentive.status": "forwarding",
        "incentive.forwarding.reference": "",
    };
    const current = await Enrollment.findOne(waiting).select("incentive");
    const attempts = current?.incentive?.forwarding?.attempts;
    const received = current?.incentive?.amount;
    if (attempts === undefined || !received)
        return false;
    // Planbok debits its fee on top, so it comes off what is forwarded.
    const forwardKobo = toKobo(received) - PLANBOK_TRANSFER_FEE * 100;
    // Planbok wants a UUID v4 here and refuses anything else with a 400. A fresh one per
    // attempt, stored before the call like every other hop's reference.
    const reference = randomUUID();
    const claimed = await Enrollment.findOneAndUpdate({ ...waiting, "incentive.forwarding.attempts": attempts }, {
        $set: { "incentive.forwarding.reference": reference, "incentive.forwarding.amount": toNaira(forwardKobo) },
        $inc: { "incentive.forwarding.attempts": 1 },
    }, { returnDocument: "after" });
    if (!claimed?.incentive)
        return false;
    try {
        const sent = await transfer(accountId, reference, forwardKobo, 
        // LambaCard's account is a Planbok virtual account too, so both sit at Loma (090620):
        // same-bank, by account number alone.
        sortCode === ourBankCode
            ? { type: "same-bank", accountNumber }
            : { type: "other-banks", accountNumber, sortCode, accountName }, `INSPECTRA COURSE ${claimed.reference}`);
        // The one id LambaCard can validate, and the reply is the only place it appears.
        if (sent.providerReference)
            await Enrollment.updateOne({ _id: id, "incentive.forwarding.reference": reference }, { $set: { "incentive.forwarding.providerReference": sent.providerReference } });
        else
            console.error(`Incentive ${reference} sent, but Planbok gave no transfer id: check Planbok.`);
        await settleForwarding(id, reference);
    }
    catch (error) {
        if (error instanceof PlanbokRefused) {
            // Turned down, so nothing moved: back to waiting for the next attempt. A Planbok
            // balance not yet credited lands here too. An admin's send is never retried by the
            // sweep, so the admin hears why and can press again.
            await Enrollment.updateOne({ _id: id, "incentive.status": "forwarding", "incentive.forwarding.reference": reference }, { $set: { "incentive.forwarding.reference": "" } });
            if (byAdmin)
                throw new AppError(`Planbok turned the transfer down, so nothing moved: ${error.reason}`, 502);
        }
        else {
            console.error(`Incentive ${reference} outcome unknown, check Planbok:`, error);
        }
    }
    return true;
};
/**
 * Confirms the forwarding transfer at Planbok, found by our key, and once it has settled
 * for the right amount hands the incentive on to the purchase, which is made with the
 * transfer id kept from the reply. Without that id there is nothing LambaCard can validate,
 * so a send whose reply never came back waits for an admin. Anything else leaves it be.
 */
const settleForwarding = async (id, key) => {
    const open = {
        _id: id,
        "incentive.status": "forwarding",
        "incentive.forwarding.reference": key,
    };
    const row = await Enrollment.findOne(open).select("incentive");
    if (!row?.incentive)
        return;
    let settled;
    try {
        settled = await findTransfer(envConfig.PLANBOK_ACCOUNT_ID, key);
    }
    catch {
        return; // Not readable now; the next sweep asks again.
    }
    if (!settled)
        return; // Not listed yet.
    if (settled.status !== "SUCCESS") {
        console.error(`Incentive forward ${key} is ${settled.status}.`);
        return;
    }
    const forwarded = row.incentive.forwarding?.amount;
    if (!forwarded || settled.entry !== "DEBIT" || toKobo(settled.amount) !== toKobo(forwarded)) {
        console.error(`Incentive forward ${key} does not match the payout: check Planbok.`);
        return;
    }
    if (!row.incentive.forwarding?.providerReference) {
        console.error(`Incentive forward ${key} went through, but its Planbok transfer id is unknown: check Planbok.`);
        return;
    }
    const moved = await Enrollment.updateOne(open, {
        $set: {
            "incentive.status": "purchasing",
            "incentive.forwarding.sentAt": new Date(),
        },
    });
    if (moved.modifiedCount)
        await startPurchase(id);
};
/**
 * The third hop: LambaCard buys the tokens with Planbok's reference for the forwarded
 * naira, into the realtor's own wallet, naming the referrer's wallet when there is one. A
 * realtor with no active wallet waits here. Safe to repeat: LambaCard replays the first
 * purchase for the same reference and body, so a refusal or an unknown outcome is simply
 * tried again by the next sweep.
 */
export const startPurchase = async (id) => {
    const row = await Enrollment.findOne({
        _id: id,
        "incentive.status": "purchasing",
        "incentive.purchase": trusted({ $exists: false }),
    }).select("incentive registeredUser referral");
    const transactionReference = row?.incentive?.forwarding?.providerReference;
    const forwarded = row?.incentive?.forwarding?.amount;
    if (!row?.incentive || !transactionReference)
        return false;
    if (!forwarded) {
        console.error(`Incentive purchase for ${transactionReference} waits: the forwarded amount was not recorded.`);
        return false;
    }
    const wallet = row.registeredUser
        ? await Wallet.findOne({ user: row.registeredUser, status: "active" }).select("address")
        : null;
    if (!wallet?.address)
        return false;
    // LambaCard refuses a referrer who is the customer; a row like that needs an admin, never a
    // purchase sent without its referrer.
    const referrerAddress = row.referral?.walletAddress;
    if (referrerAddress && referrerAddress.toLowerCase() === wallet.address.toLowerCase()) {
        console.error(`Incentive purchase for ${transactionReference} waits: the referrer's wallet is the buyer's.`);
        return false;
    }
    try {
        const purchase = await createPurchase({
            transactionReference,
            amountKobo: toKobo(forwarded),
            walletAddress: wallet.address,
            ...(referrerAddress && { referrerAddress }),
        });
        await Enrollment.updateOne({ _id: id, "incentive.status": "purchasing", "incentive.purchase": trusted({ $exists: false }) }, {
            $set: {
                "incentive.purchase": {
                    id: purchase.id,
                    status: purchase.status,
                    walletAddress: purchase.walletAddress,
                    customerTokenUnits: purchase.customerTokenUnits,
                    ...(purchase.referrerAddress && {
                        referrerAddress: purchase.referrerAddress,
                        referralTokenUnits: purchase.referralTokenUnits,
                    }),
                },
            },
        });
    }
    catch (error) {
        console.error(`Incentive purchase for ${transactionReference} not made yet: ${error.message}`);
    }
    return true;
};
/**
 * What an admin needs before starting a reward from the Planbok balance: a course paid
 * before the reward existed (or whose payout never left), with nothing under way, for a
 * realtor whose wallet is ready. Refuses with the reason otherwise.
 */
export const rewardFromBalancePreview = async (id) => {
    const enrollment = await Enrollment.findById(id);
    if (!enrollment)
        throw new AppError("That enrollment does not exist.", 404);
    if (enrollment.status === "pending")
        throw new AppError("This course has not been paid for.", 409);
    // An old payout (`sent`) went straight to LambaCard with no purchase. It qualifies only
    // once LambaCard has returned the money; the admin confirms that, the prompt says so.
    // An admin's earlier send that Planbok turned down left nothing sent: it can be pressed again.
    const unsent = !!enrollment.incentive?.fromBalance &&
        enrollment.incentive.status === "forwarding" &&
        !enrollment.incentive.forwarding?.reference;
    if (enrollment.incentive && !unsent && !["due", "sent"].includes(enrollment.incentive.status))
        throw new AppError("This realtor's reward is already under way or settled.", 409);
    if (!enrollment.registeredUser)
        throw new AppError("This enrollment has no account linked yet.", 409);
    const wallet = await Wallet.findOne({ user: enrollment.registeredUser, status: "active" }).select("address");
    if (!wallet?.address)
        throw new AppError("This realtor has no active wallet yet, so there is nowhere to send the tokens.", 409);
    const { PLANBOK_ACCOUNT_ID: accountId, PLANBOK_ACCOUNT_NAME: accountName } = envConfig;
    if (!accountId)
        throw new AppError("No Planbok account is set for rewards.", 503);
    const { available } = await getBalance(accountId);
    const oldPayoutSentAt = (enrollment.incentive?.status === "sent" ? enrollment.incentive.sentAt : enrollment.incentive?.oldPayoutSentAt) ??
        null;
    return {
        enrollment,
        walletAddress: wallet.address,
        balance: available,
        accountName,
        amount: LEGACY_PAYOUT,
        forwarded: LEGACY_PAYOUT - PLANBOK_TRANSFER_FEE,
        oldPayoutSentAt,
    };
};
/**
 * Starts a reward from money already in our Planbok account: no Flutterwave hop, straight
 * to forwarding, after which it runs exactly like any other reward. The claim is
 * conditional, so it cannot race the sweep or a second click into paying twice.
 */
export const sendRewardFromBalance = async (id) => {
    const { balance, amount, oldPayoutSentAt } = await rewardFromBalancePreview(id);
    if (balance < toKobo(amount))
        throw new AppError(`The Planbok account holds ₦${(balance / 100).toLocaleString("en-NG")}, short of ₦${amount.toLocaleString("en-NG")}.`, 409);
    const claimed = await Enrollment.findOneAndUpdate({
        _id: id,
        status: trusted({ $ne: "pending" }),
        $or: [
            { incentive: trusted({ $exists: false }) },
            { "incentive.status": trusted({ $in: ["due", "sent"] }) },
            { "incentive.fromBalance": true, "incentive.status": "forwarding", "incentive.forwarding.reference": "" },
        ],
    }, {
        $set: {
            incentive: {
                amount,
                status: "forwarding",
                fromBalance: true,
                ...(oldPayoutSentAt && { oldPayoutSentAt }),
                funding: { reference: "", attempts: 0 },
                forwarding: { reference: "", attempts: 0 },
            },
        },
    });
    if (!claimed)
        throw new AppError("This realtor's reward was started a moment ago.", 409);
    console.log(`Incentive for ${claimed.reference} started from the Planbok balance by an admin.`);
    await startForwarding(id, true);
    return Enrollment.findById(id).lean();
};
/**
 * Applies a purchase read back from LambaCard, never a webhook body. CONFIRMED ends it once
 * the tokens are on chain (a sandbox simulation has no transaction); REJECTED ends it for an
 * admin to settle with LambaCard. Anything else, RECONCILIATION_REQUIRED included, is still
 * LambaCard's to finish, so only the status is recorded and the sweep keeps asking.
 */
export const settlePurchase = async (purchase) => {
    const open = {
        "incentive.status": "purchasing",
        "incentive.purchase.id": purchase.id,
        "incentive.forwarding.providerReference": purchase.transactionReference,
    };
    const { status, settlementMode, settlement } = purchase;
    const onChain = !!settlement.transactionHash;
    if (status === "CONFIRMED" && (onChain || settlementMode === "SIMULATED")) {
        // Conditional on still purchasing, so only the first of the webhook and the sweep
        // gets the row back, and the realtor hears once.
        const delivered = await Enrollment.findOneAndUpdate(open, {
            $set: {
                "incentive.status": "confirmed",
                "incentive.purchase.status": status,
                "incentive.purchase.customerTokenUnits": purchase.customerTokenUnits,
                ...(purchase.referrerAddress && { "incentive.purchase.referralTokenUnits": purchase.referralTokenUnits }),
                ...(onChain && {
                    "incentive.purchase.transactionHash": settlement.transactionHash,
                    "incentive.purchase.explorerUrl": settlement.explorerUrl,
                }),
                "incentive.purchase.confirmedAt": new Date(),
            },
        }, { returnDocument: "after" });
        if (delivered?.incentive?.purchase)
            sendTokenReward(delivered.email, {
                name: delivered.fullname,
                reference: delivered.reference,
                tokens: toTokenAmount(delivered.incentive.purchase.customerTokenUnits),
                walletAddress: delivered.incentive.purchase.walletAddress,
                explorerUrl: delivered.incentive.purchase.explorerUrl,
            });
        if (delivered?.incentive?.purchase?.referralTokenUnits && delivered.referral)
            void notifyReferrer(delivered);
        return;
    }
    if (status === "REJECTED") {
        const rejected = await Enrollment.findOneAndUpdate(open, {
            $set: { "incentive.status": "rejected", "incentive.purchase.status": status },
        });
        if (rejected)
            console.error(`Incentive purchase ${purchase.id} rejected by LambaCard: settle it with them.`);
        return;
    }
    const moved = await Enrollment.findOneAndUpdate({ ...open, "incentive.purchase.status": trusted({ $ne: status }) }, { $set: { "incentive.purchase.status": status } });
    if (moved && status === "RECONCILIATION_REQUIRED")
        console.error(`Incentive purchase ${purchase.id} needs reconciliation at LambaCard.`);
};
/** Tells the referrer their share of a referred course has landed. */
const notifyReferrer = async (delivered) => {
    const purchase = delivered.incentive.purchase;
    if (!purchase.referrerAddress || !purchase.referralTokenUnits)
        return;
    const referrer = await User.findById(delivered.referral.referrer).select("fullname email");
    if (!referrer)
        return;
    sendReferralReward(referrer.email, {
        name: referrer.fullname,
        referredName: delivered.fullname.trim().split(/\s+/)[0] ?? "",
        reference: delivered.reference,
        tokens: toTokenAmount(purchase.referralTokenUnits),
        walletAddress: purchase.referrerAddress,
        ...(purchase.explorerUrl && { explorerUrl: purchase.explorerUrl }),
    });
};
/**
 * Catches up on what the moment of payment could not finish: asks Flutterwave and Planbok
 * about transfers still in flight, then sends every hop still waiting (refused, failed, or
 * waiting on a balance). A hop sent with no id or reference back is left alone: its outcome
 * is unknown and only an admin checking Flutterwave or Planbok can settle it.
 */
const sweep = async () => {
    const inFlight = await Enrollment.find({
        "incentive.status": "funding",
        "incentive.funding.transferId": trusted({ $exists: true }),
    }).select("incentive.funding.transferId");
    for (const { incentive } of inFlight) {
        const transferId = incentive.funding.transferId;
        try {
            await settleIncentive(await getTransfer(transferId));
        }
        catch (error) {
            console.error(`Could not read incentive transfer ${transferId}:`, error);
        }
    }
    // Every forward that went out, including one whose reply never came back: found by key.
    const forwarded = await Enrollment.find({
        "incentive.status": "forwarding",
        "incentive.forwarding.reference": trusted({ $nin: ["", null] }),
    }).select("incentive.forwarding.reference");
    for (const { _id, incentive } of forwarded)
        await settleForwarding(_id, incentive.forwarding.reference);
    // Purchases still open. The only catch for one LambaCard stops reporting on, such as a
    // payment check that timed out and sits at CREATED.
    const buying = await Enrollment.find({
        "incentive.status": "purchasing",
        "incentive.purchase.id": trusted({ $exists: true }),
    }).select("incentive.purchase.id");
    for (const { incentive } of buying) {
        const purchaseId = incentive.purchase.id;
        try {
            await settlePurchase(await getPurchase(purchaseId));
        }
        catch (error) {
            console.error(`Could not read incentive purchase ${purchaseId}: ${error.message}`);
        }
    }
    const due = await Enrollment.find({ "incentive.status": "due" }).select("_id");
    let started = 0;
    for (const { _id } of due)
        if (await startIncentive(_id))
            started += 1;
    // An admin's send from the Planbok balance moves only on a click, never from here.
    const toForward = await Enrollment.find({
        "incentive.status": "forwarding",
        "incentive.forwarding.reference": "",
        "incentive.fromBalance": trusted({ $ne: true }),
    }).select("_id");
    for (const { _id } of toForward)
        if (await startForwarding(_id))
            started += 1;
    const toPurchase = await Enrollment.find({
        "incentive.status": "purchasing",
        "incentive.purchase": trusted({ $exists: false }),
    }).select("_id");
    let waitingOnWallet = 0;
    for (const { _id } of toPurchase) {
        if (await startPurchase(_id))
            started += 1;
        else
            waitingOnWallet += 1;
    }
    if (started)
        console.log(`Incentive sweep: started ${started} transfer(s) or purchase(s).`);
    if (waitingOnWallet)
        console.log(`Incentive sweep: ${waitingOnWallet} purchase(s) wait for a realtor wallet.`);
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