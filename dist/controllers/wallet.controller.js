import { trusted } from "mongoose";
import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";
import Enrollment, { toTokenAmount, } from "../models/enrollment.model.js";
import Identity from "../models/identity.model.js";
import Wallet, { publicWallet } from "../models/wallet.model.js";
import { createWallet, getWalletBalances } from "../services/planbok.service.js";
import { ensureReferralCode } from "../services/referral.service.js";
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
const PAID_STATUSES = ["paid", "completed"];
const PAID = trusted({ $in: PAID_STATUSES });
/**
 * The LBT a realtor earns: one reward for their own paid course, and one for every course
 * a realtor they referred paid for. The realtor sees three states only: delivered, on its
 * way, or delayed (LambaCard rejected the purchase, or it was paid the old way with no
 * purchase): an admin settles those. The amount shows once LambaCard has quoted it, never
 * before.
 */
const realtorReward = (enrollment, source) => {
    const { status, purchase } = enrollment.incentive;
    const delayed = status === "rejected" || status === "sent";
    const units = source === "course" ? purchase?.customerTokenUnits : purchase?.referralTokenUnits;
    return {
        id: enrollment._id,
        source,
        // Only the first name of the realtor a referral came from.
        ...(source === "referral" && { referredName: enrollment.fullname.trim().split(/\s+/)[0] ?? "" }),
        earnedAt: enrollment.paidAt,
        status: status === "confirmed" ? "delivered" : delayed ? "delayed" : "on_its_way",
        tokens: units ? toTokenAmount(units) : null,
        symbol: "LBT",
        explorerUrl: status === "confirmed" ? (purchase?.explorerUrl ?? null) : null,
        deliveredAt: status === "confirmed" ? (purchase?.confirmedAt ?? null) : null,
    };
};
export const getMyRewards = async (req, res) => {
    const me = req.user._id;
    const referredByMe = {
        "referral.referrer": me,
        status: PAID,
        "incentive.status": trusted({ $exists: true }),
    };
    const [own, referred] = await Promise.all([
        Enrollment.find({ registeredUser: me, "incentive.status": trusted({ $exists: true }) }).lean(),
        Enrollment.find(referredByMe).lean(),
    ]);
    const rewards = [
        ...own.map((e) => realtorReward(e, "course")),
        ...referred.map((e) => realtorReward(e, "referral")),
    ].sort((a, b) => (b.earnedAt?.getTime() ?? 0) - (a.earnedAt?.getTime() ?? 0));
    res.status(200).json({ status: "success", data: { rewards } });
};
/**
 * The realtor's referral link and what it has earned. Only a realtor with an active wallet
 * can refer, since that is where the referrer's tokens land; the code is issued on the
 * first ask. A referral counts once the course is paid for.
 */
export const getMyReferral = async (req, res) => {
    const me = req.user._id;
    const wallet = await Wallet.findOne({ user: me, status: "active" }).select("_id");
    if (!wallet)
        throw new AppError("Create your wallet to start referring realtors.", 403);
    const code = await ensureReferralCode(me);
    const paidReferrals = { "referral.referrer": me, status: PAID };
    const referred = await Enrollment.find(paidReferrals)
        .select("incentive.status incentive.purchase.referralTokenUnits")
        .lean();
    const delivered = referred.filter((e) => e.incentive?.status === "confirmed");
    const units = delivered.reduce((sum, e) => sum + BigInt(e.incentive?.purchase?.referralTokenUnits ?? "0"), 0n);
    res.status(200).json({
        status: "success",
        data: {
            referral: {
                code,
                link: `${envConfig.CLIENT_URL.replace(/\/+$/, "")}/course?ref=${code}`,
                referred: referred.length,
                delivered: delivered.length,
                tokens: toTokenAmount(units.toString()),
                symbol: "LBT",
            },
        },
    });
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