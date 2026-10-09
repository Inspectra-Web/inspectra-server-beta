import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";
import Identity from "../models/identity.model.js";
import Inspection from "../models/inspection.model.js";
import LedgerEntry from "../models/ledgerEntry.model.js";
import VirtualAccount, { publicVirtualAccount } from "../models/virtualAccount.model.js";
import { decrypt } from "../services/crypto.service.js";
import { sendVirtualAccountOpened } from "../services/email.service.js";
import { createAccount, findAccount, getBalance } from "../services/planbok.service.js";
import { ensureProfile } from "../services/profile.service.js";
import { listEarningsSchema } from "../validators/virtualAccount.validator.js";
export const getMyVirtualAccount = async (req, res) => {
    const account = await VirtualAccount.findOne({ user: req.user._id });
    const balance = account?.status === "active" && account.planbokId ? await getBalance(account.planbokId, req.user.email) : null;
    res.status(200).json({
        status: "success",
        data: { account: account && publicVirtualAccount(account), balance },
    });
};
export const openMyVirtualAccount = async (req, res) => {
    const user = req.user;
    const existing = await VirtualAccount.findOne({ user: user._id });
    if (existing?.status === "active") {
        res.status(200).json({ status: "success", data: { account: publicVirtualAccount(existing) } });
        return;
    }
    const identity = await Identity.findOne({ user: user._id }).select("+nin +bvn");
    if (!identity?.verified)
        throw new AppError("Verify your identity before opening a virtual account.", 403);
    if (!identity.nin || !identity.bvn)
        throw new AppError(`Your identity check is missing your NIN or BVN. Contact ${envConfig.SUPPORT_EMAIL} to add it.`, 403);
    const profile = await ensureProfile(user);
    if (!profile.address.trim())
        throw new AppError("Add your home address in your Profile before opening a virtual account.", 403);
    // Saved before Planbok is called, so a retry re-sends the same idempotency key.
    const account = existing ?? (await VirtualAccount.create({ kind: "realtor", user: user._id, consentedAt: new Date() }));
    const opened = (await createAccount(account.idempotencyKey, account.refId, identity.legalName, {
        firstName: identity.firstName,
        lastName: identity.lastName,
        phoneNumber: user.phone ?? "",
        email: user.email,
        address: [profile.address, profile.city, profile.state].filter(Boolean).join(", "),
        dateOfBirth: identity.dateOfBirth,
        bvn: decrypt(identity.bvn),
        nin: decrypt(identity.nin),
    })) ?? (await findAccount(account.refId, user.email));
    if (!opened) {
        // Planbok refused it. Dropping the row frees the idempotency key for a fresh attempt.
        await account.deleteOne();
        throw new AppError("We could not open your virtual account. Try again later.", 502);
    }
    account.planbokId = opened.id;
    account.accountNumber = opened.accountNumber;
    account.accountName = opened.accountName;
    account.bankName = opened.bankName;
    account.bankCode = opened.bankCode;
    account.status = "active";
    account.activatedAt = new Date();
    await account.save();
    sendVirtualAccountOpened(user.email, account);
    res.status(201).json({ status: "success", data: { account: publicVirtualAccount(account) } });
};
/**
 * Inspection fees paid into this realtor's account, from the ledger: a fee counts once
 * Flutterwave reported its transfer successful, never before. `held` is what buyers
 * have paid that is still waiting on a viewing, an answer or the transfer itself, so
 * the realtor can see money on its way without it being called theirs yet. A disputed
 * fee is left out of both: it may not come to them at all.
 */
export const listMyEarnings = async (req, res) => {
    const { page, limit } = listEarningsSchema.parse(req.query);
    const user = req.user;
    const account = await VirtualAccount.findOne({ user: user._id }).select("_id");
    const [earned] = account
        ? await LedgerEntry.aggregate([
            { $match: { account: account._id, kind: "release", direction: "credit" } },
            {
                $facet: {
                    rows: [
                        { $sort: { createdAt: -1, _id: -1 } },
                        { $skip: (page - 1) * limit },
                        { $limit: limit },
                        {
                            $lookup: {
                                from: "inspections",
                                localField: "inspection",
                                foreignField: "_id",
                                as: "inspection",
                                pipeline: [
                                    { $project: { slot: 1, property: 1 } },
                                    {
                                        $lookup: {
                                            from: "properties",
                                            localField: "property",
                                            foreignField: "_id",
                                            as: "property",
                                            pipeline: [{ $project: { title: 1, ref: 1 } }],
                                        },
                                    },
                                    { $unwind: { path: "$property", preserveNullAndEmptyArrays: true } },
                                ],
                            },
                        },
                        { $unwind: { path: "$inspection", preserveNullAndEmptyArrays: true } },
                    ],
                    total: [{ $group: { _id: null, count: { $sum: 1 }, kobo: { $sum: "$amount" } } }],
                },
            },
        ])
        : [];
    const [held] = await Inspection.aggregate([
        { $match: { realtor: user._id, "escrow.status": { $in: ["held", "releasing"] } } },
        {
            $group: {
                _id: null,
                count: { $sum: 1 },
                naira: { $sum: { $ifNull: ["$escrow.releaseAmount", "$escrow.fee"] } },
            },
        },
    ]);
    const total = earned?.total[0]?.count ?? 0;
    res.status(200).json({
        status: "success",
        data: {
            earnings: (earned?.rows ?? []).map((row) => ({
                id: row._id,
                amount: row.amount,
                reference: row.flwReference,
                paidAt: row.createdAt,
                slot: row.inspection?.slot,
                inspection: row.inspection?._id,
                property: row.inspection?.property?.title ?? "",
            })),
            // Kobo, like the balance, so both render through the same formatter.
            earned: earned?.total[0]?.kobo ?? 0,
            held: { count: held?.count ?? 0, kobo: (held?.naira ?? 0) * 100 },
            page,
            limit,
            total,
            pages: Math.max(1, Math.ceil(total / limit)),
        },
    });
};
//# sourceMappingURL=virtualAccount.controller.js.map