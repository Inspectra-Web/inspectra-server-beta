import { Schema, model } from "mongoose";
export const COURSE_STATUSES = ["draft", "published"];
/** What the course costs until the admin says otherwise. Naira. */
export const DEFAULT_COURSE_PRICE = 10_000;
const text = () => ({ type: String, trim: true, default: "" });
const courseSchema = new Schema({
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
}, { timestamps: true });
/** What publishing needs. Saving a half-built draft is fine; showing one is not. */
export const missingForPublish = (course) => [
    ["title", course.title],
    ["subtitle", course.subtitle],
    ["description", course.description],
    ["cover image", course.cover],
    ["video", course.videoUrl],
]
    .filter(([, value]) => !value)
    .map(([label]) => label);
/** The sales page. No `videoUrl`: the video is what the payment buys. */
export const publicCourse = (course) => ({
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
export const fullCourse = (course) => ({
    ...publicCourse(course),
    videoUrl: course.videoUrl,
});
const Course = model("Course", courseSchema);
export default Course;
//# sourceMappingURL=course.model.js.map