import type { Request, Response } from "express";
import { Types, trusted, type PipelineStage } from "mongoose";

import AppError from "../error/app.error.js";
import Inspection, {
  ACTIVE_STATUSES,
  inspectionRecord,
  type InspectionDoc,
  type InspectionStatus,
  type Party,
} from "../models/inspection.model.js";
import Profile from "../models/profile.model.js";
import Property, {
  listingCard,
  type ListingStatus,
  type PropertyDoc,
  type VerificationStatus,
} from "../models/property.model.js";
import User, { personCard } from "../models/user.model.js";
import {
  sendInspectionCancelled,
  sendInspectionDecided,
  sendInspectionRequested,
  sendInspectionRescheduled,
  type InspectionBrief,
} from "../services/email.service.js";
import {
  inspectionIdSchema,
  listInspectionsSchema,
  type CreateInspectionInput,
  type DecisionInput,
  type InspectionSort,
  type ListInspectionsQuery,
  type RescheduleInput,
} from "../validators/inspection.validator.js";

const other = (side: Party): Party => (side === "seeker" ? "realtor" : "seeker");

const SORTS: Record<InspectionSort, Record<string, 1 | -1>> = {
  // The _id tiebreaker keeps a row from slipping between pages on equal slots, which
  // matters more here than elsewhere: half-hour slots collide constantly.
  soonest: { slot: 1, _id: 1 },
  latest: { slot: -1, _id: -1 },
};

const live = (status: InspectionStatus): boolean => ACTIVE_STATUSES.includes(status);

/**
 * A booking is not a hidden account, so refusing someone else's is a 403 rather than
 * the 404 the realtor directory uses. The same distinction findOwn draws on a thread
 * and findOwned on a listing: nothing about it is secret, it is just not yours.
 */
const findOwn = async (
  id: string,
  side: Party,
  userId: Types.ObjectId,
): Promise<InspectionDoc> => {
  const inspection = await Inspection.findById(id);

  if (!inspection) throw new AppError("No viewing with that id.", 404);
  if (!inspection[side].equals(userId))
    throw new AppError("This viewing is not yours.", 403);

  return inspection;
};

/**
 * The listing and the counterpart, for one booking. A booking whose listing or whose
 * counterpart account is gone answers 404, which is what the lists do too: they drop
 * it on an $unwind with no preserveNullAndEmptyArrays.
 */
const bookingContext = async (inspection: InspectionDoc, side: Party) => {
  const [property, person] = await Promise.all([
    Property.findById(inspection.property),
    User.findById(inspection[other(side)]),
  ]);

  if (!property || !person)
    throw new AppError("This viewing is no longer available.", 404);

  return { property, person };
};

/* ------------------------------------------------------------------ *
 * The two lists. One record with two views, so one pipeline with two ends:
 * `side` is both who is asking and the field to match them on.
 * ------------------------------------------------------------------ */

/** Which tab a booking falls under. Derived per request, never stored: it turns on
 *  the clock, so a stored copy would be wrong the moment the slot passed. */
type Bucket = "upcoming" | "past";

interface InspectionRow {
  _id: Types.ObjectId;
  slot: Date;
  status: InspectionStatus;
  createdAt: Date;
  propertyId: Types.ObjectId;
  slug: string;
  title: string;
  image: string;
  city: string;
  fullAddress: string;
  price: number;
  listingStatus: ListingStatus;
  // Named apart from the booking's own status, which the filter matches on.
  verificationStatus: VerificationStatus;
  personId: Types.ObjectId;
  personName: string;
  personAvatar: string;
  certified: boolean;
}

interface InspectionPage {
  rows: InspectionRow[];
  total: { count: number }[];
  counts: { _id: InspectionStatus; count: number }[];
  buckets: { _id: Bucket; count: number }[];
}

/** A row is a card: when, what and who. The buyer's note and the realtor's reply
 *  belong to the detail page, which is the one surface with room to read them. */
const rowBase = (row: InspectionRow) => ({
  id: row._id,
  slot: row.slot,
  status: row.status,
  createdAt: row.createdAt,
  property: {
    id: row.propertyId,
    slug: row.slug,
    title: row.title,
    image: row.image,
    city: row.city,
    fullAddress: row.fullAddress,
    price: row.price,
    listingStatus: row.listingStatus,
    status: row.verificationStatus,
  },
});

/** The buyer's view: the realtor showing it, carrying the seal the card renders. */
const inspectionRow = (row: InspectionRow) => ({
  ...rowBase(row),
  realtor: {
    id: row.personId,
    fullname: row.personName,
    avatar: row.personAvatar,
    certified: row.certified,
  },
});

/** The realtor's view: the buyer. No email and no phone, as on a lead. */
const diaryRow = (row: InspectionRow) => ({
  ...rowBase(row),
  seeker: {
    id: row.personId,
    fullname: row.personName,
    avatar: row.personAvatar,
  },
});

const loadInspections = async (
  side: Party,
  userId: Types.ObjectId,
  query: ListInspectionsQuery,
) => {
  const { window, status, sort, page, limit } = query;

  // One clock for the whole pipeline, so the bucket a row lands in and the counts
  // above it cannot disagree by a few milliseconds.
  const now = new Date();

  const pipeline: PipelineStage[] = [
    { $match: { [side]: userId } },
    {
      $lookup: {
        from: "properties",
        localField: "property",
        foreignField: "_id",
        as: "listing",
      },
    },
    // No preserve on either: a booking on a listing that was deleted, or with an
    // account that is gone, drops out rather than rendering half a row.
    { $unwind: "$listing" },
    {
      $lookup: {
        from: "users",
        localField: other(side),
        foreignField: "_id",
        as: "person",
      },
    },
    { $unwind: "$person" },
  ];

  // The seal is the buyer's view only: a buyer has no certification to show.
  if (side === "seeker")
    pipeline.push(
      {
        $lookup: {
          from: "profiles",
          localField: "realtor",
          foreignField: "user",
          as: "profile",
        },
      },
      // Profiles are created lazily, so an older realtor may not own one yet.
      { $unwind: { path: "$profile", preserveNullAndEmptyArrays: true } },
    );

  pipeline.push({
    $addFields: {
      // Upcoming is live-and-still-ahead; past is everything else, so the pair covers
      // every booking. Computed before the facet because a counting branch groups on it.
      bucket: {
        $cond: [
          { $and: [{ $in: ["$status", ACTIVE_STATUSES] }, { $gte: ["$slot", now] }] },
          "upcoming",
          "past",
        ],
      },
      propertyId: "$listing._id",
      slug: "$listing.slug",
      title: "$listing.title",
      image: { $ifNull: [{ $first: "$listing.images.url" }, ""] },
      city: { $ifNull: ["$listing.address.city", ""] },
      fullAddress: { $ifNull: ["$listing.address.fullAddress", ""] },
      price: { $ifNull: ["$listing.price", 0] },
      listingStatus: "$listing.listingStatus",
      verificationStatus: "$listing.verification.status",
      personId: "$person._id",
      personName: { $ifNull: ["$person.fullname", ""] },
      personAvatar: { $ifNull: ["$person.avatar", ""] },
      certified: { $ifNull: ["$profile.certified", false] },
    },
  });

  // In the branches that page, and deliberately not in the two counting branches:
  // choosing a tab cannot be allowed to zero the tab beside it.
  const scope: PipelineStage.FacetPipelineStage[] = [];

  if (window !== "all") scope.push({ $match: { bucket: window } });
  if (status !== "all") scope.push({ $match: { status } });

  pipeline.push({
    $facet: {
      rows: [
        ...scope,
        { $sort: SORTS[sort] },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $project: {
            slot: 1,
            status: 1,
            createdAt: 1,
            propertyId: 1,
            slug: 1,
            title: 1,
            image: 1,
            city: 1,
            fullAddress: 1,
            price: 1,
            listingStatus: 1,
            verificationStatus: 1,
            personId: 1,
            personName: 1,
            personAvatar: 1,
            certified: 1,
          },
        },
      ],
      total: [...scope, { $count: "count" }],
      counts: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
      buckets: [{ $group: { _id: "$bucket", count: { $sum: 1 } } }],
    },
  });

  const [result] = await Inspection.aggregate<InspectionPage>(pipeline);

  const total = result?.total[0]?.count ?? 0;
  const counts = {
    all: 0,
    upcoming: 0,
    past: 0,
    requested: 0,
    confirmed: 0,
    completed: 0,
    declined: 0,
    cancelled: 0,
  };

  for (const row of result?.counts ?? []) {
    counts[row._id] += row.count;
    counts.all += row.count;
  }

  // A second group over the same set, so the two tabs already sum to `all`.
  for (const row of result?.buckets ?? []) counts[row._id] += row.count;

  return {
    rows: result?.rows ?? [],
    counts,
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
};

/** What the notification says. The listing is read for it either way. */
const brief = (
  inspection: InspectionDoc,
  property: Pick<PropertyDoc, "ref" | "title">,
  person: string,
  message: string,
): InspectionBrief => ({
  id: String(inspection._id),
  ref: property.ref,
  property: property.title,
  person,
  slot: inspection.slot,
  message,
});

/* ------------------------------------------------------------------ *
 * The buyer's side.
 * ------------------------------------------------------------------ */

export const createInspection = async (req: Request, res: Response): Promise<void> => {
  const { property: propertyId, slot, note }: CreateInspectionInput = req.body;
  const seeker = req.user!;

  const property = await Property.findById(propertyId);

  if (!property) throw new AppError("No listing with that id.", 404);

  const owner = await User.findById(property.user);

  // The gate the marketplace applies, and the same 404: a suspended realtor's listings
  // are off the public site, so no viewing can be booked on one either. Verification
  // status is deliberately not a gate; a pending listing is public and can be visited.
  if (!owner || owner.status !== "active")
    throw new AppError("No listing with that id.", 404);

  // sanitizeFilter is on globally, so a deliberate operator has to be trusted().
  const existing = await Inspection.findOne({
    property: property._id,
    seeker: seeker._id,
    status: trusted({ $in: ACTIVE_STATUSES }),
  });

  // The partial unique index enforces this too, so a race answers 409 either way.
  // This is the copy that can say something useful about it.
  if (existing)
    throw new AppError(
      "You already have a viewing booked on this listing. Move that one rather than booking a second.",
      409,
    );

  const inspection = await Inspection.create({
    property: property._id,
    realtor: property.user,
    seeker: seeker._id,
    slot,
    note: note ?? "",
  });

  // The realtor is not sitting in their console, and a viewing nobody answers is a
  // buyer lost on the day they were ready to turn up.
  sendInspectionRequested(
    owner.email,
    brief(inspection, property, seeker.fullname, inspection.note),
  );

  res.status(201).json({
    status: "success",
    message: "Your viewing request is with the realtor.",
    data: { inspection: inspectionRecord(inspection) },
  });
};

export const listMyInspections = async (req: Request, res: Response): Promise<void> => {
  const query = listInspectionsSchema.parse(req.query);

  const { rows, ...page } = await loadInspections("seeker", req.user!._id, query);

  res.status(200).json({
    status: "success",
    data: { inspections: rows.map(inspectionRow), ...page },
  });
};

export const getMyInspection = async (req: Request, res: Response): Promise<void> => {
  const { id } = inspectionIdSchema.parse(req.params);

  const inspection = await findOwn(id, "seeker", req.user!._id);
  const { property, person } = await bookingContext(inspection, "seeker");
  const profile = await Profile.findOne({ user: person._id });

  res.status(200).json({
    status: "success",
    data: {
      inspection: inspectionRecord(inspection),
      property: listingCard(property),
      // The business fields the aside renders, mirroring the inquiry detail. Still no
      // email, phone or personal address: the thread stays the channel.
      realtor: {
        ...personCard(person),
        agencyName: profile?.agencyName ?? "",
        city: profile?.city ?? "",
        certified: profile?.certified ?? false,
      },
    },
  });
};

/**
 * Moving a booking sends it back to `requested`. A confirmed viewing is the realtor
 * having said they will be there at that time, so a new time is a new request: the
 * alternative is a diary entry they never agreed to.
 */
export const rescheduleInspection = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = inspectionIdSchema.parse(req.params);
  const { slot }: RescheduleInput = req.body;

  const inspection = await findOwn(id, "seeker", req.user!._id);

  if (!live(inspection.status))
    throw new AppError(`This viewing is already ${inspection.status}.`, 409);

  if (inspection.slot.getTime() === slot.getTime())
    throw new AppError("That is the time already booked.", 409);

  inspection.slot = slot;
  inspection.status = "requested";
  // The realtor's reply was about the old time, so it does not survive the move.
  inspection.response = "";
  inspection.decidedAt = undefined;

  await inspection.save({ validateModifiedOnly: true });

  const [property, realtor] = await Promise.all([
    Property.findById(inspection.property).select("ref title"),
    User.findById(inspection.realtor).select("email"),
  ]);

  if (property && realtor)
    sendInspectionRescheduled(
      realtor.email,
      brief(inspection, property, req.user!.fullname, ""),
    );

  res.status(200).json({
    status: "success",
    message: "Your new time is with the realtor.",
    data: { inspection: inspectionRecord(inspection) },
  });
};

/* ------------------------------------------------------------------ *
 * The realtor's side. The same records, read as their diary.
 * ------------------------------------------------------------------ */

export const listRealtorInspections = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const query = listInspectionsSchema.parse(req.query);

  const { rows, ...page } = await loadInspections("realtor", req.user!._id, query);

  res.status(200).json({
    status: "success",
    data: { inspections: rows.map(diaryRow), ...page },
  });
};

export const getRealtorInspection = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = inspectionIdSchema.parse(req.params);

  const inspection = await findOwn(id, "realtor", req.user!._id);
  const { property, person } = await bookingContext(inspection, "realtor");

  res.status(200).json({
    status: "success",
    data: {
      inspection: inspectionRecord(inspection),
      property: listingCard(property),
      seeker: personCard(person),
    },
  });
};

const DECIDED = {
  confirmed: "Viewing confirmed. The buyer has been told.",
  declined: "Viewing declined. The buyer has been told.",
  completed: "Marked as done.",
};

export const decideInspection = async (req: Request, res: Response): Promise<void> => {
  const { id } = inspectionIdSchema.parse(req.params);
  const { status, response }: DecisionInput = req.body;

  const inspection = await findOwn(id, "realtor", req.user!._id);

  if (status === "completed") {
    if (inspection.status !== "confirmed")
      throw new AppError("Only a confirmed viewing can be marked as done.", 409);

    // A viewing that has not happened cannot have gone ahead. Without this a realtor
    // could close out a booking the buyer is still expecting to attend.
    if (inspection.slot.getTime() > Date.now())
      throw new AppError("This viewing has not happened yet.", 422);
  } else if (inspection.status !== "requested") {
    throw new AppError(`This viewing is already ${inspection.status}.`, 409);
  }

  inspection.status = status;
  if (response !== undefined) inspection.response = response;
  inspection.decidedAt = new Date();

  await inspection.save({ validateModifiedOnly: true });

  const [property, seeker] = await Promise.all([
    Property.findById(inspection.property).select("ref title"),
    User.findById(inspection.seeker).select("email"),
  ]);

  if (property && seeker)
    sendInspectionDecided(
      seeker.email,
      brief(inspection, property, req.user!.fullname, inspection.response),
      status,
    );

  res.status(200).json({
    status: "success",
    message: DECIDED[status],
    data: { inspection: inspectionRecord(inspection) },
  });
};

/* ------------------------------------------------------------------ *
 * Both sides. Either party can call a viewing off, so this is one handler that
 * reads which end is asking off the record rather than off their role.
 * ------------------------------------------------------------------ */

export const cancelInspection = async (req: Request, res: Response): Promise<void> => {
  const { id } = inspectionIdSchema.parse(req.params);
  const user = req.user!;

  const inspection = await Inspection.findById(id);

  if (!inspection) throw new AppError("No viewing with that id.", 404);

  const fromSeeker = inspection.seeker.equals(user._id);

  if (!fromSeeker && !inspection.realtor.equals(user._id))
    throw new AppError("This viewing is not yours.", 403);

  if (!live(inspection.status))
    throw new AppError(`This viewing is already ${inspection.status}.`, 409);

  const side: Party = fromSeeker ? "seeker" : "realtor";

  inspection.status = "cancelled";
  inspection.cancelledBy = side;
  inspection.decidedAt = new Date();

  await inspection.save({ validateModifiedOnly: true });

  // Whoever did not call it off is the one who needs telling.
  const [property, counterpart] = await Promise.all([
    Property.findById(inspection.property).select("ref title"),
    User.findById(fromSeeker ? inspection.realtor : inspection.seeker).select("email"),
  ]);

  if (property && counterpart)
    sendInspectionCancelled(
      counterpart.email,
      brief(inspection, property, user.fullname, ""),
      side,
    );

  res.status(200).json({
    status: "success",
    message: "Viewing cancelled.",
    data: { inspection: inspectionRecord(inspection) },
  });
};
