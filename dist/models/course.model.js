import { Schema, model } from "mongoose";
export const COURSE_STATUSES = ["draft", "published"];
/** What the course costs until the admin says otherwise. Naira. */
export const DEFAULT_COURSE_PRICE = 15_000;
/** Enough for a few masterclasses and the platform video, with room to grow. */
export const MAX_LESSONS = 12;
const text = () => ({ type: String, trim: true, default: "" });
// Like the course, a lesson saves half-built and is checked for completeness at publish.
const lessonSchema = new Schema({
    title: text(),
    summary: text(),
    videoKey: text(),
    videoUrl: text(),
    videoPublicId: text(),
    pendingKey: text(),
    pendingUploadId: text(),
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
    const live = liveLessons(course);
    if (live.length === 0)
        missing.push("lesson with a video");
    live.forEach((lesson, i) => {
        if (!lesson.title)
            missing.push(`title on lesson ${i + 1}`);
    });
    return missing;
};
/** A lesson with a video to play. */
export const playable = (lesson) => !!(lesson.videoKey || lesson.videoUrl);
/**
 * The lessons realtors and the sales page see. One still waiting for its video is left
 * out, so a published course can take a new lesson before its upload has finished.
 */
export const liveLessons = (course) => course.lessons.filter(playable);
/** The whole course's length, for the sales page. */
export const courseMinutes = (course) => liveLessons(course).reduce((sum, lesson) => sum + lesson.minutes, 0);
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
    lessons: liveLessons(course).map(lessonOutline),
});
/**
 * The admin: every lesson, including one still waiting for its video, and whether each
 * has one. The controller adds the expiring link to play it, since that needs signing.
 */
export const adminCourse = (course) => ({
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
const Course = model("Course", courseSchema);
export default Course;
//# sourceMappingURL=course.model.js.map