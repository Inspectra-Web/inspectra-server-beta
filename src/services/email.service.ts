import { Resend } from "resend";

import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";
import User from "../models/user.model.js";

const resend = new Resend(envConfig.RESEND_API_KEY);

interface EmailOptions {
  to: string | string[];
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

/* ------------------------------------------------------------------ *
 * Listing notifications. The trust axis has two people waiting on each other:
 * an admin who does not know a listing arrived, and a realtor who does not know
 * it was judged. These carry that news, and nothing else depends on them.
 * ------------------------------------------------------------------ */

/**
 * A notification is a side channel, so it never fails the request that raised it: a
 * listing that saved must not answer 502 because Resend was down. It is fired and
 * left, which is also why a realtor never waits on the admin's mail. The whole
 * delivery is wrapped rather than the send alone, because working out who to send
 * to is a database read and can fail the same way.
 */
const notify = (ref: string, send: () => Promise<void>): void => {
  void send().catch((error: unknown) => {
    console.error(`Notification failed for ${ref}:`, error);
  });
};

/** Every active admin: the queue is shared, so the work is offered to all of them. */
const adminEmails = async (): Promise<string[]> => {
  const admins = await User.find({ role: "admin", status: "active" }).select("email");

  return admins.map((admin) => admin.email);
};

/** What an email says about a listing. Enough to recognise it without opening the link. */
export interface ListingBrief {
  id: string;
  ref: string;
  title: string;
  city: string;
  state: string;
  realtor: string;
}

const adminListing = (listing: ListingBrief, subject: string, lead: string): void =>
  notify(listing.ref, async () => {
    const to = await adminEmails();

    // No admin seeded yet, or every one of them suspended. Nobody to tell, and an
    // empty recipient list is a 422 from Resend rather than a quiet no-op.
    if (!to.length) return;

    await sendEmail({
      to,
      subject,
      body: [
        lead,
        `${listing.title}\n${listing.ref} · ${listing.city}, ${listing.state}\nRealtor: ${listing.realtor}`,
        `Review it:\n${envConfig.CLIENT_URL}/admin/verification/${listing.id}`,
      ].join("\n\n"),
    });
  });

export const sendListingSubmitted = (listing: ListingBrief): void =>
  adminListing(
    listing,
    `New listing to verify: ${listing.title}`,
    "A realtor submitted a listing. It is waiting on verification.",
  );

/**
 * `recheck` is the load-bearing half. An edit to a listing already in the queue is
 * routine; one that pulled a live badge means a checked asset changed behind it.
 */
export const sendListingUpdated = (listing: ListingBrief, recheck: boolean): void =>
  adminListing(
    listing,
    recheck
      ? `Verified listing changed: ${listing.title}`
      : `Listing updated: ${listing.title}`,
    recheck
      ? "A realtor changed a listing that had already been checked. Its badge is back to pending, so it needs another review."
      : "A realtor updated a listing that is waiting on verification.",
  );

/** A document the reviewer flagged, and the line they wrote about it. */
export interface FlaggedDocument {
  name: string;
  reason: string;
}

const VERDICTS = {
  verified: {
    subject: (title: string) => `Listing verified: ${title}`,
    lead: "Your listing passed verification. The Verified badge is live on it now.",
  },
  disputed: {
    subject: (title: string) => `Listing disputed: ${title}`,
    lead: "Your listing has been disputed after review. It stays on the site carrying a Disputed status until the problem below is settled.",
  },
  pending: {
    subject: (title: string) => `Listing sent back: ${title}`,
    lead: "Your listing has been sent back for another look before it can be verified.",
  },
};

/**
 * The reviewer's verdict, to the realtor who owns the listing. The flagged documents
 * travel with it: without them the realtor learns the outcome and not what to fix.
 */
export const sendListingReviewed = (
  to: string,
  listing: ListingBrief,
  status: keyof typeof VERDICTS,
  note: string,
  flagged: FlaggedDocument[],
): void => {
  const verdict = VERDICTS[status];

  const body = [
    verdict.lead,
    `${listing.title}\n${listing.ref} · ${listing.city}, ${listing.state}`,
    ...(note ? [`From the reviewer:\n${note}`] : []),
    ...(flagged.length
      ? [`Documents to fix:\n${flagged.map((doc) => `- ${doc.name}: ${doc.reason}`).join("\n")}`]
      : []),
    `Open the listing:\n${envConfig.CLIENT_URL}/realtor/listings/${listing.id}`,
  ].join("\n\n");

  notify(listing.ref, () =>
    sendEmail({ to, subject: verdict.subject(listing.title), body }),
  );
};

/* ------------------------------------------------------------------ *
 * Inquiry notifications. A thread is the only channel between a buyer and a
 * realtor, and neither of them is sitting in the console waiting, so each side
 * is told when the other writes.
 * ------------------------------------------------------------------ */

/** What an email says about a conversation. The message travels: a notification
 *  that only says "you have a message" makes the reader open the app to learn
 *  whether it was worth opening. */
export interface InquiryBrief {
  id: string;
  ref: string;
  property: string;
  /** Whoever wrote the message, as the account stores their name. */
  person: string;
  message: string;
}

/**
 * To the realtor, when a buyer writes. `first` separates a new inquiry from a
 * follow-up on a thread they have already seen, the way `recheck` does above.
 */
export const sendInquiryReceived = (
  to: string,
  inquiry: InquiryBrief,
  first: boolean,
): void =>
  notify(inquiry.ref, () =>
    sendEmail({
      to,
      subject: first
        ? `New inquiry: ${inquiry.property}`
        : `New message: ${inquiry.property}`,
      body: [
        first
          ? `${inquiry.person} asked about one of your listings.`
          : `${inquiry.person} sent another message about one of your listings.`,
        `${inquiry.property}\n${inquiry.ref}`,
        `Their message:\n${inquiry.message}`,
        `Reply:\n${envConfig.CLIENT_URL}/realtor/leads/${inquiry.id}`,
      ].join("\n\n"),
    }),
  );

/** To the buyer, when the realtor answers. */
export const sendInquiryReplied = (to: string, inquiry: InquiryBrief): void =>
  notify(inquiry.ref, () =>
    sendEmail({
      to,
      subject: `Reply about ${inquiry.property}`,
      body: [
        `${inquiry.person} replied to your inquiry.`,
        `${inquiry.property}\n${inquiry.ref}`,
        `Their message:\n${inquiry.message}`,
        `Open the conversation:\n${envConfig.CLIENT_URL}/dashboard/inquiries/${inquiry.id}`,
      ].join("\n\n"),
    }),
  );

/* ------------------------------------------------------------------ *
 * Inspection notifications. A viewing is an appointment two people have to keep,
 * so every change of plan has to reach the other one. These are the only messages
 * in the app with a deadline attached: a request nobody answers expires by itself.
 * ------------------------------------------------------------------ */

/** What an email says about a viewing. The time travels in full, because a
 *  notification that makes the reader open the app to learn *when* has failed at
 *  the one job it had. */
export interface InspectionBrief {
  id: string;
  ref: string;
  property: string;
  /** Whoever the mail is about, as the account stores their name. */
  person: string;
  slot: Date;
  /** The free line: the buyer's note when booking, or the realtor's reply. */
  message: string;
}

/**
 * Listings and buyers are Nigerian and the viewing happens at the property, so the
 * time is written in Lagos regardless of where the server is. Reading it in UTC
 * would put a morning appointment an hour earlier than anyone agreed.
 */
const when = (inspection: InspectionBrief): string =>
  new Intl.DateTimeFormat("en-NG", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Africa/Lagos",
  }).format(inspection.slot);

const realtorLink = (inspection: InspectionBrief): string =>
  `${envConfig.CLIENT_URL}/realtor/inspections/${inspection.id}`;

const seekerLink = (inspection: InspectionBrief): string =>
  `${envConfig.CLIENT_URL}/dashboard/inspections/${inspection.id}`;

/** To the realtor, when a buyer books. */
export const sendInspectionRequested = (
  to: string,
  inspection: InspectionBrief,
): void =>
  notify(inspection.ref, () =>
    sendEmail({
      to,
      subject: `Viewing requested: ${inspection.property}`,
      body: [
        `${inspection.person} asked to view one of your listings.`,
        `${inspection.property}\n${inspection.ref}`,
        when(inspection),
        ...(inspection.message ? [`Their note:\n${inspection.message}`] : []),
        `Confirm or decline it:\n${realtorLink(inspection)}`,
      ].join("\n\n"),
    }),
  );

/** To the realtor, when the buyer moves the time. It is a fresh request, not an
 *  edit, so the mail says so: the old slot is no longer in their diary. */
export const sendInspectionRescheduled = (
  to: string,
  inspection: InspectionBrief,
): void =>
  notify(inspection.ref, () =>
    sendEmail({
      to,
      subject: `Viewing moved: ${inspection.property}`,
      body: [
        `${inspection.person} moved their viewing, so it needs confirming again.`,
        `${inspection.property}\n${inspection.ref}`,
        `The new time:\n${when(inspection)}`,
        `Confirm or decline it:\n${realtorLink(inspection)}`,
      ].join("\n\n"),
    }),
  );

const OUTCOMES = {
  confirmed: {
    subject: (property: string) => `Viewing confirmed: ${property}`,
    lead: "The realtor confirmed your viewing. Put it in your calendar.",
  },
  declined: {
    subject: (property: string) => `Viewing declined: ${property}`,
    lead: "The realtor cannot make this viewing. You can propose another time on the listing.",
  },
  completed: {
    subject: (property: string) => `Viewing closed: ${property}`,
    lead: "The realtor marked this viewing as done.",
  },
};

/** To the buyer, when the realtor answers. */
export const sendInspectionDecided = (
  to: string,
  inspection: InspectionBrief,
  outcome: keyof typeof OUTCOMES,
): void => {
  const { subject, lead } = OUTCOMES[outcome];

  notify(inspection.ref, () =>
    sendEmail({
      to,
      subject: subject(inspection.property),
      body: [
        lead,
        `${inspection.property}\n${inspection.ref}`,
        when(inspection),
        ...(inspection.message
          ? [`From ${inspection.person}:\n${inspection.message}`]
          : []),
        `Open it:\n${seekerLink(inspection)}`,
      ].join("\n\n"),
    }),
  );
};

/** To whoever did not call it off. `by` is the party who cancelled, so the link
 *  goes to the other one's console. */
export const sendInspectionCancelled = (
  to: string,
  inspection: InspectionBrief,
  by: "seeker" | "realtor",
): void =>
  notify(inspection.ref, () =>
    sendEmail({
      to,
      subject: `Viewing cancelled: ${inspection.property}`,
      body: [
        by === "seeker"
          ? `${inspection.person} cancelled their viewing.`
          : `${inspection.person} cancelled this viewing.`,
        `${inspection.property}\n${inspection.ref}`,
        `It was booked for:\n${when(inspection)}`,
        `Open it:\n${by === "seeker" ? realtorLink(inspection) : seekerLink(inspection)}`,
      ].join("\n\n"),
    }),
  );

export default sendEmail;
