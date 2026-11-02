import { Schema, model, type HydratedDocument, type Types } from "mongoose";

/**
 * The realtor course: one paid teaser video a prospective realtor watches before they may
 * register. There is exactly one document, upserted on the admin's first read, so every
 * field defaults and completeness is checked at publish rather than on save.
 */

export type CourseStatus = "draft" | "published";
export const COURSE_STATUSES: CourseStatus[] = ["draft", "published"];

/** What the course costs until the admin says otherwise. Naira. */
export const DEFAULT_COURSE_PRICE = 10_000;

export interface ICourse {
  title: string;
  subtitle: string;
  description: string;
  cover: string;
  videoUrl: string;
  /** Length of the video, shown on the sales page. */
  minutes: number;
  /** Naira. Every enrollment is priced from this, never from a request. */
  price: number;
  status: CourseStatus;

  createdAt: Date;
  updatedAt: Date;
}

export type CourseDoc = HydratedDocument<ICourse>;

const text = () => ({ type: String, trim: true, default: "" });

const courseSchema = new Schema<ICourse>(
  {
    title: text(),
    subtitle: text(),
    description: text(),
    cover: text(),
    videoUrl: text(),
    minutes: { type: Number, min: [0, "Length cannot be negative"], default: 0 },
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
  },
  { timestamps: true },
);

/** What publishing needs. Saving a half-built draft is fine; showing one is not. */
export const missingForPublish = (course: ICourse): string[] =>
  (
    [
      ["title", course.title],
      ["subtitle", course.subtitle],
      ["description", course.description],
      ["cover image", course.cover],
      ["video", course.videoUrl],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([label]) => label);

type CourseRow = ICourse & { _id: Types.ObjectId };

/** The sales page. No `videoUrl`: the video is what the payment buys. */
export const publicCourse = (course: CourseRow) => ({
  id: course._id,
  title: course.title,
  subtitle: course.subtitle,
  description: course.description,
  cover: course.cover,
  minutes: course.minutes,
  price: course.price,
  status: course.status,
  updatedAt: course.updatedAt,
});

/** A paid learner, and the admin: everything, video included. */
export const fullCourse = (course: CourseRow) => ({
  ...publicCourse(course),
  videoUrl: course.videoUrl,
});

const Course = model<ICourse>("Course", courseSchema);

export default Course;
