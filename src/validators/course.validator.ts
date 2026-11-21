import { z } from "zod";

import { COURSE_STATUSES, MAX_LESSONS } from "../models/course.model.js";
import { MAX_VIDEO_BYTES } from "../services/r2.service.js";
import {
  ENROLLMENT_STATUSES,
  INCENTIVE_PAYOUT,
  type EnrollmentStatus,
} from "../models/enrollment.model.js";
import { email, password, passwordsMatch } from "./auth.validator.js";

const PAGE_SIZE = 10;
const PAGE_SIZE_MAX = 48;
const SEARCH_MAX = 80;
const TEXT_MAX = 2000;

// The raw secrets are 64 hex characters (randomBytes(32)).
const secret = (label: string) =>
  z.string().regex(/^[0-9a-f]{64}$/i, `That ${label} is not valid`);

/**
 * The checkout that opens the realtor account too. Strict, and carrying no amount: the
 * price is read off the course document, so the body has no way to name its own.
 */
export const joinCourseSchema = z
  .strictObject({
    fullname: z.string("Required").trim().min(3, "Enter your full name").max(120),
    email,
    phone: z.string("Required").trim().min(7, "Enter a valid phone number").max(20),
    password,
    confirmPassword: z.string("Required").min(1, "Confirm your password"),
  })
  .refine((v) => v.password === v.confirmPassword, passwordsMatch);

export type JoinCourseInput = z.infer<typeof joinCourseSchema>;

/** The transaction id on Flutterwave's redirect: a claim to check, not proof. */
export const verifyEnrollmentSchema = z.strictObject({
  transactionId: z.coerce
    .number("That is not a valid transaction id")
    .int()
    .positive("That is not a valid transaction id"),
});

export type VerifyEnrollmentInput = z.infer<typeof verifyEnrollmentSchema>;

const url = z.union([z.literal(""), z.url("Enter a full link starting with https://")]);

/**
 * The admin saving the course's own details. Status has its own write, and the lessons
 * have their own endpoints, so neither is here.
 */
export const saveCourseSchema = z.strictObject({
  title: z.string().trim().max(200),
  subtitle: z.string().trim().max(300),
  description: z.string().trim().max(TEXT_MAX),
  cover: url,
  // ₦10,000 of every payment funds the realtor's incentive, so the price must clear it.
  price: z
    .number()
    .int("Whole naira only")
    .gt(INCENTIVE_PAYOUT, "The course costs more than ₦10,000, which funds the realtor's incentive"),
});

export type SaveCourseInput = z.infer<typeof saveCourseSchema>;

const minutes = z.number().int("Whole minutes only").min(0).max(600);

/** A lesson's details. An uploaded video goes to R2 separately, through the upload routes. */
export const saveLessonSchema = z.strictObject({
  title: z.string().trim().max(200),
  summary: z.string().trim().max(500),
  /**
   * A link to play the lesson from instead of an uploaded file: YouTube, Vimeo, Google
   * Drive or a direct video file. Empty keeps an uploaded file. A link can be watched
   * outside INSPECTRA; an uploaded file cannot.
   */
  videoUrl: url,
  minutes,
});

export type SaveLessonInput = z.infer<typeof saveLessonSchema>;

const uploadId = z.string().trim().min(1, "Missing the upload id").max(1024);

/** Starting a lesson video upload. The size picks the number of parts; 5 GB at most. */
export const startLessonUploadSchema = z.strictObject({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().regex(/^video\/[\w.+-]+$/, "Upload a video file"),
  size: z
    .number()
    .int()
    .positive()
    .max(MAX_VIDEO_BYTES, "That video is over 5 GB. Compress it and upload it again."),
});

export type StartLessonUploadInput = z.infer<typeof startLessonUploadSchema>;

/** Up to 20 part addresses at a time. R2 numbers parts from 1 to 10,000. */
export const signLessonPartsSchema = z.strictObject({
  uploadId,
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(20),
});

export type SignLessonPartsInput = z.infer<typeof signLessonPartsSchema>;

/** Every part, with the ETag R2 answered its upload with, and the length read off the file. */
export const completeLessonUploadSchema = z.strictObject({
  uploadId,
  parts: z
    .array(z.strictObject({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(200) }))
    .min(1)
    .max(10_000),
  minutes: minutes.min(1, "At least 1 minute"),
});

export type CompleteLessonUploadInput = z.infer<typeof completeLessonUploadSchema>;

export const cancelLessonUploadSchema = z.strictObject({ uploadId });

export type CancelLessonUploadInput = z.infer<typeof cancelLessonUploadSchema>;

const objectId = (label: string) => z.string().regex(/^[0-9a-f]{24}$/i, `That ${label} is not valid`);

/** The new order, as every lesson id exactly once. The controller checks it is a permutation. */
export const lessonOrderSchema = z.strictObject({
  ids: z.array(objectId("lesson")).min(1).max(MAX_LESSONS),
});

export type LessonOrderInput = z.infer<typeof lessonOrderSchema>;

export const courseStatusSchema = z.strictObject({
  status: z.enum(COURSE_STATUSES, "Choose draft or published"),
});

export type CourseStatusInput = z.infer<typeof courseStatusSchema>;

/* Params and queries: z.object, parsed inline in the controller. ------------------ */

export const enrollmentReferenceSchema = z.object({
  reference: z.string().regex(/^INS-CRS-[0-9A-F]{8}$/i, "That is not a valid course reference"),
});

export const accessSchema = z.object({ access: secret("course link") });

export const lessonParamSchema = z.object({ lessonId: objectId("lesson") });

export const inviteSchema = z.object({ invite: secret("registration link") });

const STATUS_FILTERS: (EnrollmentStatus | "all")[] = ["all", ...ENROLLMENT_STATUSES];

export const listEnrollmentsSchema = z.object({
  q: z.string().trim().max(SEARCH_MAX, "Search is too long").default(""),
  status: z.enum(STATUS_FILTERS).default("all"),
  page: z.coerce.number().int().min(1, "Page starts at 1").default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_SIZE_MAX, `Ask for at most ${PAGE_SIZE_MAX} per page`)
    .default(PAGE_SIZE),
});

export type ListEnrollmentsQuery = z.infer<typeof listEnrollmentsSchema>;
