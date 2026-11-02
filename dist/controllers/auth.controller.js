import { trusted } from "mongoose";
import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";
import Enrollment from "../models/enrollment.model.js";
import User, { hashToken, publicUser } from "../models/user.model.js";
import { sendPasswordChanged, sendRealtorJoined, sendResetEmail, sendVerifyEmail, sendWelcome, } from "../services/email.service.js";
import { enrollmentByInvite } from "../services/course.service.js";
import { ensureProfile } from "../services/profile.service.js";
import { cookieOptions, sendAuthCookie } from "../services/token.service.js";
/**
 * The account and its profile, without the verification send: the waitlist join writes
 * a request in between, so the caller mails once everything it needs is saved.
 */
export const createAccount = async (input) => {
    const user = new User(input);
    const verifyToken = user.createEmailVerifyToken();
    await user.save();
    const profile = await ensureProfile(user);
    // Ahead of the verification send: if that fails the account still exists.
    if (user.role === "realtor")
        sendRealtorJoined({ id: String(user._id), name: user.fullname, email: user.email });
    return {
        user,
        profile,
        verifyUrl: `${envConfig.CLIENT_URL}/verify-email?token=${verifyToken}`,
    };
};
/**
 * A realtor account is opened by the invite the realtor course hands out, for the email
 * that bought it. The invite is claimed before the account is created, so two sign-ups
 * racing on one invite cannot both get through, and released again if the account then
 * fails (a taken email, say), so a mistake does not burn it.
 */
const claimInvite = async (invite, email) => {
    if (!invite)
        throw new AppError("Realtor accounts start with the realtor course.", 403);
    const enrollment = await enrollmentByInvite(invite);
    if (enrollment.email !== email)
        throw new AppError("Register with the email you enrolled in the course with.", 400);
    const claimed = await Enrollment.findOneAndUpdate({ _id: enrollment._id, registeredAt: null }, { $set: { registeredAt: new Date() } }, { returnDocument: "after" });
    if (!claimed)
        throw new AppError("This registration link has already been used. Sign in instead.", 409);
    return claimed;
};
export const register = async (req, res) => {
    const { fullname, email, password, role, invite } = req.body;
    const enrollment = role === "realtor" ? await claimInvite(invite, email) : null;
    let account;
    try {
        account = await createAccount({ fullname, email, password, role });
    }
    catch (error) {
        if (enrollment)
            await Enrollment.updateOne({ _id: enrollment._id }, { $unset: { registeredAt: 1 } });
        throw error;
    }
    const { user, verifyUrl } = account;
    if (enrollment)
        await Enrollment.updateOne({ _id: enrollment._id }, { $set: { registeredUser: user._id } });
    // The account exists (and a realtor's invite is spent) whatever the mailer does next, so a
    // failed send is reported, not thrown. Answering with an error here would tell someone
    // with a working account to start again, and a used invite cannot. Resend from sign-in
    // or the sign-up page covers the missing email.
    let emailSent = true;
    try {
        await sendVerifyEmail(user.email, verifyUrl);
    }
    catch (error) {
        emailSent = false;
        console.error(`Verification email failed for ${user.email}:`, error);
    }
    res.status(201).json({
        status: "success",
        message: emailSent
            ? "Account created. Check your email to verify your address."
            : "Account created, but the verification email did not send. Ask for a new link.",
        data: { user: publicUser(user), emailSent },
    });
};
export const verifyEmail = async (req, res) => {
    const { token } = req.body;
    const user = await User.findOne({
        emailVerifyToken: hashToken(token),
        // trusted(): db.config sets sanitizeFilter, which would wrap this $gt in $eq.
        emailVerifyExpires: trusted({ $gt: new Date() }),
    }).select("+emailVerifyToken +emailVerifyExpires");
    if (!user)
        throw new AppError("Verification link is invalid or has expired.", 400);
    user.emailVerified = true;
    user.emailVerifyToken = undefined;
    user.emailVerifyExpires = undefined;
    await user.save({ validateBeforeSave: false });
    if (user.role !== "admin")
        sendWelcome(user.email, user.role);
    res.status(200).json({
        status: "success",
        message: "Email verified. You can now log in.",
    });
};
export const resendVerification = async (req, res) => {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (user && !user.emailVerified) {
        const verifyToken = user.createEmailVerifyToken();
        await user.save({ validateBeforeSave: false });
        await sendVerifyEmail(user.email, `${envConfig.CLIENT_URL}/verify-email?token=${verifyToken}`);
    }
    // Same answer either way: whether an address is registered is not public.
    res.status(200).json({
        status: "success",
        message: "If that email needs verification, a new link is on its way.",
    });
};
export const login = async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).select("+password");
    // One message for both failures, so this cannot be used to probe for accounts.
    if (!user || !(await user.correctPassword(password)))
        throw new AppError("Incorrect email or password.", 401);
    if (user.status === "suspended")
        throw new AppError(`This account has been suspended. Please contact ${envConfig.SUPPORT_EMAIL}.`, 403);
    // After the password check, so it tells an attacker nothing they lack.
    if (!user.emailVerified)
        throw new AppError("Please verify your email address before logging in.", 403);
    if (user.role === "admin")
        throw new AppError("Admins sign in at the admin console.", 403);
    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
    sendAuthCookie(user, 200, res);
};
export const logout = (_req, res) => {
    res.clearCookie("jwt", cookieOptions);
    res.status(200).json({ status: "success", message: "Logged out successfully." });
};
export const getMe = (req, res) => {
    res.status(200).json({ status: "success", data: { user: publicUser(req.user) } });
};
export const updatePassword = async (req, res) => {
    const { currentPassword, password } = req.body;
    // protect deliberately leaves the hash unselected, so refetch it here.
    const user = await User.findById(req.user._id).select("+password");
    if (!user || !(await user.correctPassword(currentPassword)))
        throw new AppError("Your current password is incorrect.", 401);
    user.password = password;
    await user.save();
    sendPasswordChanged(user.email);
    // The save invalidated every token issued before it, this caller's included.
    sendAuthCookie(user, 200, res);
};
export const forgotPassword = async (req, res) => {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (user && user.status !== "suspended") {
        const resetToken = user.createPasswordResetToken();
        await user.save({ validateBeforeSave: false });
        try {
            await sendResetEmail(user.email, `${envConfig.CLIENT_URL}/reset-password?token=${resetToken}`);
        }
        catch {
            user.passwordResetToken = undefined;
            user.passwordResetExpires = undefined;
            await user.save({ validateBeforeSave: false });
            throw new AppError("Could not send the reset email. Please try again later.", 500);
        }
    }
    res.status(200).json({
        status: "success",
        message: "If an account exists for that email, a reset link is on its way.",
    });
};
export const resetPassword = async (req, res) => {
    const { token, password } = req.body;
    const user = await User.findOne({
        passwordResetToken: hashToken(token),
        passwordResetExpires: trusted({ $gt: new Date() }),
    }).select("+passwordResetToken +passwordResetExpires");
    if (!user)
        throw new AppError("Reset link is invalid or has expired.", 400);
    if (user.status === "suspended")
        throw new AppError(`This account has been suspended. Please contact ${envConfig.SUPPORT_EMAIL}.`, 403);
    user.password = password;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();
    sendPasswordChanged(user.email);
    // No auto-login: verification stays the gate, and the client sends them to sign in.
    res.status(200).json({
        status: "success",
        message: "Password updated. Please log in with your new password.",
    });
};
//# sourceMappingURL=auth.controller.js.map