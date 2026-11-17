import { Types, disconnect } from "mongoose";
import dbConfig from "../config/db.config.js";
import Course from "../models/course.model.js";
import Enrollment from "../models/enrollment.model.js";
/**
 * Moves the course's single video into its first lesson, so a course built before lessons
 * keeps playing, and drops the old single-video fields. Then marks that lesson watched for
 * everyone who already finished.
 *
 * Read and written on the raw collection: the old fields are no longer in the schema, so
 * Mongoose would hide them. Safe to run twice: a course that already has lessons only has
 * the old fields cleared, and `$addToSet` never adds the lesson twice.
 */
const LESSON_TITLE = "How INSPECTRA works and pays you";
const LEGACY = { videoUrl: "", videoPublicId: "", minutes: "" };
const migrateLessons = async () => {
    await dbConfig();
    const course = await Course.collection.findOne({});
    if (!course)
        console.log("No course yet. Nothing to move.");
    else if ((course.lessons?.length ?? 0) > 0 || !course.videoUrl) {
        await Course.collection.updateOne({ _id: course._id }, { $unset: LEGACY });
        console.log("No single video to move. Cleared any old video fields.");
    }
    else {
        const lessonId = new Types.ObjectId();
        await Course.collection.updateOne({ _id: course._id }, {
            $set: {
                lessons: [
                    {
                        _id: lessonId,
                        title: LESSON_TITLE,
                        summary: "",
                        videoUrl: course.videoUrl,
                        videoPublicId: course.videoPublicId ?? "",
                        minutes: course.minutes ?? 0,
                    },
                ],
            },
            $unset: LEGACY,
        });
        const watched = await Enrollment.updateMany({ status: "completed" }, { $addToSet: { watchedLessons: lessonId } }, { timestamps: false });
        console.log(`Moved the course video into lesson 1, "${LESSON_TITLE}".`);
        console.log(`Marked it watched on ${watched.modifiedCount} finished enrollment(s).`);
    }
    await disconnect();
    process.exit(0);
};
migrateLessons().catch(async (error) => {
    console.error("Lesson migration failed:", error);
    await disconnect();
    process.exit(1);
});
//# sourceMappingURL=lessons.script.js.map