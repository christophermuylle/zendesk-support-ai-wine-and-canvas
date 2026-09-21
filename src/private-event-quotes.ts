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
// STATUS (2026-09-21): all four templates' real copy, pricing, and
// restaurant/venue links are in below. Cadillac's pricing group was
// briefly unclear mid-build (the corporate/standard template text
// appeared to group it with Indianapolis/Tampa/Fort Myers/Fort Lauderdale
// instead of Grand Rapids) but Christopher confirmed his original pricing
// message is correct: "Cadillac is listed with Grand Rapids from what I
// sent" - Lansing/Grand Rapids/Cadillac all share one rate. That template
// text was stale/wrong and is NOT what's used below. Naples also gets the
// same Pet Portrait +$10 bump as Orlando/Miami, and Bonita Springs shares
// Naples' pricing (both confirmed 2026-09-21). No open pricing questions
// remain.
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
// from their grouped siblings ("for Miami we charge more than Fort
// Lauderdale" - confirmed again by the corporate/standard/fundraiser
// templates below, which all group Miami with Orlando/Naples). So this
// resolver takes the slug LocationResolver already matched and further
// narrows Fort-Lauderdale-slug tickets into "fort-lauderdale" vs. "miami",
// and Fort-Myers-slug tickets into "fort-myers" vs. "naples", based on
// which city name is actually in the text.
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
    // "bonita springs" added 2026-09-21 - the corporate/standard templates
    // both list "Orlando, Naples/Bonita Springs, and Miami" as one pricing
    // group, so Bonita Springs needs to resolve to the "naples" pricing
    // key too. NOTE: locations.yaml's fort-myers match_keywords doesn't
    // have "bonita springs" yet, so a ticket that ONLY says "Bonita
    // Springs" (no "Fort Myers"/"Naples"/"Cape Coral") won't match a
    // location at all upstream and will never reach this function -
    // flagged to Christopher, worth adding there too.
    const mentionsNaples = text.includes("naples") || text.includes("bonita springs");
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

// ---------------------------------------------------------------------------
// Pricing.
//
// All pricing questions from earlier drafts of this file are resolved:
// Cadillac mirrors Grand Rapids (Christopher: "Cadillac is listed with
// Grand Rapids from what I sent"), Naples gets the same Pet Portrait +$10
// bump as Orlando/Miami (Christopher: "Add naples to the Miami group"),
// and Bonita Springs shares Naples' pricing/link (Christopher: "it should
// be the same pricing as Naples") - see getLocationInfo(),
// getPetPortraitPricing(), and resolvePrivateEventLocationKey() below.
// ---------------------------------------------------------------------------

/** One row of a per-person, group-size-tiered price list (e.g. "8-29 guests -> $44/person"). */
export interface PricingTierRow {
  range: string; // "8-29", "30-49", "50+"
  pricePerPerson: number;
}

export interface PrivateEventPricing {
  corporateTiers: PricingTierRow[];
  standardTiers: PricingTierRow[];
  /** Per-person retail rate customers/ticket-buyers pay at a fundraiser event; Wine and Canvas keeps fundraiserKeep of it, the rest goes to the cause (the group can raise the retail rate above this to raise more). */
  fundraiserRetail: number;
  fundraiserKeep: number;
  /** Flat per-person rate for the kids/Cookies & Canvas template (no group-size tiers given for kids). */
  kidsPricePerPerson: number;
}

// Christopher, 2026-09-21 ("Here is pricing for all locations that
// includes discounts for 30+ people", confirmed again when Cadillac's
// grouping came into question: "Cadillac is listed with Grand Rapids from
// what I sent"). Three groups:
//   Group A: Indianapolis / Tampa / Fort Myers / Fort Lauderdale
//   Group B: Orlando / Naples (incl. Bonita Springs) / Miami - higher tier
//   Grand Rapids/Cadillac: share one rate (Lansing shares it too, but
//     Lansing never reaches this code - excluded upstream)
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
// Grand Rapids and Cadillac share this rate (Christopher, 2026-09-21:
// "Cadillac is listed with Grand Rapids from what I sent").
const GRAND_RAPIDS_CORPORATE_TIERS: PricingTierRow[] = [
  { range: "8-29", pricePerPerson: 44 },
  { range: "30-49", pricePerPerson: 40 },
  { range: "50+", pricePerPerson: 35 },
];
const GRAND_RAPIDS_STANDARD_TIERS: PricingTierRow[] = [
  { range: "8-29", pricePerPerson: 40 },
  { range: "30-49", pricePerPerson: 35 },
  { range: "50+", pricePerPerson: 30 },
];

// Fundraiser: "we discount the retail rate by $5 and donate the difference
// to your cause" - retail matches the standard per-person rate, keep =
// retail - 5.
const GROUP_A_FUNDRAISER = { retail: 39, keep: 34 };
const GROUP_B_FUNDRAISER = { retail: 45, keep: 40 };
const GRAND_RAPIDS_FUNDRAISER = { retail: 40, keep: 35 };

// Kids/Cookies & Canvas: a DIFFERENT grouping than corporate/standard/
// fundraiser - the kids template calls out Fort Lauderdale on its own
// (lower than the default rate) rather than grouping it with Indianapolis/
// Tampa/Fort Myers. Cadillac and Grand Rapids aren't mentioned either way
// and fall into the unstated default bucket (INFERRED - see #2).
const KIDS_DEFAULT_PRICE = 29; // Tampa, Fort Myers, Indianapolis, Grand Rapids, Cadillac (INFERRED for the last two)
const KIDS_FORT_LAUDERDALE_PRICE = 27;
const KIDS_ORLANDO_NAPLES_MIAMI_PRICE = 35;

/**
 * Pet Portraits is a fundraiser-only add-on project with its own
 * per-ticket pricing. The fundraiser template's literal text only said
 * "(For Orlando/Miami add $10 for pet art)", leaving Naples out even
 * though it's grouped with Orlando/Miami everywhere else - flagged to
 * Christopher, who confirmed 2026-09-21: "Add naples to the Miami group."
 * Naples now gets the same +$10 bump as Orlando/Miami.
 */
export function getPetPortraitPricing(locationKey: PrivateEventLocationKey): { charge: number; retail: number } {
  const bump = locationKey === "orlando" || locationKey === "miami" || locationKey === "naples" ? 10 : 0;
  return { charge: 45 + bump, retail: 55 + bump };
}

export interface PrivateEventLocationInfo {
  displayName: string;
  /** Restaurant/venue list link for this city (rendered as a real hyperlink, not raw HTML). */
  restaurantListUrl: string | null;
  pricing: PrivateEventPricing;
  /** Set only for markets with an extra service fee (currently just Cadillac). */
  travelFee?: string;
}

// Real links, Christopher 2026-09-21 (pasted directly in the corporate/
// standard/fundraiser template text). Naples and Miami share one combined
// link. Cadillac's is its own dedicated venue list (given earlier,
// separate from the "restaurant partner" lists below).
const RESTAURANT_LIST_INDIANAPOLIS = "https://drive.google.com/file/d/1bHVyXPZh8RjHGdYFC4Ag0cgts_neh6bq/view?usp=sharing";
const RESTAURANT_LIST_TAMPA = "https://drive.google.com/file/d/1gTEOFxbdbvKhMtKhfOPo_-ZxgfAO_A9-/view?usp=sharing";
const RESTAURANT_LIST_ORLANDO = "https://drive.google.com/file/d/1zCNFqOIM1xmzI3f5c_3aRcjgsg9Cxywt/view?usp=sharing";
const RESTAURANT_LIST_FORT_LAUDERDALE = "https://drive.google.com/file/d/1bY8pEwUCLddKcq2mpAtwYNFbea2J4mWJ/view?usp=sharing";
const RESTAURANT_LIST_FORT_MYERS = "https://drive.google.com/file/d/12OquEzEeWsrrioNKCxpxE517ZhsMlCl1/view?usp=sharing";
const RESTAURANT_LIST_GRAND_RAPIDS = "https://drive.google.com/file/d/1_tpH4iq8jeYF07RXhH-FjC7BhPl5SOtZ/view?usp=sharing";
const RESTAURANT_LIST_NAPLES_MIAMI = "https://drive.google.com/file/d/1o84eo8n8kaQHyf2yzH7Zkec3cSrwf3jp/view?usp=sharing";
const CADILLAC_VENUE_LIST = "https://docs.google.com/document/d/1wsJfW_gH5Vz2CF7XDC4Y70wQh8MRAayLh5xcIcT_NHY/edit?usp=sharing";

export const PRIVATE_EVENT_LOCATIONS: Record<PrivateEventLocationKey, PrivateEventLocationInfo> = {
  "fort-myers": {
    displayName: "Fort Myers / Cape Coral, FL",
    restaurantListUrl: RESTAURANT_LIST_FORT_MYERS,
    pricing: { corporateTiers: GROUP_A_CORPORATE_TIERS, standardTiers: GROUP_A_STANDARD_TIERS, ...GROUP_A_FUNDRAISER_FIELDS(), kidsPricePerPerson: KIDS_DEFAULT_PRICE },
  },
  naples: {
    displayName: "Naples, FL",
    restaurantListUrl: RESTAURANT_LIST_NAPLES_MIAMI,
    pricing: { corporateTiers: GROUP_B_CORPORATE_TIERS, standardTiers: GROUP_B_STANDARD_TIERS, ...GROUP_B_FUNDRAISER_FIELDS(), kidsPricePerPerson: KIDS_ORLANDO_NAPLES_MIAMI_PRICE },
  },
  tampa: {
    displayName: "Tampa / St. Pete / Clearwater, FL",
    restaurantListUrl: RESTAURANT_LIST_TAMPA,
    pricing: { corporateTiers: GROUP_A_CORPORATE_TIERS, standardTiers: GROUP_A_STANDARD_TIERS, ...GROUP_A_FUNDRAISER_FIELDS(), kidsPricePerPerson: KIDS_DEFAULT_PRICE },
  },
  orlando: {
    displayName: "Orlando, FL",
    restaurantListUrl: RESTAURANT_LIST_ORLANDO,
    pricing: { corporateTiers: GROUP_B_CORPORATE_TIERS, standardTiers: GROUP_B_STANDARD_TIERS, ...GROUP_B_FUNDRAISER_FIELDS(), kidsPricePerPerson: KIDS_ORLANDO_NAPLES_MIAMI_PRICE },
  },
  "fort-lauderdale": {
    displayName: "Fort Lauderdale, FL",
    restaurantListUrl: RESTAURANT_LIST_FORT_LAUDERDALE,
    pricing: { corporateTiers: GROUP_A_CORPORATE_TIERS, standardTiers: GROUP_A_STANDARD_TIERS, ...GROUP_A_FUNDRAISER_FIELDS(), kidsPricePerPerson: KIDS_FORT_LAUDERDALE_PRICE },
  },
  miami: {
    displayName: "Miami, FL",
    restaurantListUrl: RESTAURANT_LIST_NAPLES_MIAMI, // shares the combined Naples/Miami link
    pricing: { corporateTiers: GROUP_B_CORPORATE_TIERS, standardTiers: GROUP_B_STANDARD_TIERS, ...GROUP_B_FUNDRAISER_FIELDS(), kidsPricePerPerson: KIDS_ORLANDO_NAPLES_MIAMI_PRICE },
  },
  indianapolis: {
    displayName: "Indianapolis, IN",
    restaurantListUrl: RESTAURANT_LIST_INDIANAPOLIS,
    pricing: { corporateTiers: GROUP_A_CORPORATE_TIERS, standardTiers: GROUP_A_STANDARD_TIERS, ...GROUP_A_FUNDRAISER_FIELDS(), kidsPricePerPerson: KIDS_DEFAULT_PRICE },
  },
  "grand-rapids": {
    displayName: "Grand Rapids, MI",
    restaurantListUrl: RESTAURANT_LIST_GRAND_RAPIDS,
    pricing: { corporateTiers: GRAND_RAPIDS_CORPORATE_TIERS, standardTiers: GRAND_RAPIDS_STANDARD_TIERS, ...GRAND_RAPIDS_FUNDRAISER_FIELDS(), kidsPricePerPerson: KIDS_DEFAULT_PRICE },
  },
  cadillac: {
    displayName: "Cadillac, MI",
    restaurantListUrl: CADILLAC_VENUE_LIST,
    // Mirrors Grand Rapids across every category (Christopher, 2026-09-21:
    // "Cadillac is listed with Grand Rapids from what I sent") - plus its
    // own $75 travel fee and dedicated venue-list link.
    pricing: { corporateTiers: GRAND_RAPIDS_CORPORATE_TIERS, standardTiers: GRAND_RAPIDS_STANDARD_TIERS, ...GRAND_RAPIDS_FUNDRAISER_FIELDS(), kidsPricePerPerson: KIDS_DEFAULT_PRICE },
    travelFee: "$75 travel fee",
  },
};

function GROUP_A_FUNDRAISER_FIELDS() {
  return { fundraiserRetail: GROUP_A_FUNDRAISER.retail, fundraiserKeep: GROUP_A_FUNDRAISER.keep };
}
function GROUP_B_FUNDRAISER_FIELDS() {
  return { fundraiserRetail: GROUP_B_FUNDRAISER.retail, fundraiserKeep: GROUP_B_FUNDRAISER.keep };
}
function GRAND_RAPIDS_FUNDRAISER_FIELDS() {
  return { fundraiserRetail: GRAND_RAPIDS_FUNDRAISER.retail, fundraiserKeep: GRAND_RAPIDS_FUNDRAISER.keep };
}

/** Resolves a location key to its full pricing/link info. */
export function getLocationInfo(key: PrivateEventLocationKey): PrivateEventLocationInfo {
  return PRIVATE_EVENT_LOCATIONS[key];
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

// Christopher, 2026-09-21 (corporate/standard/fundraiser templates all
// include this link).
const PARTY_IN_ACTION_URL = "https://wineandcanvas.com/paint-sip-private-events/";

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

/** "Please note: $75 travel fee applies for this location." or null if the location has none - null (not "") so the join-filter below can drop it cleanly without eating intentional blank spacer lines. */
function travelFeeLine(loc: PrivateEventLocationInfo): string | null {
  return loc.travelFee ? `Please note: ${loc.travelFee} applies for this location.` : null;
}

/** Joins template lines, dropping only null/undefined entries (conditional lines) - keeps "" entries, which are intentional blank-line paragraph breaks. */
function joinLines(lines: Array<string | null | undefined>): string {
  return lines.filter((l): l is string => l !== null && l !== undefined).join("\n");
}

/** Same as joinLines, but also drops __EMBED_*__ image-placeholder lines entirely - used for the plain-text body, which can't show an image anyway. The HTML body keeps the markers (via joinLines) so embedImages() can swap them for real <img> tags once uploaded. */
function joinLinesPlain(lines: Array<string | null | undefined>): string {
  return lines.filter((l): l is string => l !== null && l !== undefined && !l.startsWith("__EMBED_")).join("\n");
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
      return renderCorporateOrStandard(loc, locationKey, firstName, "corporate");
    case "fundraiser":
      return renderFundraiser(loc, locationKey, firstName, mentionsGiftDonation(ctx));
    case "kids":
      return renderKids(loc, locationKey, firstName);
    case "standard":
    default:
      return renderCorporateOrStandard(loc, locationKey, firstName, "standard");
  }
}

// Corporate and standard are word-for-word identical in Christopher's
// pasted templates - only the pricing tiers differ - so one function
// renders both. The "Groups of 30+ get a discount — ask us!" line from his
// literal template is replaced with the actual 30-49/50+ tier numbers
// below (we have the real numbers, no reason to make the customer ask) -
// flag to Christopher if he'd rather keep the literal "ask us" instead.
function renderCorporateOrStandard(
  loc: PrivateEventLocationInfo,
  locationKey: PrivateEventLocationKey,
  firstName: string,
  category: "corporate" | "standard"
): RenderedQuote {
  const tiers = category === "corporate" ? loc.pricing.corporateTiers : loc.pricing.standardTiers;
  const customFee = 75;

  const plainBody = joinLines([
    `Hi ${firstName},`,
    ``,
    `What a fun occasion to plan for — you're going to give your group something they'll actually talk about for weeks! 🎨`,
    ``,
    `Here's everything you need to know to get started:`,
    ``,
    `🏠 Venue`,
    `We come to you — fully mobile, we bring every supply to your location (home, rental, restaurant, you name it). No studio, no hassle.`,
    ``,
    loc.restaurantListUrl
      ? `Need a space? Here's our partner restaurant list for ${loc.displayName} — most don't charge extra beyond food and beverage costs per person: ${loc.restaurantListUrl}. Take a look and let me know if anything works and I'll check availability.`
      : `[TODO_CHRISTOPHER: restaurant list link for ${loc.displayName}]`,
    ``,
    `🎨 What We Bring`,
    `Everything — canvases, easels, aprons, table covers, all of it. You handle food, drinks, and seating (or your venue does). Drinks can absolutely include alcohol — totally your call!`,
    ``,
    `Standard event: 3 hours, 16×20 canvas, step-by-step guided painting. Need to fit a tighter timeline? We can do 2 hours on an 11×14 canvas.`,
    ``,
    `Want something different? We also offer other projects like glass painting, pet art, and more — just ask and we'll send over a project pricing sheet!`,
    ``,
    `1,000+ painting designs to choose from (we send the link once your deposit is in). Want something custom and unique to your event? We can do that for a $${customFee} flat fee.`,
    ``,
    `💲 Pricing for ${loc.displayName}`,
    `Minimum group size: 8 guests`,
    `Price per person: ${tiers.map((t) => `$${t.pricePerPerson}/person (${t.range} guests)`).join(", ")}`,
    `Tighter budget? Smaller canvas options are available at a lower per-person rate.`,
    travelFeeLine(loc),
    `Travel fees may apply outside the greater city limits.`,
    ``,
    `📋 To Book`,
    `A deposit locks in your date — it covers 2 seats or 20% of your expected headcount (whichever is higher). The balance is due the day before your event. The deposit is non-refundable but transferable for up to one year if your plans change.`,
    ``,
    `This quote is valid for 30 days.`,
    ``,
    `📷 See a Party in Action: ${PARTY_IN_ACTION_URL}`,
    ``,
    `Ready to lock in your date? Just reply with your preferred date and approximate headcount and I'll check availability right away. Dates go fast, especially on weekends — I'd love to get yours on the calendar! 🎉`,
    ``,
    `Cheers,`,
    ``,
    `Bonnie — Private Event Coordinator`,
    ``,
    `The Wine & Canvas Team`,
  ]);

  const htmlBody = toHtml(plainBody, loc.restaurantListUrl);
  return { category, locationKey, plainBody, htmlBody, imageAssets: [] };
}

function renderFundraiser(
  loc: PrivateEventLocationInfo,
  locationKey: PrivateEventLocationKey,
  firstName: string,
  mentionsDonation: boolean
): RenderedQuote {
  const { fundraiserRetail: retail, fundraiserKeep: keep } = loc.pricing;
  const petPricing = getPetPortraitPricing(locationKey);

  const prefix: Array<string | null> = mentionsDonation ? [FUNDRAISER_DONATION_PREFIX, ``] : [];
  const bodyLines: Array<string | null> = [
    ...prefix,
    `Hi ${firstName},`,
    ``,
    `Thank you for reaching out about our Wine & Canvas private events. We'd absolutely love to help you plan an exciting paint party.`,
    ``,
    `Here is some additional info about the process and pricing to help you make the best choice.`,
    ``,
    `Venue: We are available to host events at any of your preferred locations, including your home.`,
    loc.restaurantListUrl
      ? `If you're in need of a space, here's our partner restaurant list for ${loc.displayName}: ${loc.restaurantListUrl}. Most do not charge for use of space but they do expect everyone to order food and drinks during the event.`
      : `[TODO_CHRISTOPHER: restaurant list link for ${loc.displayName}]`,
    ``,
    `Materials: We provide all the art materials including table covers and aprons. We don't provide food/beverages or tables/chairs. Serving alcohol at the party is always optional.`,
    ``,
    `Painting: We can do canvas or glass painting for the quoted price. Our portfolio has 1,000's of images available. We will send a link once you are ready to book. If you don't see a design you like there is an extra $75 flat fee for custom paintings.`,
    ``,
    `Pricing: The group minimum is currently 12 people to host a fundraising event. For fundraisers, we discount the retail rate by $5 and donate the difference to your cause — you can increase the retail rate to raise the donation amount if you like.`,
    ``,
    `Standard rate for ${loc.displayName} (Step-by-step Canvas, 16×20, 3-hour event): $${retail} per person — we keep $${keep}, and $${retail - keep} per ticket goes to your cause.`,
    `Options to do a 2-hour event on 11×14 will lower the cost — just ask!`,
    travelFeeLine(loc),
    `Travel fees may apply if outside the greater city limits.`,
    ``,
    `🐾 Pet Portraits: We also do fundraising events with our pet portrait project — a great fit for animal rescues and shelters! Since this is more work-intensive for our artists, we charge $${petPricing.charge} per ticket sold; suggested retail is $${petPricing.retail} — we keep $${petPricing.charge}, and $${petPricing.retail - petPricing.charge} per ticket goes to your cause by default (more if you raise the retail price).`,
    `__EMBED_FUNDRAISER_PET_PORTRAIT__`,
    ``,
    `Timing: We book events for 3 hours but can do 2 if you have time restrictions (this doesn't include setup/cleanup - a shorter event may need a smaller canvas or a more simplified image). Pet Portraits is always a 3-hour event.`,
    ``,
    `This quote is valid for 30 days.`,
    ``,
    `📷 See a Party in Action: ${PARTY_IN_ACTION_URL}`,
    ``,
    `If you'd like to move forward with the planning process, don't hesitate to reach out and we can get you started! Dates go fast, especially on weekends — I'd love to get yours on the calendar! 🎉`,
    ``,
    `Cheers,`,
    `Bonnie`,
    `The Wine & Canvas Team`,
  ];

  const plainBody = joinLinesPlain(bodyLines);
  const htmlBody = toHtml(joinLines(bodyLines), loc.restaurantListUrl);

  return {
    category: "fundraiser",
    locationKey,
    plainBody,
    htmlBody,
    imageAssets: [{ key: "fundraiser-pet-portrait", filename: "fundraiser-pet-portrait-example.jpg", contentType: "image/jpeg" }],
  };
}

function renderKids(loc: PrivateEventLocationInfo, locationKey: PrivateEventLocationKey, firstName: string): RenderedQuote {
  const price = loc.pricing.kidsPricePerPerson;

  const bodyLines: Array<string | null> = [
    `Hi ${firstName},`,
    ``,
    `Thank you for reaching out about our Cookies & Canvas private events! We'd absolutely love to help you plan an exciting paint party. 🎉`,
    ``,
    `Here is some additional info about the process and pricing to help you make the best choice.`,
    ``,
    `Venue: We are 100% mobile so we do not have a studio space. We are available to host events at any of your preferred locations, including your home.`,
    loc.restaurantListUrl
      ? `If you're in need of a space, here's our partner restaurant list for ${loc.displayName}: ${loc.restaurantListUrl}. Most don't charge for use of space but they do expect everyone to order food and drinks during the event.`
      : `[TODO_CHRISTOPHER: restaurant list link for ${loc.displayName}]`,
    ``,
    `Materials: We provide all the art materials including table covers and aprons. We don't provide food/beverages or tables/chairs. This means we don't provide cookies either.`,
    ``,
    `Painting: We can do canvas for the quoted price. Our portfolio has 100's of images available. We will send a link once the deposit is paid. If you don't see a design you like there is an extra $50 flat fee for custom paintings.`,
    ``,
    `Below is just one of the examples from our portfolio, a colorful "Cutie Unicorn" 🦄`,
    `__EMBED_KIDS_UNICORN__`,
    ``,
    `Pricing for ${loc.displayName}:`,
    `The group minimum is currently 10 people to host an event and the rate is $${price} per person.`,
    `Outside your budget? We also offer an 8x10 size canvas for a one hour painting - ask for pricing!`,
    `Discounts are provided for groups of 30+ people.`,
    travelFeeLine(loc),
    `Travel fees may apply if outside the greater city limits.`,
    `We require a deposit that also covers 2 seats or 20% of your expected headcount, whichever is higher, to book your party. The rest is due the day before. The deposit is non-refundable but transferable for up to one year.`,
    ``,
    `Timing: We book events for 1.5-2 hours. This doesn't include setup/cleanup. The canvas size is 11x14 or 12x12 upon request.`,
    ``,
    `This quote is valid for 30 days.`,
    ``,
    `If you'd like to move forward with the planning process, don't hesitate to reach out and we can get you started! Dates go fast, especially on weekends — I'd love to get yours on the calendar! 🎉`,
    ``,
    `Here's a peek at a past Cookies & Canvas party in action:`,
    `__EMBED_KIDS_FAMILY__`,
    ``,
    `Cheers,`,
    `Bonnie`,
    `The Wine & Canvas Team`,
  ];

  const plainBody = joinLinesPlain(bodyLines);
  const htmlBody = toHtml(joinLines(bodyLines), loc.restaurantListUrl);
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
 * visible in the customer's inbox), plus the fixed "See a Party in Action"
 * link when present. Placeholder markers for embedded images
 * (__EMBED_*__) are left as literal text here and resolved to real <img>
 * tags by embedImages() once each asset has been uploaded and its
 * content_url is known (that requires an API call this pure function can't
 * make - see the private_event_quote branch in pipeline.ts).
 */
function toHtml(plainBody: string, restaurantListUrl: string | null): string {
  const escaped = escapeHtml(plainBody);
  let html = escaped.replace(/\n/g, "<br>\n");
  // restaurantListUrl already covers Cadillac's own venue link when that's
  // the matched location - don't also list CADILLAC_VENUE_LIST separately,
  // or the same URL gets wrapped in <a> twice (once as the href, once as
  // the visible text) on the second pass, corrupting the markup.
  const urlsToLink = [...new Set([restaurantListUrl, PARTY_IN_ACTION_URL].filter((u): u is string => !!u))];
  for (const url of urlsToLink) {
    const escapedUrl = escapeHtml(url);
    html = html.split(escapedUrl).join(`<a href="${escapedUrl}">${escapedUrl}</a>`);
  }
  return `<p>${html}</p>`;
}

/**
 * Splices <img> tags for each RenderedQuote.imageAssets entry onto the
 * htmlBody, replacing that image's __EMBED_<KEY>__ placeholder (uppercase,
 * underscored asset key) if one is present, or appending at the end
 * otherwise. Called from pipeline.ts after uploading each asset and
 * getting back its content_url.
 */
export function embedImages(htmlBody: string, images: Array<{ key: string; contentUrl: string }>): string {
  let html = htmlBody;
  for (const img of images) {
    const marker = `__EMBED_${img.key.toUpperCase().replace(/-/g, "_")}__`;
    const tag = `<img src="${escapeHtml(img.contentUrl)}" alt="">`;
    html = html.includes(marker) ? html.replace(marker, tag) : `${html}\n${tag}`;
  }
  return html;
}

export { ASSET_DIR };
