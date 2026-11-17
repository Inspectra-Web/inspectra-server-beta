import { Schema, model, type HydratedDocument, type Types } from "mongoose";

/**
 * The realtor course: an ordered set of lessons a prospective realtor pays for once and
 * watches in turn, the last one opening their dashboard. There is exactly one document,
 * upserted on the admin's first read, so every field defaults and completeness is checked
 * at publish rather than on save.
 */

export type CourseStatus = "draft" | "published";
export const COURSE_STATUSES: CourseStatus[] = ["draft", "published"];

/** What the course costs until the admin says otherwise. Naira. */
export const DEFAULT_COURSE_PRICE = 10_000;

/** Enough for a few masterclasses and the platform video, with room to grow. */
export const MAX_LESSONS = 12;

/** One video in the course, listed in its stored order. Watching is not tracked. */
export interface ILesson {
  _id: Types.ObjectId;
  title: string;
  /** A line or two on what the lesson covers. */
  summary: string;
  /** The R2 object holding the video. Never sent out: realtors get an expiring link to it. */
  videoKey: string;
  /** An earlier video, uploaded to Cloudinary or linked, kept playing until replaced. */
  videoUrl: string;
  /** Cloudinary id of that earlier upload, so replacing it deletes it. Never sent out. */
  videoPublicId: string;
  /** An R2 upload in progress: where it is going and its multipart id. Never sent out. */
  pendingKey: string;
  pendingUploadId: string;
  minutes: number;
}

export interface ICourse {
  title: string;
  subtitle: string;
  description: string;
  cover: string;
  /** Cloudinary id of the uploaded cover, so a replaced one can be deleted. Never sent out. */
  coverPublicId: string;
  /** Naira. Every enrollment is priced from this, never from a request. */
  price: number;
  status: CourseStatus;
  lessons: Types.DocumentArray<ILesson>;

  createdAt: Date;
  updatedAt: Date;
}

export type CourseDoc = HydratedDocument<ICourse>;

const text = () => ({ type: String, trim: true, default: "" });

// Like the course, a lesson saves half-built and is checked for completeness at publish.
const lessonSchema = new Schema<ILesson>({
  title: text(),
  summary: text(),
  videoKey: text(),
  videoUrl: text(),
  videoPublicId: text(),
  pendingKey: text(),
  pendingUploadId: text(),
  minutes: { type: Number, min: [0, "Length cannot be negative"], default: 0 },
});

const courseSchema = new Schema<ICourse>(
  {
    title: text(),
    subtitle: text(),
    description: text(),
    cover: text(),
    coverPublicId: text(),
    price: {
      type: Number,
      min: [100, "The course costs at least ₦100"],
      default: DEFAULT_COURSE_PRICE,
    },
    status: {
      type: String,
      enum: { values: COURSE_STATUSES, message: "{VALUE} is not a valid course status" },
      default: "draft",
    },
    lessons: {
      type: [lessonSchema],
      default: [],
      validate: [
        (lessons: ILesson[]) => lessons.length <= MAX_LESSONS,
        `A course holds at most ${MAX_LESSONS} lessons`,
      ],
    },
  },
  { timestamps: true },
);

/** What publishing needs. Saving a half-built draft is fine; showing one is not. */
export const missingForPublish = (course: ICourse): string[] => {
  const fields: [string, string][] = [
    ["title", course.title],
    ["subtitle", course.subtitle],
    ["description", course.description],
    ["cover image", course.cover],
  ];
  const missing = fields.filter(([, value]) => !value).map(([label]) => label);

  const live = liveLessons(course);
  if (live.length === 0) missing.push("lesson with a video");

  live.forEach((lesson, i) => {
    if (!lesson.title) missing.push(`title on lesson ${i + 1}`);
  });

  return missing;
};

/** A lesson with a video to play. */
export const playable = (lesson: ILesson): boolean => !!(lesson.videoKey || lesson.videoUrl);

/**
 * The lessons realtors and the sales page see. One still waiting for its video is left
 * out, so a published course can take a new lesson before its upload has finished.
 */
export const liveLessons = (course: ICourse): ILesson[] => course.lessons.filter(playable);

/** The whole course's length, for the sales page. */
export const courseMinutes = (course: ICourse): number =>
  liveLessons(course).reduce((sum, lesson) => sum + lesson.minutes, 0);

type CourseRow = ICourse & { _id: Types.ObjectId };

/** A lesson as a visitor sees it: what it is, never the video. */
export const lessonOutline = (lesson: ILesson) => ({
  id: lesson._id,
  title: lesson.title,
  summary: lesson.summary,
  minutes: lesson.minutes,
});

/** The sales page. No video links: the videos are what the payment buys. */
export const publicCourse = (course: CourseRow) => ({
  id: course._id,
  title: course.title,
  subtitle: course.subtitle,
  description: course.description,
  cover: course.cover,
  minutes: courseMinutes(course),
  price: course.price,
  status: course.status,
  updatedAt: course.updatedAt,
  lessons: liveLessons(course).map(lessonOutline),
});

/**
 * The admin: every lesson, including one still waiting for its video, and whether each
 * has one. The controller adds the expiring link to play it, since that needs signing.
 */
export const adminCourse = (course: CourseRow) => ({
  ...publicCourse(course),
  lessons: course.lessons.map((lesson) => ({
    ...lessonOutline(lesson),
    hasVideo: playable(lesson),
    /** An uploaded file in R2. */
    stored: !!lesson.videoKey,
    /** The link the lesson plays from, for the editor; empty for an uploaded file. */
    link: lesson.videoUrl,
  })),
});

const Course = model<ICourse>("Course", courseSchema);

export default Course;
