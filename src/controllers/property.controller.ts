import type { Request, Response } from "express";
import { trusted, type QueryFilter, type Types } from "mongoose";

import AppError from "../error/app.error.js";
import Property, {
  detailedProperty,
  type IProperty,
  type PropertyDoc,
  type VerificationStatus,
} from "../models/property.model.js";
import { destroyAsset, uploadDocument, uploadPhoto } from "../services/upload.service.js";
import {
  addDocumentSchema,
  listPropertiesSchema,
  propertyIdSchema,
  typeFitsCategory,
  type AddDocumentInput,
  type CreatePropertyInput,
  type ListPropertiesQuery,
  type PropertySort,
  type UpdatePropertyInput,
} from "../validators/property.validator.js";

const IMAGES_MAX = 20;
const DOCUMENTS_MAX = 5;

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SORTS: Record<PropertySort, Record<string, 1 | -1>> = {
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
const buildFilter = (
  query: ListPropertiesQuery,
  base: QueryFilter<IProperty>,
): QueryFilter<IProperty> => {
  const filter: QueryFilter<IProperty> = { ...base };

  if (query.q) {
    const pattern = new RegExp(escapeRegex(query.q), "i");
    filter.$or = [
      { title: pattern },
      { ref: pattern },
      { "address.fullAddress": pattern },
      { "address.city": pattern },
    ];
  }

  if (query.city !== "all") filter["address.city"] = query.city;
  if (query.listingStatus !== "all") filter.listingStatus = query.listingStatus;
  if (query.type !== "all") filter.type = query.type;
  if (query.category !== "all") filter.category = query.category;
  if (query.beds) filter["features.bedrooms"] = trusted({ $gte: query.beds });

  if (query.minPrice !== undefined || query.maxPrice !== undefined) {
    const range: Record<string, number> = {};

    if (query.minPrice !== undefined) range.$gte = query.minPrice;
    if (query.maxPrice !== undefined) range.$lte = query.maxPrice;

    filter.price = trusted(range);
  }

  return filter;
};

interface StatusCount {
  _id: VerificationStatus;
  count: number;
}

/** Counts for the All / Verified / Pending / Disputed control, in one round trip. */
const countByStatus = async (filter: QueryFilter<IProperty>) => {
  const rows = await Property.aggregate<StatusCount>([
    { $match: filter },
    { $group: { _id: "$verification.status", count: { $sum: 1 } } },
  ]);

  const counts = { all: 0, verified: 0, pending: 0, disputed: 0 };

  for (const row of rows) {
    counts[row._id] += row.count;
    counts.all += row.count;
  }

  return counts;
};

/**
 * A listing is publicly visible whatever its verification status, so refusing one
 * that belongs to someone else is a 403, not the 404 the realtor directory uses to
 * hide accounts that are not public at all.
 */
const findOwned = async (id: string, owner: Types.ObjectId): Promise<PropertyDoc> => {
  const property = await Property.findById(id);

  if (!property) throw new AppError("No listing with that id.", 404);
  if (!property.user.equals(owner)) throw new AppError("This listing is not yours.", 403);

  return property;
};

export const createProperty = async (req: Request, res: Response): Promise<void> => {
  const body: CreatePropertyInput = req.body;

  const property = await Property.create({ ...body, user: req.user!._id });

  res.status(201).json({
    status: "success",
    message: "Listing created. It is now waiting on verification.",
    data: { property: detailedProperty(property) },
  });
};

export const listMyProperties = async (req: Request, res: Response): Promise<void> => {
  const query = listPropertiesSchema.parse(req.query);
  const { status, sort, page, limit } = query;

  const base = buildFilter(query, { user: req.user!._id });
  const filter =
    status === "all" ? base : { ...base, "verification.status": status };

  const [counts, properties] = await Promise.all([
    countByStatus(base),
    Property.find(filter)
      .sort(SORTS[sort])
      .skip((page - 1) * limit)
      .limit(limit),
  ]);

  const total = counts[status];

  res.status(200).json({
    status: "success",
    data: {
      properties: properties.map(detailedProperty),
      counts,
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
  });
};

export const getMyProperty = async (req: Request, res: Response): Promise<void> => {
  const { id } = propertyIdSchema.parse(req.params);

  const property = await findOwned(id, req.user!._id);

  res.status(200).json({
    status: "success",
    data: { property: detailedProperty(property) },
  });
};

export const updateMyProperty = async (req: Request, res: Response): Promise<void> => {
  const { id } = propertyIdSchema.parse(req.params);
  const body: UpdatePropertyInput = req.body;

  const property = await findOwned(id, req.user!._id);

  const { features, fees, images, documents, ...rest } = body;

  Object.assign(property, rest);
  // Merged, not replaced: the form sends only the keys it has, and a land listing
  // sends almost none. Replacing would reset the rest to 0.
  if (features) Object.assign(property.features, features);
  if (fees) Object.assign(property.fees, fees);

  // Keep-lists: what the composer still wants. Whatever is missing is dropped here
  // and from Cloudinary, which is how a photo gets removed.
  // Cloudinary files a PDF as an image resource, like the photos, so one delete
  // path covers both.
  const dropped: string[] = [];

  if (images) {
    for (const image of property.images)
      if (!images.includes(image.url)) dropped.push(image.publicId);

    property.images = property.images.filter((image) => images.includes(image.url));
  }

  if (documents) {
    for (const doc of property.documents)
      if (!documents.includes(doc.fileUrl)) dropped.push(doc.publicId);

    property.documents = property.documents.filter((doc) => documents.includes(doc.fileUrl));
  }

  // The validator can only check the pair when a request carries both halves. Here
  // the stored half is known.
  if (!typeFitsCategory(property.category, property.type))
    throw new AppError(
      `A ${property.type} is not a ${property.category} property`,
      422,
    );

  // An edited listing is no longer the listing that was checked, so the badge goes
  // back to pending rather than surviving a change to the asset behind it.
  const recheck = property.isModified() && property.verification.status !== "pending";

  if (recheck) {
    property.verification.status = "pending";
    property.verification.note = "";
    property.verification.reviewedAt = undefined;
    property.verification.reviewedBy = undefined;
  }

  await property.save();

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

export const addPropertyPhotos = async (req: Request, res: Response): Promise<void> => {
  const { id } = propertyIdSchema.parse(req.params);
  const files = Array.isArray(req.files) ? req.files : [];

  if (!files.length) throw new AppError("Choose at least one photo to upload.", 400);

  const property = await findOwned(id, req.user!._id);
  const room = IMAGES_MAX - property.images.length;

  if (files.length > room)
    throw new AppError(
      room > 0
        ? `You can add ${room} more photo${room === 1 ? "" : "s"} to this listing.`
        : `This listing already has ${IMAGES_MAX} photos.`,
      400,
    );

  const uploaded = await Promise.all(files.map((file) => uploadPhoto(file.buffer)));

  property.images.push(...uploaded.map(({ url, publicId }) => ({ url, publicId })));

  await property.save();

  res.status(201).json({
    status: "success",
    message: `${uploaded.length} photo${uploaded.length === 1 ? "" : "s"} added.`,
    data: { property: detailedProperty(property) },
  });
};

export const addPropertyDocument = async (req: Request, res: Response): Promise<void> => {
  const { id } = propertyIdSchema.parse(req.params);
  const { name, notes, issuedDate }: AddDocumentInput = req.body;

  if (!req.file) throw new AppError("Choose a document to upload.", 400);

  const property = await findOwned(id, req.user!._id);

  if (property.documents.length >= DOCUMENTS_MAX)
    throw new AppError(`A listing carries at most ${DOCUMENTS_MAX} documents.`, 400);

  const { url, publicId, bytes } = await uploadDocument(req.file.buffer);

  property.documents.push({
    name,
    notes,
    fileUrl: url,
    publicId,
    status: "pending",
    ...(issuedDate ? { issuedDate } : {}),
    size: bytes,
  });

  await property.save();

  res.status(201).json({
    status: "success",
    message: `${name} added. It goes to the verification team.`,
    data: { property: detailedProperty(property) },
  });
};

export const deleteMyProperty = async (req: Request, res: Response): Promise<void> => {
  const { id } = propertyIdSchema.parse(req.params);

  const property = await findOwned(id, req.user!._id);

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
