import { trusted } from "mongoose";
import AppError from "../error/app.error.js";
import Enrollment, { toTokenAmount } from "../models/enrollment.model.js";
import Identity from "../models/identity.model.js";
import Wallet, { publicWallet } from "../models/wallet.model.js";
import { createWallet, getWalletBalances } from "../services/planbok.service.js";
const NOT_CREATED = "We could not create your wallet. Try again later.";
export const getMyWallet = async (req, res) => {
    const wallet = await Wallet.findOne({ user: req.user._id });
    res.status(200).json({ status: "success", data: { wallet: wallet && publicWallet(wallet) } });
};
// Apart from getMyWallet, so a Planbok outage fails the balance and not the address.
export const getMyWalletBalances = async (req, res) => {
    const wallet = await Wallet.findOne({ user: req.user._id });
    const balances = wallet?.status === "active" && wallet.planbokId ? await getWalletBalances(wallet.planbokId) : null;
    res.status(200).json({ status: "success", data: { balances } });
};
/**
 * The LBT a realtor earns, today one reward per paid course. The realtor sees three states
 * only: delivered, on its way, or delayed (LambaCard rejected the purchase, or it was paid
 * the old way with no purchase): an admin settles those. The amount shows once LambaCard
 * has quoted it, never before.
 */
const realtorReward = (enrollment) => {
    const { status, purchase } = enrollment.incentive;
    const delayed = status === "rejected" || status === "sent";
    return {
        id: enrollment._id,
        source: "course",
        earnedAt: enrollment.paidAt,
        status: status === "confirmed" ? "delivered" : delayed ? "delayed" : "on_its_way",
        tokens: purchase ? toTokenAmount(purchase.customerTokenUnits) : null,
        symbol: "LBT",
        explorerUrl: status === "confirmed" ? (purchase?.explorerUrl ?? null) : null,
        deliveredAt: status === "confirmed" ? (purchase?.confirmedAt ?? null) : null,
    };
};
export const getMyRewards = async (req, res) => {
    const enrollments = await Enrollment.find({
        registeredUser: req.user._id,
        "incentive.status": trusted({ $exists: true }),
    })
        .sort({ paidAt: -1 })
        .lean();
    res.status(200).json({ status: "success", data: { rewards: enrollments.map(realtorReward) } });
};
export const openMyWallet = async (req, res) => {
    const user = req.user;
    const existing = await Wallet.findOne({ user: user._id });
    if (existing?.status === "active") {
        res.status(200).json({ status: "success", data: { wallet: publicWallet(existing) } });
        return;
    }
    const identity = await Identity.findOne({ user: user._id });
    if (!identity?.verified)
        throw new AppError("Verify your identity before creating a wallet.", 403);
    // Saved before Planbok is called, so a retry re-sends the same idempotency key.
    const wallet = existing ?? (await Wallet.create({ user: user._id }));
    let opened;
    try {
        opened = await createWallet(wallet.idempotencyKey, wallet.refId, identity.legalName);
    }
    catch (error) {
        // A Planbok refusal is logged where it happens; anything else would vanish here.
        if (!(error instanceof AppError))
            console.error(`Wallet ${wallet.refId} failed: ${error instanceof Error ? error.message : "unknown error"}`);
        throw new AppError(NOT_CREATED, 502);
    }
    if (!opened) {
        // Planbok refused it. Dropping the row frees the idempotency key for a fresh attempt.
        console.error(`Wallet ${wallet.refId}: Planbok returned no wallet of its own.`);
        await wallet.deleteOne();
        throw new AppError(NOT_CREATED, 502);
    }
    wallet.planbokId = opened.id;
    wallet.address = opened.address;
    wallet.blockchain = opened.blockchain;
    wallet.status = "active";
    wallet.activatedAt = new Date();
    await wallet.save();
    res.status(201).json({ status: "success", data: { wallet: publicWallet(wallet) } });
};
//# sourceMappingURL=wallet.controller.js.map