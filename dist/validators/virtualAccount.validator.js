import { z } from "zod";
export const openVirtualAccountSchema = z.strictObject({
    consent: z.literal(true, "Agree to open the account with your BVN and NIN"),
});
//# sourceMappingURL=virtualAccount.validator.js.map