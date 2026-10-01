import { Resend } from "resend";

import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";
import User from "../models/user.model.js";
import {
  button,
  heading,
  layout,
  lead,
  list,
  note,
  quote,
  rows,
  slip,
  type Block,
  type Tone,
} from "../templates/email.template.js";

const resend = new Resend(envConfig.RESEND_API_KEY);

interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
}

/** The SDK reports failures in `error` rather than throwing, so raise it here. */
const sendEmail = async ({ to, subject, html, text }: EmailOptions): Promise<void> => {
  const { error } = await resend.emails.send({
    from: `INSPECTRA <${envConfig.RESEND_EMAIL}>`,
    to,
    subject,
    html,
    text,
  });

  if (error) throw new AppError(`Email delivery failed: ${error.message}`, 502);
};

const ACCOUNT_REASON =
  "You're getting this because this address was used to sign up on INSPECTRA.";

export const sendVerifyEmail = (to: string, url: string): Promise<void> =>
  sendEmail({
    to,
    subject: "Verify your INSPECTRA email",
    ...layout({
      eyebrow: "Account",
      preheader: "Confirm your email address to activate your account.",
      reason: ACCOUNT_REASON,
      blocks: [
        heading("Verify your email"),
        lead("Confirm your email address to activate your account."),
        button("Verify email", url),
        note("This link expires in 24 hours."),
      ],
    }),
  });

export const sendResetEmail = (to: string, url: string): Promise<void> =>
  sendEmail({
    to,
    subject: "Reset your INSPECTRA password",
    ...layout({
      eyebrow: "Account",
      preheader: "Choose a new password. This link expires in 30 minutes.",
      reason: ACCOUNT_REASON,
      blocks: [
        heading("Reset your password"),
        lead("Someone asked to reset the password on this account. Choose a new one below."),
        button("Choose a new password", url),
        note(
          "This link expires in 30 minutes. If you did not ask for this, ignore this email and your password stays the same.",
        ),
      ],
    }),
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

const LISTER_REASON = "You're getting this because you list properties on INSPECTRA.";

const adminListing = (
  listing: ListingBrief,
  subject: string,
  title: string,
  intro: string,
  status: string,
): void =>
  notify(listing.ref, async () => {
    const to = await adminEmails();

    // No admin seeded yet, or every one of them suspended. Nobody to tell, and an
    // empty recipient list is a 422 from Resend rather than a quiet no-op.
    if (!to.length) return;

    await sendEmail({
      to,
      subject,
      ...layout({
        eyebrow: "Verification",
        preheader: `${listing.title}, ${listing.city}. ${intro}`,
        reason: "You're getting this because you review listings on INSPECTRA.",
        blocks: [
          heading(title),
          lead(intro),
          slip({
            ref: listing.ref,
            status,
            tone: "pending",
            title: listing.title,
            lines: [`${listing.city}, ${listing.state}`, `Realtor: ${listing.realtor}`],
          }),
          button("Review listing", `${envConfig.CLIENT_URL}/admin/verification/${listing.id}`),
        ],
      }),
    });
  });

export const sendListingSubmitted = (listing: ListingBrief): void =>
  adminListing(
    listing,
    `New listing to verify: ${listing.title}`,
    "New listing to verify",
    "A realtor submitted a listing. It is waiting on verification.",
    "Pending",
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
    recheck ? "Verified listing changed" : "Listing updated",
    recheck
      ? "A realtor changed a listing that had already been checked. Its badge is back to pending, so it needs another review."
      : "A realtor updated a listing that is waiting on verification.",
    recheck ? "Recheck" : "Pending",
  );

/** A document the reviewer flagged, and the line they wrote about it. */
export interface FlaggedDocument {
  name: string;
  reason: string;
}

interface Verdict {
  subject: (title: string) => string;
  heading: string;
  lead: string;
  status: string;
  tone: Tone;
}

const VERDICTS: Record<"verified" | "disputed" | "pending", Verdict> = {
  verified: {
    subject: (title) => `Listing verified: ${title}`,
    heading: "Your listing is verified",
    lead: "Your listing passed verification. The Verified badge is live on it now.",
    status: "Verified",
    tone: "verified",
  },
  disputed: {
    subject: (title) => `Listing disputed: ${title}`,
    heading: "Your listing is disputed",
    lead: "Your listing has been disputed after review. It stays on the site carrying a Disputed status until the problem below is settled.",
    status: "Disputed",
    tone: "disputed",
  },
  pending: {
    subject: (title) => `Listing sent back: ${title}`,
    heading: "Your listing was sent back",
    lead: "Your listing has been sent back for another look before it can be verified.",
    status: "Sent back",
    tone: "pending",
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

  const blocks: Block[] = [
    heading(verdict.heading),
    lead(verdict.lead),
    slip({
      ref: listing.ref,
      status: verdict.status,
      tone: verdict.tone,
      title: listing.title,
      lines: [`${listing.city}, ${listing.state}`],
    }),
    ...(note ? [quote("From the reviewer", note)] : []),
    ...(flagged.length
      ? [
          list(
            "Documents to fix",
            flagged.map((doc) => ({ name: doc.name, detail: doc.reason })),
            verdict.tone,
          ),
        ]
      : []),
    button("Open listing", `${envConfig.CLIENT_URL}/realtor/listings/${listing.id}`),
  ];

  notify(listing.ref, () =>
    sendEmail({
      to,
      subject: verdict.subject(listing.title),
      ...layout({
        eyebrow: "Verification",
        preheader: `${listing.title}. ${verdict.lead}`,
        reason: LISTER_REASON,
        blocks,
      }),
    }),
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
      ...layout({
        eyebrow: "Inquiries",
        preheader: `${inquiry.person}: ${inquiry.message}`,
        reason: LISTER_REASON,
        blocks: [
          heading(first ? "New inquiry" : "New message"),
          lead(
            first
              ? `${inquiry.person} asked about one of your listings.`
              : `${inquiry.person} sent another message about one of your listings.`,
          ),
          slip({
            ref: inquiry.ref,
            status: first ? "Inquiry" : "Message",
            tone: "neutral",
            title: inquiry.property,
          }),
          quote(`From ${inquiry.person}`, inquiry.message),
          button("Reply", `${envConfig.CLIENT_URL}/realtor/leads/${inquiry.id}`),
        ],
      }),
    }),
  );

/** To the buyer, when the realtor answers. */
export const sendInquiryReplied = (to: string, inquiry: InquiryBrief): void =>
  notify(inquiry.ref, () =>
    sendEmail({
      to,
      subject: `Reply about ${inquiry.property}`,
      ...layout({
        eyebrow: "Inquiries",
        preheader: `${inquiry.person}: ${inquiry.message}`,
        reason: "You're getting this because you asked a realtor about a listing on INSPECTRA.",
        blocks: [
          heading("You have a reply"),
          lead(`${inquiry.person} replied to your inquiry.`),
          slip({ ref: inquiry.ref, status: "Reply", tone: "neutral", title: inquiry.property }),
          quote(`From ${inquiry.person}`, inquiry.message),
          button(
            "Open conversation",
            `${envConfig.CLIENT_URL}/dashboard/inquiries/${inquiry.id}`,
          ),
        ],
      }),
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

const viewingSlip = (inspection: InspectionBrief, status: string, tone: Tone): Block =>
  slip({
    ref: inspection.ref,
    status,
    tone,
    title: inspection.property,
    lines: [when(inspection)],
  });

const SEEKER_REASON = "You're getting this because you booked a viewing on INSPECTRA.";

/** To the realtor, when a buyer books. */
export const sendInspectionRequested = (
  to: string,
  inspection: InspectionBrief,
): void =>
  notify(inspection.ref, () =>
    sendEmail({
      to,
      subject: `Viewing requested: ${inspection.property}`,
      ...layout({
        eyebrow: "Viewings",
        preheader: `${inspection.person} wants to view it on ${when(inspection)}.`,
        reason: LISTER_REASON,
        blocks: [
          heading("Viewing requested"),
          lead(`${inspection.person} asked to view one of your listings.`),
          viewingSlip(inspection, "Requested", "pending"),
          ...(inspection.message ? [quote("Their note", inspection.message)] : []),
          button("Confirm or decline", realtorLink(inspection)),
          note("A request nobody answers expires on its own."),
        ],
      }),
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
      ...layout({
        eyebrow: "Viewings",
        preheader: `New time: ${when(inspection)}. It needs confirming again.`,
        reason: LISTER_REASON,
        blocks: [
          heading("Viewing moved"),
          lead(`${inspection.person} moved their viewing, so it needs confirming again.`),
          viewingSlip(inspection, "New time", "pending"),
          button("Confirm or decline", realtorLink(inspection)),
        ],
      }),
    }),
  );

const OUTCOMES: Record<"confirmed" | "declined" | "completed", Verdict> = {
  confirmed: {
    subject: (property) => `Viewing confirmed: ${property}`,
    heading: "Viewing confirmed",
    lead: "The realtor confirmed your viewing. Put it in your calendar.",
    status: "Confirmed",
    tone: "verified",
  },
  declined: {
    subject: (property) => `Viewing declined: ${property}`,
    heading: "Viewing declined",
    lead: "The realtor cannot make this viewing. You can propose another time on the listing.",
    status: "Declined",
    tone: "disputed",
  },
  completed: {
    subject: (property) => `Viewing closed: ${property}`,
    heading: "Viewing closed",
    lead: "The realtor marked this viewing as done.",
    status: "Done",
    tone: "neutral",
  },
};

/** To the buyer, when the realtor answers. */
export const sendInspectionDecided = (
  to: string,
  inspection: InspectionBrief,
  outcome: keyof typeof OUTCOMES,
): void => {
  const result = OUTCOMES[outcome];

  notify(inspection.ref, () =>
    sendEmail({
      to,
      subject: result.subject(inspection.property),
      ...layout({
        eyebrow: "Viewings",
        preheader: `${result.lead} ${when(inspection)}.`,
        reason: SEEKER_REASON,
        blocks: [
          heading(result.heading),
          lead(result.lead),
          viewingSlip(inspection, result.status, result.tone),
          ...(inspection.message
            ? [quote(`From ${inspection.person}`, inspection.message)]
            : []),
          button("Open viewing", seekerLink(inspection)),
        ],
      }),
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
      ...layout({
        eyebrow: "Viewings",
        preheader: `It was booked for ${when(inspection)}.`,
        reason: by === "seeker" ? LISTER_REASON : SEEKER_REASON,
        blocks: [
          heading("Viewing cancelled"),
          lead(
            by === "seeker"
              ? `${inspection.person} cancelled their viewing.`
              : `${inspection.person} cancelled this viewing.`,
          ),
          viewingSlip(inspection, "Cancelled", "disputed"),
          button(
            "Open viewing",
            by === "seeker" ? realtorLink(inspection) : seekerLink(inspection),
          ),
        ],
      }),
    }),
  );

/* ---------------------------------------------------------------- *
 * Payments
 * ---------------------------------------------------------------- */

export interface PaymentBrief {
  reference: string;
  /** The plan's display name, so a receipt reads "Professional", not "professional". */
  plan: string;
  amount: number;
  /** How they paid: card, bank transfer, USSD. Whatever Flutterwave reported. */
  channel: string;
  periodEnd: Date;
}

const naira = new Intl.NumberFormat("en-NG", {
  style: "currency",
  currency: "NGN",
  maximumFractionDigits: 0,
});

/** Flutterwave reports `card`, `bank_transfer`, `ussd`; a receipt says "Card", "Bank transfer", "USSD". */
const channelName = (channel: string): string => {
  if (channel.toLowerCase() === "ussd") return "USSD";
  const words = channel.replace(/[_-]+/g, " ").toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Lagos, for the same reason a viewing time is: the reader is here. */
const until = (date: Date): string =>
  new Intl.DateTimeFormat("en-NG", {
    dateStyle: "full",
    timeZone: "Africa/Lagos",
  }).format(date);

/**
 * To the realtor, once money has actually cleared.
 *
 * A notification rather than a transactional send: by the time this fires the payment
 * is banked and the plan is already active, so a Resend outage must never turn a
 * successful charge into a failed request.
 */
export const sendPaymentReceipt = (to: string, payment: PaymentBrief): void =>
  notify(payment.reference, () =>
    sendEmail({
      to,
      subject: `Receipt for your ${payment.plan} plan`,
      ...layout({
        eyebrow: "Receipt",
        preheader: `${naira.format(payment.amount)} paid. Your ${payment.plan} plan runs until ${until(payment.periodEnd)}.`,
        reason: "You're getting this because you paid for an INSPECTRA plan.",
        blocks: [
          heading("Payment received"),
          lead("Your payment went through. Thank you."),
          slip({
            ref: payment.reference,
            status: "Paid",
            tone: "verified",
            title: `${payment.plan} plan`,
            lines: [`Runs until ${until(payment.periodEnd)}`],
          }),
          rows([
            ["Amount", naira.format(payment.amount)],
            ["Paid by", channelName(payment.channel)],
          ]),
          button("View subscription", `${envConfig.CLIENT_URL}/realtor/subscription`),
        ],
      }),
    }),
  );


export default sendEmail;
