import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Types, trusted } from "mongoose";
import AppError from "../error/app.error.js";
import Identity from "../models/identity.model.js";
import Profile from "../models/profile.model.js";
import Property, { detailedProperty, publicProperty, } from "../models/property.model.js";
import PropertyView from "../models/propertyView.model.js";
import User from "../models/user.model.js";
import { sendListingSubmitted, sendListingUpdated, } from "../services/email.service.js";
import { ensureProfile, listingEligibility } from "../services/profile.service.js";
import { destroyAsset, isPdf, uploadDocument, uploadPhoto, } from "../services/upload.service.js";
import { listPropertiesSchema, documentIdSchema, propertyIdSchema, propertySlugSchema, typeFitsCategory, } from "../validators/property.validator.js";
const IMAGES_MAX = 20;
const DOCUMENTS_MAX = 5;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SORTS = {
    // Descending on the status string reads verified, pending, disputed: the trust
    // order already, so no computed rank field is needed.
    recommended: { "verification.status": -1, createdAt: -1, _id: -1 },
    newest: { createdAt: -1, _id: -1 },
    "price-asc": { price: 1, _id: 1 },
    "price-desc": { price: -1, _id: -1 },
    views: { views: -1, createdAt: -1, _id: -1 },
};
/**
 * Everything except the verification status, which is applied separately so the
 * segmented control's counts are not narrowed by the segment already chosen.
 * `trusted()` on every deliberate operator: db.config sets sanitizeFilter globally.
 */
const buildFilter = (query, base) => {
    const filter = { ...base };
    if (query.q) {
        const pattern = new RegExp(escapeRegex(query.q), "i");
        filter.$or = [
            { title: pattern },
            { ref: pattern },
            { "address.fullAddress": pattern },
            { "address.city": pattern },
        ];
    }
    // An explicit set of listings, for the saved shortlist. An empty array would match
    // nothing, which is right: a reader with an empty shortlist has no cards.
    if (query.ids)
        filter._id = trusted({ $in: query.ids.map((id) => new Types.ObjectId(id)) });
    if (query.city !== "all")
        filter["address.city"] = query.city;
    if (query.listingStatus !== "all")
        filter.listingStatus = query.listingStatus;
    if (query.type !== "all")
        filter.type = query.type;
    if (query.category !== "all")
        filter.category = query.category;
    if (query.beds)
        filter["features.bedrooms"] = trusted({ $gte: query.beds });
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
        const range = {};
        if (query.minPrice !== undefined)
            range.$gte = query.minPrice;
        if (query.maxPrice !== undefined)
            range.$lte = query.maxPrice;
        filter.price = trusted(range);
    }
    return filter;
};
/**
 * The realtor's portfolio in one round trip: the counts behind the All / Verified /
 * Pending / Disputed control, and the views total beside them. Views are summed here
 * rather than on the client because a page only ever holds `limit` rows, so a total
 * added up there would understate every portfolio past the first page.
 */
const portfolioTally = async (filter) => {
    const rows = await Property.aggregate([
        { $match: filter },
        {
            $group: {
                _id: "$verification.status",
                count: { $sum: 1 },
                views: { $sum: "$views" },
            },
        },
    ]);
    const counts = { all: 0, verified: 0, pending: 0, disputed: 0 };
    let views = 0;
    for (const row of rows) {
        counts[row._id] += row.count;
        counts.all += row.count;
        views += row.views;
    }
    return { counts, views };
};
/**
 * Count one person's interest in a listing, at most once, ever.
 *
 * `views` used to be incremented on every request to the public detail route, which
 * made it a hit counter: a refresh, a bot, a link preview and the realtor checking
 * their own page all scored. It now answers the question the number is read as, which
 * is how many people have looked.
 *
 * Three kinds of reader are deliberately not counted. An anonymous visitor, because
 * there is nothing to count them by that is not a guess (an IP is shared by an office
 * and changes on a phone). The owner, because a realtor refreshing their own listing
 * is not demand. An admin, because reviewing a listing is not shopping for it.
 *
 * Nothing here may fail the request: a view counter is not worth a 500 on a page the
 * whole internet is allowed to read, so every error is swallowed.
 */
const recordView = async (property, user) => {
    if (!user || user.role === "admin" || property.user.equals(user._id))
        return;
    try {
        // Upsert rather than find-then-create: the write is atomic, and `upsertedCount`
        // is what tells us this is the first time without a second round trip. The unique
        // index is what settles two tabs opening the listing at the same moment.
        const result = await PropertyView.updateOne({ property: property._id, user: user._id }, { $setOnInsert: { property: property._id, user: user._id } }, { upsert: true });
        if (result.upsertedCount)
            await Property.updateOne({ _id: property._id }, { $inc: { views: 1 } });
    }
    catch {
        // A duplicate key from a race, or the database having a bad moment. Either way
        // the reader still gets their listing.
    }
};
/**
 * A listing is publicly visible whatever its verification status, so refusing one
 * that belongs to someone else is a 403, not the 404 the realtor directory uses to
 * hide accounts that are not public at all.
 */
const findOwned = async (id, owner) => {
    const property = await Property.findById(id);
    if (!property)
        throw new AppError("No listing with that id.", 404);
    if (!property.user.equals(owner))
        throw new AppError("This listing is not yours.", 403);
    return property;
};
/**
 * A changed listing is no longer the listing that was checked, so the badge goes back
 * to pending rather than surviving a change to the asset behind it. Per-document
 * verdicts are left alone: those files did not change.
 */
const sendBackForReview = (property) => {
    if (property.verification.status === "pending")
        return false;
    property.verification.status = "pending";
    property.verification.note = "";
    property.verification.reviewedAt = undefined;
    property.verification.reviewedBy = undefined;
    return true;
};
/** What the admin's notification says about a listing. */
const listingBrief = (property, realtor) => ({
    id: String(property._id),
    ref: property.ref,
    title: property.title,
    city: property.address.city,
    state: property.address.state,
    realtor,
});
/* ------------------------------------------------------------------ *
 * The public marketplace. The only two handlers here that answer to nobody
 * signed in, which is why they are declared above the router's protect gate.
 * ------------------------------------------------------------------ */
/**
 * Who the public may see. A suspended realtor's listings come off the site with
 * them, and a listing whose account is gone drops out on the unwind. Shared by
 * the browse and by a single listing, so one hidden from the grid cannot be
 * reached by typing its URL: the failure vettedStages exists to prevent.
 *
 * Verification status is deliberately not a gate. A pending or disputed listing
 * stays public and says so, which is the whole point of the segmented control.
 */
const publicStages = [
    { $lookup: { from: "users", localField: "user", foreignField: "_id", as: "realtor" } },
    { $unwind: "$realtor" },
    { $match: { "realtor.status": "active" } },
    // Profiles are created lazily, so an older realtor may not own one yet.
    { $lookup: { from: "profiles", localField: "user", foreignField: "user", as: "profile" } },
    { $unwind: { path: "$profile", preserveNullAndEmptyArrays: true } },
];
const marketplaceRow = (row) => ({
    id: row._id,
    ref: row.ref,
    slug: row.slug,
    title: row.title,
    price: row.price,
    type: row.type,
    listingStatus: row.listingStatus,
    status: row.status,
    city: row.city,
    fullAddress: row.fullAddress,
    image: row.image,
    beds: row.beds,
    baths: row.baths,
    floorArea: row.floorArea,
    landSize: row.landSize,
    hasVideo: row.hasVideo,
    realtor: {
        id: row.realtorId,
        fullname: row.realtorName,
        avatar: row.realtorAvatar,
        certified: row.certified,
    },
    createdAt: row.createdAt,
});
export const listProperties = async (req, res) => {
    const query = listPropertiesSchema.parse(req.query);
    const { city, type, status, realtor, sort, page, limit } = query;
    // Applied here rather than inside buildFilter: that helper also builds a realtor's
    // own list from a { user } base, and a clause there would overwrite it.
    const owner = realtor ? { user: new Types.ObjectId(realtor) } : {};
    // City and type are neutralised here and applied in the facet branches instead:
    // a dropdown narrowed by its own pick empties itself after one choice.
    const pipeline = [
        { $match: { ...buildFilter({ ...query, city: "all", type: "all" }, {}), ...owner } },
        ...publicStages,
        {
            $addFields: {
                status: "$verification.status",
                city: { $ifNull: ["$address.city", ""] },
                fullAddress: { $ifNull: ["$address.fullAddress", ""] },
                image: { $ifNull: [{ $first: "$images.url" }, ""] },
                beds: { $ifNull: ["$features.bedrooms", 0] },
                baths: { $ifNull: ["$features.bathrooms", 0] },
                floorArea: { $ifNull: ["$features.floorArea", 0] },
                landSize: { $ifNull: ["$features.landSize", 0] },
                // Either an external tour or an uploaded clip counts as a video.
                hasVideo: {
                    $gt: [
                        {
                            $strLenCP: {
                                $concat: [
                                    { $ifNull: ["$videoUrl", ""] },
                                    { $ifNull: ["$video.url", ""] },
                                ],
                            },
                        },
                        0,
                    ],
                },
                realtorId: "$realtor._id",
                realtorName: { $ifNull: ["$realtor.fullname", ""] },
                realtorAvatar: { $ifNull: ["$realtor.avatar", ""] },
                certified: { $ifNull: ["$profile.certified", false] },
            },
        },
    ];
    const cityMatch = city === "all" ? [] : [{ $match: { city } }];
    const typeMatch = type === "all" ? [] : [{ $match: { type } }];
    // The status clause lives in the branches that page, and deliberately not in
    // counts: choosing one segment cannot be allowed to zero the other three.
    const statusMatch = status === "all" ? [] : [{ $match: { status } }];
    pipeline.push({
        $facet: {
            rows: [
                ...cityMatch,
                ...typeMatch,
                ...statusMatch,
                { $sort: SORTS[sort] },
                { $skip: (page - 1) * limit },
                { $limit: limit },
                {
                    $project: {
                        ref: 1,
                        slug: 1,
                        title: 1,
                        price: 1,
                        type: 1,
                        listingStatus: 1,
                        status: 1,
                        city: 1,
                        fullAddress: 1,
                        image: 1,
                        beds: 1,
                        baths: 1,
                        floorArea: 1,
                        landSize: 1,
                        hasVideo: 1,
                        realtorId: 1,
                        realtorName: 1,
                        realtorAvatar: 1,
                        certified: 1,
                        createdAt: 1,
                    },
                },
            ],
            total: [...cityMatch, ...typeMatch, ...statusMatch, { $count: "count" }],
            counts: [
                ...cityMatch,
                ...typeMatch,
                { $group: { _id: "$status", count: { $sum: 1 } } },
            ],
            // Neither branch takes any of the three: a filter must never narrow the
            // list of options it was itself chosen from.
            cities: [
                { $match: { city: { $ne: "" } } },
                { $group: { _id: "$city" } },
                { $sort: { _id: 1 } },
            ],
            types: [{ $group: { _id: "$type" } }, { $sort: { _id: 1 } }],
        },
    });
    const [result] = await Property.aggregate(pipeline);
    const rows = result?.rows ?? [];
    const total = result?.total[0]?.count ?? 0;
    const counts = { all: 0, verified: 0, pending: 0, disputed: 0 };
    for (const row of result?.counts ?? []) {
        counts[row._id] += row.count;
        counts.all += row.count;
    }
    res.status(200).json({
        status: "success",
        data: {
            listings: rows.map(marketplaceRow),
            counts,
            cities: (result?.cities ?? []).map((c) => c._id),
            types: (result?.types ?? []).map((t) => t._id),
            page,
            limit,
            total,
            pages: Math.max(1, Math.ceil(total / limit)),
        },
    });
};
export const getProperty = async (req, res) => {
    const { slug } = propertySlugSchema.parse(req.params);
    const property = await Property.findOne({ slug });
    if (!property)
        throw new AppError("No listing with that link.", 404);
    const [owner, profile, identity] = await Promise.all([
        User.findById(property.user),
        Profile.findOne({ user: property.user }),
        Identity.findOne({ user: property.user }),
    ]);
    // The same gate publicStages applies to the browse, and a 404 rather than the
    // 403 findOwned gives a realtor: what is hidden here is the account, not the
    // verification status, and a hidden account is not confirmed to exist.
    if (!owner || owner.status !== "active")
        throw new AppError("No listing with that link.", 404);
    await recordView(property, req.user);
    res.status(200).json({
        status: "success",
        data: {
            listing: publicProperty(property),
            // No email, phone or account status: the marketplace is not the console.
            realtor: {
                id: owner._id,
                fullname: owner.fullname,
                avatar: owner.avatar,
                agencyName: profile?.agencyName ?? "",
                city: profile?.city ?? "",
                certified: profile?.certified ?? false,
                identityVerified: identity?.verified ?? false,
            },
        },
    });
};
export const createProperty = async (req, res) => {
    const body = req.body;
    const user = req.user;
    // A listing carries its realtor to the buyer, so the person has to exist properly
    // before the property can. Checked here rather than on the photo and document
    // routes too: those need a listing that already cleared this.
    const [profile, identity] = await Promise.all([
        ensureProfile(user),
        Identity.findOne({ user: user._id }),
    ]);
    const { ready, missing } = listingEligibility(user, profile, identity);
    if (!ready) {
        const needs = missing.length > 1
            ? `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`
            : missing[0];
        throw new AppError(`You need ${needs} before you can list a property.`, 403);
    }
    const property = await Property.create({ ...body, user: user._id });
    sendListingSubmitted(listingBrief(property, user.fullname));
    res.status(201).json({
        status: "success",
        message: "Listing created. It is now waiting on verification.",
        data: { property: detailedProperty(property) },
    });
};
export const listMyProperties = async (req, res) => {
    const query = listPropertiesSchema.parse(req.query);
    const { status, sort, page, limit } = query;
    const base = buildFilter(query, { user: req.user._id });
    const filter = status === "all" ? base : { ...base, "verification.status": status };
    const [{ counts, views }, properties] = await Promise.all([
        portfolioTally(base),
        Property.find(filter)
            .sort(SORTS[sort])
            .skip((page - 1) * limit)
            .limit(limit),
    ]);
    const total = counts[status];
    // `views` sits beside `counts`, not inside it: it is one portfolio total, not a
    // fourth per-status tally, and ListingCounts is shared with two other endpoints
    // that send no such field.
    res.status(200).json({
        status: "success",
        data: {
            properties: properties.map(detailedProperty),
            counts,
            views,
            page,
            limit,
            total,
            pages: Math.max(1, Math.ceil(total / limit)),
        },
    });
};
export const getMyProperty = async (req, res) => {
    const { id } = propertyIdSchema.parse(req.params);
    const property = await findOwned(id, req.user._id);
    res.status(200).json({
        status: "success",
        data: { property: detailedProperty(property) },
    });
};
export const updateMyProperty = async (req, res) => {
    const { id } = propertyIdSchema.parse(req.params);
    const body = req.body;
    const property = await findOwned(id, req.user._id);
    const { features, fees, images, documents, ...rest } = body;
    Object.assign(property, rest);
    // Merged, not replaced: the form sends only the keys it has, and a land listing
    // sends almost none. Replacing would reset the rest to 0.
    if (features)
        Object.assign(property.features, features);
    if (fees)
        Object.assign(property.fees, fees);
    // Keep-lists: what the composer still wants. Whatever is missing is dropped here
    // and from Cloudinary, which is how a photo gets removed.
    // Cloudinary files a PDF as an image resource, like the photos, so one delete
    // path covers both.
    const dropped = [];
    if (images) {
        for (const image of property.images)
            if (!images.includes(image.url))
                dropped.push(image.publicId);
        property.images = property.images.filter((image) => images.includes(image.url));
    }
    if (documents) {
        for (const doc of property.documents)
            if (!documents.includes(String(doc._id)))
                dropped.push(doc.publicId);
        property.documents = property.documents.filter((doc) => documents.includes(String(doc._id)));
    }
    // The validator can only check the pair when a request carries both halves. Here
    // the stored half is known.
    if (!typeFitsCategory(property.category, property.type))
        throw new AppError(`A ${property.type} is not a ${property.category} property`, 422);
    // Read before sendBackForReview, which modifies the document itself. A listing
    // already pending is still an edit the admin should hear about; it just does not
    // pull a badge on the way.
    const changed = property.isModified();
    const recheck = changed && sendBackForReview(property);
    await property.save();
    if (changed)
        sendListingUpdated(listingBrief(property, req.user.fullname), recheck);
    // Only once the listing no longer points at them: a failed delete must not
    // leave the page showing a file that is already gone.
    await Promise.all(dropped.map((publicId) => destroyAsset(publicId)));
    res.status(200).json({
        status: "success",
        message: recheck
            ? "Listing updated. It goes back for verification."
            : "Listing updated.",
        data: { property: detailedProperty(property) },
    });
};
export const addPropertyPhotos = async (req, res) => {
    const { id } = propertyIdSchema.parse(req.params);
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length)
        throw new AppError("Choose at least one photo to upload.", 400);
    const property = await findOwned(id, req.user._id);
    const room = IMAGES_MAX - property.images.length;
    if (files.length > room)
        throw new AppError(room > 0
            ? `You can add ${room} more photo${room === 1 ? "" : "s"} to this listing.`
            : `This listing already has ${IMAGES_MAX} photos.`, 400);
    const uploaded = await Promise.all(files.map((file) => uploadPhoto(file.buffer)));
    property.images.push(...uploaded.map(({ url, publicId }) => ({ url, publicId })));
    // New photos change the asset behind the badge, so the same rule as an edit applies.
    const recheck = sendBackForReview(property);
    await property.save();
    // Only on a demotion, unlike an edit. Every listing is composed as a save and then
    // its uploads, so mailing each one would mean three emails for one new listing.
    if (recheck)
        sendListingUpdated(listingBrief(property, req.user.fullname), true);
    const added = `${uploaded.length} photo${uploaded.length === 1 ? "" : "s"} added.`;
    res.status(201).json({
        status: "success",
        message: recheck ? `${added} The listing goes back for verification.` : added,
        data: { property: detailedProperty(property) },
    });
};
export const addPropertyDocument = async (req, res) => {
    const { id } = propertyIdSchema.parse(req.params);
    const { name, notes, issuedDate } = req.body;
    if (!req.file)
        throw new AppError("Choose a document to upload.", 400);
    // The multer filter trusts the browser's mimetype. The header bytes are the real check.
    if (!isPdf(req.file.buffer))
        throw new AppError("That file is not a PDF. Save the document as a PDF and try again.", 400);
    const property = await findOwned(id, req.user._id);
    if (property.documents.length >= DOCUMENTS_MAX)
        throw new AppError(`A listing carries at most ${DOCUMENTS_MAX} documents.`, 400);
    const { url, publicId, bytes } = await uploadDocument(req.file.buffer);
    property.documents.push({
        name,
        notes,
        reason: "",
        fileUrl: url,
        publicId,
        status: "pending",
        ...(issuedDate ? { issuedDate } : {}),
        size: bytes,
    });
    const recheck = sendBackForReview(property);
    await property.save();
    // As with photos: the composer's own upload on a new listing is not news.
    if (recheck)
        sendListingUpdated(listingBrief(property, req.user.fullname), true);
    res.status(201).json({
        status: "success",
        message: recheck
            ? `${name} added. The listing goes back for verification.`
            : `${name} added. It goes to the verification team.`,
        data: { property: detailedProperty(property) },
    });
};
export const deleteMyProperty = async (req, res) => {
    const { id } = propertyIdSchema.parse(req.params);
    const property = await findOwned(id, req.user._id);
    await property.deleteOne();
    // After the row is gone: an orphaned file is a smaller problem than a listing
    // that refused to delete because Cloudinary was down.
    await Promise.all([
        ...property.images.map((image) => destroyAsset(image.publicId)),
        ...property.documents.map((doc) => destroyAsset(doc.publicId)),
        property.video.publicId ? destroyAsset(property.video.publicId) : Promise.resolve(),
    ]);
    res.status(200).json({
        status: "success",
        message: "Listing deleted.",
        data: { id: property._id },
    });
};
/**
 * The document itself, streamed rather than linked. The Cloudinary URL never reaches a
 * client, so this is the only way to read a title document, and it authorises the reader
 * first: the realtor who owns the listing, or an admin reviewing it.
 *
 * `inline` plus the PDF content type asks the browser to render it rather than save it.
 * That removes the download affordance, not the possibility: anything a browser can
 * display, a determined reader can capture.
 */
export const getPropertyDocument = async (req, res) => {
    const { id, docId } = documentIdSchema.parse(req.params);
    const property = await Property.findById(id);
    if (!property)
        throw new AppError("No listing with that id.", 404);
    const user = req.user;
    if (user.role !== "admin" && !property.user.equals(user._id))
        throw new AppError("This listing is not yours.", 403);
    const doc = property.documents.find((d) => String(d._id) === docId);
    if (!doc?.fileUrl)
        throw new AppError("That document is not on this listing.", 404);
    const upstream = await fetch(doc.fileUrl);
    if (!upstream.ok || !upstream.body)
        throw new AppError("Could not fetch the document. Please try again.", 502);
    // New documents are PDFs, but a listing may still carry a scan uploaded before that
    // rule. Serve what is actually stored, from a two-entry allowlist: with `nosniff` below
    // this is what stops anything else ever rendering inline on our own origin.
    const upstreamType = upstream.headers.get("content-type") ?? "";
    const type = upstreamType.startsWith("image/") ? upstreamType : "application/pdf";
    const extension = type === "application/pdf" ? "pdf" : type.slice("image/".length);
    res.setHeader("Content-Type", type);
    // The filename only ever shows if a reader saves it anyway; name it after the document.
    res.setHeader("Content-Disposition", `inline; filename="${doc.name.replace(/"/g, "")}.${extension}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    // A title document is private, so it must not sit in a shared or on-disk cache.
    res.setHeader("Cache-Control", "private, no-store");
    const length = upstream.headers.get("content-length");
    if (length)
        res.setHeader("Content-Length", length);
    await pipeline(Readable.fromWeb(upstream.body), res);
};
//# sourceMappingURL=property.controller.js.map