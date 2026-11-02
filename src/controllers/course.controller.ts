import type { Request, Response } from "express";
import { trusted, type PipelineStage, type Types } from "mongoose";

import AppError from "../error/app.error.js";
import Course, { fullCourse, missingForPublish, publicCourse } from "../models/course.model.js";
import Enrollment, {
  adminEnrollment,
  learnerEnrollment,
  type EnrollmentStatus,
  type IEnrollment,
} from "../models/enrollment.model.js";
import {
  accessFor,
  courseLink,
  creditEnrollment,
  enrollmentByAccess,
  enrollmentByInvite,
  enrollmentFor,
  issueInvite,
  theCourse,
} from "../services/course.service.js";
import { sendCourseAccess } from "../services/email.service.js";
import { createCheckout, verifyTransaction } from "../services/flutterwave.service.js";
import { uploadCourseCover, uploadCourseVideo } from "../services/upload.service.js";
import {
  accessSchema,
  courseUploadSchema,
  enrollmentReferenceSchema,
  inviteSchema,
  listEnrollmentsSchema,
  type CourseStatusInput,
  type EnrollInput,
  type SaveCourseInput,
  type VerifyEnrollmentInput,
} from "../validators/course.validator.js";

/* Public ------------------------------------------------------------------------ */

/** The sales page: the published course without its video, or null while in draft. */
export const getCourse = async (_req: Request, res: Response): Promise<void> => {
  const course = await Course.findOne({ status: "published" });

  res.status(200).json({ status: "success", data: { course: course && publicCourse(course) } });
};

/**
 * A guest starting the checkout. Priced off the course, never the request. Someone who
 * already paid is not charged twice: their link is mailed again instead.
 */
export const enroll = async (req: Request, res: Response): Promise<void> => {
  const { fullname, email, phone }: EnrollInput = req.body;

  const course = await Course.findOne({ status: "published" });
  if (!course) throw new AppError("The realtor course is not open yet.", 409);

  const paid = await Enrollment.findOne({ email, status: trusted({ $in: ["paid", "completed"] }) });

  if (paid) {
    if (paid.registeredAt)
      throw new AppError("You have already registered as a realtor. Sign in instead.", 409);

    sendCourseAccess(paid.email, {
      name: paid.fullname,
      reference: paid.reference,
      amount: paid.amount,
      channel: paid.channel,
      url: courseLink(accessFor(paid._id)),
    });
    throw new AppError("You have already paid for the course. We have emailed your link again.", 409);
  }

  // One checkout per email: an attempt nobody completed is not a record of anything.
  await Enrollment.deleteMany({ email, status: "pending" });

  const enrollment = await Enrollment.create({ fullname, email, phone, amount: course.price });

  const link = await createCheckout({
    reference: enrollment.reference,
    amount: enrollment.amount,
    currency: enrollment.currency,
    customer: { email, name: fullname, phone },
    description: "INSPECTRA realtor course",
    returnPath: "/course/callback",
    meta: { reference: enrollment.reference, kind: "course", fullname, email, phone },
  });

  res.status(201).json({ status: "success", data: { link, reference: enrollment.reference } });
};

/**
 * Where Flutterwave sends the guest back to. The transaction is always read back from
 * Flutterwave, even when the webhook has already settled the row: a reference alone is
 * not proof of paying, and this answer carries the course link.
 */
export const verifyEnrollment = async (req: Request, res: Response): Promise<void> => {
  const { reference } = enrollmentReferenceSchema.parse(req.params);
  const { transactionId }: VerifyEnrollmentInput = req.body;

  const flw = await verifyTransaction(transactionId);

  if (flw.tx_ref !== reference)
    throw new AppError("That transaction belongs to a different payment.", 400);

  const enrollment = await enrollmentFor(flw);
  if (!enrollment) throw new AppError("No course payment with that reference.", 404);

  const settled =
    enrollment.status === "pending"
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

export const getLearnerCourse = async (req: Request, res: Response): Promise<void> => {
  const { access } = accessSchema.parse(req.params);

  const enrollment = await enrollmentByAccess(access);
  const course = await theCourse();

  res.status(200).json({
    status: "success",
    data: { course: fullCourse(course), enrollment: learnerEnrollment(enrollment) },
  });
};

/** The video ended. The server cannot see a video play; the no-skip rule is the player's. */
export const finishCourse = async (req: Request, res: Response): Promise<void> => {
  const { access } = accessSchema.parse(req.params);

  const enrollment = await enrollmentByAccess(access);
  const invite = await issueInvite(enrollment);

  res.status(200).json({
    status: "success",
    data: { invite, enrollment: learnerEnrollment(enrollment) },
  });
};

/** Who an invite belongs to, so sign-up can fill and lock their details. */
export const getInvite = async (req: Request, res: Response): Promise<void> => {
  const { invite } = inviteSchema.parse(req.params);

  const enrollment = await enrollmentByInvite(invite);

  res.status(200).json({
    status: "success",
    data: { invite: { fullname: enrollment.fullname, email: enrollment.email } },
  });
};

/* Admin ------------------------------------------------------------------------- */

export const getAdminCourse = async (_req: Request, res: Response): Promise<void> => {
  const course = await theCourse();

  res.status(200).json({ status: "success", data: { course: fullCourse(course) } });
};

/** Saved whole. A published course may not be saved into a state it could not publish in. */
export const saveCourse = async (req: Request, res: Response): Promise<void> => {
  const body: SaveCourseInput = req.body;

  const course = await theCourse();
  course.set(body);

  const missing = missingForPublish(course);
  if (course.status === "published" && missing.length)
    throw new AppError(`A published course needs a ${missing.join(", ")}.`, 400);

  await course.save();

  res.status(200).json({ status: "success", data: { course: fullCourse(course) } });
};

export const setCourseStatus = async (req: Request, res: Response): Promise<void> => {
  const { status }: CourseStatusInput = req.body;

  const course = await theCourse();

  const missing = missingForPublish(course);
  if (status === "published" && missing.length)
    throw new AppError(`Add a ${missing.join(", ")} before publishing.`, 400);

  course.status = status;
  await course.save();

  res.status(200).json({ status: "success", data: { course: fullCourse(course) } });
};

/** One file to Cloudinary, answered with its URL. The admin saves the URL with the course. */
export const uploadCourseAsset = async (req: Request, res: Response): Promise<void> => {
  const { kind } = courseUploadSchema.parse(req.query);
  const file = req.file;

  if (!file) throw new AppError("Choose a file to upload.", 400);

  const wanted = kind === "cover" ? "image/" : "video/";
  if (!file.mimetype.startsWith(wanted))
    throw new AppError(kind === "cover" ? "The cover must be an image." : "Upload a video file.", 400);

  const uploaded =
    kind === "cover" ? await uploadCourseCover(file.buffer) : await uploadCourseVideo(file.buffer);

  res.status(201).json({ status: "success", data: { url: uploaded.url } });
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface EnrollmentPage {
  rows: (IEnrollment & { _id: Types.ObjectId })[];
  total: { count: number }[];
  statuses: { _id: EnrollmentStatus; count: number }[];
  registered: { count: number }[];
}

/**
 * Everyone who started a checkout. The search narrows every branch; the status narrows
 * only `rows` and `total`, so the status counts never empty the control they sit on.
 */
export const listEnrollments = async (req: Request, res: Response): Promise<void> => {
  const { q, status, page, limit } = listEnrollmentsSchema.parse(req.query);

  const statusMatch: PipelineStage.FacetPipelineStage[] =
    status === "all" ? [] : [{ $match: { status } }];

  const pipeline: PipelineStage[] = [];

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
      registered: [{ $match: { registeredAt: { $exists: true } } }, { $count: "count" }],
    },
  });

  const [result] = await Enrollment.aggregate<EnrollmentPage>(pipeline);

  const counts: Record<EnrollmentStatus | "all", number> = { all: 0, pending: 0, paid: 0, completed: 0 };
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
