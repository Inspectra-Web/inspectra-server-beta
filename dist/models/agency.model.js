import { Schema, model } from "mongoose";
export const COMPANY_TYPES = [
    "BUSINESS_NAME",
    "COMPANY",
    "INCORPORATED_TRUSTEES",
    "LIMITED_PARTNERSHIP",
    "LIMITED_LIABILITY_PARTNERSHIP",
];
export const ADDRESS_STATES = [
    "unsubmitted",
    "in-review",
    "verified",
    "flagged",
];
const text = () => ({ type: String, trim: true, default: "" });
const agencySchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: [true, "An agency check must belong to a user"],
        unique: true,
    },
    // The two checks are independent, so there is no boolean at the root: one flag
    // covering both would be a lie the moment only one of them passes.
    cac: {
        // Stored in full, unlike a NIN or BVN. An RC number is public register data and
        // is itself the proof a buyer re-checks on the CAC portal.
        rcNumber: text(),
        companyName: text(),
        companyType: text(),
        registeredAddress: text(),
        registeredOn: { type: Date },
        verified: { type: Boolean, default: false },
        verifiedAt: { type: Date },
    },
    // Reviewed by a person, not a provider. Nigerian utility bills are rarely in the
    // occupier's own name (shared compounds, the landlord's name, or a prepaid meter
    // receipt from a bank app), so there is no field an API could match on. A human
    // reads the bill against the meter number and says yes or no. Nothing is copied off
    // it: the check is that the address stands up, not a new address of record.
    address: {
        meterNumber: text(),
        document: {
            url: text(),
            publicId: text(),
        },
        status: {
            type: String,
            enum: { values: ADDRESS_STATES, message: "{VALUE} is not a valid address state" },
            default: "unsubmitted",
        },
        // The reviewer's line, cleared whenever the status leaves flagged.
        reason: text(),
        submittedAt: { type: Date },
        verifiedAt: { type: Date },
        reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    },
}, { timestamps: true });
// Not unique: co-directors of one firm both match its affiliates legitimately.
agencySchema.index({ "cac.rcNumber": 1 });
export const publicAgency = (agency) => ({
    cac: {
        rcNumber: agency.cac.rcNumber,
        companyName: agency.cac.companyName,
        companyType: agency.cac.companyType,
        registeredAddress: agency.cac.registeredAddress,
        registeredOn: agency.cac.registeredOn,
        verified: agency.cac.verified,
        verifiedOn: agency.cac.verifiedAt,
    },
    address: {
        // document and reviewedBy are withheld: the realtor has no use for the file back,
        // and does not need to know which admin read it. Only the admin shape carries them.
        meterNumber: agency.address.meterNumber,
        status: agency.address.status,
        reason: agency.address.reason,
        submittedOn: agency.address.submittedAt,
        verifiedOn: agency.address.verifiedAt,
    },
});
const Agency = model("Agency", agencySchema);
export default Agency;
//# sourceMappingURL=agency.model.js.map