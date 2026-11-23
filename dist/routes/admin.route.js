import { Router } from "express";
import rateLimit from "express-rate-limit";
import { adminLogin, decideDisputeHandler, getDispute, getAdminSession, getUser, getListing, listListings, getPayment, getRealtorVirtualAccount, getRealtorWallet, getRealtorWalletBalances, getRequest, getRequestDemand, listDisputes, listPayments, listRealtors, listRequests, listUsers, listVirtualAccounts, listWallets, reviewListing, setRealtorSubscription, updateUserStatus, } from "../controllers/admin.controller.js";
import { addLesson, cancelLessonUpload, completeLessonUpload, deleteLesson, getAdminCourse, getEnrollmentReward, listEnrollments, sendEnrollmentReward, reorderLessons, saveCourse, setCourseStatus, signLessonParts, startLessonUpload, updateLesson, } from "../controllers/course.controller.js";
import AppError from "../error/app.error.js";
import { protect, restrictTo } from "../middlewares/auth.middleware.js";
import validate from "../middlewares/validate.middleware.js";
import { decideDisputeSchema, reviewListingSchema, userStatusSchema, } from "../validators/admin.validator.js";
import { loginSchema } from "../validators/auth.validator.js";
import { cancelLessonUploadSchema, completeLessonUploadSchema, courseStatusSchema, lessonOrderSchema, saveLessonSchema, signLessonPartsSchema, startLessonUploadSchema, } from "../validators/course.validator.js";
import { courseUpload } from "../services/upload.service.js";
import { setSubscriptionSchema } from "../validators/subscription.validator.js";
const tooManyAttempts = (_req, _res, next) => next(new AppError("Too many attempts. Please try again later.", 429));
const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: tooManyAttempts,
});
const router = Router();
router.post("/login", adminLimiter, validate(loginSchema), adminLogin);
router.get("/session", protect, restrictTo("admin"), getAdminSession);
router.get("/users", protect, restrictTo("admin"), listUsers);
router.get("/realtors", protect, restrictTo("admin"), listRealtors);
router.get("/listings", protect, restrictTo("admin"), listListings);
router.get("/payments", protect, restrictTo("admin"), listPayments);
router.get("/virtual-accounts", protect, restrictTo("admin"), listVirtualAccounts);
router.get("/wallets", protect, restrictTo("admin"), listWallets);
router.get("/requests", protect, restrictTo("admin"), listRequests);
router.get("/requests/demand", protect, restrictTo("admin"), getRequestDemand);
router.get("/requests/:id", protect, restrictTo("admin"), getRequest);
router.get("/disputes", protect, restrictTo("admin"), listDisputes);
router.get("/disputes/:id", protect, restrictTo("admin"), getDispute);
router.patch("/disputes/:id", protect, restrictTo("admin"), validate(decideDisputeSchema), decideDisputeHandler);
// Below the literal above, and keyed on the reference rather than an id: that is the
// string on the realtor's receipt and in Flutterwave.
router.get("/payments/:reference", protect, restrictTo("admin"), getPayment);
router.get("/listings/:id", protect, restrictTo("admin"), getListing);
router.get("/users/:id", protect, restrictTo("admin"), getUser);
router.get("/realtors/:id/virtual-account", protect, restrictTo("admin"), getRealtorVirtualAccount);
router.get("/realtors/:id/wallet", protect, restrictTo("admin"), getRealtorWallet);
router.get("/realtors/:id/wallet/balances", protect, restrictTo("admin"), getRealtorWalletBalances);
// The review lives here, not on the property router: that one is realtor-only, so an
// admin cannot reach any route on it.
router.patch("/listings/:id/verification", protect, restrictTo("admin"), validate(reviewListingSchema), reviewListing);
router.patch("/users/:id/status", protect, restrictTo("admin"), validate(userStatusSchema), updateUserStatus);
// Granting a plan lives here rather than on the subscription router, which answers to
// realtors only. Same reason the listing verdict sits on this one.
router.patch("/realtors/:id/subscription", protect, restrictTo("admin"), validate(setSubscriptionSchema), setRealtorSubscription);
// The realtor course. Literal paths, so they sit clear of every :id route above.
router.get("/course", protect, restrictTo("admin"), getAdminCourse);
// Multipart: the details as JSON in `course`, plus any new cover. Files reach Cloudinary
// only as part of a save, so an abandoned edit never leaves one behind.
router.put("/course", protect, restrictTo("admin"), courseUpload.fields([{ name: "courseCover", maxCount: 1 }]), saveCourse);
// Lessons: their details as JSON. A lesson's video goes from the browser straight to R2,
// through the upload routes below. `order` is declared before `:lessonId` so it is never
// read as an id.
router.post("/course/lessons", protect, restrictTo("admin"), validate(saveLessonSchema), addLesson);
router.put("/course/lessons/order", protect, restrictTo("admin"), validate(lessonOrderSchema), reorderLessons);
router.put("/course/lessons/:lessonId", protect, restrictTo("admin"), validate(saveLessonSchema), updateLesson);
router.delete("/course/lessons/:lessonId", protect, restrictTo("admin"), deleteLesson);
// A lesson video upload: start it, sign its parts in batches, then finish or cancel it.
const lessonUpload = "/course/lessons/:lessonId/upload";
router.post(lessonUpload, protect, restrictTo("admin"), validate(startLessonUploadSchema), startLessonUpload);
router.post(`${lessonUpload}/parts`, protect, restrictTo("admin"), validate(signLessonPartsSchema), signLessonParts);
router.post(`${lessonUpload}/complete`, protect, restrictTo("admin"), validate(completeLessonUploadSchema), completeLessonUpload);
router.post(`${lessonUpload}/cancel`, protect, restrictTo("admin"), validate(cancelLessonUploadSchema), cancelLessonUpload);
router.patch("/course/status", protect, restrictTo("admin"), validate(courseStatusSchema), setCourseStatus);
router.get("/course/enrollments", protect, restrictTo("admin"), listEnrollments);
// A reward for a course paid before rewards existed, from money already in our Planbok account.
router.get("/course/enrollments/:id/reward", protect, restrictTo("admin"), getEnrollmentReward);
router.post("/course/enrollments/:id/reward", protect, restrictTo("admin"), sendEnrollmentReward);
export default router;
//# sourceMappingURL=admin.route.js.map