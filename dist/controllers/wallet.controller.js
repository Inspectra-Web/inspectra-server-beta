import AppError from "../error/app.error.js";
import Identity from "../models/identity.model.js";
import Wallet, { publicWallet } from "../models/wallet.model.js";
import { createWallet, findWallet } from "../services/planbok.service.js";
const NOT_CREATED = "We could not create your wallet. Try again later.";
export const getMyWallet = async (req, res) => {
    const wallet = await Wallet.findOne({ user: req.user._id });
    res.status(200).json({ status: "success", data: { wallet: wallet && publicWallet(wallet) } });
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
        opened =
            (await createWallet(wallet.idempotencyKey, wallet.refId, identity.legalName)) ??
                (await findWallet(wallet.refId));
    }
    catch {
        // Planbok's own reason is already in the server log; the realtor gets one plain message.
        throw new AppError(NOT_CREATED, 502);
    }
    if (!opened) {
        // Planbok refused it. Dropping the row frees the idempotency key for a fresh attempt.
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