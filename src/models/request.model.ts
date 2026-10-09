import { Schema, model, type HydratedDocument, type Types } from "mongoose";

import {
  PROPERTY_CATEGORIES,
  PROPERTY_TYPES,
  type PropertyCategory,
  type PropertyType,
} from "../types/property.type.js";

const AREAS_MAX = 5;
const NOTES_MAX = 500;

/** How long a request stays live before the seeker has to say they are still looking. */
export const REQUEST_TTL_DAYS = 90;
/** Active requests one seeker may hold at once. */
export const ACTIVE_REQUESTS_MAX = 3;

/** The live subset of ListingStatus: what a seeker can ask for, not what a listing retires into. */
export type RequestIntent = "rent" | "sale" | "lease" | "shortlet";
/** The launch cities. Slugs, so the client owns the labels. */
export type RequestCity = "lagos" | "port-harcourt" | "abuja";
export type RequestTimeline = "now" | "3-months" | "6-months" | "exploring";
/** Expired is not a status: it is derived from expiresAt, so renewing needs no status write. */
export type RequestStatus = "active" | "closed";

// Exported so the schema's enums and the request validator read the same lists.
export const REQUEST_INTENTS: RequestIntent[] = ["rent", "sale", "lease", "shortlet"];
export const REQUEST_CITIES: RequestCity[] = ["lagos", "port-harcourt", "abuja"];
export const REQUEST_TIMELINES: RequestTimeline[] = ["now", "3-months", "6-months", "exploring"];
export const REQUEST_STATUSES: RequestStatus[] = ["active", "closed"];

export const requestExpiry = (from = Date.now()) =>
  new Date(from + REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000);

export interface IPropertyRequest {
  seeker: Types.ObjectId;

  intent: RequestIntent;
  category: PropertyCategory;
  type?: PropertyType;
  city: RequestCity;
  areas: string[];
  // Naira. Per year for rent and lease, per night for a shortlet, the total for a sale.
  budgetMin?: number;
  budgetMax: number;
  bedrooms?: number;
  timeline: RequestTimeline;
  notes: string;

  status: RequestStatus;
  expiresAt: Date;
  remindedAt?: Date;
  consentedAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

const naira = { type: Number, min: [0, "An amount cannot be negative"] satisfies [number, string] };

const propertyRequestSchema = new Schema<IPropertyRequest>(
  {
    seeker: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: [true, "A request must belong to a seeker"],
    },

    intent: {
      type: String,
      enum: { values: REQUEST_INTENTS, message: "{VALUE} is not a valid intent" },
      required: [true, "Say whether you want to rent, buy, lease or shortlet"],
    },
    category: {
      type: String,
      enum: { values: PROPERTY_CATEGORIES, message: "{VALUE} is not a valid property category" },
      required: [true, "Choose a property category"],
    },
    type: {
      type: String,
      enum: { values: PROPERTY_TYPES, message: "{VALUE} is not a valid property type" },
    },
    city: {
      type: String,
      enum: { values: REQUEST_CITIES, message: "{VALUE} is not a launch city" },
      required: [true, "Choose a city"],
    },
    areas: {
      type: [{ type: String, trim: true }],
      default: [],
      validate: {
        validator: (value: string[]) => value.length <= AREAS_MAX,
        message: `Name at most ${AREAS_MAX} areas`,
      },
    },
    budgetMin: naira,
    budgetMax: { ...naira, required: [true, "Set a budget"] },
    bedrooms: { type: Number, min: [0, "Bedrooms cannot be negative"] },
    timeline: {
      type: String,
      enum: { values: REQUEST_TIMELINES, message: "{VALUE} is not a valid timeline" },
      required: [true, "Say when you need it"],
    },
    notes: {
      type: String,
      trim: true,
      default: "",
      maxLength: [NOTES_MAX, `Keep it under ${NOTES_MAX} characters`],
    },

    status: {
      type: String,
      enum: { values: REQUEST_STATUSES, message: "{VALUE} is not a valid request status" },
      default: "active",
    },
    expiresAt: { type: Date, default: () => requestExpiry() },
    remindedAt: { type: Date },
    consentedAt: { type: Date, required: [true, "Consent to be contacted is required"] },
  },
  { timestamps: true },
);

export type PropertyRequestDoc = HydratedDocument<IPropertyRequest>;

// The seeker's own list, and the live-demand reads (admin counts, the reminder script).
propertyRequestSchema.index({ seeker: 1, createdAt: -1 });
propertyRequestSchema.index({ status: 1, expiresAt: 1 });

/** Response allowlist: the schema has no toJSON transform, so shape it here. */
export const requestCard = (request: PropertyRequestDoc) => ({
  id: request._id,
  intent: request.intent,
  category: request.category,
  type: request.type,
  city: request.city,
  areas: request.areas,
  budgetMin: request.budgetMin,
  budgetMax: request.budgetMax,
  bedrooms: request.bedrooms,
  timeline: request.timeline,
  notes: request.notes,
  status: request.status,
  expired: request.expiresAt.getTime() < Date.now(),
  expiresAt: request.expiresAt,
  createdAt: request.createdAt,
  updatedAt: request.updatedAt,
});

const PropertyRequest = model<IPropertyRequest>("PropertyRequest", propertyRequestSchema);

export default PropertyRequest;
