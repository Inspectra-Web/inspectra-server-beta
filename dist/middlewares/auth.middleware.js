import jwt from "jsonwebtoken";
import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";
import User from "../models/user.model.js";
/** Identity only. Whether the account may act is each route's business. */
export const protect = async (req, _res, next) => {
    const { authorization } = req.headers;
    let token;
    // slice, not split: an index would be `string | undefined` under
    // noUncheckedIndexedAccess and would not narrow.
    if (authorization?.startsWith("Bearer "))
        token = authorization.slice(7);
    else if (req.cookies?.jwt)
        token = req.cookies.jwt;
    if (!token)
        throw new AppError("You are not logged in. Please log in to get access.", 401);
    const decoded = jwt.verify(token, envConfig.JWT_SECRET);
    const currentUser = await User.findById(decoded.id).select("+passwordChangedAt");
    if (!currentUser)
        throw new AppError("The user belonging to this token no longer exists.", 401);
    if (currentUser.changedPasswordAfter(decoded.iat))
        throw new AppError("Your password was recently changed. Please log in again.", 401);
    if (currentUser.status === "suspended")
        throw new AppError("This account has been suspended. Please contact support.", 403);
    req.user = currentUser;
    next();
};
/**
 * Identity if there is any, and no opinion if there is not. For public routes that
 * behave differently for someone signed in: the marketplace listing counts a view
 * against the person reading it, and cannot ask them to log in first.
 *
 * Every failure is silent by design. An expired or malformed token here means "not
 * signed in", not "error": a stale cookie must never 401 a page that anyone on the
 * internet is allowed to read.
 */
export const optionalAuth = async (req, _res, next) => {
    const { authorization } = req.headers;
    let token;
    if (authorization?.startsWith("Bearer "))
        token = authorization.slice(7);
    else if (req.cookies?.jwt)
        token = req.cookies.jwt;
    if (!token)
        return next();
    try {
        const decoded = jwt.verify(token, envConfig.JWT_SECRET);
        const currentUser = await User.findById(decoded.id).select("+passwordChangedAt");
        // The same three refusals protect makes, minus the shouting.
        if (currentUser &&
            !currentUser.changedPasswordAfter(decoded.iat) &&
            currentUser.status !== "suspended")
            req.user = currentUser;
    }
    catch {
        // Not signed in. Carry on.
    }
    next();
};
/** Synchronous, so it hands the error to next() rather than throwing. */
export const restrictTo = (...roles) => (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
        next(new AppError("You do not have permission to perform this action", 403));
        return;
    }
    next();
};
//# sourceMappingURL=auth.middleware.js.map