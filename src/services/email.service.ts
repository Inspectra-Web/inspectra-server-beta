import { Resend } from "resend";

import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";

const resend = new Resend(envConfig.RESEND_API_KEY);

interface EmailOptions {
  to: string;
  subject: string;
  body: string;
}

/** The SDK reports failures in `error` rather than throwing, so raise it here. */
const sendEmail = async ({ to, subject, body }: EmailOptions): Promise<void> => {
  const { error } = await resend.emails.send({
    from: `INSPECTRA <${envConfig.RESEND_EMAIL}>`,
    to,
    subject,
    text: body,
  });

  if (error) throw new AppError(`Email delivery failed: ${error.message}`, 502);
};

export const sendVerifyEmail = (to: string, url: string): Promise<void> =>
  sendEmail({
    to,
    subject: "Verify your INSPECTRA email",
    body: `Confirm your email address to activate your account:\n${url}\n\nThis link expires in 24 hours.`,
  });

export const sendResetEmail = (to: string, url: string): Promise<void> =>
  sendEmail({
    to,
    subject: "Reset your INSPECTRA password",
    body: `Choose a new password:\n${url}\n\nThis link expires in 30 minutes. If you did not ask for this, ignore this email.`,
  });

export default sendEmail;
