import AppError from "../error/app.error.js";
import Identity from "../models/identity.model.js";
import Profile, { publicProfile } from "../models/profile.model.js";
import Property from "../models/property.model.js";
import User, { publicUser } from "../models/user.model.js";
import { composeName, ensureProfile, listingEligibility, } from "../services/profile.service.js";
import { destroyAvatar, uploadAvatar } from "../services/upload.service.js";
import { REALTOR_FIELDS, SEEKER_FIELDS, savedListingSchema, } from "../validators/profile.validator.js";
const forbiddenFor = (role) => {
    if (role === "realtor")
        return SEEKER_FIELDS;
    if (role === "seeker")
        return REALTOR_FIELDS;
    return [...REALTOR_FIELDS, ...SEEKER_FIELDS];
};
/**
 * The account envelope. Only a realtor can list, so only a realtor is told whether
 * they may yet, and the console reads that rather than re-deriving the rule from the
 * fields it happens to render. The update emits it too: filling the profile in is the
 * moment the answer changes, so the reply carries the new one.
 */
const accountPayload = async (user, profile) => ({
    user: publicUser(user),
    profile: publicProfile(profile),
    listing: user.role === "realtor"
        ? listingEligibility(user, profile, await Identity.findOne({ user: user._id }))
        : undefined,
});
export const getMyProfile = async (req, res) => {
    const user = req.user;
    const profile = await ensureProfile(user);
    res.status(200).json({ status: "success", data: await accountPayload(user, profile) });
};
export const updateMyProfile = async (req, res) => {
    const body = req.body;
    const user = req.user;
    const offending = forbiddenFor(user.role).filter((field) => field in body);
    if (offending.length)
        throw new AppError(`These fields are not available on your account: ${offending.join(", ")}`, 403);
    const profile = await ensureProfile(user);
    const { phone, ...profileFields } = body;
    const updated = await Profile.findOneAndUpdate({ user: user._id }, profileFields, {
        returnDocument: "after",
        runValidators: true,
    });
    if (!updated)
        throw new AppError("Your profile could not be found.", 404);
    const userFields = {};
    if (phone !== undefined)
        userFields.phone = phone;
    if (["firstName", "middleName", "lastName"].some((part) => part in body))
        userFields.fullname = composeName({
            firstName: body.firstName ?? profile.firstName,
            middleName: body.middleName ?? profile.middleName,
            lastName: body.lastName ?? profile.lastName,
        });
    // Read back rather than assigning in memory: the schema lowercases fullname.
    const nextUser = Object.keys(userFields).length
        ? ((await User.findByIdAndUpdate(user._id, userFields, {
            returnDocument: "after",
            runValidators: true,
        })) ?? user)
        : user;
    res.status(200).json({
        status: "success",
        message: "Profile updated.",
        data: await accountPayload(nextUser, updated),
    });
};
export const updateMyAvatar = async (req, res) => {
    const user = req.user;
    if (!req.file)
        throw new AppError("Choose an image to upload.", 400);
    const { url, publicId } = await uploadAvatar(req.file.buffer);
    const replaced = user.avatarId;
    const updated = await User.findByIdAndUpdate(user._id, { avatar: url, avatarId: publicId }, { returnDocument: "after", runValidators: true });
    // Only once the new image is stored: a failed delete must not leave the
    // account pointing at nothing.
    if (replaced)
        await destroyAvatar(replaced);
    res.status(200).json({
        status: "success",
        message: "Photo updated.",
        data: { user: publicUser(updated ?? user) },
    });
};
export const deleteMyAvatar = async (req, res) => {
    const user = req.user;
    const replaced = user.avatarId;
    const updated = await User.findByIdAndUpdate(user._id, { avatar: "", avatarId: "" }, { returnDocument: "after", runValidators: true });
    if (replaced)
        await destroyAvatar(replaced);
    res.status(200).json({
        status: "success",
        message: "Photo removed.",
        data: { user: publicUser(updated ?? user) },
    });
};
/* ------------------------------------------------------------------ *
 * The shortlist. Ids only: the listings themselves come from the marketplace
 * browse, which already shapes a card and applies the public gate, so a saved
 * listing whose realtor was suspended drops out of the page without this
 * endpoint having to know anything about that.
 * ------------------------------------------------------------------ */
const savedIds = (profile) => profile.savedListings.map((id) => String(id));
export const listSaved = async (req, res) => {
    const profile = await ensureProfile(req.user);
    res.status(200).json({
        status: "success",
        data: { ids: savedIds(profile) },
    });
};
export const saveListing = async (req, res) => {
    const { id } = savedListingSchema.parse(req.params);
    const property = await Property.findById(id).select("_id");
    if (!property)
        throw new AppError("No listing with that id.", 404);
    const profile = await ensureProfile(req.user);
    // Saving twice is the same shortlist, so it answers 200 rather than a 409: a heart
    // clicked from two tabs is not an error the reader needs to hear about.
    if (!profile.savedListings.some((saved) => saved.equals(property._id))) {
        profile.savedListings.push(property._id);
        await profile.save({ validateModifiedOnly: true });
    }
    res.status(200).json({
        status: "success",
        message: "Saved.",
        data: { ids: savedIds(profile) },
    });
};
export const unsaveListing = async (req, res) => {
    const { id } = savedListingSchema.parse(req.params);
    const profile = await ensureProfile(req.user);
    const before = profile.savedListings.length;
    profile.savedListings = profile.savedListings.filter((saved) => String(saved) !== id);
    // No existence check on the listing: a saved property that was since deleted still
    // has to be removable, which a 404 here would prevent.
    if (profile.savedListings.length !== before)
        await profile.save({ validateModifiedOnly: true });
    res.status(200).json({
        status: "success",
        message: "Removed from saved.",
        data: { ids: savedIds(profile) },
    });
};
//# sourceMappingURL=profile.controller.js.map