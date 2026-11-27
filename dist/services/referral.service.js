import { randomInt } from "node:crypto";
import { trusted } from "mongoose";
import AppError from "../error/app.error.js";
import User, { REFERRAL_ALPHABET } from "../models/user.model.js";
import Wallet from "../models/wallet.model.js";
/**
 * Realtors referring realtors to the course. Only a realtor with an active wallet can
 * refer: the referrer's tokens settle on chain into that wallet, captured when the
 * checkout opens.
 */
const newCode = () => Array.from({ length: 8 }, () => REFERRAL_ALPHABET[randomInt(REFERRAL_ALPHABET.length)]).join("");
const INVALID = "That referral link is not valid.";
/**
 * The referral a code stands for, or a 400. Refuses a code nobody holds, a suspended
 * referrer, a referrer with no active wallet, and a buyer naming their own code.
 */
export const referrerFor = async (code, buyer) => {
    const referralCode = code.trim().toUpperCase();
    const referrer = await User.findOne({
        referralCode,
        role: "realtor",
        status: trusted({ $ne: "suspended" }),
    }).select("fullname");
    if (!referrer)
        throw new AppError(INVALID, 400);
    if (buyer && referrer._id.equals(buyer))
        throw new AppError("You cannot use your own referral link.", 400);
    const wallet = await Wallet.findOne({ user: referrer._id, status: "active" }).select("address");
    if (!wallet?.address)
        throw new AppError(INVALID, 400);
    return {
        referral: { referrer: referrer._id, code: referralCode, walletAddress: wallet.address },
        firstName: referrer.fullname.trim().split(/\s+/)[0] ?? "",
    };
};
/**
 * The realtor's referral code, issued on first ask and never changed. Conditional on
 * having none, so two first asks agree; a collision with another realtor's code just
 * draws again.
 */
export const ensureReferralCode = async (userId) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const existing = await User.findById(userId).select("referralCode");
        if (!existing)
            throw new AppError("That account does not exist.", 404);
        if (existing.referralCode)
            return existing.referralCode;
        try {
            const issued = await User.findOneAndUpdate({ _id: userId, referralCode: trusted({ $exists: false }) }, { $set: { referralCode: newCode() } }, { returnDocument: "after" }).select("referralCode");
            if (issued?.referralCode)
                return issued.referralCode;
        }
        catch (error) {
            if (error.code !== 11000)
                throw error;
        }
    }
    throw new AppError("Your referral link could not be created. Please try again.", 503);
};
//# sourceMappingURL=referral.service.js.map