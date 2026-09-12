import { z } from "zod";
import { ID_DOCUMENTS } from "../models/identity.model.js";
const ID_LENGTH = 11;
export const verifyIdentitySchema = z.strictObject({
    document: z.enum(ID_DOCUMENTS),
    number: z
        .string("Required")
        .trim()
        .regex(/^\d+$/, "Numbers only")
        .length(ID_LENGTH, `A NIN or BVN is ${ID_LENGTH} digits`),
});
//# sourceMappingURL=identity.validator.js.map