import type { Request, Response } from "express";
import { Types, type PipelineStage } from "mongoose";

import AppError from "../error/app.error.js";
import User from "../models/user.model.js";
import { listRealtorsSchema, realtorIdSchema } from "../validators/realtor.validator.js";

/** What the public directory renders. No email or personal address, and no phone on a
 *  row: one profile hands those out (see getRealtor), a paged list never does. */
interface PublicRealtorRow {
  _id: Types.ObjectId;
  fullname: string;
  avatar: string;
  city: string;
  state: string;
  agencyName: string;
  jobTitle: string;
  experience: string;
  region: string;
  bio: string;
  specialization: string[];
  certified: boolean;
  identityVerified: boolean;
  createdAt: Date;
}

interface RealtorPage {
  rows: PublicRealtorRow[];
  total: { count: number }[];
  cities: { _id: string }[];
}

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const publicRealtor = (row: PublicRealtorRow) => ({
  id: row._id,
  fullname: row.fullname,
  avatar: row.avatar,
  city: row.city,
  state: row.state,
  agencyName: row.agencyName,
  jobTitle: row.jobTitle,
  experience: row.experience,
  region: row.region,
  bio: row.bio,
  specialization: row.specialization,
  certified: row.certified,
  identityVerified: row.identityVerified,
  createdAt: row.createdAt,
});

/**
 * Who the public may see, and what of them. Shared by the directory and by a single
 * profile so a realtor hidden from one cannot be reached through the other.
 */
const vettedStages: PipelineStage[] = [
  // Suspended accounts stay off the public site whatever their checks say.
  { $match: { role: "realtor", status: "active" } },
  {
    $lookup: { from: "profiles", localField: "_id", foreignField: "user", as: "profile" },
  },
  { $unwind: { path: "$profile", preserveNullAndEmptyArrays: true } },
  {
    $lookup: { from: "identities", localField: "_id", foreignField: "user", as: "identity" },
  },
  { $unwind: { path: "$identity", preserveNullAndEmptyArrays: true } },
  {
    $addFields: {
      city: { $ifNull: ["$profile.city", ""] },
      state: { $ifNull: ["$profile.state", ""] },
      agencyName: { $ifNull: ["$profile.agencyName", ""] },
      agencyAddress: { $ifNull: ["$profile.agencyAddress", ""] },
      jobTitle: { $ifNull: ["$profile.jobTitle", ""] },
      experience: { $ifNull: ["$profile.experience", ""] },
      region: { $ifNull: ["$profile.region", ""] },
      bio: { $ifNull: ["$profile.bio", ""] },
      specialization: { $ifNull: ["$profile.specialization", []] },
      availabilityStatus: { $ifNull: ["$profile.availabilityStatus", ""] },
      contactMeans: { $ifNull: ["$profile.contactMeans", ""] },
      // Read here so one profile can hand them out, but deliberately not projected
      // into the directory rows: a paged list of every number is a harvest.
      phone: { $ifNull: ["$phone", ""] },
      whatsapp: { $ifNull: ["$profile.whatsapp", ""] },
      socials: { $ifNull: ["$profile.socials", {}] },
      certified: { $ifNull: ["$profile.certified", false] },
      identityVerified: { $ifNull: ["$identity.verified", false] },
    },
  },
  // The gate: a realtor earns a public profile by clearing either check.
  { $match: { $or: [{ certified: true }, { identityVerified: true }] } },
];

const SORTS: Record<string, Record<string, 1 | -1>> = {
  // Certification outranks identity: it is the harder thing to earn.
  recommended: { certified: -1, identityVerified: -1, createdAt: -1, _id: -1 },
  newest: { createdAt: -1, _id: -1 },
  name: { fullname: 1, _id: 1 },
};

export const listRealtors = async (req: Request, res: Response): Promise<void> => {
  const { q, city, sort, page, limit } = listRealtorsSchema.parse(req.query);

  const pipeline: PipelineStage[] = [...vettedStages];

  if (q) {
    const pattern = new RegExp(escapeRegex(q), "i");
    pipeline.push({
      $match: {
        $or: [
          { fullname: pattern },
          { agencyName: pattern },
          { city: pattern },
          { region: pattern },
        ],
      },
    });
  }

  // Repeated in both branches so the city list itself is not narrowed by the
  // city already chosen, which would empty the dropdown after one pick.
  const cityMatch: PipelineStage.FacetPipelineStage[] =
    city === "all" ? [] : [{ $match: { city } }];

  pipeline.push({
    $facet: {
      rows: [
        ...cityMatch,
        { $sort: SORTS[sort] ?? SORTS.recommended! },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $project: {
            fullname: 1,
            avatar: 1,
            city: 1,
            state: 1,
            agencyName: 1,
            jobTitle: 1,
            experience: 1,
            region: 1,
            bio: 1,
            specialization: 1,
            certified: 1,
            identityVerified: 1,
            createdAt: 1,
          },
        },
      ],
      total: [...cityMatch, { $count: "count" }],
      cities: [{ $match: { city: { $ne: "" } } }, { $group: { _id: "$city" } }, { $sort: { _id: 1 } }],
    },
  });

  const [result] = await User.aggregate<RealtorPage>(pipeline);

  const rows = result?.rows ?? [];
  const total = result?.total[0]?.count ?? 0;

  res.status(200).json({
    status: "success",
    data: {
      realtors: rows.map(publicRealtor),
      cities: (result?.cities ?? []).map((c) => c._id),
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
  });
};

interface RealtorProfileRow extends PublicRealtorRow {
  agencyAddress: string;
  availabilityStatus: string;
  contactMeans: string;
  phone: string;
  whatsapp: string;
  socials: { instagram: string; linkedin: string; facebook: string; x: string };
}

export const getRealtor = async (req: Request, res: Response): Promise<void> => {
  const { id } = realtorIdSchema.parse(req.params);

  const [realtor] = await User.aggregate<RealtorProfileRow>([
    { $match: { _id: new Types.ObjectId(id) } },
    ...vettedStages,
    {
      $project: {
        fullname: 1,
        avatar: 1,
        city: 1,
        state: 1,
        agencyName: 1,
        agencyAddress: 1,
        jobTitle: 1,
        experience: 1,
        region: 1,
        bio: 1,
        specialization: 1,
        availabilityStatus: 1,
        contactMeans: 1,
        phone: 1,
        whatsapp: 1,
        socials: 1,
        certified: 1,
        identityVerified: 1,
        createdAt: 1,
      },
    },
  ]);

  // A realtor who has cleared neither check is not merely hidden from the
  // directory: their profile does not exist publicly either.
  if (!realtor) throw new AppError("No realtor with that id.", 404);

  res.status(200).json({
    status: "success",
    data: {
      realtor: {
        ...publicRealtor(realtor),
        agencyAddress: realtor.agencyAddress,
        availabilityStatus: realtor.availabilityStatus,
        // A buyer gets to call or message directly. `contactMeans` says which channel
        // the realtor would rather hear on; it is a statement, not a gate.
        contactMeans: realtor.contactMeans,
        phone: realtor.phone,
        whatsapp: realtor.whatsapp,
        socials: realtor.socials,
      },
    },
  });
};
