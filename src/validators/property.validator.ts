import { z } from "zod";

import {
  LEGAL_DOCUMENT_NAMES,
  LISTING_STATUSES,
  VERIFICATION_STATUSES,
  type ListingStatus,
  type VerificationStatus,
} from "../models/property.model.js";
import {
  PROPERTY_CATEGORIES,
  PROPERTY_TYPES,
  PROPERTY_TYPES_BY_CATEGORY,
  type PropertyCategory,
  type PropertyType,
} from "../types/property.type.js";

// Mirrors client/src/lib/listingSchema.ts so the two ends agree on the rules.

const TITLE_MIN = 4;
const TITLE_MAX = 140;
const DESCRIPTION_MIN = 10;
const DESCRIPTION_MAX = 1200;
const TERMS_MAX = 300;
const FEE_NAME_MAX = 80;
const FEES_MAX = 10;
const AMENITIES_MAX = 40;
const AMENITY_MAX = 60;
const NOTES_MAX = 300;
// Mirror the caps enforced on the schema's arrays in property.model.ts.
const IMAGES_MAX = 20;
const DOCUMENTS_MAX = 5;
const YEAR_MIN = 1900;
const YEAR_MAX = 2100;

const SEARCH_MAX = 100;
const CITY_MAX = 80;
// The model slices the title to 80, then appends a hyphen and 8 hex.
const SLUG_MAX = 89;
const BEDS_MAX = 20;
const PAGE_SIZE = 12;
const PAGE_SIZE_MAX = 48;

const line = z.string("Required").trim();

const count = z
  .number("Enter a number")
  .int("Enter a whole number")
  .nonnegative("Cannot be negative");

// Zero is allowed throughout: the model reads it as "not applicable", and it is how
// the composer clears a measurement that does not apply to this property.
const area = z.number("Enter a number").nonnegative("Enter a valid size");

const addressSchema = z.strictObject({
  fullAddress: line.min(TITLE_MIN, "Enter the full address"),
  city: line.min(2, "Enter the city or LGA"),
  state: line.min(2, "Enter the state"),
  country: line.min(2, "Enter the country"),
});

/**
 * Optional key by key, because a land listing leaves most of these blank. The
 * controller merges into the stored sub-document rather than replacing it, so an
 * omitted key keeps its value instead of resetting to 0.
 */
const featuresSchema = z
  .strictObject({
    bedrooms: count,
    bathrooms: count,
    toilets: count,
    garage: count,
    kitchen: count,
    floors: count,
    floorArea: area,
    landSize: area,
    yearBuilt: count
      .max(YEAR_MAX, "Enter a valid year")
      .refine((year) => year === 0 || year >= YEAR_MIN, "Enter a valid year"),
  })
  .partial();

const feeSchema = z.strictObject({
  name: line.min(1, "Name the fee").max(FEE_NAME_MAX, "That name is too long"),
  amount: z.number("Enter the amount").nonnegative("Cannot be negative"),
  optional: z.boolean(),
});

// `additional` is sent whole: a fee left out of the array is a fee removed.
const feesSchema = z
  .strictObject({
    paymentTerms: line.max(TERMS_MAX, `Keep it under ${TERMS_MAX} characters`),
    refundPolicy: line.max(TERMS_MAX, `Keep it under ${TERMS_MAX} characters`),
    additional: z.array(feeSchema).max(FEES_MAX, `List at most ${FEES_MAX} fees`),
  })
  .partial();

/**
 * Types overlap categories on purpose (a serviced apartment sells as residential,
 * commercial or mixed use), so the pair is checked against the shared map rather
 * than each enum alone. Exported because a partial update can send one half of the
 * pair, and only the controller holds the other half.
 */
export const typeFitsCategory = (
  category: PropertyCategory,
  type: PropertyType,
): boolean => PROPERTY_TYPES_BY_CATEGORY[category].includes(type);

const checkPair = (
  body: { category?: PropertyCategory; type?: PropertyType },
  ctx: z.RefinementCtx,
): void => {
  if (!body.category || !body.type) return;
  if (typeFitsCategory(body.category, body.type)) return;

  ctx.addIssue({
    code: "custom",
    path: ["type"],
    message: `A ${body.type} is not a ${body.category} property`,
  });
};

/**
 * Strict, which is what keeps the platform's own fields out of a realtor's write:
 * `ref`, `user`, `views` and `verification` are all absent here on purpose.
 * `images` and `documents` are absent too, because files arrive as multipart on
 * their own endpoints, never in this body.
 */
const propertyObject = z.strictObject({
  title: line
    .min(TITLE_MIN, "Give the listing a descriptive title")
    .max(TITLE_MAX, `Keep the title under ${TITLE_MAX} characters`),
  description: line
    .min(DESCRIPTION_MIN, "Add a short description")
    .max(DESCRIPTION_MAX, `Keep it under ${DESCRIPTION_MAX} characters`),
  price: z.number("Enter the asking price").positive("Price must be greater than 0"),
  type: z.enum(PROPERTY_TYPES, "Choose a property type"),
  category: z.enum(PROPERTY_CATEGORIES, "Choose a category"),
  listingStatus: z.enum(LISTING_STATUSES, "Choose a listing status"),
  address: addressSchema,
  features: featuresSchema,
  amenities: z
    .array(line.min(1, "An amenity cannot be blank").max(AMENITY_MAX, "That amenity is too long"))
    .max(AMENITIES_MAX, `Pick at most ${AMENITIES_MAX} amenities`),
  videoUrl: line.refine(
    (value) => value === "" || /^https?:\/\/.+/.test(value),
    "Enter a valid URL",
  ),
  fees: feesSchema,
});

export const createPropertySchema = propertyObject
  .partial({ features: true, amenities: true, videoUrl: true, fees: true })
  .superRefine(checkPair);

export type CreatePropertyInput = z.infer<typeof createPropertySchema>;

/**
 * `images` and `documents` are keep-lists, not uploads: what the composer still wants.
 * Anything stored and missing from the list is deleted, which is how it removes a photo.
 * New files arrive on their own endpoints.
 *
 * Photos are kept by URL because a photo's URL is public anyway; documents are kept by
 * their subdocument id, because their URL is never handed to the client.
 */
export const updatePropertySchema = propertyObject
  .extend({
    images: z.array(line).max(IMAGES_MAX, `Keep at most ${IMAGES_MAX} photos`),
    documents: z
      .array(line.regex(/^[0-9a-f]{24}$/i, "That is not a valid document id"))
      .max(DOCUMENTS_MAX, `Keep at most ${DOCUMENTS_MAX} documents`),
  })
  .partial()
  .superRefine((body, ctx) => {
    if (Object.keys(body).length === 0) {
      ctx.addIssue({ code: "custom", message: "Send at least one field to update" });
    }

    checkPair(body, ctx);
  });

export type UpdatePropertyInput = z.infer<typeof updatePropertySchema>;

/** The metadata beside an uploaded document. Arrives as multipart text fields. */
export const addDocumentSchema = z.strictObject({
  name: z.enum(LEGAL_DOCUMENT_NAMES, "Say which document this is"),
  notes: line.max(NOTES_MAX, `Keep notes under ${NOTES_MAX} characters`).default(""),
  issuedDate: z.coerce.date("Enter a valid date").optional(),
});

export type AddDocumentInput = z.infer<typeof addDocumentSchema>;

export type PropertySort = "recommended" | "newest" | "price-asc" | "price-desc" | "views";

/** "Recommended" is verified-first, not paid placement: there is no featured tier. */
export const PROPERTY_SORTS: PropertySort[] = [
  "recommended",
  "newest",
  "price-asc",
  "price-desc",
  "views",
];

// "all" is the sentinel the controller checks, as on the realtor directory.
const STATUS_FILTERS: (VerificationStatus | "all")[] = ["all", ...VERIFICATION_STATUSES];
const LISTING_FILTERS: (ListingStatus | "all")[] = ["all", ...LISTING_STATUSES];
const TYPE_FILTERS: (PropertyType | "all")[] = ["all", ...PROPERTY_TYPES];
const CATEGORY_FILTERS: (PropertyCategory | "all")[] = ["all", ...PROPERTY_CATEGORIES];

/**
 * Deliberately `z.object`, not `z.strictObject`. Strictness belongs on a write body,
 * where it keeps privileged fields out; on a read-only query string it only turns a
 * stray param into a 422. Parsed inline in the controller, since `validate()` assigns
 * to `req.body` and Express 5 exposes `req.query` as a getter only.
 */
export const listPropertiesSchema = z.object({
  q: line.max(SEARCH_MAX, "Search is too long").default(""),
  city: line.max(CITY_MAX, "City is too long").default("all"),
  status: z.enum(STATUS_FILTERS).default("all"),
  listingStatus: z.enum(LISTING_FILTERS).default("all"),
  type: z.enum(TYPE_FILTERS).default("all"),
  category: z.enum(CATEGORY_FILTERS).default("all"),
  // A minimum, not an exact count: the filter reads "3+ beds".
  beds: z.coerce.number().int().min(0).max(BEDS_MAX).default(0),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().nonnegative().optional(),
  sort: z.enum(PROPERTY_SORTS).default("recommended"),
  page: z.coerce.number().int().min(1, "Page starts at 1").default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_SIZE_MAX, `Ask for at most ${PAGE_SIZE_MAX} per page`)
    .default(PAGE_SIZE),
});

export type ListPropertiesQuery = z.infer<typeof listPropertiesSchema>;

export const propertyIdSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/i, "That is not a valid listing id"),
});

export type PropertyIdParams = z.infer<typeof propertyIdSchema>;

/**
 * The public handle. Lowercase words joined by single hyphens, which is exactly what
 * `buildSlug` stamps, so anything else was never a link we issued.
 */
export const propertySlugSchema = z.object({
  slug: z
    .string()
    .trim()
    .max(SLUG_MAX, "That is not a valid listing link")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "That is not a valid listing link"),
});

export type PropertySlugParams = z.infer<typeof propertySlugSchema>;

/** The listing plus one of its documents, for the stream-the-file route. */
export const documentIdSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/i, "That is not a valid listing id"),
  docId: z.string().regex(/^[0-9a-f]{24}$/i, "That is not a valid document id"),
});
