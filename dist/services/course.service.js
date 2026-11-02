import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";
import Course from "../models/course.model.js";
import Enrollment from "../models/enrollment.model.js";
import { hashToken } from "../models/user.model.js";
import { fingerprint } from "./crypto.service.js";
import { sendCourseAccess } from "./email.service.js";
/**
 * The course link and the registration invite are derived from the enrollment id with the
 * server's key, not drawn at random. The redirect and the webhook both settle most
 * payments, and a random secret would have the second one replace the link the first one
 * emailed. Derived, the same value comes back every time; only its hash is stored, and
 * without the key neither can be worked out from an id.
 */
export const accessFor = (id) => fingerprint(`course-access:${id}`);
export const inviteFor = (id) => fingerprint(`course-invite:${id}`);
const clientOrigin = envConfig.CLIENT_URL.replace(/\/+$/, "");
export const courseLink = (access) => `${clientOrigin}/course/learn?access=${access}`;
/** The one course. Upserted, so the admin's first read creates the draft. */
export const theCourse = () => Course.findOneAndUpdate({}, { $setOnInsert: {} }, { upsert: true, returnDocument: "after" });
/**
 * The row behind a course charge, rebuilt if a successful charge has outlived it.
 *
 * Starting a second checkout with the same email drops the first pending row, so a guest
 * who pays the first tab anyway arrives with real money and no row. Their details rode on
 * the charge's meta; the amount is read off the course, never off the charge.
 */
export const enrollmentFor = async (flw) => {
    const existing = await Enrollment.findOne({ reference: flw.tx_ref });
    if (existing)
        return existing;
    if (flw.status !== "successful")
        return null;
    const { fullname, email, phone } = flw.meta ?? {};
    if (!fullname || !email || !phone)
        return null;
    const course = await theCourse();
    console.warn(`Rebuilding enrollment ${flw.tx_ref}: its attempt row was already gone.`);
    return Enrollment.create({ fullname, email, phone, reference: flw.tx_ref, amount: course.price });
};
/**
 * Turns a verified charge into a paid enrollment, exactly once.
 *
 * The same claim as a plan payment: a conditional update on `pending`, so whichever of
 * the redirect and the webhook loses gets null instead of a second email. Both answer
 * with the same access, because it is derived rather than stored.
 */
export const creditEnrollment = async (enrollment, flw) => {
    if (flw.tx_ref !== enrollment.reference)
        throw new AppError("That transaction belongs to a different payment.", 400);
    if (flw.status !== "successful") {
        // The row stays pending, so enrolling again starts a clean checkout.
        await Enrollment.updateOne({ _id: enrollment._id, status: "pending" }, { $set: { failureReason: flw.status, flwId: flw.id, flwRef: flw.flw_ref } });
        throw new AppError("That payment did not go through.", 402);
    }
    // What was paid against what was asked. The reason the amount never comes off a request.
    if (flw.currency !== enrollment.currency || flw.amount < enrollment.amount)
        throw new AppError("That payment does not match what was owed.", 400);
    const access = accessFor(enrollment._id);
    const claimed = await Enrollment.findOneAndUpdate({ _id: enrollment._id, status: "pending" }, {
        $set: {
            status: "paid",
            flwId: flw.id,
            flwRef: flw.flw_ref,
            channel: flw.payment_type ?? "",
            paidAt: new Date(),
            failureReason: "",
            accessHash: hashToken(access),
        },
    }, { returnDocument: "after" });
    if (claimed)
        sendCourseAccess(claimed.email, {
            name: claimed.fullname,
            reference: claimed.reference,
            amount: claimed.amount,
            channel: claimed.channel,
            url: courseLink(access),
        });
    const settled = claimed ?? (await Enrollment.findById(enrollment._id)) ?? enrollment;
    return { enrollment: settled, access };
};
/** A paid enrollment by its course link, or a 404 that says nothing about which part failed. */
export const enrollmentByAccess = async (access) => {
    const enrollment = await Enrollment.findOne({ accessHash: hashToken(access) });
    if (!enrollment)
        throw new AppError("This course link is not valid.", 404);
    return enrollment;
};
/**
 * The video ended: the enrollment is completed and the invite is handed out. Safe to call
 * again, which is how a returning learner gets their invite back. Once the invite has
 * been used, there is nothing left to hand out.
 */
export const issueInvite = async (enrollment) => {
    if (enrollment.registeredAt)
        throw new AppError("You have already registered. Sign in instead.", 409);
    const invite = inviteFor(enrollment._id);
    enrollment.status = "completed";
    enrollment.completedAt ??= new Date();
    enrollment.inviteHash = hashToken(invite);
    await enrollment.save({ validateModifiedOnly: true });
    return invite;
};
/** The enrollment an invite belongs to, if it can still open an account. */
export const enrollmentByInvite = async (invite) => {
    const enrollment = await Enrollment.findOne({
        inviteHash: hashToken(invite),
        status: "completed",
    });
    if (!enrollment)
        throw new AppError("This registration link is not valid. Open the one from your course page.", 400);
    if (enrollment.registeredAt)
        throw new AppError("This registration link has already been used. Sign in instead.", 409);
    return enrollment;
};
//# sourceMappingURL=course.service.js.map