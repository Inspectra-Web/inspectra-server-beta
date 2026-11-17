import { trusted } from "mongoose";
import AppError from "../error/app.error.js";
import Course, { MAX_LESSONS, adminCourse, lessonOutline, missingForPublish, publicCourse, } from "../models/course.model.js";
import Enrollment, { adminEnrollment, learnerEnrollment, } from "../models/enrollment.model.js";
import User from "../models/user.model.js";
import { createAccount } from "./auth.controller.js";
import { accessFor, courseLink, creditEnrollment, enrollmentByAccess, enrollmentByInvite, enrollmentFor, lessonUnlocked, openDashboard, theCourse, watchLesson, } from "../services/course.service.js";
import { sendCourseAccess, sendVerifyEmail } from "../services/email.service.js";
import { createCheckout, verifyTransaction } from "../services/flutterwave.service.js";
import { courseAssetId, destroyAsset, uploadCourseCover, uploadCourseVideo, } from "../services/upload.service.js";
import { accessSchema, enrollmentReferenceSchema, inviteSchema, learnerLessonSchema, lessonParamSchema, listEnrollmentsSchema, saveCourseSchema, saveLessonSchema, } from "../validators/course.validator.js";
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
    // Any realtor may buy it: one waiting on payment, or one whose dashboard was open before
    // the course existed.
    if (user.role !== "realtor")
        throw new AppError("The realtor course opens realtor accounts. Use a different email.", 403);
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
 * The course as this learner may see it: every lesson's outline, whether it is watched and
 * open, and a video link only for the open ones. A locked lesson's video stays on the
 * server, so the order is not the player's word alone.
 */
const learnerCourse = (course, enrollment) => {
    const watched = new Set(enrollment.watchedLessons.map(String));
    return {
        ...publicCourse(course),
        lessons: course.lessons.map((lesson, i) => {
            const unlocked = lessonUnlocked(course, enrollment, i);
            return {
                ...lessonOutline(lesson),
                watched: enrollment.status === "completed" || watched.has(String(lesson._id)),
                unlocked,
                videoUrl: unlocked ? lesson.videoUrl : "",
            };
        }),
    };
};
export const getLearnerCourse = async (req, res) => {
    const { access } = accessSchema.parse(req.params);
    const enrollment = await enrollmentByAccess(access);
    const course = await theCourse();
    res.status(200).json({
        status: "success",
        data: { course: learnerCourse(course, enrollment), enrollment: learnerEnrollment(enrollment) },
    });
};
/**
 * A lesson ended. Answers with the course as it now stands, so the next lesson's video
 * arrives with the news that it is open. `invite` is null unless an old guest row has just
 * completed.
 */
export const finishLesson = async (req, res) => {
    const { access, lessonId } = learnerLessonSchema.parse(req.params);
    const enrollment = await enrollmentByAccess(access);
    const course = await theCourse();
    const { enrollment: updated, invite } = await watchLesson(course, enrollment, lessonId);
    res.status(200).json({
        status: "success",
        data: {
            invite,
            course: learnerCourse(course, updated),
            enrollment: learnerEnrollment(updated),
        },
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
    res.status(200).json({ status: "success", data: { course: adminCourse(course) } });
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
    res.status(200).json({ status: "success", data: { course: adminCourse(course) } });
};
/* Lessons ----------------------------------------------------------------------- */
/** The new video file on a lesson save, checked for type. */
const lessonVideoFile = (req) => {
    const file = req.files?.lessonVideo?.[0];
    if (file && !file.mimetype.startsWith("video/"))
        throw new AppError("Upload a video file.", 400);
    return file;
};
const findLesson = (course, lessonId) => {
    const lesson = course.lessons.find((l) => String(l._id) === lessonId);
    if (!lesson)
        throw new AppError("That lesson is not in this course.", 404);
    return lesson;
};
/**
 * Writes a lesson's details and any new video, then saves the course. The same discipline
 * as the cover: a video uploaded here is deleted if the save fails, and a replaced one is
 * deleted once it succeeds.
 */
const writeLesson = async (course, lesson, body, videoFile) => {
    const before = {
        video: lesson.videoUrl,
        videoId: lesson.videoPublicId || courseAssetId(lesson.videoUrl),
    };
    let uploadedId = "";
    try {
        Object.assign(lesson, body, {
            videoPublicId: body.videoUrl === before.video ? before.videoId : "",
        });
        if (videoFile) {
            const file = await uploadCourseVideo(videoFile.buffer);
            uploadedId = file.publicId;
            lesson.videoUrl = file.url;
            lesson.videoPublicId = file.publicId;
        }
        assertPublishable(course);
        await course.save();
    }
    catch (error) {
        await destroyAsset(uploadedId, "video");
        throw error;
    }
    if (lesson.videoUrl !== before.video && before.videoId)
        await destroyAsset(before.videoId, "video");
};
/** Multipart: the lesson as JSON in `lesson`, plus an optional `lessonVideo`. */
export const addLesson = async (req, res) => {
    const body = readJsonField(req, "lesson", (value) => saveLessonSchema.parse(value));
    const videoFile = lessonVideoFile(req);
    const course = await theCourse();
    if (course.lessons.length >= MAX_LESSONS)
        throw new AppError(`A course holds at most ${MAX_LESSONS} lessons.`, 400);
    course.lessons.push({});
    const lesson = course.lessons.at(-1);
    if (!lesson)
        throw new AppError("The lesson could not be added.", 500);
    await writeLesson(course, lesson, body, videoFile);
    res.status(201).json({ status: "success", data: { course: adminCourse(course) } });
};
export const updateLesson = async (req, res) => {
    const { lessonId } = lessonParamSchema.parse(req.params);
    const body = readJsonField(req, "lesson", (value) => saveLessonSchema.parse(value));
    const videoFile = lessonVideoFile(req);
    const course = await theCourse();
    await writeLesson(course, findLesson(course, lessonId), body, videoFile);
    res.status(200).json({ status: "success", data: { course: adminCourse(course) } });
};
/** Removes a lesson and its uploaded video. A published course keeps at least one. */
export const deleteLesson = async (req, res) => {
    const { lessonId } = lessonParamSchema.parse(req.params);
    const course = await theCourse();
    const lesson = findLesson(course, lessonId);
    const videoId = lesson.videoPublicId || courseAssetId(lesson.videoUrl);
    course.lessons.pull(lesson._id);
    assertPublishable(course);
    await course.save();
    await destroyAsset(videoId, "video");
    res.status(200).json({ status: "success", data: { course: adminCourse(course) } });
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
    res.status(200).json({ status: "success", data: { course: adminCourse(course) } });
};
export const setCourseStatus = async (req, res) => {
    const { status } = req.body;
    const course = await theCourse();
    const missing = missingForPublish(course);
    if (status === "published" && missing.length)
        throw new AppError(`Add a ${missing.join(", ")} before publishing.`, 400);
    course.status = status;
    await course.save();
    res.status(200).json({ status: "success", data: { course: adminCourse(course) } });
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