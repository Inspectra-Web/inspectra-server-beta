import { trusted } from "mongoose";
import AppError from "../error/app.error.js";
import Course, { fullCourse, missingForPublish, publicCourse } from "../models/course.model.js";
import Enrollment, { adminEnrollment, learnerEnrollment, } from "../models/enrollment.model.js";
import User from "../models/user.model.js";
import { createAccount } from "./auth.controller.js";
import { accessFor, completeEnrollment, courseLink, creditEnrollment, enrollmentByAccess, enrollmentByInvite, enrollmentFor, theCourse, } from "../services/course.service.js";
import { sendCourseAccess, sendVerifyEmail } from "../services/email.service.js";
import { createCheckout, verifyTransaction } from "../services/flutterwave.service.js";
import { courseAssetId, destroyAsset, uploadCourseCover, uploadCourseVideo, } from "../services/upload.service.js";
import { accessSchema, enrollmentReferenceSchema, inviteSchema, listEnrollmentsSchema, saveCourseSchema, } from "../validators/course.validator.js";
/* Public ------------------------------------------------------------------------ */
/** The sales page: the published course without its video, or null while in draft. */
export const getCourse = async (_req, res) => {
    const course = await Course.findOne({ status: "published" });
    res.status(200).json({ status: "success", data: { course: course && publicCourse(course) } });
};
const PAID_STATUSES = ["paid", "completed"];
const PAID = trusted({ $in: PAID_STATUSES });
const publishedCourse = async () => {
    const course = await Course.findOne({ status: "published" });
    if (!course)
        throw new AppError("The realtor course is not open yet.", 409);
    return course;
};
/** Nobody is charged twice: a paid buyer has their link mailed again instead. */
const refuseRepeatBuyer = async (email) => {
    const paid = await Enrollment.findOne({ email, status: PAID });
    if (!paid)
        return;
    if (paid.registeredAt)
        throw new AppError("You have already paid for the course. Sign in instead.", 409);
    sendCourseAccess(paid.email, {
        name: paid.fullname,
        reference: paid.reference,
        amount: paid.amount,
        channel: paid.channel,
        url: courseLink(accessFor(paid._id)),
    });
    throw new AppError("You have already paid for the course. We have emailed your link again.", 409);
};
/** Priced off the enrollment, which was priced off the course, never the request. */
const openCheckout = (enrollment) => {
    const { fullname, email, phone, reference } = enrollment;
    return createCheckout({
        reference,
        amount: enrollment.amount,
        currency: enrollment.currency,
        customer: { email, name: fullname, phone },
        description: "INSPECTRA realtor course",
        returnPath: "/course/callback",
        // Enough to rebuild the row from nothing, account link included.
        meta: {
            reference,
            kind: "course",
            fullname,
            email,
            phone,
            ...(enrollment.registeredUser && { user: String(enrollment.registeredUser) }),
        },
    });
};
/**
 * The checkout that opens the realtor account in the same submit, locked until the video
 * is finished. The account is saved before the checkout opens, so a checkout that fails
 * leaves an account that can sign in and pay from there.
 */
export const joinCourse = async (req, res) => {
    const { fullname, email, phone, password } = req.body;
    const course = await publishedCourse();
    // Ahead of the write, for a message that says what to do. The unique index still
    // catches a race, as a 409 from the global handler.
    if (await User.exists({ email }))
        throw new AppError("An account with this email already exists. Sign in to buy the course.", 409);
    await refuseRepeatBuyer(email);
    const { user, verifyUrl } = await createAccount({
        fullname,
        email,
        password,
        phone,
        role: "realtor",
        courseLocked: true,
    });
    await Enrollment.deleteMany({ email, status: "pending" });
    const enrollment = await Enrollment.create({
        fullname,
        email,
        phone,
        amount: course.price,
        registeredUser: user._id,
        registeredAt: new Date(),
    });
    // The account exists whatever the mailer does, so a failed send is logged, not thrown.
    // Sign-in offers a new link.
    sendVerifyEmail(user.email, verifyUrl).catch((error) => console.error(`Verification email failed for ${user.email}:`, error));
    const link = await openCheckout(enrollment);
    res.status(201).json({ status: "success", data: { link, reference: enrollment.reference } });
};
/** A signed-in realtor whose console is still locked, paying from their account. */
export const checkoutCourse = async (req, res) => {
    const user = req.user;
    if (user.role !== "realtor")
        throw new AppError("The realtor course opens realtor accounts. Use a different email.", 403);
    if (!user.courseLocked)
        throw new AppError("Your realtor console is already open.", 409);
    const course = await publishedCourse();
    if (await Enrollment.exists({ registeredUser: user._id, status: PAID }))
        throw new AppError("You have already paid for the course. Open it from your dashboard.", 409);
    await Enrollment.deleteMany({ registeredUser: user._id, status: "pending" });
    const enrollment = await Enrollment.create({
        fullname: user.fullname,
        email: user.email,
        phone: user.phone,
        amount: course.price,
        registeredUser: user._id,
        registeredAt: new Date(),
    });
    const link = await openCheckout(enrollment);
    res.status(201).json({ status: "success", data: { link, reference: enrollment.reference } });
};
/**
 * The signed-in realtor's own enrollment: the latest one, paid ahead of pending. The
 * course link comes back only once it is paid for.
 */
export const getMyEnrollment = async (req, res) => {
    const mine = { registeredUser: req.user._id };
    const enrollment = (await Enrollment.findOne({ ...mine, status: PAID }).sort({ createdAt: -1 })) ??
        (await Enrollment.findOne(mine).sort({ createdAt: -1 }));
    res.status(200).json({
        status: "success",
        data: {
            enrollment: enrollment && learnerEnrollment(enrollment),
            access: enrollment && enrollment.status !== "pending" ? accessFor(enrollment._id) : null,
        },
    });
};
/**
 * Where Flutterwave sends the guest back to. The transaction is always read back from
 * Flutterwave, even when the webhook has already settled the row: a reference alone is
 * not proof of paying, and this answer carries the course link.
 */
export const verifyEnrollment = async (req, res) => {
    const { reference } = enrollmentReferenceSchema.parse(req.params);
    const { transactionId } = req.body;
    const flw = await verifyTransaction(transactionId);
    if (flw.tx_ref !== reference)
        throw new AppError("That transaction belongs to a different payment.", 400);
    const enrollment = await enrollmentFor(flw);
    if (!enrollment)
        throw new AppError("No course payment with that reference.", 404);
    const settled = enrollment.status === "pending"
        ? (await creditEnrollment(enrollment, flw)).enrollment
        : enrollment;
    res.status(200).json({
        status: "success",
        message: "Payment confirmed. Your course link is on its way to your email.",
        data: {
            reference: settled.reference,
            amount: settled.amount,
            email: settled.email,
            access: accessFor(settled._id),
        },
    });
};
/* Learner ----------------------------------------------------------------------- */
export const getLearnerCourse = async (req, res) => {
    const { access } = accessSchema.parse(req.params);
    const enrollment = await enrollmentByAccess(access);
    const course = await theCourse();
    res.status(200).json({
        status: "success",
        data: { course: fullCourse(course), enrollment: learnerEnrollment(enrollment) },
    });
};
/**
 * The video ended. The server cannot see a video play; the no-skip rule is the player's.
 * `invite` is null when the enrollment already has an account, which this unlocks.
 */
export const finishCourse = async (req, res) => {
    const { access } = accessSchema.parse(req.params);
    const enrollment = await enrollmentByAccess(access);
    const invite = await completeEnrollment(enrollment);
    res.status(200).json({
        status: "success",
        data: { invite, enrollment: learnerEnrollment(enrollment) },
    });
};
/** Who an invite belongs to, so sign-up can fill and lock their details. */
export const getInvite = async (req, res) => {
    const { invite } = inviteSchema.parse(req.params);
    const enrollment = await enrollmentByInvite(invite);
    res.status(200).json({
        status: "success",
        data: { invite: { fullname: enrollment.fullname, email: enrollment.email } },
    });
};
/* Admin ------------------------------------------------------------------------- */
export const getAdminCourse = async (_req, res) => {
    const course = await theCourse();
    res.status(200).json({ status: "success", data: { course: fullCourse(course) } });
};
/** The details ride as JSON in the `course` field of a multipart body, beside any files. */
const readCourseBody = (req) => {
    const raw = req.body?.course;
    if (typeof raw !== "string")
        throw new AppError("Send the course details.", 400);
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new AppError("The course details are not valid.", 400);
    }
    return saveCourseSchema.parse(parsed);
};
/**
 * Saved whole, new files included. A cover or video reaches Cloudinary only here, so an
 * edit that is reloaded or discarded never leaves a file behind; if the save then fails,
 * what was just uploaded is deleted. Once it succeeds, a replaced file is deleted too.
 * A published course may not be saved into a state it could not publish in.
 */
export const saveCourse = async (req, res) => {
    const body = readCourseBody(req);
    const files = (req.files ?? {});
    const coverFile = files.courseCover?.[0];
    const videoFile = files.courseVideo?.[0];
    if (coverFile && !coverFile.mimetype.startsWith("image/"))
        throw new AppError("The cover must be an image.", 400);
    if (videoFile && !videoFile.mimetype.startsWith("video/"))
        throw new AppError("Upload a video file.", 400);
    const course = await theCourse();
    const before = {
        cover: course.cover,
        coverId: course.coverPublicId || courseAssetId(course.cover),
        video: course.videoUrl,
        videoId: course.videoPublicId || courseAssetId(course.videoUrl),
    };
    const uploaded = [];
    try {
        const next = {
            ...body,
            // A link that changed by hand is no longer a file this course uploaded.
            coverPublicId: body.cover === before.cover ? before.coverId : "",
            videoPublicId: body.videoUrl === before.video ? before.videoId : "",
        };
        if (coverFile) {
            const file = await uploadCourseCover(coverFile.buffer);
            uploaded.push({ id: file.publicId, type: "image" });
            next.cover = file.url;
            next.coverPublicId = file.publicId;
        }
        if (videoFile) {
            const file = await uploadCourseVideo(videoFile.buffer);
            uploaded.push({ id: file.publicId, type: "video" });
            next.videoUrl = file.url;
            next.videoPublicId = file.publicId;
        }
        course.set(next);
        const missing = missingForPublish(course);
        if (course.status === "published" && missing.length)
            throw new AppError(`A published course needs a ${missing.join(", ")}.`, 400);
        await course.save();
    }
    catch (error) {
        await Promise.all(uploaded.map(({ id, type }) => destroyAsset(id, type)));
        throw error;
    }
    // Nothing points at a replaced file any more. destroyAsset never throws.
    if (course.cover !== before.cover && before.coverId)
        await destroyAsset(before.coverId, "image");
    if (course.videoUrl !== before.video && before.videoId)
        await destroyAsset(before.videoId, "video");
    res.status(200).json({ status: "success", data: { course: fullCourse(course) } });
};
export const setCourseStatus = async (req, res) => {
    const { status } = req.body;
    const course = await theCourse();
    const missing = missingForPublish(course);
    if (status === "published" && missing.length)
        throw new AppError(`Add a ${missing.join(", ")} before publishing.`, 400);
    course.status = status;
    await course.save();
    res.status(200).json({ status: "success", data: { course: fullCourse(course) } });
};
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Everyone who started a checkout. The search narrows every branch; the status narrows
 * only `rows` and `total`, so the status counts never empty the control they sit on.
 */
export const listEnrollments = async (req, res) => {
    const { q, status, page, limit } = listEnrollmentsSchema.parse(req.query);
    const statusMatch = status === "all" ? [] : [{ $match: { status } }];
    const pipeline = [];
    if (q) {
        const pattern = new RegExp(escapeRegex(q), "i");
        pipeline.push({
            $match: { $or: [{ fullname: pattern }, { email: pattern }, { phone: pattern }, { reference: pattern }] },
        });
    }
    pipeline.push({
        $facet: {
            rows: [
                ...statusMatch,
                { $sort: { createdAt: -1, _id: -1 } },
                { $skip: (page - 1) * limit },
                { $limit: limit },
            ],
            total: [...statusMatch, { $count: "count" }],
            statuses: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
            // Joined: watched, with an account. An account alone is not it, since one opened at
            // checkout exists before paying.
            registered: [
                { $match: { status: "completed", registeredAt: { $exists: true } } },
                { $count: "count" },
            ],
        },
    });
    const [result] = await Enrollment.aggregate(pipeline);
    const counts = { all: 0, pending: 0, paid: 0, completed: 0 };
    for (const row of result?.statuses ?? []) {
        counts[row._id] += row.count;
        counts.all += row.count;
    }
    const total = result?.total[0]?.count ?? 0;
    res.status(200).json({
        status: "success",
        data: {
            enrollments: (result?.rows ?? []).map(adminEnrollment),
            total,
            page,
            limit,
            pages: Math.max(1, Math.ceil(total / limit)),
            counts,
            registered: result?.registered[0]?.count ?? 0,
        },
    });
};
//# sourceMappingURL=course.controller.js.map