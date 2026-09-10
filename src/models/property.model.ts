import { Schema, model, type HydratedDocument, type Types } from "mongoose";

import {
  PROPERTY_CATEGORIES,
  PROPERTY_TYPES,
  type PropertyCategory,
  type PropertyType,
} from "../types/property.type.js";

const TITLE_MAX = 140;
const SLUG_MAX = 80;
const DESCRIPTION_MAX = 1200;
const TERMS_MAX = 300;
const IMAGES_MAX = 20;
const DOCUMENTS_MAX = 5;

/** What the listing is offered as, plus the terminal states it retires into. */
export type ListingStatus =
  | "sale"
  | "rent"
  | "lease"
  | "shortlet"
  | "sold"
  | "rented"
  | "leased";

/**
 * The trust axis, and the one the badge renders. Platform-owned: a realtor never
 * writes it. Distinct from `listingStatus`, which is the realtor's own.
 */
export type VerificationStatus = "pending" | "verified" | "disputed";

/** Per-document outcome, set by the admin reviewing the dossier. */
export type DocumentStatus = "pending" | "verified" | "flagged";

export type LegalDocumentName =
  | "Certificate of Occupancy (C of O)"
  | "Governor's Consent"
  | "Deed of Assignment"
  | "Deed of Conveyance"
  | "Deed of Lease / Sublease"
  | "Power of Attorney"
  | "Land Purchase Receipt"
  | "Registered Survey Plan"
  | "Excision / Gazette"
  | "Building Plan Approval"
  | "Environmental Impact Assessment (EIA)"
  | "Completion Certificate"
  | "Certificate of Habitability"
  | "Property Tax Clearance Certificate"
  | "Valuation Report"
  | "Tenancy Agreement"
  | "Lease Agreement"
  | "Inspection Report"
  | "Estate Allocation Letter"
  | "Agency Agreement"
  | "Government Allocation Letter"
  | "Affidavit of Ownership"
  | "Offer Letter / Acceptance Letter"
  | "Other";

// Exported so the schema's enum and the request validator read the same list.
export const LISTING_STATUSES: ListingStatus[] = [
  "sale",
  "rent",
  "lease",
  "shortlet",
  "sold",
  "rented",
  "leased",
];

export const VERIFICATION_STATUSES: VerificationStatus[] = [
  "pending",
  "verified",
  "disputed",
];

export const DOCUMENT_STATUSES: DocumentStatus[] = ["pending", "verified", "flagged"];

export const LEGAL_DOCUMENT_NAMES: LegalDocumentName[] = [
  "Certificate of Occupancy (C of O)",
  "Governor's Consent",
  "Deed of Assignment",
  "Deed of Conveyance",
  "Deed of Lease / Sublease",
  "Power of Attorney",
  "Land Purchase Receipt",
  "Registered Survey Plan",
  "Excision / Gazette",
  "Building Plan Approval",
  "Environmental Impact Assessment (EIA)",
  "Completion Certificate",
  "Certificate of Habitability",
  "Property Tax Clearance Certificate",
  "Valuation Report",
  "Tenancy Agreement",
  "Lease Agreement",
  "Inspection Report",
  "Estate Allocation Letter",
  "Agency Agreement",
  "Government Allocation Letter",
  "Affidavit of Ownership",
  "Offer Letter / Acceptance Letter",
  "Other",
];

/** An uploaded file: the URL to render it by and the Cloudinary id to delete it by. */
export interface PropertyMedia {
  url: string;
  publicId: string;
}

export interface LegalDocument {
  _id?: Types.ObjectId;
  name: LegalDocumentName;
  // The realtor's line about the document.
  notes: string;
  // The reviewer's line about why it was flagged. Never public.
  reason: string;
  fileUrl: string;
  publicId: string;
  status: DocumentStatus;
  issuedDate?: Date;
  size: number;
}

export interface AdditionalFee {
  name: string;
  amount: number;
  optional: boolean;
}

export interface IProperty {
  user: Types.ObjectId;
  ref: string;
  slug: string;

  title: string;
  description: string;
  price: number;
  type: PropertyType;
  category: PropertyCategory;
  listingStatus: ListingStatus;

  address: {
    fullAddress: string;
    city: string;
    state: string;
    country: string;
  };

  features: {
    bedrooms: number;
    bathrooms: number;
    toilets: number;
    garage: number;
    kitchen: number;
    floors: number;
    floorArea: number;
    landSize: number;
    yearBuilt: number;
  };

  amenities: string[];
  images: PropertyMedia[];
  videoUrl: string;
  video: PropertyMedia;
  documents: LegalDocument[];

  verification: {
    status: VerificationStatus;
    note: string;
    reviewedAt?: Date;
    reviewedBy?: Types.ObjectId;
  };

  fees: {
    paymentTerms: string;
    refundPolicy: string;
    additional: AdditionalFee[];
  };

  views: number;

  createdAt: Date;
  updatedAt: Date;
}

// `satisfies` keeps each message pair a tuple: Mongoose types these options as
// [value, message], and a plain array literal widens and stops type-checking.
const text = () => ({ type: String, trim: true, default: "" });
const count = () => ({
  type: Number,
  default: 0,
  min: [0, "Cannot be negative"] satisfies [number, string],
});

const required = (label: string) => ({
  type: String,
  trim: true,
  required: [true, `${label} is required`] satisfies [boolean, string],
});

// Files arrive as multipart and never pass through a request body schema, so the
// caps belong here rather than in a validator.
const capped = (max: number, message: string) => ({
  validator: (value: unknown[]) => value.length <= max,
  message,
});

const propertySchema = new Schema<IProperty>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "A listing must belong to a realtor"],
    },
    // Human-readable and searchable. Stamped from the id, so it is unique by
    // construction and never needs a retry on collision.
    ref: { type: String, trim: true, uppercase: true, unique: true },
    // The public URL for the listing. Stamped the same way, for the same reason.
    slug: { type: String, trim: true, lowercase: true, unique: true },

    title: {
      ...required("A title"),
      maxLength: [TITLE_MAX, `Keep the title under ${TITLE_MAX} characters`],
    },
    description: {
      ...required("A description"),
      maxLength: [DESCRIPTION_MAX, `Keep it under ${DESCRIPTION_MAX} characters`],
    },
    price: {
      type: Number,
      required: [true, "An asking price is required"],
      min: [0, "Price cannot be negative"],
    },
    type: {
      type: String,
      required: [true, "A property type is required"],
      enum: {
        values: PROPERTY_TYPES,
        message: "{VALUE} is not a valid property type",
      },
    },
    category: {
      type: String,
      required: [true, "A property category is required"],
      enum: {
        values: PROPERTY_CATEGORIES,
        message: "{VALUE} is not a valid property category",
      },
    },
    listingStatus: {
      type: String,
      required: [true, "A listing status is required"],
      enum: {
        values: LISTING_STATUSES,
        message: "{VALUE} is not a valid listing status",
      },
    },

    address: {
      fullAddress: required("The full address"),
      city: required("A city or LGA"),
      state: required("A state"),
      country: required("A country"),
    },

    // Zero reads as "not applicable" on the client, which is what land needs.
    features: {
      bedrooms: count(),
      bathrooms: count(),
      toilets: count(),
      garage: count(),
      kitchen: count(),
      floors: count(),
      floorArea: count(),
      landSize: count(),
      yearBuilt: count(),
    },

    // Free-form on purpose: the form offers a curated list, but rewording an
    // amenity there must not need a migration here.
    amenities: { type: [String], default: [] },

    images: {
      type: [{ url: text(), publicId: text() }],
      default: [],
      validate: capped(IMAGES_MAX, `Add at most ${IMAGES_MAX} photos`),
    },
    // An externally hosted tour, beside the one file we host ourselves.
    videoUrl: text(),
    video: {
      url: text(),
      publicId: text(),
    },

    documents: {
      type: [
        {
          name: {
            type: String,
            required: [true, "Say which document this is"],
            enum: {
              values: LEGAL_DOCUMENT_NAMES,
              message: "{VALUE} is not a document we accept",
            },
          },
          notes: text(),
          reason: text(),
          fileUrl: text(),
          publicId: text(),
          status: {
            type: String,
            enum: {
              values: DOCUMENT_STATUSES,
              message: "{VALUE} is not a valid document status",
            },
            default: "pending",
          },
          issuedDate: { type: Date },
          size: count(),
        },
      ],
      default: [],
      validate: capped(DOCUMENTS_MAX, `Attach at most ${DOCUMENTS_MAX} documents`),
    },

    verification: {
      status: {
        type: String,
        enum: {
          values: VERIFICATION_STATUSES,
          message: "{VALUE} is not a valid verification status",
        },
        default: "pending",
      },
      // Why it was disputed, or what the reviewer noted. Never public.
      note: text(),
      reviewedAt: { type: Date },
      reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    },

    // The transparency promise: every naira beyond the asking price, in writing.
    fees: {
      paymentTerms: {
        type: String,
        trim: true,
        maxLength: [TERMS_MAX, `Keep it under ${TERMS_MAX} characters`],
        default: "",
      },
      refundPolicy: {
        type: String,
        trim: true,
        maxLength: [TERMS_MAX, `Keep it under ${TERMS_MAX} characters`],
        default: "",
      },
      additional: {
        type: [
          {
            name: required("A fee name"),
            amount: {
              type: Number,
              required: [true, "A fee needs an amount"],
              min: [0, "Cannot be negative"],
            },
            optional: { type: Boolean, default: false },
          },
        ],
        default: [],
      },
    },

    views: count(),
  },
  { timestamps: true },
);

export type PropertyDoc = HydratedDocument<IProperty>;

// The two access paths: the marketplace browse, and a realtor's own listings.
propertySchema.index({ "verification.status": 1, listingStatus: 1, createdAt: -1 });
propertySchema.index({ user: 1, createdAt: -1 });

/**
 * The listing's public URL. The title carries it, so the link says what it points at,
 * but the last 8 hex of the id is appended for the same reason `ref` uses it: unique
 * by construction, with no retry loop and no race. Titles are nowhere near unique in
 * this market, and two realtors both posting "3 Bedroom Apartment In Lekki" must not
 * mean the second one cannot be saved at all.
 */
export const buildSlug = (title: string, id: string): string => {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, "");

  const suffix = id.slice(-8);

  return base ? `${base}-${suffix}` : suffix;
};

// Mongoose 9 passes no `next`: return to continue, throw to abort. `this` is
// annotated because the validate hook does not infer the document type.
propertySchema.pre("validate", function (this: PropertyDoc) {
  if (!this.ref) this.ref = `INS-${String(this._id).slice(-8).toUpperCase()}`;

  // Stamped once and never re-derived. A slug that moved with the title would break
  // every link already shared, and a listing's link outlives its wording.
  if (!this.slug && this.title) this.slug = buildSlug(this.title, String(this._id));
});

/**
 * The whole listing, for the two people entitled to see it: the realtor who owns it
 * and the admin reviewing it. Carries the reviewer's note, which `publicProperty`
 * below withholds. The reviewer's own id stays out of both.
 *
 * A document's `fileUrl` stays out too. A Cloudinary link is public and permanent to
 * anyone it reaches, so the file is served through `/properties/:id/documents/:docId/file`
 * instead, which authorises the reader and streams it inline. `id` is the handle for that.
 */
export const detailedProperty = (property: PropertyDoc) => ({
  id: property._id,
  ref: property.ref,
  slug: property.slug,
  title: property.title,
  description: property.description,
  price: property.price,
  type: property.type,
  category: property.category,
  listingStatus: property.listingStatus,
  address: property.address,
  features: property.features,
  amenities: property.amenities,
  images: property.images.map((image) => image.url),
  videoUrl: property.videoUrl,
  video: property.video.url,
  documents: property.documents.map((doc) => ({
    id: doc._id,
    name: doc.name,
    notes: doc.notes,
    reason: doc.reason,
    status: doc.status,
    issuedDate: doc.issuedDate,
    size: doc.size,
  })),
  verification: {
    status: property.verification.status,
    note: property.verification.note,
    reviewedAt: property.verification.reviewedAt,
  },
  fees: {
    paymentTerms: property.fees.paymentTerms,
    refundPolicy: property.fees.refundPolicy,
    additional: property.fees.additional.map((fee) => ({
      name: fee.name,
      amount: fee.amount,
      optional: fee.optional,
    })),
  },
  views: property.views,
  createdAt: property.createdAt,
  updatedAt: property.updatedAt,
});

/** Response allowlist: the schema has no toJSON transform, so shape it here.
 *  Documents are reduced to the fact of a check: the files themselves stay private,
 *  the way a realtor's identity number does. `status` is the verification axis the
 *  badge renders; the realtor's own state is `listingStatus`. */
export const publicProperty = (property: PropertyDoc) => ({
  id: property._id,
  ref: property.ref,
  slug: property.slug,
  realtor: property.user,
  title: property.title,
  description: property.description,
  price: property.price,
  type: property.type,
  category: property.category,
  listingStatus: property.listingStatus,
  address: property.address,
  features: property.features,
  amenities: property.amenities,
  images: property.images.map((image) => image.url),
  videoUrl: property.videoUrl,
  video: property.video.url,
  documents: property.documents.map((doc) => ({ name: doc.name, status: doc.status })),
  status: property.verification.status,
  verifiedOn: property.verification.reviewedAt,
  fees: {
    paymentTerms: property.fees.paymentTerms,
    refundPolicy: property.fees.refundPolicy,
    additional: property.fees.additional.map((fee) => ({
      name: fee.name,
      amount: fee.amount,
      optional: fee.optional,
    })),
  },
  views: property.views,
  createdAt: property.createdAt,
});

const Property = model<IProperty>("Property", propertySchema);

export default Property;
