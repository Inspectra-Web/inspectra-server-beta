import { Schema, model } from "mongoose";
export const COURSE_STATUSES = ["draft", "published"];
/** What the course costs until the admin says otherwise. Naira. */
export const DEFAULT_COURSE_PRICE = 10_000;
/** Enough for a few masterclasses and the platform video, with room to grow. */
export const MAX_LESSONS = 12;
const text = () => ({ type: String, trim: true, default: "" });
// Like the course, a lesson saves half-built and is checked for completeness at publish.
const lessonSchema = new Schema({
    title: text(),
    summary: text(),
    videoUrl: text(),
    videoPublicId: text(),
    minutes: { type: Number, min: [0, "Length cannot be negative"], default: 0 },
});
const courseSchema = new Schema({
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
            (lessons) => lessons.length <= MAX_LESSONS,
            `A course holds at most ${MAX_LESSONS} lessons`,
        ],
    },
}, { timestamps: true });
/** What publishing needs. Saving a half-built draft is fine; showing one is not. */
export const missingForPublish = (course) => {
    const fields = [
        ["title", course.title],
        ["subtitle", course.subtitle],
        ["description", course.description],
        ["cover image", course.cover],
    ];
    const missing = fields.filter(([, value]) => !value).map(([label]) => label);
    if (course.lessons.length === 0)
        missing.push("lesson");
    course.lessons.forEach((lesson, i) => {
        if (!lesson.title)
            missing.push(`title on lesson ${i + 1}`);
        if (!lesson.videoUrl)
            missing.push(`video on lesson ${i + 1}`);
    });
    return missing;
};
/** The whole course's length, for the sales page. */
export const courseMinutes = (course) => course.lessons.reduce((sum, lesson) => sum + lesson.minutes, 0);
/** A lesson as a visitor sees it: what it is, never the video. */
export const lessonOutline = (lesson) => ({
    id: lesson._id,
    title: lesson.title,
    summary: lesson.summary,
    minutes: lesson.minutes,
});
/** The sales page. No video links: the videos are what the payment buys. */
export const publicCourse = (course) => ({
    id: course._id,
    title: course.title,
    subtitle: course.subtitle,
    description: course.description,
    cover: course.cover,
    minutes: courseMinutes(course),
    price: course.price,
    status: course.status,
    updatedAt: course.updatedAt,
    lessons: course.lessons.map(lessonOutline),
});
/** The admin: every lesson with its video. */
export const adminCourse = (course) => ({
    ...publicCourse(course),
    lessons: course.lessons.map((lesson) => ({ ...lessonOutline(lesson), videoUrl: lesson.videoUrl })),
});
const Course = model("Course", courseSchema);
export default Course;
//# sourceMappingURL=course.model.js.map