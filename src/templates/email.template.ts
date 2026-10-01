import envConfig from "../config/env.config.js";

/** One piece of an email, written twice: the HTML part and the plain-text part. */
export interface Block {
  html: string;
  text: string;
}

export type Tone = "verified" | "pending" | "disputed" | "neutral";

const C = {
  canvas: "#F4F3EE",
  card: "#FFFFFF",
  stub: "#F8F7F2",
  line: "#E2E0D6",
  perforation: "#CFCBBD",
  ink: "#14212B",
  muted: "#55636F",
  faint: "#8A939E",
  night: "#071428",
  brand: "#1AACF0",
  brandLight: "#38D4FF",
  brandDeep: "#1565D8",
  link: "#0A6AA6",
  button: "#0A2636",
};

const TONES: Record<Tone, string> = {
  verified: "#0F9D6E",
  pending: "#B7791F",
  disputed: "#C2410C",
  neutral: "#55636F",
};

const DISPLAY = "'Bricolage Grotesque','Segoe UI',Helvetica,Arial,sans-serif";
const BODY = "'DM Sans','Segoe UI',Helvetica,Arial,sans-serif";

/** Names, messages and reviewer notes are user input: everything interpolated passes here. */
const escape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const multiline = (value: string): string => escape(value).replace(/\r?\n/g, "<br>");

const space = (px: number): string =>
  `<tr><td height="${px}" style="height:${px}px;font-size:0;line-height:0;">&nbsp;</td></tr>`;

const row = (inner: string, gap = 0): string =>
  `${gap ? space(gap) : ""}<tr><td class="px" style="padding:0 40px;">${inner}</td></tr>`;

export const heading = (value: string): Block => ({
  html: row(
    `<h1 class="t-ink" style="margin:0;font-family:${DISPLAY};font-size:26px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${C.ink};">${escape(value)}</h1>`,
  ),
  text: value,
});

export const lead = (value: string): Block => ({
  html: row(
    `<p class="t-muted" style="margin:0;font-family:${BODY};font-size:16px;line-height:1.6;color:${C.muted};">${escape(value)}</p>`,
    12,
  ),
  text: value,
});

/** Small print under an action: link expiry, "ignore this if it wasn't you". */
export const note = (value: string): Block => ({
  html: row(
    `<p class="t-faint" style="margin:0;font-family:${BODY};font-size:13px;line-height:1.6;color:${C.faint};">${escape(value)}</p>`,
    20,
  ),
  text: value,
});

interface Slip {
  ref: string;
  status: string;
  tone: Tone;
  title: string;
  lines?: string[];
}

/**
 * The ref slip: the record the email is about, as a ticket. The stub carries the ref and
 * its status, a dashed perforation, then the title and whatever identifies it.
 */
export const slip = ({ ref, status, tone, title, lines = [] }: Slip): Block => {
  const details = lines
    .map(
      (line) =>
        `<p class="t-muted" style="margin:6px 0 0;font-family:${BODY};font-size:14px;line-height:1.5;color:${C.muted};font-variant-numeric:tabular-nums;">${escape(line)}</p>`,
    )
    .join("");

  return {
    html: row(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="b-line" style="border:1px solid ${C.line};border-radius:12px;border-collapse:separate;">
        <tr>
          <td class="stack stub bg-stub" width="150" valign="top" style="width:150px;padding:18px 18px 18px 20px;background:${C.stub};border-radius:12px 0 0 12px;">
            <p class="t-faint" style="margin:0;font-family:${BODY};font-size:11px;line-height:1.4;letter-spacing:0.12em;text-transform:uppercase;color:${C.faint};">Ref</p>
            <p class="t-ink" style="margin:4px 0 0;font-family:${DISPLAY};font-size:15px;line-height:1.3;font-weight:700;color:${C.ink};font-variant-numeric:tabular-nums;overflow-wrap:anywhere;word-break:break-word;">${escape(ref)}</p>
            <p style="margin:12px 0 0;font-family:${BODY};font-size:11px;line-height:1.4;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${TONES[tone]};"><span style="display:inline-block;width:7px;height:7px;border-radius:7px;background:${TONES[tone]};vertical-align:middle;font-size:0;line-height:0;">&nbsp;</span>&nbsp;${escape(status)}</p>
          </td>
          <td class="stack slip-body bg-card" valign="top" style="padding:18px 20px;border-left:2px dashed ${C.perforation};background:${C.card};border-radius:0 12px 12px 0;">
            <p class="t-ink" style="margin:0;font-family:${DISPLAY};font-size:17px;line-height:1.35;font-weight:600;color:${C.ink};">${escape(title)}</p>
            ${details}
          </td>
        </tr>
      </table>`,
      24,
    ),
    text: [`${title}`, ...lines, `${ref} · ${status}`].join("\n"),
  };
};

/** A message or note quoted from a person, kept in their words. */
export const quote = (label: string, body: string): Block => ({
  html: row(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td class="bg-stub" style="padding:16px 20px;background:${C.stub};border-left:3px solid ${C.brand};border-radius:0 10px 10px 0;">
          <p class="t-faint" style="margin:0 0 6px;font-family:${BODY};font-size:11px;line-height:1.4;letter-spacing:0.12em;text-transform:uppercase;color:${C.faint};">${escape(label)}</p>
          <p class="t-ink" style="margin:0;font-family:${BODY};font-size:15px;line-height:1.6;color:${C.ink};">${multiline(body)}</p>
        </td>
      </tr>
    </table>`,
    20,
  ),
  text: `${label}:\n${body}`,
});

/** Named items that each need attention, such as the documents a reviewer flagged. */
export const list = (
  label: string,
  items: { name: string; detail: string }[],
  tone: Tone,
): Block => ({
  html: row(
    `<p class="t-faint" style="margin:0 0 4px;font-family:${BODY};font-size:11px;line-height:1.4;letter-spacing:0.12em;text-transform:uppercase;color:${C.faint};">${escape(label)}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${items
        .map(
          (item) => `<tr>
        <td width="14" valign="top" style="width:14px;padding:19px 0 0;font-size:0;line-height:0;"><span style="display:inline-block;width:6px;height:6px;border-radius:6px;background:${TONES[tone]};font-size:0;line-height:0;">&nbsp;</span></td>
        <td class="b-line" style="padding:10px 0;border-bottom:1px solid ${C.line};">
          <p class="t-ink" style="margin:0;font-family:${BODY};font-size:15px;line-height:1.5;font-weight:600;color:${C.ink};">${escape(item.name)}</p>
          <p class="t-muted" style="margin:2px 0 0;font-family:${BODY};font-size:14px;line-height:1.5;color:${C.muted};">${multiline(item.detail)}</p>
        </td>
      </tr>`,
        )
        .join("")}
    </table>`,
    20,
  ),
  text: `${label}:\n${items.map((item) => `- ${item.name}: ${item.detail}`).join("\n")}`,
});

/** Label and value pairs, such as the lines of a receipt. */
export const rows = (pairs: [string, string][]): Block => ({
  html: row(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${pairs
        .map(
          ([label, value]) => `<tr>
        <td class="b-line t-muted" style="padding:12px 0;border-bottom:1px solid ${C.line};font-family:${BODY};font-size:14px;line-height:1.5;color:${C.muted};">${escape(label)}</td>
        <td class="b-line t-ink" align="right" style="padding:12px 0 12px 16px;border-bottom:1px solid ${C.line};font-family:${BODY};font-size:15px;line-height:1.5;font-weight:600;color:${C.ink};font-variant-numeric:tabular-nums;word-break:break-word;">${escape(value)}</td>
      </tr>`,
        )
        .join("")}
    </table>`,
    20,
  ),
  text: pairs.map(([label, value]) => `${label}: ${value}`).join("\n"),
});

/** The one action an email asks for, with the raw link under it for clients that block buttons. */
export const button = (label: string, url: string): Block => ({
  html: `${row(
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btn">
      <tr>
        <td class="btn-cell" align="center" bgcolor="${C.button}" style="border-radius:10px;background:${C.button};">
          <a href="${escape(url)}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${BODY};font-size:15px;line-height:1.2;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:10px;">${escape(label)} &rarr;</a>
        </td>
      </tr>
    </table>`,
    28,
  )}${row(
    `<p class="t-faint" style="margin:0;font-family:${BODY};font-size:12px;line-height:1.6;color:${C.faint};">Button not working? Paste this link into your browser:<br><a class="lnk" href="${escape(url)}" target="_blank" style="color:${C.link};text-decoration:underline;word-break:break-all;">${escape(url)}</a></p>`,
    16,
  )}`,
  text: `${label}:\n${url}`,
});

const STYLES = `
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table { border-collapse:collapse; mso-table-lspace:0; mso-table-rspace:0; }
  a { color:${C.link}; }
  @media screen and (max-width:620px) {
    .container { width:100% !important; }
    .px { padding-left:20px !important; padding-right:20px !important; }
    .stack { display:block !important; width:100% !important; box-sizing:border-box; }
    .stub { border-radius:12px 12px 0 0 !important; }
    .slip-body { border-left:0 !important; border-top:2px dashed ${C.perforation} !important; border-radius:0 0 12px 12px !important; }
    .btn { width:100% !important; }
    .btn-cell a { display:block !important; }
    h1 { font-size:23px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .bg-canvas { background:#0B141B !important; }
    .bg-card { background:#101C25 !important; }
    .bg-stub { background:#16232E !important; }
    .b-line { border-color:#253540 !important; }
    .t-ink { color:#E9F0F4 !important; }
    .t-muted { color:#93A2AD !important; }
    .t-faint { color:#61717C !important; }
    .slip-body { border-color:#3A4C58 !important; }
    .btn-cell { background:${C.brand} !important; }
    .btn-cell a { color:${C.night} !important; }
    .lnk { color:#7AD4FF !important; }
  }
  [data-ogsc] .bg-canvas { background:#0B141B !important; }
  [data-ogsc] .bg-card { background:#101C25 !important; }
  [data-ogsc] .bg-stub { background:#16232E !important; }
  [data-ogsc] .t-ink { color:#E9F0F4 !important; }
  [data-ogsc] .t-muted { color:#93A2AD !important; }
`;

interface Layout {
  /** The area this email belongs to, shown in the header: Account, Listings, Viewings. */
  eyebrow: string;
  /** The line inboxes show after the subject. */
  preheader: string;
  blocks: Block[];
  /** Why this person received it, for the footer. */
  reason: string;
}

export const layout = ({ eyebrow, preheader, blocks, reason }: Layout): Block => {
  const site = envConfig.CLIENT_URL;
  const host = site.replace(/^https?:\/\//, "").replace(/\/$/, "");
  // Zero-width padding keeps the inbox preview from running on into the body copy.
  const filler = "&#847;&zwnj;&nbsp;".repeat(60);

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="x-apple-disable-message-reformatting">
<title>INSPECTRA</title>
<!--[if !mso]><!-->
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=DM+Sans:opsz,wght@9..40,400;9..40,600;9..40,700&display=swap" rel="stylesheet">
<!--<![endif]-->
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>${STYLES}</style>
</head>
<body class="bg-canvas" style="margin:0;padding:0;background:${C.canvas};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.canvas};opacity:0;">${escape(preheader)}${filler}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-canvas" style="background:${C.canvas};">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="container" style="width:600px;max-width:600px;">
        <tr>
          <td style="background:${C.night};border-radius:16px 16px 0 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td class="px" style="padding:22px 40px;font-family:${DISPLAY};font-size:17px;line-height:1;font-weight:800;letter-spacing:0.18em;color:#FFFFFF;">INSPECTRA</td>
                <td class="px" align="right" style="padding:22px 40px;font-family:${BODY};font-size:11px;line-height:1;letter-spacing:0.14em;text-transform:uppercase;color:${C.brandLight};">${escape(eyebrow)}</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td height="3" style="height:3px;font-size:0;line-height:0;background:${C.brand};background-image:linear-gradient(90deg,${C.brandLight},${C.brand} 45%,${C.brandDeep});">&nbsp;</td>
        </tr>
        <tr>
          <td class="bg-card b-line" style="background:${C.card};border:1px solid ${C.line};border-top:0;border-radius:0 0 16px 16px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${space(36)}
              ${blocks.map((block) => block.html).join("")}
              ${space(40)}
            </table>
          </td>
        </tr>
        <tr>
          <td class="px" style="padding:24px 40px 0;">
            <p class="t-faint" style="margin:0;font-family:${BODY};font-size:12px;line-height:1.7;color:${C.faint};">${escape(reason)}</p>
            <p class="t-faint" style="margin:8px 0 0;font-family:${BODY};font-size:12px;line-height:1.7;color:${C.faint};">INSPECTRA · Verified properties and verified realtors, across Nigeria · <a class="lnk" href="${escape(site)}" target="_blank" style="color:${C.link};text-decoration:none;">${escape(host)}</a></p>
          </td>
        </tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [
    "INSPECTRA",
    ...blocks.map((block) => block.text),
    "--",
    reason,
    site,
  ].join("\n\n");

  return { html, text };
};
