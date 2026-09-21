// Mechanical (non-AI) private-event quote templates for Wine and Canvas.
// Triggered by the "private_event_quote" rule action (config/rules.yaml's
// event_booking_question rule) and rendered in the "private_event_quote"
// branch of src/pipeline.ts - no AI call, deterministic keyword
// classification + a literal template, matching this codebase's existing
// order_confirmation / newsletter_signup mechanical-action pattern.
//
// Christopher, 2026-09-21: "We need to now work on Wine and Canvas private
// event requests. There are more rules for this brand... You classify it
// as keywords in the inquiry form." Four categories, each with its own
// literal template: corporate, fundraiser, kids ("Cookies & Canvas", ages
// 16 and under), and standard (everything else).
//
// ****************************************************************************
// STATUS (2026-09-21): the classification engine, location/pricing
// resolution (including the Miami/Fort-Lauderdale and Naples/Fort-Myers
// splits and Cadillac's Grand-Rapids-equivalent pricing), image embedding,
// and hyperlink rendering below are built and wired into the pipeline.
// The actual customer-facing TEMPLATE COPY - the exact wording, prices,
// and restaurant/venue links for each city Christopher pasted earlier in
// this project - is NOT included below (marked TODO_CHRISTOPHER
// throughout). That content was in an earlier part of this conversation
// that aged out of context before this file was written, and guessing at
// real prices/links for a customer-facing quote would be worse than
// leaving it blank. Do not flip PRIVATE_EVENT_QUOTES_LIVE to true, and do
// not treat this as done, until every TODO_CHRISTOPHER block has been
// replaced with his actual approved copy.
// ****************************************************************************

import type { TicketContext } from "./types.js";
import { getTicketMatchText } from "./util.js";

export type PrivateEventCategory = "kids" | "fundraiser" | "corporate" | "standard";

// ---------------------------------------------------------------------------
// Classification - keyword-matched against the ticket subject + latest
// customer message (same text util.getTicketMatchText already builds for
// rules.ts/locations.ts), NOT AI-classified (Christopher was explicit about
// this - Painting and Vino uses AI classification for its private-event
// categories, but Wine and Canvas's simpler codebase does keyword matching
// instead).
//
// Priority when more than one set matches (e.g. a corporate-sounding
// message that also mentions a kid's age): kids > fundraiser > corporate >
// standard. This ordering is my own assumption, not something Christopher
// specified - he confirmed each keyword set individually but never said
// which should win when they overlap. Flagging this the same way the
// Lansing/Kalamazoo wording was flagged: reasonable default, confirm with
// Christopher if a real ticket ever gets misclassified because of it.
// ---------------------------------------------------------------------------

// Confirmed verbatim by Christopher, 2026-09-21: "Things like: staff,
// office, employees, team building, team bonding, company event, corporate
// would all get this quote."
const CORPORATE_KEYWORDS = [
  "staff",
  "office",
  "employees",
  "team building",
  "team bonding",
  "company event",
  "corporate",
];

// Christopher approved this starting set ("Yes, cast the similar wide net
// for both") - not an exhaustive confirmed list, broaden as real tickets
// reveal gaps, same as the out_of_scope_location wording.
const FUNDRAISER_KEYWORDS = ["fundraiser", "charity", "nonprofit", "non-profit", "rescue", "donate", "donation", "cause"];

// Same "wide net" approval as fundraiser - starting set, not exhaustive.
const KIDS_KEYWORDS = ["kids party", "kid's party", "kids' party", "birthday", "children", "sweet 16", "sweet sixteen"];

// Catches "turning 10", "10th birthday", "10 year old" / "10-year-old" for
// ages 16 and under (Christopher: kids template covers "ages 16 and
// under"). Deliberately only matches 1-16 so a "17th birthday" or an adult
// milestone birthday doesn't get miscategorized as the kids template.
const KIDS_AGE_PATTERN = /\b(?:turning\s+)?(1[0-6]|[1-9])(?:st|nd|rd|th)?\s*[- ]?(?:years?|yrs?)?[- ]?(?:old\b|birthday\b)/i;

/** True if the inquiry mentions "donate"/"donation" - triggers the fundraiser template's gift-certificate-donation disclaimer prefix (see FUNDRAISER_DONATION_PREFIX below). */
export function mentionsGiftDonation(ctx: TicketContext): boolean {
  const text = getTicketMatchText(ctx);
  return text.includes("donat"); // catches donate/donation/donating, same plain-substring convention as the rest of this codebase
}

export function classifyPrivateEvent(ctx: TicketContext): PrivateEventCategory {
  const text = getTicketMatchText(ctx);

  if (KIDS_KEYWORDS.some((k) => text.includes(k)) || KIDS_AGE_PATTERN.test(text)) {
    return "kids";
  }
  if (FUNDRAISER_KEYWORDS.some((k) => text.includes(k))) {
    return "fundraiser";
  }
  if (CORPORATE_KEYWORDS.some((k) => text.includes(k))) {
    return "corporate";
  }
  return "standard";
}

// ---------------------------------------------------------------------------
// Location/pricing resolution.
//
// This is DELIBERATELY finer-grained than src/locations.ts's LocationResolver:
// locations.yaml groups "Fort Myers / Cape Coral / Naples" under one slug
// (fort-myers) and "Fort Lauderdale / Miami" under one slug
// (fort-lauderdale), because for the AI knowledge-base system they share a
// single location page. But for private-event PRICING specifically,
// Christopher was explicit that Miami and Naples are priced differently
// from their grouped siblings:
//   - "Yes, for Miami we charge more then Fort Lauderdale" (Miami groups
//     with Orlando/Naples pricing instead)
//   - Naples/Miami share one combined restaurant-list link, separate from
//     Fort Myers's and Fort Lauderdale's own links.
// So this resolver takes the slug LocationResolver already matched and
// further narrows Fort-Lauderdale-slug tickets into "fort-lauderdale" vs.
// "miami", and Fort-Myers-slug tickets into "fort-myers" vs. "naples",
// based on which city name is actually in the text.
//
// Kalamazoo and Lansing are never reached here - the out_of_scope_location
// rule in rules.yaml excludes them before a ticket ever gets to
// event_booking_question.
// ---------------------------------------------------------------------------

export type PrivateEventLocationKey =
  | "fort-myers"
  | "naples"
  | "tampa"
  | "orlando"
  | "fort-lauderdale"
  | "miami"
  | "indianapolis"
  | "grand-rapids"
  | "cadillac";

/**
 * Narrows a locations.yaml slug match down to the finer-grained pricing key
 * above. Returns null if the slug isn't one this private-event system has
 * pricing for yet (shouldn't happen for the 9 managed locations, but fails
 * safe rather than guessing).
 */
export function resolvePrivateEventLocationKey(ctx: TicketContext, matchedSlug: string): PrivateEventLocationKey | null {
  const text = getTicketMatchText(ctx);

  if (matchedSlug === "fort-lauderdale") {
    const mentionsMiami = text.includes("miami");
    const mentionsFtLauderdale = text.includes("fort lauderdale") || text.includes("ft lauderdale") || text.includes("ft. lauderdale");
    return mentionsMiami && !mentionsFtLauderdale ? "miami" : "fort-lauderdale";
  }
  if (matchedSlug === "fort-myers") {
    const mentionsNaples = text.includes("naples");
    const mentionsFtMyers = text.includes("fort myers") || text.includes("ft myers") || text.includes("cape coral");
    return mentionsNaples && !mentionsFtMyers ? "naples" : "fort-myers";
  }
  if (
    matchedSlug === "tampa" ||
    matchedSlug === "orlando" ||
    matchedSlug === "indianapolis" ||
    matchedSlug === "grand-rapids" ||
    matchedSlug === "cadillac"
  ) {
    return matchedSlug;
  }
  return null;
}

/** One row of a per-person, group-size-tiered price list (e.g. "8-29 guests -> $44/person"). */
export interface PricingTierRow {
  range: string; // "8-29", "30-49", "50+"
  pricePerPerson: number;
}

export interface PrivateEventPricing {
  corporateTiers: PricingTierRow[] | null;
  standardTiers: PricingTierRow[] | null;
  // Fundraiser and kids pricing work differently (retail/keep split for
  // fundraiser, flat rate for kids) and haven't been sent yet.
  fundraiserRetail: string | null; // TODO_CHRISTOPHER
  fundraiserKeep: string | null; // TODO_CHRISTOPHER
  kidsPrice: string | null; // TODO_CHRISTOPHER
}

export interface PrivateEventLocationInfo {
  displayName: string;
  /** Restaurant/venue list link for this city (rendered as a real hyperlink, not raw HTML). */
  restaurantListUrl: string | null;
  pricing: PrivateEventPricing;
  /** Set only for markets with an extra service fee (currently just Cadillac). */
  travelFee?: string;
}

// Real per-person discount tiers, Christopher 2026-09-21 ("Here is pricing
// for all locations that includes discounts for 30+ people"). Three
// pricing groups, each covering several cities:
//   Group A: Tampa / Fort Myers / Indianapolis / Ft Lauderdale
//   Group B: Orlando / Naples / Miami (higher tier - confirms Christopher's
//     earlier "for Miami we charge more than Fort Lauderdale")
//   Group C: Lansing / Grand Rapids / Cadillac (Lansing itself never
//     reaches this code - excluded upstream by out_of_scope_location - but
//     its rate is recorded here in case that scope ever changes)
// Kept as separate named constants per group (even where two groups'
// numbers happen to match, like Group A and Group C corporate) so editing
// one group's rate later can't accidentally move another group with it.
const GROUP_A_CORPORATE_TIERS: PricingTierRow[] = [
  { range: "8-29", pricePerPerson: 44 },
  { range: "30-49", pricePerPerson: 40 },
  { range: "50+", pricePerPerson: 35 },
];
const GROUP_A_STANDARD_TIERS: PricingTierRow[] = [
  { range: "8-29", pricePerPerson: 39 },
  { range: "30-49", pricePerPerson: 35 },
  { range: "50+", pricePerPerson: 30 },
];
const GROUP_B_CORPORATE_TIERS: PricingTierRow[] = [
  { range: "8-29", pricePerPerson: 50 },
  { range: "30-49", pricePerPerson: 45 },
  { range: "50+", pricePerPerson: 40 },
];
const GROUP_B_STANDARD_TIERS: PricingTierRow[] = [
  { range: "8-29", pricePerPerson: 45 },
  { range: "30-49", pricePerPerson: 40 },
  { range: "50+", pricePerPerson: 35 },
];
const GROUP_C_CORPORATE_TIERS: PricingTierRow[] = [
  { range: "8-29", pricePerPerson: 44 },
  { range: "30-49", pricePerPerson: 40 },
  { range: "50+", pricePerPerson: 35 },
];
const GROUP_C_STANDARD_TIERS: PricingTierRow[] = [
  { range: "8-29", pricePerPerson: 40 },
  { range: "30-49", pricePerPerson: 35 },
  { range: "50+", pricePerPerson: 30 },
];

// TODO_CHRISTOPHER: fundraiser (retail/keep) and kids pricing haven't been
// sent yet - corporate/standard tiers above are real. Restaurant/venue
// list links are still placeholders except Cadillac's (the real one you
// gave me: https://docs.google.com/document/d/1wsJfW_gH5Vz2CF7XDC4Y70wQh8MRAayLh5xcIcT_NHY/edit?usp=sharing).
export const PRIVATE_EVENT_LOCATIONS: Record<PrivateEventLocationKey, PrivateEventLocationInfo> = {
  "fort-myers": {
    displayName: "Fort Myers / Cape Coral, FL",
    restaurantListUrl: null,
    pricing: { corporateTiers: GROUP_A_CORPORATE_TIERS, standardTiers: GROUP_A_STANDARD_TIERS, fundraiserRetail: null, fundraiserKeep: null, kidsPrice: null },
  },
  naples: {
    displayName: "Naples, FL",
    restaurantListUrl: null, // shares a restaurant link with Miami per Christopher
    pricing: { corporateTiers: GROUP_B_CORPORATE_TIERS, standardTiers: GROUP_B_STANDARD_TIERS, fundraiserRetail: null, fundraiserKeep: null, kidsPrice: null },
  },
  tampa: {
    displayName: "Tampa / St. Pete / Clearwater, FL",
    restaurantListUrl: null,
    pricing: { corporateTiers: GROUP_A_CORPORATE_TIERS, standardTiers: GROUP_A_STANDARD_TIERS, fundraiserRetail: null, fundraiserKeep: null, kidsPrice: null },
  },
  orlando: {
    displayName: "Orlando, FL",
    restaurantListUrl: null,
    pricing: { corporateTiers: GROUP_B_CORPORATE_TIERS, standardTiers: GROUP_B_STANDARD_TIERS, fundraiserRetail: null, fundraiserKeep: null, kidsPrice: null },
  },
  "fort-lauderdale": {
    displayName: "Fort Lauderdale, FL",
    restaurantListUrl: null,
    pricing: { corporateTiers: GROUP_A_CORPORATE_TIERS, standardTiers: GROUP_A_STANDARD_TIERS, fundraiserRetail: null, fundraiserKeep: null, kidsPrice: null },
  },
  miami: {
    displayName: "Miami, FL",
    restaurantListUrl: null, // prices like Orlando/Naples, NOT Fort Lauderdale; shares restaurant link with Naples
    pricing: { corporateTiers: GROUP_B_CORPORATE_TIERS, standardTiers: GROUP_B_STANDARD_TIERS, fundraiserRetail: null, fundraiserKeep: null, kidsPrice: null },
  },
  indianapolis: {
    displayName: "Indianapolis, IN",
    restaurantListUrl: null,
    pricing: { corporateTiers: GROUP_A_CORPORATE_TIERS, standardTiers: GROUP_A_STANDARD_TIERS, fundraiserRetail: null, fundraiserKeep: null, kidsPrice: null },
  },
  "grand-rapids": {
    displayName: "Grand Rapids, MI",
    restaurantListUrl: null,
    pricing: { corporateTiers: GROUP_C_CORPORATE_TIERS, standardTiers: GROUP_C_STANDARD_TIERS, fundraiserRetail: null, fundraiserKeep: null, kidsPrice: null },
  },
  cadillac: {
    displayName: "Cadillac, MI",
    restaurantListUrl: "https://docs.google.com/document/d/1wsJfW_gH5Vz2CF7XDC4Y70wQh8MRAayLh5xcIcT_NHY/edit?usp=sharing",
    // Christopher, 2026-09-21: "We don't have a current licensee in
    // Cadillac. We can service it but it would be a $75 travel fee and
    // same rates as Grand Rapids." / "Yes, Cadillac gets same pricing as
    // Grand Rapids for all templates." - pricing resolved at lookup time
    // in getLocationInfo() below (copies grand-rapids' pricing), not
    // duplicated here so the two markets can't drift out of sync. Also
    // matches the Group C rate Christopher sent directly.
    pricing: { corporateTiers: GROUP_C_CORPORATE_TIERS, standardTiers: GROUP_C_STANDARD_TIERS, fundraiserRetail: null, fundraiserKeep: null, kidsPrice: null },
    travelFee: "$75 travel fee",
  },
};

/** Resolves a location key to its full pricing/link info, applying Cadillac's "same as Grand Rapids" rule. */
export function getLocationInfo(key: PrivateEventLocationKey): PrivateEventLocationInfo {
  const info = PRIVATE_EVENT_LOCATIONS[key];
  if (key === "cadillac") {
    return { ...info, pricing: PRIVATE_EVENT_LOCATIONS["grand-rapids"].pricing };
  }
  return info;
}

// ---------------------------------------------------------------------------
// Template rendering.
// ---------------------------------------------------------------------------

/** First name for the "Hi [First Name]," greeting - falls back to "there" if we only have a full name or nothing. */
export function getFirstName(ctx: TicketContext): string {
  const name = ctx.requester?.name?.trim();
  if (!name) return "there";
  return name.split(/\s+/)[0];
}

// Confirmed final wording, Christopher 2026-09-21 (after his edit: "Great,
// I would just take out 'outside' and leave the rest"). Prepended to the
// fundraiser template whenever the inquiry mentions "donate"/"donation" -
// some of those inquiries are actually free-gift-certificate requests, not
// real fundraiser bookings.
export const FUNDRAISER_DONATION_PREFIX = `Thanks so much for thinking of us! Unfortunately we're not able to offer free gift certificate donations for events. We'd love to help in a different way though — hosting a fundraising event of your own is something we do often, and it's a great way to raise money for your cause. Here's how that works:`;

export interface RenderedQuote {
  category: PrivateEventCategory;
  locationKey: PrivateEventLocationKey;
  /** Plain-text version (used for the internal-review note, and as Zendesk's non-HTML comment.body fallback). */
  plainBody: string;
  /** HTML version with real <a href> hyperlinks - see zendesk.ts's postComment htmlBody support. */
  htmlBody: string;
  /** Local asset files (under assets/private-events/) this template embeds - uploaded via ZendeskClient.uploadFile at send time. */
  imageAssets: Array<{ key: string; filename: string; contentType: string }>;
}

const ASSET_DIR = "assets/private-events";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Renders "$75 travel fee applies for this location." or "" if the location has none. */
function travelFeeLine(loc: PrivateEventLocationInfo): string {
  return loc.travelFee ? `Please note: ${loc.travelFee} applies for this location.` : "";
}

/** Renders a group-size-tiered per-person price list, e.g. "8-29 guests: $44/person\n30-49 guests: $40/person\n50+ guests: $35/person". */
function formatTiers(tiers: PricingTierRow[] | null, label: string): string {
  if (!tiers) return `[TODO_CHRISTOPHER: ${label} pricing not set yet]`;
  return tiers.map((t) => `  ${t.range} guests: $${t.pricePerPerson}/person`).join("\n");
}

export function renderPrivateEventQuote(
  ctx: TicketContext,
  category: PrivateEventCategory,
  locationKey: PrivateEventLocationKey
): RenderedQuote {
  const loc = getLocationInfo(locationKey);
  const firstName = getFirstName(ctx);

  switch (category) {
    case "corporate":
      return renderCorporate(loc, locationKey, firstName);
    case "fundraiser":
      return renderFundraiser(loc, locationKey, firstName, mentionsGiftDonation(ctx));
    case "kids":
      return renderKids(loc, locationKey, firstName);
    case "standard":
    default:
      return renderStandard(loc, locationKey, firstName);
  }
}

// TODO_CHRISTOPHER: every template body below is placeholder copy standing
// in for your real corporate/standard/fundraiser/kids templates (with the
// personalized-greeting, 30-day-validity, urgency-closer, "See a Party in
// Action" link, and embedded-photo revisions you approved). Please resend
// the four templates verbatim and I'll drop your exact wording in here in
// place of these placeholders - this scaffolding (classification, per-city
// pricing/link filtering, image embedding, hyperlink rendering) is ready
// for it.

function renderCorporate(loc: PrivateEventLocationInfo, locationKey: PrivateEventLocationKey, firstName: string): RenderedQuote {
  const plainBody = [
    `Hi ${firstName},`,
    ``,
    `Thanks for thinking of Wine and Canvas for your corporate/team event in ${loc.displayName}! [TODO_CHRISTOPHER: real corporate template body]`,
    ``,
    `Pricing for ${loc.displayName} (per person, based on group size):`,
    formatTiers(loc.pricing.corporateTiers, "corporate"),
    loc.restaurantListUrl ? `Restaurant/venue list: ${loc.restaurantListUrl}` : `[TODO_CHRISTOPHER: restaurant list link for ${loc.displayName}]`,
    travelFeeLine(loc),
    ``,
    `This quote is valid for 30 days.`,
    ``,
    `Dates go fast, especially on weekends — I'd love to get yours on the calendar! 🎉`,
  ]
    .filter(Boolean)
    .join("\n");

  const htmlBody = toHtml(plainBody, loc.restaurantListUrl);
  return { category: "corporate", locationKey, plainBody, htmlBody, imageAssets: [] };
}

function renderStandard(loc: PrivateEventLocationInfo, locationKey: PrivateEventLocationKey, firstName: string): RenderedQuote {
  const plainBody = [
    `Hi ${firstName},`,
    ``,
    `Thanks for reaching out about a private event with Wine and Canvas in ${loc.displayName}! [TODO_CHRISTOPHER: real standard template body]`,
    ``,
    `Pricing for ${loc.displayName} (per person, based on group size):`,
    formatTiers(loc.pricing.standardTiers, "standard"),
    loc.restaurantListUrl ? `Restaurant/venue list: ${loc.restaurantListUrl}` : `[TODO_CHRISTOPHER: restaurant list link for ${loc.displayName}]`,
    travelFeeLine(loc),
    ``,
    `This quote is valid for 30 days.`,
    ``,
    `Dates go fast, especially on weekends — I'd love to get yours on the calendar! 🎉`,
  ]
    .filter(Boolean)
    .join("\n");

  const htmlBody = toHtml(plainBody, loc.restaurantListUrl);
  return { category: "standard", locationKey, plainBody, htmlBody, imageAssets: [] };
}

function renderFundraiser(
  loc: PrivateEventLocationInfo,
  locationKey: PrivateEventLocationKey,
  firstName: string,
  mentionsDonation: boolean
): RenderedQuote {
  const retail = loc.pricing.fundraiserRetail ?? "[TODO_CHRISTOPHER: fundraiser retail price for " + loc.displayName + "]";
  const keep = loc.pricing.fundraiserKeep ?? "[TODO_CHRISTOPHER: fundraiser keep amount for " + loc.displayName + "]";

  const bodyLines = [
    `Hi ${firstName},`,
    ``,
    `Thanks for thinking of Wine and Canvas for your fundraiser in ${loc.displayName}! [TODO_CHRISTOPHER: real fundraiser template body, incl. Pet Portraits paragraph]`,
    ``,
    `Fundraiser pricing for ${loc.displayName}: retail ${retail}, your group keeps ${keep}`,
    loc.restaurantListUrl ? `Restaurant/venue list: ${loc.restaurantListUrl}` : `[TODO_CHRISTOPHER: restaurant list link for ${loc.displayName}]`,
    travelFeeLine(loc),
    ``,
    `📷 See a Party in Action: [TODO_CHRISTOPHER: link]`,
    ``,
    `This quote is valid for 30 days.`,
    ``,
    `Dates go fast, especially on weekends — I'd love to get yours on the calendar! 🎉`,
  ].filter(Boolean);

  const plainBody = (mentionsDonation ? [FUNDRAISER_DONATION_PREFIX, ``] : []).concat(bodyLines).join("\n");
  const htmlBody = toHtml(plainBody, loc.restaurantListUrl);

  return {
    category: "fundraiser",
    locationKey,
    plainBody,
    htmlBody,
    imageAssets: [{ key: "fundraiser-pet-portrait", filename: "fundraiser-pet-portrait-example.jpg", contentType: "image/jpeg" }],
  };
}

function renderKids(loc: PrivateEventLocationInfo, locationKey: PrivateEventLocationKey, firstName: string): RenderedQuote {
  const price = loc.pricing.kidsPrice ?? "[TODO_CHRISTOPHER: kids/Cookies & Canvas price for " + loc.displayName + "]";
  const plainBody = [
    `Hi ${firstName},`,
    ``,
    `Thanks for thinking of Wine and Canvas's Cookies & Canvas for your event in ${loc.displayName}! [TODO_CHRISTOPHER: real kids template body]`,
    ``,
    `Pricing for ${loc.displayName}: ${price}`,
    loc.restaurantListUrl ? `Restaurant/venue list: ${loc.restaurantListUrl}` : `[TODO_CHRISTOPHER: restaurant list link for ${loc.displayName}]`,
    travelFeeLine(loc),
    ``,
    `This quote is valid for 30 days.`,
    ``,
    `Dates go fast, especially on weekends — I'd love to get yours on the calendar! 🎉`,
  ]
    .filter(Boolean)
    .join("\n");

  const htmlBody = toHtml(plainBody, loc.restaurantListUrl);
  return {
    category: "kids",
    locationKey,
    plainBody,
    htmlBody,
    imageAssets: [
      { key: "kids-unicorn", filename: "kids-unicorn-example.jpg", contentType: "image/jpeg" },
      { key: "kids-family", filename: "kids-family-example.png", contentType: "image/png" },
    ],
  };
}

/**
 * Converts a plain-text body into an HTML version with the restaurant/venue
 * link rendered as a real <a href> hyperlink (Christopher: "Make sure you
 * hyperlink instead of using HTML link" - i.e. don't leave raw markup
 * visible in the customer's inbox). <img> tags for embedded photos are
 * spliced in separately by the pipeline once the image has been uploaded
 * and its content_url is known (see the private_event_quote branch in
 * pipeline.ts), since that requires an API call this pure function can't
 * make.
 */
function toHtml(plainBody: string, restaurantListUrl: string | null): string {
  const escaped = escapeHtml(plainBody);
  let html = escaped.replace(/\n/g, "<br>\n");
  if (restaurantListUrl) {
    const escapedUrl = escapeHtml(restaurantListUrl);
    html = html.replace(escapedUrl, `<a href="${escapedUrl}">${escapedUrl}</a>`);
  }
  return `<p>${html}</p>`;
}

/** Splices <img> tags for the given uploaded content URLs onto the end of an htmlBody. Called from pipeline.ts after uploading each RenderedQuote.imageAssets entry. */
export function embedImages(htmlBody: string, imageContentUrls: string[]): string {
  if (!imageContentUrls.length) return htmlBody;
  const imgs = imageContentUrls.map((url) => `<img src="${escapeHtml(url)}" alt="">`).join("\n");
  return `${htmlBody}\n${imgs}`;
}

export { ASSET_DIR };
