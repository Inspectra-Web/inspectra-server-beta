import { Schema, model } from "mongoose";
const BODY_MAX = 1000;
const MESSAGES_MAX = 100;
// Exported so the schema's enum and the request validator read the same list.
export const INQUIRY_STATUSES = ["new", "responded", "closed"];
// `satisfies` keeps each message pair a tuple: Mongoose types these options as
// [value, message], and a plain array literal widens and stops type-checking.
const belongsTo = (label) => ({
    type: Schema.Types.ObjectId,
    ref: "User",
    required: [true, `An inquiry must carry ${label}`],
});
// A message is written once and never edited, so an updatedAt on it would be a lie.
const messageSchema = new Schema({
    sender: belongsTo("its author"),
    body: {
        type: String,
        trim: true,
        required: [true, "Write a message"],
        maxLength: [BODY_MAX, `Keep it under ${BODY_MAX} characters`],
    },
}, { timestamps: { createdAt: true, updatedAt: false } });
const inquirySchema = new Schema({
    property: {
        type: Schema.Types.ObjectId,
        ref: "Property",
        required: [true, "An inquiry must be about a property"],
    },
    realtor: belongsTo("the realtor it is addressed to"),
    seeker: belongsTo("the seeker who sent it"),
    status: {
        type: String,
        enum: {
            values: INQUIRY_STATUSES,
            message: "{VALUE} is not a valid inquiry status",
        },
        default: "new",
    },
    messages: {
        type: [messageSchema],
        default: [],
        validate: [
            {
                validator: (value) => value.length > 0,
                message: "An inquiry needs a message",
            },
            {
                validator: (value) => value.length <= MESSAGES_MAX,
                message: `This conversation has reached ${MESSAGES_MAX} messages`,
            },
        ],
    },
    lastMessageAt: { type: Date, default: Date.now },
}, { timestamps: true });
/**
 * One thread per property and seeker, so a second "Message realtor" click appends to
 * the conversation instead of forking a duplicate the two sides then read separately.
 */
inquirySchema.index({ property: 1, seeker: 1 }, { unique: true });
// The two queues: the realtor's leads, and the seeker's own inquiries.
inquirySchema.index({ realtor: 1, status: 1, lastMessageAt: -1 });
inquirySchema.index({ seeker: 1, lastMessageAt: -1 });
/**
 * Response allowlist: the schema has no toJSON transform, so shape it here. Both sides
 * read this same thread, which is why a message carries `author` rather than a user id:
 * it is all a bubble needs to pick its side, and neither party learns the other's id.
 */
export const inquiryThread = (inquiry) => ({
    id: inquiry._id,
    status: inquiry.status,
    messages: inquiry.messages.map((message) => ({
        id: message._id,
        author: (inquiry.seeker.equals(message.sender)
            ? "seeker"
            : "realtor"),
        body: message.body,
        createdAt: message.createdAt,
    })),
    lastMessageAt: inquiry.lastMessageAt,
    createdAt: inquiry.createdAt,
});
const Inquiry = model("Inquiry", inquirySchema);
export default Inquiry;
//# sourceMappingURL=inquiry.model.js.map