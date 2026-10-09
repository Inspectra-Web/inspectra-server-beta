import { Resend } from "resend";
import envConfig from "../config/env.config.js";
import AppError from "../error/app.error.js";
import User from "../models/user.model.js";
import { button, heading, layout, lead, list, note, quote, rows, slip, } from "../templates/email.template.js";
const resend = new Resend(envConfig.RESEND_API_KEY);
/** The SDK reports failures in `error` rather than throwing, so raise it here. */
const sendEmail = async ({ to, subject, html, text }) => {
    const { error } = await resend.emails.send({
        from: `INSPECTRA <${envConfig.RESEND_EMAIL}>`,
        to,
        subject,
        html,
        text,
    });
    if (error)
        throw new AppError(`Email delivery failed: ${error.message}`, 502);
};
/** Names are stored lowercased, so title-case them as the client does: "ada obi" -> "Ada Obi". */
const displayName = (fullname) => fullname
    .split(/s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
const ACCOUNT_REASON = "You're getting this because this address was used to sign up on INSPECTRA.";
export const sendVerifyEmail = (to, url) => sendEmail({
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
export const sendResetEmail = (to, url) => sendEmail({
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
            note("This link expires in 30 minutes. If you did not ask for this, ignore this email and your password stays the same."),
        ],
    }),
});
/**
 * After the address is confirmed, so it only reaches someone who can sign in. A
 * realtor's next step is the identity check that stands between them and a listing;
 * a seeker's is the marketplace.
 */
export const sendWelcome = (to, role) => notify(to, () => sendEmail({
    to,
    subject: "Welcome to INSPECTRA",
    ...layout({
        eyebrow: "Account",
        preheader: role === "realtor"
            ? "Your email is confirmed. Verify your identity to start listing."
            : "Your email is confirmed. Every listing here shows its verification status.",
        reason: ACCOUNT_REASON,
        blocks: role === "realtor"
            ? [
                heading("Welcome to INSPECTRA"),
                lead("Your email is confirmed. Before you can list, complete your profile and verify your identity with your NIN and BVN. Buyers see that check on every listing you post."),
                button("Verify your identity", `${envConfig.CLIENT_URL}/realtor/verification`),
            ]
            : [
                heading("Welcome to INSPECTRA"),
                lead("Your email is confirmed. Every listing here carries its verification status, so you can see what has been checked before you book a viewing."),
                button("Browse listings", `${envConfig.CLIENT_URL}/listings`),
            ],
    }),
}));
/**
 * Either way the password changed, from settings or through a reset link. The one
 * person who needs this is the owner who did not do it, so it says what to do then.
 */
export const sendPasswordChanged = (to) => notify(to, () => sendEmail({
    to,
    subject: "Your INSPECTRA password was changed",
    ...layout({
        eyebrow: "Security",
        preheader: "If this wasn't you, reset your password now.",
        reason: ACCOUNT_REASON,
        blocks: [
            heading("Your password was changed"),
            lead("The password on your account was just changed, and every other session was signed out."),
            note("If this wasn't you, reset your password straight away."),
            button("Reset password", `${envConfig.CLIENT_URL}/forgot-password`),
        ],
    }),
}));
/** An admin moved the account. Without this the first a user hears of a suspension
 *  is a login that fails. A realtor is also told their listings came off the site. */
export const sendAccountStatus = (to, status, role) => notify(to, () => sendEmail({
    to,
    subject: status === "suspended"
        ? "Your INSPECTRA account is suspended"
        : "Your INSPECTRA account is active again",
    ...layout({
        eyebrow: "Account",
        preheader: status === "suspended"
            ? "You can no longer sign in."
            : "You can sign in again.",
        reason: ACCOUNT_REASON,
        blocks: status === "suspended"
            ? [
                heading("Your account is suspended"),
                lead(role === "realtor"
                    ? "An INSPECTRA admin suspended your account. You can no longer sign in, and your listings are off the site until it is reactivated."
                    : "An INSPECTRA admin suspended your account. You can no longer sign in."),
                note(`If you think this is a mistake, write to ${envConfig.SUPPORT_EMAIL}.`),
            ]
            : [
                heading("Your account is active again"),
                lead(role === "realtor"
                    ? "An INSPECTRA admin reactivated your account. You can sign in again, and your listings are back on the site."
                    : "An INSPECTRA admin reactivated your account. You can sign in again."),
                button("Sign in", `${envConfig.CLIENT_URL}/login`),
            ],
    }),
}));
/** The last rung of the identity check. It is what puts the badge on the realtor and
 *  what unlocks listing, so the mail points at the listing form. */
export const sendIdentityVerified = (to) => notify(to, () => sendEmail({
    to,
    subject: "Your identity is verified",
    ...layout({
        eyebrow: "Identity",
        preheader: "Your NIN and BVN check out. You can list properties now.",
        reason: "You're getting this because you verified your identity on INSPECTRA.",
        blocks: [
            heading("Your identity is verified"),
            lead("Your NIN and BVN match. Buyers now see you as a verified realtor, and you can list properties."),
            button("List a property", `${envConfig.CLIENT_URL}/realtor/listings/new`),
        ],
    }),
}));
/** To every admin, when a realtor account is created. Sent at sign-up, so the address
 *  is not confirmed yet and the mail says so. */
export const sendRealtorJoined = (realtor) => notify(realtor.email, async () => {
    const to = await adminEmails();
    if (!to.length)
        return;
    await sendEmail({
        to,
        subject: `New realtor: ${displayName(realtor.name)}`,
        ...layout({
            eyebrow: "Realtors",
            preheader: `${displayName(realtor.name)} signed up as a realtor.`,
            reason: "You're getting this because you are an INSPECTRA admin.",
            blocks: [
                heading("New realtor signed up"),
                lead(`${displayName(realtor.name)} created a realtor account.`),
                rows([
                    ["Name", displayName(realtor.name)],
                    ["Email", realtor.email],
                ]),
                note("Their email is not confirmed yet, and they still have to verify their identity before they can list."),
                button("View realtor", `${envConfig.CLIENT_URL}/admin/realtors/${realtor.id}`),
            ],
        }),
    });
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
const notify = (ref, send) => {
    void send().catch((error) => {
        console.error(`Notification failed for ${ref}:`, error);
    });
};
/** Every active admin: the queue is shared, so the work is offered to all of them. */
const adminEmails = async () => {
    const admins = await User.find({ role: "admin", status: "active" }).select("email");
    return admins.map((admin) => admin.email);
};
const LISTER_REASON = "You're getting this because you list properties on INSPECTRA.";
const adminListing = (listing, subject, title, intro, status) => notify(listing.ref, async () => {
    const to = await adminEmails();
    // No admin seeded yet, or every one of them suspended. Nobody to tell, and an
    // empty recipient list is a 422 from Resend rather than a quiet no-op.
    if (!to.length)
        return;
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
                    lines: [`${listing.city}, ${listing.state}`, `Realtor: ${displayName(listing.realtor)}`],
                }),
                button("Review listing", `${envConfig.CLIENT_URL}/admin/verification/${listing.id}`),
            ],
        }),
    });
});
export const sendListingSubmitted = (listing) => adminListing(listing, `New listing to verify: ${listing.title}`, "New listing to verify", "A realtor submitted a listing. It is waiting on verification.", "Pending");
/**
 * `recheck` is the load-bearing half. An edit to a listing already in the queue is
 * routine; one that pulled a live badge means a checked asset changed behind it.
 */
export const sendListingUpdated = (listing, recheck) => adminListing(listing, recheck
    ? `Verified listing changed: ${listing.title}`
    : `Listing updated: ${listing.title}`, recheck ? "Verified listing changed" : "Listing updated", recheck
    ? "A realtor changed a listing that had already been checked. Its badge is back to pending, so it needs another review."
    : "A realtor updated a listing that is waiting on verification.", recheck ? "Recheck" : "Pending");
const VERDICTS = {
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
export const sendListingReviewed = (to, listing, status, note, flagged) => {
    const verdict = VERDICTS[status];
    const blocks = [
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
                list("Documents to fix", flagged.map((doc) => ({ name: doc.name, detail: doc.reason })), verdict.tone),
            ]
            : []),
        button("Open listing", `${envConfig.CLIENT_URL}/realtor/listings/${listing.id}`),
    ];
    notify(listing.ref, () => sendEmail({
        to,
        subject: verdict.subject(listing.title),
        ...layout({
            eyebrow: "Verification",
            preheader: `${listing.title}. ${verdict.lead}`,
            reason: LISTER_REASON,
            blocks,
        }),
    }));
};
/**
 * To the realtor, when a buyer writes. `first` separates a new inquiry from a
 * follow-up on a thread they have already seen, the way `recheck` does above.
 */
export const sendInquiryReceived = (to, inquiry, first) => notify(inquiry.ref, () => sendEmail({
    to,
    subject: first
        ? `New inquiry: ${inquiry.property}`
        : `New message: ${inquiry.property}`,
    ...layout({
        eyebrow: "Inquiries",
        preheader: `${displayName(inquiry.person)}: ${inquiry.message}`,
        reason: LISTER_REASON,
        blocks: [
            heading(first ? "New inquiry" : "New message"),
            lead(first
                ? `${displayName(inquiry.person)} asked about one of your listings.`
                : `${displayName(inquiry.person)} sent another message about one of your listings.`),
            slip({
                ref: inquiry.ref,
                status: first ? "Inquiry" : "Message",
                tone: "neutral",
                title: inquiry.property,
            }),
            quote(`From ${displayName(inquiry.person)}`, inquiry.message),
            button("Reply", `${envConfig.CLIENT_URL}/realtor/leads/${inquiry.id}`),
        ],
    }),
}));
/** To the buyer, when the realtor answers. */
export const sendInquiryReplied = (to, inquiry) => notify(inquiry.ref, () => sendEmail({
    to,
    subject: `Reply about ${inquiry.property}`,
    ...layout({
        eyebrow: "Inquiries",
        preheader: `${displayName(inquiry.person)}: ${inquiry.message}`,
        reason: "You're getting this because you asked a realtor about a listing on INSPECTRA.",
        blocks: [
            heading("You have a reply"),
            lead(`${displayName(inquiry.person)} replied to your inquiry.`),
            slip({ ref: inquiry.ref, status: "Reply", tone: "neutral", title: inquiry.property }),
            quote(`From ${displayName(inquiry.person)}`, inquiry.message),
            button("Open conversation", `${envConfig.CLIENT_URL}/dashboard/inquiries/${inquiry.id}`),
        ],
    }),
}));
/**
 * Listings and buyers are Nigerian and the viewing happens at the property, so the
 * time is written in Lagos regardless of where the server is. Reading it in UTC
 * would put a morning appointment an hour earlier than anyone agreed.
 */
const lagosTime = (slot) => new Intl.DateTimeFormat("en-NG", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Africa/Lagos",
}).format(slot);
const when = (inspection) => lagosTime(inspection.slot);
const realtorLink = (inspection) => `${envConfig.CLIENT_URL}/realtor/inspections/${inspection.id}`;
const seekerLink = (inspection) => `${envConfig.CLIENT_URL}/dashboard/inspections/${inspection.id}`;
const viewingSlip = (inspection, status, tone) => slip({
    ref: inspection.ref,
    status,
    tone,
    title: inspection.property,
    lines: [when(inspection)],
});
const SEEKER_REASON = "You're getting this because you booked a viewing on INSPECTRA.";
/** To the realtor, when a buyer books. */
export const sendInspectionRequested = (to, inspection) => notify(inspection.ref, () => sendEmail({
    to,
    subject: `Viewing requested: ${inspection.property}`,
    ...layout({
        eyebrow: "Viewings",
        preheader: `${displayName(inspection.person)} wants to view it on ${when(inspection)}.`,
        reason: LISTER_REASON,
        blocks: [
            heading("Viewing requested"),
            lead(`${displayName(inspection.person)} asked to view one of your listings.`),
            viewingSlip(inspection, "Requested", "pending"),
            ...(inspection.message ? [quote("Their note", inspection.message)] : []),
            button("Confirm or decline", realtorLink(inspection)),
            note("A request nobody answers expires on its own."),
        ],
    }),
}));
/** To the realtor, when the buyer moves the time. It is a fresh request, not an
 *  edit, so the mail says so: the old slot is no longer in their diary. */
export const sendInspectionRescheduled = (to, inspection) => notify(inspection.ref, () => sendEmail({
    to,
    subject: `Viewing moved: ${inspection.property}`,
    ...layout({
        eyebrow: "Viewings",
        preheader: `New time: ${when(inspection)}. It needs confirming again.`,
        reason: LISTER_REASON,
        blocks: [
            heading("Viewing moved"),
            lead(`${displayName(inspection.person)} moved their viewing, so it needs confirming again.`),
            viewingSlip(inspection, "New time", "pending"),
            button("Confirm or decline", realtorLink(inspection)),
        ],
    }),
}));
const OUTCOMES = {
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
export const sendInspectionDecided = (to, inspection, outcome) => {
    const result = OUTCOMES[outcome];
    notify(inspection.ref, () => sendEmail({
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
                    ? [quote(`From ${displayName(inspection.person)}`, inspection.message)]
                    : []),
                button("Open viewing", seekerLink(inspection)),
            ],
        }),
    }));
};
/** To whoever did not call it off. `by` is the party who cancelled, so the link
 *  goes to the other one's console. */
export const sendInspectionCancelled = (to, inspection, by) => notify(inspection.ref, () => sendEmail({
    to,
    subject: `Viewing cancelled: ${inspection.property}`,
    ...layout({
        eyebrow: "Viewings",
        preheader: `It was booked for ${when(inspection)}.`,
        reason: by === "seeker" ? LISTER_REASON : SEEKER_REASON,
        blocks: [
            heading("Viewing cancelled"),
            lead(by === "seeker"
                ? `${displayName(inspection.person)} cancelled their viewing.`
                : `${displayName(inspection.person)} cancelled this viewing.`),
            viewingSlip(inspection, "Cancelled", "disputed"),
            button("Open viewing", by === "seeker" ? realtorLink(inspection) : seekerLink(inspection)),
        ],
    }),
}));
/** To both sides, when a confirmed viewing lapses because the buyer never paid for it. */
export const sendInspectionUnpaid = (to, inspection, audience) => notify(inspection.ref, () => sendEmail({
    to,
    subject: `Viewing cancelled, not paid: ${inspection.property}`,
    ...layout({
        eyebrow: "Viewings",
        preheader: `It was booked for ${when(inspection)}.`,
        reason: audience === "realtor" ? LISTER_REASON : SEEKER_REASON,
        blocks: [
            heading("Viewing cancelled"),
            lead(audience === "seeker"
                ? "The inspection fee was not paid in time, so this viewing has been cancelled. You can book it again from the listing."
                : `${displayName(inspection.person)} did not pay the inspection fee in time, so this viewing has been cancelled and the time is free again.`),
            viewingSlip(inspection, "Cancelled", "disputed"),
            button("Open viewing", audience === "realtor" ? realtorLink(inspection) : seekerLink(inspection)),
        ],
    }),
}));
/** The day after a paid viewing: asks one side whether it happened. */
export const sendAttendanceCheck = (to, inspection, audience) => notify(inspection.ref, () => sendEmail({
    to,
    subject: `Did the viewing happen? ${inspection.property}`,
    ...layout({
        eyebrow: "Viewings",
        preheader: `It was booked for ${when(inspection)}.`,
        reason: audience === "realtor" ? LISTER_REASON : SEEKER_REASON,
        blocks: [
            heading("Did the viewing happen?"),
            lead(audience === "seeker"
                ? `Tell us whether your viewing with ${displayName(inspection.person)} went ahead. If you don't answer within 48 hours, the fee is paid to them as normal.`
                : `Tell us whether ${displayName(inspection.person)} came to the viewing. The fee is released to you once it is confirmed, or 48 hours from now if the buyer raises nothing.`),
            viewingSlip(inspection, "Awaiting confirmation", "pending"),
            button("Answer now", audience === "realtor" ? realtorLink(inspection) : seekerLink(inspection)),
        ],
    }),
}));
/** To the realtor, once their inspection fee has landed in their virtual account. */
export const sendFeeReleased = (to, inspection, amount) => notify(inspection.ref, () => sendEmail({
    to,
    subject: `Inspection fee paid: ${inspection.property}`,
    ...layout({
        eyebrow: "Payments",
        preheader: `₦${amount.toLocaleString("en-NG")} is in your virtual account.`,
        reason: LISTER_REASON,
        blocks: [
            heading("Your inspection fee is paid"),
            lead(`₦${amount.toLocaleString("en-NG")} for your viewing with ${displayName(inspection.person)} has been paid into your INSPECTRA virtual account.`),
            viewingSlip(inspection, "Paid", "verified"),
            button("Open viewing", realtorLink(inspection)),
        ],
    }),
}));
/** To the side that did not raise it: a paid viewing's money is on hold for review. */
export const sendDisputeNotice = (to, inspection, audience) => notify(inspection.ref, () => sendEmail({
    to,
    subject: `Viewing under review: ${inspection.property}`,
    ...layout({
        eyebrow: "Viewings",
        preheader: `It was booked for ${when(inspection)}.`,
        reason: audience === "realtor" ? LISTER_REASON : SEEKER_REASON,
        blocks: [
            heading("This viewing is under review"),
            lead(`${displayName(inspection.person)}'s account of this viewing differs from yours, so the fee is on hold while INSPECTRA reviews it. We will be in touch, and you will hear the outcome within 5 business days.`),
            viewingSlip(inspection, "Under review", "disputed"),
            button("Open viewing", audience === "realtor" ? realtorLink(inspection) : seekerLink(inspection)),
        ],
    }),
}));
/** To every admin, when a paid viewing's two sides disagree about what happened. */
export const sendDisputeOpened = (inspection, reason) => notify(inspection.ref, async () => {
    const to = await adminEmails();
    if (!to.length)
        return;
    await sendEmail({
        to,
        subject: `Dispute opened: ${inspection.property}`,
        ...layout({
            eyebrow: "Disputes",
            preheader: reason,
            reason: "You're getting this because you resolve disputes on INSPECTRA.",
            blocks: [
                heading("A viewing fee is in dispute"),
                lead(`${reason} The fee is frozen until an admin decides. Target: 5 business days.`),
                viewingSlip(inspection, "Disputed", "disputed"),
            ],
        }),
    });
});
/**
 * To a buyer, when the realtor deletes a listing they had business on. Both the
 * viewing and the thread drop out of the buyer's console with the listing, so this
 * mail is the only place they learn it. No link to either: both now answer 404.
 */
export const sendListingRemoved = (to, listing) => {
    const lost = [
        ...(listing.slot ? [`your viewing on ${lagosTime(listing.slot)} is cancelled`] : []),
        ...(listing.conversation ? ["your conversation with the realtor is closed"] : []),
    ].join(", and ");
    notify(listing.ref, () => sendEmail({
        to,
        subject: `Listing removed: ${listing.property}`,
        ...layout({
            eyebrow: listing.slot ? "Viewings" : "Inquiries",
            preheader: `The realtor took this listing down, so ${lost}.`,
            reason: listing.slot
                ? SEEKER_REASON
                : "You're getting this because you asked a realtor about a listing on INSPECTRA.",
            blocks: [
                heading("Listing removed"),
                lead(`The realtor took this listing down, so ${lost}.`),
                slip({
                    ref: listing.ref,
                    status: "Removed",
                    tone: "disputed",
                    title: listing.property,
                    lines: listing.slot ? [lagosTime(listing.slot)] : [],
                }),
                button("Browse listings", `${envConfig.CLIENT_URL}/listings`),
            ],
        }),
    }));
};
const naira = new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
});
/** Flutterwave reports `card`, `bank_transfer`, `ussd`; a receipt says "Card", "Bank transfer", "USSD". */
const channelName = (channel) => {
    if (channel.toLowerCase() === "ussd")
        return "USSD";
    const words = channel.replace(/[_-]+/g, " ").toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
};
/** Lagos, for the same reason a viewing time is: the reader is here. */
const until = (date) => new Intl.DateTimeFormat("en-NG", {
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
export const sendPaymentReceipt = (to, payment) => notify(payment.reference, () => sendEmail({
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
}));
/** To the realtor, once Planbok has opened the account. Sent once, not on a repeat open. */
export const sendVirtualAccountOpened = (to, account) => notify(to, () => sendEmail({
    to,
    subject: "Your virtual account is open",
    ...layout({
        eyebrow: "Virtual account",
        preheader: `Your NGN account ${account.accountNumber} at ${account.bankName} is ready.`,
        reason: "You're getting this because you opened a virtual account on INSPECTRA.",
        blocks: [
            heading("Your virtual account is open"),
            lead("Inspection fees you earn are paid into this account once each viewing is confirmed."),
            rows([
                ["Account number", account.accountNumber],
                ["Account name", account.accountName],
                ["Bank", account.bankName],
            ]),
            button("View account", `${envConfig.CLIENT_URL}/realtor/virtual-account`),
        ],
    }),
}));
export default sendEmail;
//# sourceMappingURL=email.service.js.map