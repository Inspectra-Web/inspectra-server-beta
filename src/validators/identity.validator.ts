import { z } from "zod";

const ID_LENGTH = 11;

const idNumber = (label: string) =>
  z
    .string("Required")
    .trim()
    .regex(/^\d+$/, "Numbers only")
    .length(ID_LENGTH, `A ${label} is ${ID_LENGTH} digits`);

export const verifyNinSchema = z.strictObject({ nin: idNumber("NIN") });

export const verifyBvnSchema = z.strictObject({ bvn: idNumber("BVN") });

export type VerifyNinInput = z.infer<typeof verifyNinSchema>;
export type VerifyBvnInput = z.infer<typeof verifyBvnSchema>;
