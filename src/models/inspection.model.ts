import { Schema, model, type HydratedDocument, type Types } from "mongoose";

const NOTE_MAX = 500;
const RESPONSE_MAX = 500;

/**
 * A booking's life. `requested` is waiting on the realtor, so it is the count their
 * console pills: the work, not the total. The three terminal states are kept apart
 * because they mean different things to a buyer: `declined` is the realtor refusing
 * the request, `cancelled` is either side calling off a viewing that was live, and
 * `completed` is the viewing having happened.
 */
export type InspectionStatus =
  | "requested"
  | "confirmed"
  | "completed"
  | "declined"
  | "cancelled";

// Exported so the schema's enum and the request validator read the same list.
export const INSPECTION_STATUSES: InspectionStatus[] = [
  "requested",
  "confirmed",
  "completed",
  "declined",
  "cancelled",
];

/**
 * Still live, so still blocking a second booking on the same listing and still
 * eligible for the Upcoming tab. The one definition both the partial index and the
 * controller's window read.
 */
export const ACTIVE_STATUSES: InspectionStatus[] = ["requested", "confirmed"];

/** Which side of a booking someone is. Stored only to say who cancelled. */
export type Party = "seeker" | "realtor";

export const PARTIES: Party[] = ["seeker", "realtor"];

export interface IInspection {
  property: Types.ObjectId;
  // Copied from property.user when the booking opens, for the same reason an inquiry
  // copies it: a realtor's queue has to be one indexed read, not a lookup through
  // properties, and it pins the viewing to whoever owned the listing when it was booked.
  realtor: Types.ObjectId;
  seeker: Types.ObjectId;

  // The whole appointment in one timestamp. Splitting it into a date plus a rendered
  // "10:30 AM" string is what left the mock unable to sort or compare anything.
  slot: Date;
  // The buyer's line when booking.
  note: string;
  status: InspectionStatus;
  // The realtor's line back: why they declined, or the meeting link when they confirm
  // a virtual tour. One field, because it is always the same thing: their reply.
  response: string;
  cancelledBy?: Party;
  decidedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

// `satisfies` keeps each message pair a tuple: Mongoose types these options as
// [value, message], and a plain array literal widens and stops type-checking.
const belongsTo = (label: string) => ({
  type: Schema.Types.ObjectId,
  ref: "User",
  required: [true, `An inspection must carry ${label}`] satisfies [boolean, string],
});

const inspectionSchema = new Schema<IInspection>(
  {
    property: {
      type: Schema.Types.ObjectId,
      ref: "Property",
      required: [true, "An inspection must be about a property"],
    },
    realtor: belongsTo("the realtor showing it"),
    seeker: belongsTo("the buyer who booked it"),

    slot: {
      type: Date,
      required: [true, "Pick a date and time"],
    },

    note: {
      type: String,
      trim: true,
      default: "",
      maxLength: [NOTE_MAX, `Keep your note under ${NOTE_MAX} characters`],
    },

    status: {
      type: String,
      enum: {
        values: INSPECTION_STATUSES,
        message: "{VALUE} is not a valid inspection status",
      },
      default: "requested",
    },

    response: {
      type: String,
      trim: true,
      default: "",
      maxLength: [RESPONSE_MAX, `Keep it under ${RESPONSE_MAX} characters`],
    },

    cancelledBy: {
      type: String,
      enum: { values: PARTIES, message: "{VALUE} is not a party to this booking" },
    },

    decidedAt: { type: Date },
  },
  { timestamps: true },
);

export type InspectionDoc = HydratedDocument<IInspection>;

/**
 * One live booking per listing and seeker, so a second "Book a viewing" click is
 * refused rather than filling the realtor's queue with the same buyer. Partial,
 * because a viewing that is over must not block booking the same place again.
 */
inspectionSchema.index(
  { property: 1, seeker: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ACTIVE_STATUSES } } },
);

// The two queues: the realtor's diary, and the buyer's own bookings.
inspectionSchema.index({ realtor: 1, status: 1, slot: 1 });
inspectionSchema.index({ seeker: 1, slot: -1 });

/**
 * Response allowlist: the schema has no toJSON transform, so shape it here. Both
 * sides read this same record, which is why `cancelledBy` is a party label rather
 * than a user id: it is all the page needs to say who called it off, and neither
 * party learns the other's id, exactly as an inquiry message carries `author`.
 */
export const inspectionRecord = (inspection: InspectionDoc) => ({
  id: inspection._id,
  slot: inspection.slot,
  note: inspection.note,
  status: inspection.status,
  response: inspection.response,
  cancelledBy: inspection.cancelledBy,
  decidedAt: inspection.decidedAt,
  createdAt: inspection.createdAt,
});

const Inspection = model<IInspection>("Inspection", inspectionSchema);

export default Inspection;
