import { trusted, Types } from "mongoose";
import AppError from "../error/app.error.js";
import Course, { MAX_LESSONS, adminCourse, liveLessons, playable, lessonOutline, missingForPublish, publicCourse, } from "../models/course.model.js";
import Enrollment, { adminEnrollment, learnerEnrollment, } from "../models/enrollment.model.js";
import User from "../models/user.model.js";
import { createAccount } from "./auth.controller.js";
import { MAX_VIDEO_BYTES, PART_SIZE, abortUpload, completeUpload, deleteVideoFile, partUrls, playbackUrl, r2Configured, startUpload, videoKeyFor, } from "../services/r2.service.js";
import { accessFor, courseLink, creditEnrollment, enrollmentByAccess, enrollmentByInvite, enrollmentFor, openDashboard, theCourse, completeEnrollment, } from "../services/course.service.js";
import { sendCourseAccess, sendVerifyEmail } from "../services/email.service.js";
import { rewardFromBalancePreview, sendRewardFromBalance } from "../services/incentive.service.js";
import { referrerFor } from "../services/referral.service.js";
import { createCheckout, verifyTransaction } from "../services/flutterwave.service.js";
import { courseAssetId, destroyAsset, uploadCourseCover, } from "../services/upload.service.js";
import { accessSchema, enrollmentParamSchema, enrollmentReferenceSchema, inviteSchema, lessonParamSchema, referralCodeParamSchema, listEnrollmentsSchema, saveCourseSchema, } from "../validators/course.validator.js";
/* Public ------------------------------------------------------------------------ */
/** Who a referral link belongs to, by first name only, so the checkout can say so. */
export const getReferrer = async (req, res) => {
    const { code } = referralCodeParamSchema.parse(req.params);
    const { firstName } = await referrerFor(code);
    res.status(200).json({ status: "success", data: { firstName } });
};
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
            ...(enrollment.referral && { referralCode: enrollment.referral.code }),
        },
    });
};
/**
 * The checkout that opens the realtor account in the same submit, locked until the video
 * is finished. The account is saved before the checkout opens, so a checkout that fails
 * leaves an account that can sign in and pay from there.
 */
export const joinCourse = async (req, res) => {
    const { fullname, email, phone, password, referralCode } = req.body;
    const course = await publishedCourse();
    // Ahead of the write, for a message that says what to do. The unique index still
    // catches a race, as a 409 from the global handler.
    if (await User.exists({ email }))
        throw new AppError("An account with this email already exists. Sign in to buy the course.", 409);
    await refuseRepeatBuyer(email);
    // Checked before anything is written, so a bad link leaves no account behind.
    const referred = referralCode ? await referrerFor(referralCode) : null;
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
        ...(referred && { referral: referred.referral }),
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
    const { referralCode } = req.body;
    // Any realtor may buy it: one waiting on payment, or one whose dashboard was open before
    // the course existed.
    if (user.role !== "realtor")
        throw new AppError("The realtor course opens realtor accounts. Use a different email.", 403);
    const course = await publishedCourse();
    if (await Enrollment.exists({ registeredUser: user._id, status: PAID }))
        throw new AppError("You have already paid for the course. Open it from your dashboard.", 409);
    const referred = referralCode ? await referrerFor(referralCode, user._id) : null;
    await Enrollment.deleteMany({ registeredUser: user._id, status: "pending" });
    const enrollment = await Enrollment.create({
        fullname: user.fullname,
        email: user.email,
        phone: user.phone,
        amount: course.price,
        registeredUser: user._id,
        registeredAt: new Date(),
        ...(referred && { referral: referred.referral }),
    });
    const link = await openCheckout(enrollment);
    res.status(201).json({ status: "success", data: { link, reference: enrollment.reference } });
};
/**
 * The signed-in realtor's own enrollment: the latest one, paid ahead of pending. The
 * course link comes back only once it is paid for.
 *
 * A locked realtor who has paid is someone who paid before paying opened the dashboard;
 * this is the request their lock screen makes, so it opens it for them here.
 * `dashboardOpened` tells the browser to read the account again.
 */
export const getMyEnrollment = async (req, res) => {
    const user = req.user;
    const mine = { registeredUser: user._id };
    const enrollment = (await Enrollment.findOne({ ...mine, status: PAID }).sort({ createdAt: -1 })) ??
        (await Enrollment.findOne(mine).sort({ createdAt: -1 }));
    const paid = !!enrollment && enrollment.status !== "pending";
    const dashboardOpened = paid && user.courseLocked ? await openDashboard(user._id) : false;
    res.status(200).json({
        status: "success",
        data: {
            enrollment: enrollment && learnerEnrollment(enrollment),
            access: paid ? accessFor(enrollment._id) : null,
            dashboardOpened,
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
/**
 * The course as a paid learner sees it: every lesson with its video, in order. Watching is
 * not tracked (since 2026-11-17): paying is what opens the dashboard and earns the reward,
 * so the lessons are there to dip into, any order, any part.
 */
const learnerCourse = async (course) => ({
    ...publicCourse(course),
    lessons: await Promise.all(liveLessons(course).map(async (lesson) => ({ ...lessonOutline(lesson), videoUrl: await videoLink(lesson) }))),
});
/**
 * Where a lesson plays from: an R2 file on a link that expires within the hour, so a
 * copied or shared link soon stops working; or an earlier upload or link, until replaced.
 */
const videoLink = async (lesson) => lesson.videoKey ? playbackUrl(lesson.videoKey) : lesson.videoUrl;
/**
 * The paid learner's course. An old guest row (no account) gets its sign-up invite here,
 * on opening, since there is no longer a finish to hand it out at.
 */
export const getLearnerCourse = async (req, res) => {
    const { access } = accessSchema.parse(req.params);
    const enrollment = await enrollmentByAccess(access);
    const course = await theCourse();
    const invite = enrollment.registeredUser ? null : await completeEnrollment(enrollment);
    res.status(200).json({
        status: "success",
        data: { course: await learnerCourse(course), enrollment: learnerEnrollment(enrollment), invite },
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
/** The admin course, with an expiring link to play each lesson and whether uploads can go to R2. */
const adminView = async (course) => {
    const view = adminCourse(course);
    return {
        ...view,
        videoStorage: r2Configured(),
        lessons: await Promise.all(view.lessons.map(async (lesson, i) => {
            const doc = course.lessons[i];
            return { ...lesson, videoUrl: doc && playable(doc) ? await videoLink(doc) : "" };
        })),
    };
};
export const getAdminCourse = async (_req, res) => {
    const course = await theCourse();
    res.status(200).json({ status: "success", data: { course: await adminView(course) } });
};
/** Multipart bodies carry their details as JSON in one named field, beside any file. */
const readJsonField = (req, field, parse) => {
    const raw = req.body?.[field];
    if (typeof raw !== "string")
        throw new AppError("Send the details with the upload.", 400);
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new AppError("Those details are not valid.", 400);
    }
    return parse(parsed);
};
/** A published course may not be saved into a state it could not publish in. */
const assertPublishable = (course) => {
    const missing = missingForPublish(course);
    if (course.status === "published" && missing.length)
        throw new AppError(`A published course needs a ${missing.join(", ")}.`, 400);
};
/**
 * The course's own details, a new cover included. The cover reaches Cloudinary only here,
 * so an edit that is reloaded or discarded never leaves a file behind; if the save then
 * fails, what was just uploaded is deleted. Once it succeeds, a replaced cover is deleted.
 */
export const saveCourse = async (req, res) => {
    const body = readJsonField(req, "course", (value) => saveCourseSchema.parse(value));
    const coverFile = req.files?.courseCover?.[0];
    if (coverFile && !coverFile.mimetype.startsWith("image/"))
        throw new AppError("The cover must be an image.", 400);
    const course = await theCourse();
    const before = {
        cover: course.cover,
        coverId: course.coverPublicId || courseAssetId(course.cover),
    };
    let uploadedId = "";
    try {
        const next = {
            ...body,
            // A link that changed by hand is no longer a file this course uploaded.
            coverPublicId: body.cover === before.cover ? before.coverId : "",
        };
        if (coverFile) {
            const file = await uploadCourseCover(coverFile.buffer);
            uploadedId = file.publicId;
            next.cover = file.url;
            next.coverPublicId = file.publicId;
        }
        course.set(next);
        assertPublishable(course);
        await course.save();
    }
    catch (error) {
        await destroyAsset(uploadedId, "image");
        throw error;
    }
    // Nothing points at a replaced file any more. destroyAsset never throws.
    if (course.cover !== before.cover && before.coverId)
        await destroyAsset(before.coverId, "image");
    res.status(200).json({ status: "success", data: { course: await adminView(course) } });
};
/* Lessons ----------------------------------------------------------------------- */
const findLesson = (course, lessonId) => {
    const lesson = course.lessons.find((l) => String(l._id) === lessonId);
    if (!lesson)
        throw new AppError("That lesson is not in this course.", 404);
    return lesson;
};
/** A lesson's details. Its video arrives separately, through an upload to R2. */
export const addLesson = async (req, res) => {
    const body = req.body;
    const course = await theCourse();
    if (course.lessons.length >= MAX_LESSONS)
        throw new AppError(`A course holds at most ${MAX_LESSONS} lessons.`, 400);
    course.lessons.push({ title: body.title, summary: body.summary, minutes: body.minutes });
    const lesson = course.lessons.at(-1);
    if (!lesson)
        throw new AppError("The lesson could not be added.", 500);
    await writeLesson(course, lesson, body);
    res.status(201).json({ status: "success", data: { course: await adminView(course) } });
};
export const updateLesson = async (req, res) => {
    const { lessonId } = lessonParamSchema.parse(req.params);
    const body = req.body;
    const course = await theCourse();
    await writeLesson(course, findLesson(course, lessonId), body);
    res.status(200).json({ status: "success", data: { course: await adminView(course) } });
};
/**
 * Saves a lesson's details and its link. A link replaces an uploaded file, which is then
 * deleted; an empty link keeps an uploaded file, or leaves a linked lesson with no video
 * (hidden from realtors until it gets one). A replaced Cloudinary upload is deleted too.
 */
const writeLesson = async (course, lesson, body) => {
    const before = {
        key: lesson.videoKey,
        link: lesson.videoUrl,
        cloudinary: lesson.videoPublicId || courseAssetId(lesson.videoUrl),
    };
    const linked = body.videoUrl !== "";
    Object.assign(lesson, {
        title: body.title,
        summary: body.summary,
        minutes: body.minutes,
        videoUrl: body.videoUrl,
        videoPublicId: body.videoUrl === before.link ? lesson.videoPublicId : "",
        ...(linked && { videoKey: "" }),
    });
    assertPublishable(course);
    await course.save();
    if (linked && before.key)
        await deleteVideoFile(before.key);
    if (body.videoUrl !== before.link && before.cloudinary)
        await destroyAsset(before.cloudinary, "video");
};
/* Lesson video uploads, browser to R2 ------------------------------------------- */
/**
 * Starts an upload of a lesson's video. R2 opens a multipart upload; the lesson remembers
 * it, so only this upload can sign its parts or finish. An earlier unfinished upload for
 * the lesson is cancelled.
 */
export const startLessonUpload = async (req, res) => {
    const { lessonId } = lessonParamSchema.parse(req.params);
    const { fileName, contentType, size } = req.body;
    const course = await theCourse();
    const lesson = findLesson(course, lessonId);
    const key = videoKeyFor(lessonId, fileName);
    const uploadId = await startUpload(key, contentType);
    const previous = { key: lesson.pendingKey, uploadId: lesson.pendingUploadId };
    lesson.pendingKey = key;
    lesson.pendingUploadId = uploadId;
    await course.save();
    await abortUpload(previous.key, previous.uploadId);
    res.status(201).json({
        status: "success",
        data: { uploadId, partSize: PART_SIZE, partCount: Math.ceil(size / PART_SIZE) },
    });
};
/** The pending upload a request names, or a 409 if the lesson has moved on from it. */
const pendingUpload = (lesson, uploadId) => {
    if (!lesson.pendingUploadId || lesson.pendingUploadId !== uploadId)
        throw new AppError("That upload is no longer open. Start the upload again.", 409);
    return { key: lesson.pendingKey, uploadId };
};
/** Signed addresses for the next few parts. Signed in batches so none sits waiting to expire. */
export const signLessonParts = async (req, res) => {
    const { lessonId } = lessonParamSchema.parse(req.params);
    const { uploadId, partNumbers } = req.body;
    const course = await theCourse();
    const { key } = pendingUpload(findLesson(course, lessonId), uploadId);
    res.status(200).json({ status: "success", data: { parts: await partUrls(key, uploadId, partNumbers) } });
};
/**
 * Every part is up: R2 joins them, and the file becomes the lesson's video. The video it
 * replaces, on R2 or Cloudinary, is deleted once the course is saved.
 */
export const completeLessonUpload = async (req, res) => {
    const { lessonId } = lessonParamSchema.parse(req.params);
    const { uploadId, parts, minutes } = req.body;
    const course = await theCourse();
    const lesson = findLesson(course, lessonId);
    const { key } = pendingUpload(lesson, uploadId);
    const size = await completeUpload(key, uploadId, parts);
    if (size > MAX_VIDEO_BYTES) {
        await deleteVideoFile(key);
        throw new AppError("That video is over 5 GB. Compress it and upload it again.", 400);
    }
    const replaced = { key: lesson.videoKey, cloudinary: lesson.videoPublicId || courseAssetId(lesson.videoUrl) };
    Object.assign(lesson, {
        videoKey: key,
        videoUrl: "",
        videoPublicId: "",
        pendingKey: "",
        pendingUploadId: "",
        minutes,
    });
    await course.save();
    await deleteVideoFile(replaced.key);
    await destroyAsset(replaced.cloudinary, "video");
    res.status(200).json({ status: "success", data: { course: await adminView(course) } });
};
/** The admin gave up on an upload: R2 drops the parts sent so far. */
export const cancelLessonUpload = async (req, res) => {
    const { lessonId } = lessonParamSchema.parse(req.params);
    const { uploadId } = req.body;
    const course = await theCourse();
    const lesson = findLesson(course, lessonId);
    const { key } = pendingUpload(lesson, uploadId);
    lesson.pendingKey = "";
    lesson.pendingUploadId = "";
    await course.save();
    await abortUpload(key, uploadId);
    res.status(200).json({ status: "success", data: { course: await adminView(course) } });
};
/** Removes a lesson and its uploaded video. A published course keeps at least one. */
export const deleteLesson = async (req, res) => {
    const { lessonId } = lessonParamSchema.parse(req.params);
    const course = await theCourse();
    const lesson = findLesson(course, lessonId);
    const videoId = lesson.videoPublicId || courseAssetId(lesson.videoUrl);
    const stored = { key: lesson.videoKey, pendingKey: lesson.pendingKey, uploadId: lesson.pendingUploadId };
    course.lessons.pull(lesson._id);
    assertPublishable(course);
    await course.save();
    await destroyAsset(videoId, "video");
    await deleteVideoFile(stored.key);
    await abortUpload(stored.pendingKey, stored.uploadId);
    res.status(200).json({ status: "success", data: { course: await adminView(course) } });
};
/** The lessons in a new order. The ids must be exactly the current lessons, once each. */
export const reorderLessons = async (req, res) => {
    const { ids } = req.body;
    const course = await theCourse();
    const current = course.lessons.map((lesson) => String(lesson._id));
    const same = ids.length === current.length && new Set(ids).size === ids.length && ids.every((id) => current.includes(id));
    if (!same)
        throw new AppError("The new order must list every lesson exactly once.", 400);
    const byId = new Map(course.lessons.map((lesson) => [String(lesson._id), lesson.toObject()]));
    course.set("lessons", ids.map((id) => byId.get(id)));
    await course.save();
    res.status(200).json({ status: "success", data: { course: await adminView(course) } });
};
export const setCourseStatus = async (req, res) => {
    const { status } = req.body;
    const course = await theCourse();
    const missing = missingForPublish(course);
    if (status === "published" && missing.length)
        throw new AppError(`Add a ${missing.join(", ")} before publishing.`, 400);
    course.status = status;
    await course.save();
    res.status(200).json({ status: "success", data: { course: await adminView(course) } });
};
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const REFERRAL_MATCH = {
    referred: { referral: { $exists: true } },
    direct: { referral: { $exists: false } },
};
/** One enrollment for the admin, with the referrer's name read off their account. */
const withReferrer = async (enrollment) => {
    const referrer = enrollment.referral
        ? await User.findById(enrollment.referral.referrer).select("fullname email").lean()
        : null;
    return adminEnrollment(enrollment, referrer);
};
/**
 * Everyone who started a checkout. The search narrows every branch; the status and the
 * referral filter narrow only `rows` and `total`, so their counts never empty the control
 * they sit on.
 */
export const listEnrollments = async (req, res) => {
    const { q, status, referral, page, limit } = listEnrollmentsSchema.parse(req.query);
    const statusMatch = [
        ...(status === "all" ? [] : [{ $match: { status } }]),
        ...(referral === "all" ? [] : [{ $match: REFERRAL_MATCH[referral] }]),
    ];
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
                {
                    $lookup: {
                        from: "users",
                        localField: "referral.referrer",
                        foreignField: "_id",
                        as: "referrerUser",
                        pipeline: [{ $project: { _id: 0, fullname: 1, email: 1 } }],
                    },
                },
            ],
            total: [...statusMatch, { $count: "count" }],
            statuses: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
            referrals: [{ $group: { _id: { $ne: [{ $type: "$referral" }, "missing"] }, count: { $sum: 1 } } }],
            // Joined: paid, with an account, since paying is what opens the dashboard. An account
            // alone is not it: one opened at checkout exists before paying.
            registered: [
                { $match: { status: { $in: PAID_STATUSES }, registeredAt: { $exists: true } } },
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
    const referrals = { all: 0, referred: 0, direct: 0 };
    for (const row of result?.referrals ?? []) {
        referrals[row._id ? "referred" : "direct"] += row.count;
        referrals.all += row.count;
    }
    const total = result?.total[0]?.count ?? 0;
    res.status(200).json({
        status: "success",
        data: {
            enrollments: (result?.rows ?? []).map(({ referrerUser, ...row }) => adminEnrollment(row, referrerUser?.[0] ?? null)),
            total,
            page,
            limit,
            pages: Math.max(1, Math.ceil(total / limit)),
            counts,
            referrals,
            registered: result?.registered[0]?.count ?? 0,
        },
    });
};
/** What starting this enrollment's reward from the Planbok balance would do, or why it cannot. */
export const getEnrollmentReward = async (req, res) => {
    const { id } = enrollmentParamSchema.parse(req.params);
    const { walletAddress, balance, accountName, amount, forwarded, oldPayoutSentAt } = await rewardFromBalancePreview(new Types.ObjectId(id));
    res.status(200).json({
        status: "success",
        data: { amount, forwarded, balance: balance / 100, accountName, walletAddress, oldPayoutSentAt },
    });
};
/** Takes ₦10,000 of the Planbok balance (₦9,985 to LambaCard, ₦15 Planbok's fee) and buys this realtor's tokens. */
export const sendEnrollmentReward = async (req, res) => {
    const { id } = enrollmentParamSchema.parse(req.params);
    const enrollment = await sendRewardFromBalance(new Types.ObjectId(id));
    res.status(200).json({
        status: "success",
        data: { enrollment: enrollment && (await withReferrer(enrollment)) },
    });
};
//# sourceMappingURL=course.controller.js.map