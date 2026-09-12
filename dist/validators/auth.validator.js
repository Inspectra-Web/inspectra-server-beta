import { z } from "zod";
// Mirrors client/src/lib/authSchemas.ts so the two ends agree on the rules.
const email = z
    .string("Required")
    .trim()
    .toLowerCase()
    .pipe(z.email("Enter a valid email"));
const password = z
    .string("Required")
    .min(8, "Use at least 8 characters")
    .regex(/[a-zA-Z]/, "Include at least one letter")
    .regex(/[0-9]/, "Include at least one number");
const token = z.string("Required").min(1, "Token is required");
const passwordsMatch = { path: ["confirmPassword"], message: "Passwords do not match" };
export const registerSchema = z
    .object({
    fullname: z.string("Required").trim().min(2, "Enter your full name"),
    email,
    password,
    confirmPassword: z.string("Required").min(1, "Confirm your password"),
    // Admin is assigned, never self-registered.
    role: z.enum(["seeker", "realtor"]),
})
    .refine((v) => v.password === v.confirmPassword, passwordsMatch);
// Login keeps the loose password rule: a future tightening must not lock
// existing accounts out of their own sign-in.
export const loginSchema = z.object({
    email,
    password: z.string("Required").min(1, "Enter your password"),
});
export const emailOnlySchema = z.object({ email });
export const verifyTokenSchema = z.object({ token });
export const resetPasswordSchema = z
    .object({
    token,
    password,
    confirmPassword: z.string("Required").min(1, "Confirm your password"),
})
    .refine((v) => v.password === v.confirmPassword, passwordsMatch);
export const updatePasswordSchema = z
    .object({
    currentPassword: z.string("Required").min(1, "Enter your current password"),
    password,
    confirmPassword: z.string("Required").min(1, "Confirm your password"),
})
    .refine((v) => v.password === v.confirmPassword, passwordsMatch);
//# sourceMappingURL=auth.validator.js.map