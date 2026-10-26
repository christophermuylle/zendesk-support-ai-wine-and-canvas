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
import { extractFormContactName, firstNameFromFullName, getTicketMatchText, keywordMatches } from "./util.js";

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
  "employee",
  "coworker",
];

// Christopher approved this starting set ("Yes, cast the similar wide net
// for both") - not an exhaustive confirmed list, broaden as real tickets
// reveal gaps, same as the out_of_scope_location wording.
// The inflected forms at the end were supplied accidentally by substring
// matching. Now that this list is matched as whole tokens they must be
// spelled out, or "donations" and "fundraising" would stop matching.
const FUNDRAISER_KEYWORDS = [
  "fundraiser",
  "charity",
  "nonprofit",
  "non-profit",
  "rescue",
  "donate",
  "donation",
  "cause",
  "fundraisers",
  "fundraising",
  "charities",
  "nonprofits",
  "rescues",
  "donates",
  "donating",
  "donated",
  "donations",
];

// Same "wide net" approval as fundraiser - starting set, not exhaustive.
// NO bare "birthday" here. It was in this list until 2026-10-05, and because
// classifyPrivateEvent checks kids FIRST it meant every birthday inquiry got
// the Cookies & Canvas quote whatever the guest's age - Christopher reported a
// 55-year-old's party being quoted as a kids' event (#29784). It also made
// KIDS_AGE_PATTERN below dead code: that regex exists precisely so an adult
// milestone birthday is not miscategorised, and it never got the chance to
// run. Adult birthdays fall through to STANDARD_KEYWORDS, which already
// listed "birthday".
//
// Kid birthdays are caught two ways instead: the explicit phrases below, and
// KIDS_AGE_PATTERN for a stated age of 16 or under. Painting and Vino never
// had the bare word and its phrase list is the model for this one.
const KIDS_KEYWORDS = [
  "kids party",
  "kid's party",
  "kids' party",
  "children's party",
  "childrens party",
  "kids birthday",
  "kid's birthday",
  "kids' birthday",
  "children's birthday",
  "childrens birthday",
  "child's birthday",
  "childs birthday",
  "son's birthday",
  "sons birthday",
  "daughter's birthday",
  "daughters birthday",
  "children",
  "sweet 16",
  "sweet sixteen",
  "cookies and canvas",
  "cookies & canvas",
  "girls and boys",
  "boys and girls",
  "kids event",
  "kids' event",
  "for the kids",
  "for my kids",
];

// Catches "turning 10", "10th birthday", "10 year old" / "10-year-old" for
// ages 16 and under (Christopher: kids template covers "ages 16 and
// under"). Deliberately only matches 1-16 so a "17th birthday" or an adult
// milestone birthday doesn't get miscategorized as the kids template.
// Two shapes, because the first one alone missed the commonest wording.
//
//  (a) "turning 10", "turns 8" - the age with NOTHING after it. The original
//      pattern had an optional "turning" prefix but still required "old" or
//      "birthday" to follow the number, so "the birthday girl will be turning
//      10" (#29575) never matched it. That went unnoticed while bare
//      "birthday" was in KIDS_KEYWORDS and caught everything.
//  (b) "10 year old", "10-year-old", "8th birthday", "10 yrs old".
//
// Both capped at 16, per Christopher: the kids template covers ages 16 and
// under. "turning 17", "21st birthday" and "turning 55" deliberately do not
// match.
const KIDS_AGE_PATTERN =
  /\b(?:turning|turns)\s+(?:1[0-6]|[1-9])\b|\b(?:1[0-6]|[1-9])(?:st|nd|rd|th)?\s*[- ]?(?:years?|yrs?)?[- ]?(?:olds?\b|birthdays?\b)/i;

// An age RANGE - how people describe a group of children rather than one
// birthday child: "ages 7-9", "ages 7 to 9", "7-9 year olds". The single-age
// pattern above cannot see these, because it needs a number immediately
// followed by "old" or "birthday". WC #30423 (2026-10-14, Kristina Ripani)
// wrote "Girls and boys ages 7-9 with a few adults" for a 13-guest party and
// classified as null, so she was sent the occasion clarifier instead of the
// kids quote.
//
// Both ends must land inside the kids range, so "ages 21-30" and a "Guests:
// 20-30" headcount are not mistaken for children.
const KIDS_AGE_RANGE_PATTERN =
  /\b(?:ages?|aged)\s*:?\s*(\d{1,2})\s*(?:-|\u2013|\u2014|to|through|and|&)\s*(\d{1,2})\b|\b(\d{1,2})\s*(?:-|\u2013|\u2014|to)\s*(\d{1,2})\s*(?:year|yr)s?[\s-]?olds?\b/i;

function mentionsKidsAgeRange(text: string, maxAge: number): boolean {
  const m = text.match(KIDS_AGE_RANGE_PATTERN);
  if (!m) return false;
  const low = Number(m[1] ?? m[3]);
  const high = Number(m[2] ?? m[4]);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return false;
  return low >= 1 && high >= low && high <= maxAge;
}


/** True if the inquiry mentions "donate"/"donation" - triggers the fundraiser template's gift-certificate-donation disclaimer prefix (see FUNDRAISER_DONATION_PREFIX below). */
export function mentionsGiftDonation(ctx: TicketContext): boolean {
  const text = getTicketMatchText(ctx);
  return text.includes("donat"); // catches donate/donation/donating, same plain-substring convention as the rest of this codebase
}

// Adult celebration and community signals - what makes an inquiry
// genuinely "standard" rather than merely unclassified. Added 2026-09-25
// so the classifier can tell those two apart; see the null return below.
const STANDARD_KEYWORDS = [
  "hoa",
  "homeowners association",
  "homeowner's association",
  "condo association",
  "condominium association",
  "neighborhood",
  "neighbourhood",
  "residents",
  "community event",
  "community group",
  "church group",
  "book club",
  "birthday",
  "bachelorette",
  "bachelor party",
  "bridal shower",
  "baby shower",
  "anniversary",
  "girls night",
  "girls' night",
  "girl's night",
  "ladies night",
  "celebration",
  "celebrating",
  "get together",
  "get-together",
  "reunion",
  "retirement",
  "graduation",
  "holiday party",
  "christmas party",
  "date night",
  "couples",
  "friends",
  "family",
  "celebrations",
  "celebrate",
  "resident",
  "couple",
  "friend",
  "families",
  "neighborhoods",
  "anniversaries",
  "reunions",
  "graduations",
];

/**
 * The event's focus, or null when the inquiry doesn't say.
 *
 * Christopher, 2026-09-25: "I noticed a couple Corporate Team building
 * parties were sent the general response because it was not clear what the
 * focus of the party was." This used to end in `return "standard"`, so an
 * inquiry that said nothing about its occasion was indistinguishable from
 * one that genuinely was a standard adult party.
 *
 * That matters more on this brand than on Painting and Vino: the Wine and
 * Canvas contact form has no occasion field at all, so most inquiries
 * arrive with nothing to classify on. Returning null lets the pipeline ask
 * rather than guess - see src/private-event-clarifiers.ts.
 */
/**
 * WHOLE-TOKEN matching, not substring - keywordMatches(), not includes().
 *
 * With plain substring matching these lists misfired on ordinary English:
 *   "cause"   matched "because"   -> any inquiry saying "because" was a FUNDRAISER
 *   "company" matched "accompany" -> "my husband will accompany me" was CORPORATE
 *   "staff"   matched "staffing"  -> "we are staffing it ourselves" was CORPORATE
 *
 * The first is the serious one. "because" is ordinary writing, and a false
 * fundraiser sends donation mechanics to someone throwing a birthday party.
 * Found 2026-10-05 auditing the categories after the kids-template bug
 * (#29784) - the same root cause as that one: a keyword that matches far more
 * than it looks like it does.
 *
 * Whole-token matching means inflections no longer come free, so "donations",
 * "fundraising" and the rest are spelled out in the lists above.
 */
export function classifyPrivateEvent(ctx: TicketContext): PrivateEventCategory | null {
  const text = getTicketMatchText(ctx);

  if (KIDS_KEYWORDS.some((k) => keywordMatches(text, k)) || KIDS_AGE_PATTERN.test(text) || mentionsKidsAgeRange(text, 16)) {
    return "kids";
  }
  if (FUNDRAISER_KEYWORDS.some((k) => keywordMatches(text, k))) {
    return "fundraiser";
  }
  if (CORPORATE_KEYWORDS.some((k) => keywordMatches(text, k))) {
    return "corporate";
  }
  if (STANDARD_KEYWORDS.some((k) => keywordMatches(text, k))) {
    return "standard";
  }
  return null;
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
  | "sarasota"
  | "sarasota-travel"
  | "orlando"
  | "fort-lauderdale"
  | "miami"
  | "indianapolis"
  | "bloomington"
  | "bloomington-travel"
  | "grand-rapids"
  | "cadillac";

/**
 * Narrows a locations.yaml slug match down to the finer-grained pricing key
 * above. Returns null if the slug isn't one this private-event system has
 * pricing for yet (shouldn't happen for the 9 managed locations, but fails
 * safe rather than guessing).
 */
/**
 * Miami-Dade towns, from Christopher's list 2026-10-01. Anything here is
 * the MIAMI pricing key (Group B), not Fort Lauderdale's (Group A) - $45 vs
 * $39 a head standard, so treating Kendall or Doral as Fort Lauderdale
 * under-quotes the job. "miami" covers Miami Beach, Miami Lakes, South
 * Miami and Miami-Dade on its own, so they are not listed separately.
 *
 * Fort Lauderdale still wins when the ticket names it explicitly - see the
 * caller below - because a Broward event that happens to mention Miami is a
 * Broward event.
 */
/**
 * Towns served out of Bloomington that carry a travel fee, as opposed to
 * Bloomington, Martinsville and Ellettsville, which do not (Christopher,
 * 2026-10-26). Same prices either way - this list only decides whether the
 * quote carries the fee sentence.
 *
 * State-qualified where the bare name is ambiguous, on the same reasoning as
 * the locations.yaml entry: Bedford is a city in half a dozen states and a
 * surname, and Martinsville likewise. French Lick and Terre Haute are
 * distinctive enough bare.
 */
const BLOOMINGTON_TRAVEL_FEE_KEYWORDS = [
  "bedford, in",
  "bedford in",
  "french lick",
  "terre haute",
] as const;

/**
 * Towns served out of Sarasota that carry a $40 travel fee, as opposed to
 * Sarasota proper and its barrier islands, which carry none. Christopher,
 * 2026-10-26: "You can include these areas but with a $40 travel fee:
 * Venice, North Port, Englewood, Osprey, Nokomis and Bradenton." Same prices
 * either way - this list only decides whether the fee sentence appears.
 *
 * State-qualified where the bare name would misfire, and here that is most of
 * them: Venice is Italy and a Los Angeles neighbourhood, Englewood is a city
 * in Colorado, New Jersey and Illinois, Osprey is an ordinary bird and a
 * stock venue name, and Nokomis is both a town in Illinois and a lake and
 * neighbourhood in MINNEAPOLIS - which is an excluded market on this brand,
 * so a bare "nokomis" could pull a Minneapolis ticket into a Florida quote.
 * Bradenton and North Port are distinctive enough bare.
 */
const SARASOTA_TRAVEL_FEE_KEYWORDS = [
  "venice, fl",
  "venice fl",
  "north port",
  "englewood, fl",
  "englewood fl",
  "osprey, fl",
  "osprey fl",
  "nokomis, fl",
  "nokomis fl",
  "bradenton",
] as const;

/** Broward anchors: when one of these is named, the ticket is Fort Lauderdale even if Miami is mentioned too. */
const BROWARD_ANCHOR_KEYWORDS = ["fort lauderdale", "ft lauderdale", "ft. lauderdale"] as const;

/**
 * Towns priced with NAPLES (Group B, $45/$50) rather than Fort Myers (Group A,
 * $39/$44). Both sit behind the single fort-myers slug, so this list is what
 * decides the price.
 *
 * Bonita Springs has always been here - the corporate and standard templates
 * group "Orlando, Naples/Bonita Springs, and Miami" as one tier.
 *
 * ESTERO IS DELIBERATELY NOT HERE. It sits between the two, ~15 miles from
 * Fort Myers and ~22 from Naples, with Bonita Springs in between - so Fort
 * Myers on proximity, and the cheaper of the two if the call is wrong. Moving
 * it is one line; flagged to Christopher 2026-10-02.
 */
const NAPLES_SIDE_KEYWORDS = [
  "naples",
  "bonita springs",
  // Collier County, confirmed by Christopher 2026-10-02 ("Naples: Naples,
  // Marco Island, Everglades").
  "marco island",
  "everglades city",
  "everglades, fl",
  "everglades fl",
] as const;

/** Fort Myers anchors: these win over the Naples list when a ticket names both. */
const FORT_MYERS_ANCHOR_KEYWORDS = [
  "fort myers",
  "ft myers",
  "ft. myers",
  "cape coral",
  "sanibel",
  "captiva",
  "boca grande",
  "bokeelia",
  "pineland",
  "saint james city",
  "st. james city",
  "st james city",
  "lehigh acres",
  "alva",
  "estero",
] as const;

const MIAMI_DADE_KEYWORDS = [
  "miami",
  "kendall",
  "homestead",
  "doral",
  "palmetto bay",
  "pinecrest",
  "coral gables",
  "hialeah",
  "cutler bay",
  "cutler ridge",
  "richmond heights",
  "naranja",
  "florida city",
  "brickell",
  "aventura",
  "key biscayne",
  "sweetwater, fl",
  "opa-locka",
  "opa locka",
] as const;

export function resolvePrivateEventLocationKey(ctx: TicketContext, matchedSlug: string): PrivateEventLocationKey | null {
  const text = getTicketMatchText(ctx);

  if (matchedSlug === "fort-lauderdale") {
    const mentionsMiami = MIAMI_DADE_KEYWORDS.some((k) => keywordMatches(text, k));
    const mentionsFtLauderdale = BROWARD_ANCHOR_KEYWORDS.some((k) => keywordMatches(text, k));
    return mentionsMiami && !mentionsFtLauderdale ? "miami" : "fort-lauderdale";
  }
  if (matchedSlug === "fort-myers") {
    // One slug, two prices. Naples side is Group B ($45/$50); Fort Myers side
    // is Group A ($39/$44), so a town in the wrong list is a $6-a-head error.
    // Fort Myers wins when a ticket names both, because a Fort Myers event
    // that mentions Naples in passing is still a Fort Myers event.
    const mentionsNaples = NAPLES_SIDE_KEYWORDS.some((k) => keywordMatches(text, k));
    const mentionsFtMyers = FORT_MYERS_ANCHOR_KEYWORDS.some((k) => keywordMatches(text, k));
    return mentionsNaples && !mentionsFtMyers ? "naples" : "fort-myers";
  }
  if (matchedSlug === "bloomington") {
    // One slug, one price list, two travel-fee answers. Christopher,
    // 2026-10-26: "Martinsville is in service area with no travel fee.
    // Bedford, French Link [Lick], and Terre Haute are available for parties
    // but will require a service fee."
    //
    // The fee towns WIN when a ticket names both, which is the opposite of
    // the Fort Myers/Naples and Fort Lauderdale/Miami rules above. Those
    // split two different PRICE lists, where the anchor city settles which
    // market the job belongs to. Here the price is identical either way and
    // the only question is whether a fee is owed - so the costly error is
    // quoting a Bedford party with no fee and having to add one afterwards.
    // Mentioning the fee unnecessarily is recoverable: the sentence promises
    // a number later, so we can come back with "no fee after all".
    const mentionsFeeTown = BLOOMINGTON_TRAVEL_FEE_KEYWORDS.some((k) => keywordMatches(text, k));
    return mentionsFeeTown ? "bloomington-travel" : "bloomington";
  }
  if (matchedSlug === "sarasota") {
    // Same split as bloomington above, and for the same reason: one price
    // list, two answers on the fee, and the fee towns WIN when a ticket names
    // both. Quoting a Bradenton party with no fee means going back to add $40
    // after the customer has seen a number; naming the fee when the party is
    // actually in Sarasota proper is a smaller, correctable error.
    const mentionsFeeTown = SARASOTA_TRAVEL_FEE_KEYWORDS.some((k) => keywordMatches(text, k));
    return mentionsFeeTown ? "sarasota-travel" : "sarasota";
  }
  if (
    matchedSlug === "tampa" ||
    matchedSlug === "orlando" ||
    matchedSlug === "indianapolis" ||
    matchedSlug === "bloomington" ||
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
  // Orlando left this group on 2026-10-15 with the move to Fort Myers pricing
  // and came back on 2026-10-19 with the rest of its rates. INFERRED: the
  // 2026-10-19 message covered standard, corporate and kids only.
  const bump = locationKey === "orlando" || locationKey === "miami" || locationKey === "naples" ? 10 : 0;
  return { charge: 45 + bump, retail: 55 + bump };
}

export interface PrivateEventLocationInfo {
  displayName: string;
  /** Restaurant/venue list link for this city (rendered as a real hyperlink, not raw HTML). */
  restaurantListUrl: string | null;
  pricing: PrivateEventPricing;
  /**
   * The COMPLETE customer-facing sentence about an extra service fee, or
   * unset for markets with none. It used to hold just the amount, dropped
   * into a fixed "Please note: X applies for this location." template -
   * which could not express Christopher's 2026-10-26 wording for the towns
   * whose fee is not known yet ("travel fee will be required, we will let
   * you know how much shortly"). Holding the whole sentence keeps that copy
   * his, verbatim, instead of bending it to fit a template.
   */
  travelFee?: string;
}

// Real links, Christopher 2026-09-21 (pasted directly in the corporate/
// standard/fundraiser template text). Naples and Miami share one combined
// link. Cadillac's is its own dedicated venue list (given earlier,
// separate from the "restaurant partner" lists below).
// Updated 2026-10-16 (Christopher: "Updated Indianapolis Venue kit").
const RESTAURANT_LIST_INDIANAPOLIS = "https://drive.google.com/file/d/1ljOmNUETCo9iB6Cya5NycSgwNK-fjfza/view?usp=sharing";
// Christopher, 2026-10-26, adding Bloomington: "Is the same pricing as
// Indianapolis... Here is the venue kit link". Its own kit, not a share of
// Indianapolis's.
const RESTAURANT_LIST_BLOOMINGTON = "https://drive.google.com/file/d/1PVGbphfP5tJU2G11Y10CLHf35wmhdSL0/view?usp=sharing";
// Christopher, 2026-10-26, adding Sarasota: "Please quote private events the
// same pricing as Tampa but send this SARASOTA RESTAURANT LIST LINK". Its own
// kit, not a share of Tampa's.
const RESTAURANT_LIST_SARASOTA = "https://drive.google.com/file/d/16duDOCQhUKjzXNiIhbp3fd4niuI7aTOw/view?usp=sharing";
const RESTAURANT_LIST_TAMPA = "https://drive.google.com/file/d/1gTEOFxbdbvKhMtKhfOPo_-ZxgfAO_A9-/view?usp=sharing";
const RESTAURANT_LIST_ORLANDO = "https://drive.google.com/file/d/1zCNFqOIM1xmzI3f5c_3aRcjgsg9Cxywt/view?usp=sharing";
const RESTAURANT_LIST_FORT_LAUDERDALE = "https://drive.google.com/file/d/1bY8pEwUCLddKcq2mpAtwYNFbea2J4mWJ/view?usp=sharing";
// Updated 2026-10-26 (Christopher: "Please update the fort myers restaurant
// list link for private event quotes on wine and canvas"). Fort Myers /
// Cape Coral only - the Naples side of this slug uses
// RESTAURANT_LIST_NAPLES_MIAMI and is untouched.
const RESTAURANT_LIST_FORT_MYERS = "https://drive.google.com/file/d/1Zd4is57xRSrf-YJQ2qEviHSX7WXRidMU/view?usp=sharing";
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
  // Christopher, 2026-10-26: "Adding Sarasota to our territories now. Please
  // quote private events the same pricing as Tampa but send this SARASOTA
  // RESTAURANT LIST LINK." So Tampa's rates exactly - Group A, 39/35/30
  // standard, 44/40/35 corporate, $39 fundraiser retail keeping $34, $29
  // kids - no pet-portrait bump (Tampa has none), and its own venue kit.
  sarasota: {
    displayName: "Sarasota, FL",
    restaurantListUrl: RESTAURANT_LIST_SARASOTA,
    pricing: { corporateTiers: GROUP_A_CORPORATE_TIERS, standardTiers: GROUP_A_STANDARD_TIERS, ...GROUP_A_FUNDRAISER_FIELDS(), kidsPricePerPerson: KIDS_DEFAULT_PRICE },
  },
  // Venice, North Port, Englewood, Osprey, Nokomis and Bradenton - served out
  // of Sarasota at the same prices, with a $40 travel fee. Christopher,
  // 2026-10-26. Separate KEY rather than a flag so the ticket carries
  // private_event_location_sarasota-travel and these jobs stay findable.
  "sarasota-travel": {
    displayName: "Sarasota, FL",
    restaurantListUrl: RESTAURANT_LIST_SARASOTA,
    pricing: { corporateTiers: GROUP_A_CORPORATE_TIERS, standardTiers: GROUP_A_STANDARD_TIERS, ...GROUP_A_FUNDRAISER_FIELDS(), kidsPricePerPerson: KIDS_DEFAULT_PRICE },
    travelFee: "Please note: a $40 travel fee applies for this location.",
  },
  orlando: {
    displayName: "Orlando, FL",
    restaurantListUrl: RESTAURANT_LIST_ORLANDO,
    // Christopher, 2026-10-19: reverses the 2026-10-15 move to Fort Myers
    // pricing. Orlando is back on Group B across every category - 45/40/35
    // standard, 50/45/40 corporate, $45 fundraiser retail, $35 kids - and back
    // in the +$10 pet-portrait group with Naples and Miami. His 2026-10-19
    // message quoted the bands as 8-30/31-50/51+, then confirmed Orlando
    // should match every other market's 8-29/30-49/50+ edges.
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
  // Christopher, 2026-10-26: "New location to add for private event macros.
  // Is the same pricing as Indianapolis. Please add Bloomington, Indiana for
  // private party standard, corporate, Kids, and fundraiser." So: Group A
  // across the board, same as Indianapolis - 39/35/30 standard, 44/40/35
  // corporate, $39 fundraiser retail keeping $34, $29 kids - with its own
  // venue kit. No pet-portrait bump, matching Indianapolis.
  bloomington: {
    displayName: "Bloomington, IN",
    restaurantListUrl: RESTAURANT_LIST_BLOOMINGTON,
    pricing: { corporateTiers: GROUP_A_CORPORATE_TIERS, standardTiers: GROUP_A_STANDARD_TIERS, ...GROUP_A_FUNDRAISER_FIELDS(), kidsPricePerPerson: KIDS_DEFAULT_PRICE },
  },
  // Bedford, French Lick and Terre Haute - served out of Bloomington at the
  // same prices, but with a travel fee whose amount nobody knows yet.
  // Christopher, 2026-10-26: "We will have to ask our artist what the fee is
  // so just say 'travel fee will be required, we will let you know how much
  // shortly.'" His wording, kept.
  //
  // Separate KEY rather than a flag so the ticket carries
  // private_event_location_bloomington-travel and these jobs can be found
  // later - someone has to go back and quote the actual fee.
  "bloomington-travel": {
    displayName: "Bloomington, IN",
    restaurantListUrl: RESTAURANT_LIST_BLOOMINGTON,
    pricing: { corporateTiers: GROUP_A_CORPORATE_TIERS, standardTiers: GROUP_A_STANDARD_TIERS, ...GROUP_A_FUNDRAISER_FIELDS(), kidsPricePerPerson: KIDS_DEFAULT_PRICE },
    travelFee: "Please note: a travel fee will be required for this location \u2014 we will let you know how much shortly.",
  },
  // Christopher, 2026-10-26: "I need to update Grand Rapids to not send a kit
  // right away but to say, a restaurant list will be provided based on the
  // artist's availability. Just like we say for San Diego on the Painting &
  // Vino side. This is due to multiple artists in the area." So no link in
  // the quote - the templates' null branch sends the artist-availability
  // sentence instead, matching venueOfferLines() in the other brand.
  //
  // The constant below is kept, not deleted: the list still exists and still
  // goes out by hand once the artist is known. Only the automated quote stops
  // linking it.
  "grand-rapids": {
    displayName: "Grand Rapids, MI",
    restaurantListUrl: null,
    pricing: { corporateTiers: GRAND_RAPIDS_CORPORATE_TIERS, standardTiers: GRAND_RAPIDS_STANDARD_TIERS, ...GRAND_RAPIDS_FUNDRAISER_FIELDS(), kidsPricePerPerson: KIDS_DEFAULT_PRICE },
  },
  // Christopher, 2026-10-19: "Cadillac is no longer open... You can fold into
  // Grand Rapids but there would be a $100 travel fee." The KEY stays
  // "cadillac" so tickets already tagged private_event_location_cadillac keep
  // resolving (the follow-up sequence reads that tag), but everything the
  // customer sees is now Grand Rapids: its name, its venue list, its prices -
  // which this entry already mirrored - plus the higher travel fee for the
  // northern towns. The slug in config/locations.yaml still gathers Traverse
  // City, Manistee, Ludington and the rest; they are simply served from Grand
  // Rapids now.
  // Shown to the customer as Grand Rapids since 2026-10-19, so it follows
  // Grand Rapids' no-kit treatment too - the same displayed market cannot
  // link a list for one customer and withhold it for another.
  cadillac: {
    displayName: "Grand Rapids, MI",
    restaurantListUrl: null,
    pricing: { corporateTiers: GRAND_RAPIDS_CORPORATE_TIERS, standardTiers: GRAND_RAPIDS_STANDARD_TIERS, ...GRAND_RAPIDS_FUNDRAISER_FIELDS(), kidsPricePerPerson: KIDS_DEFAULT_PRICE },
    travelFee: "Please note: a $100 travel fee applies for this location.",
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
  // The name the customer typed on the form beats the one Zendesk invented
  // from their email address - see extractFormContactName in util.ts for
  // why (#29509 went out as "Hi Trosand,").
  return (
    firstNameFromFullName(extractFormContactName(ctx)) ??
    firstNameFromFullName(ctx.requester?.name) ??
    "there"
  );
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

/** The location's travel-fee sentence, or null if it has none - null (not "") so the join-filter below can drop it cleanly without eating intentional blank spacer lines. */
function travelFeeLine(loc: PrivateEventLocationInfo): string | null {
  return loc.travelFee ?? null;
}

/** Joins template lines, dropping only null/undefined entries (conditional lines) - keeps "" entries, which are intentional blank-line paragraph breaks. */
function joinLines(lines: Array<string | null | undefined>): string {
  return lines.filter((l): l is string => l !== null && l !== undefined).join("\n");
}

/** Same as joinLines, but also drops __EMBED_*__ image-placeholder lines entirely - used for the plain-text body, which can't show an image anyway. The HTML body keeps the markers (via joinLines) so embedImages() can swap them for real <img> tags once uploaded. */
function joinLinesPlain(lines: Array<string | null | undefined>): string {
  return lines.filter((l): l is string => l !== null && l !== undefined && !l.startsWith("__EMBED_")).join("\n");
}

// ---------------------------------------------------------------------------
// Minimum group size.
//
// Standard/corporate quote 8, kids 10, fundraisers 12 - these were literals
// inside the three templates until 2026-10-11; they are constants now so the
// Lead Bros floor below has one place to apply.
//
// Lead Bros is a paid lead-gen source. Its inquiries arrive through the same
// form as everything else, so the BODY is indistinguishable from a regular
// inquiry - the only thing that marks them is the subject line, which the
// source sets to "Party Request from Wine & Canvas (LB)". Christopher,
// 2026-10-11: these quote at a 10-person minimum. Matching on the subject
// alone is what keeps regular inquiries untouched.
// ---------------------------------------------------------------------------
const DEFAULT_MINIMUM_GROUP_SIZE = 8;
const KIDS_MINIMUM_GROUP_SIZE = 10;
const FUNDRAISER_MINIMUM_GROUP_SIZE = 12;
const LEAD_BROS_MINIMUM_GROUP_SIZE = 10;
/** Both brands' markers, so either feed naming works on either brand. */
const LEAD_BROS_SUBJECT_MARKERS = ["(lb)", "lead bros"];

/** True when this ticket came in through the Lead Bros feed. Subject only - a
 * customer writing "lead bros" in the body of a normal inquiry is not one, and
 * "Re: Party Request from Wine & Canvas (LB)" on a reply still is. */
export function isLeadBrosInquiry(ctx: TicketContext): boolean {
  const subject = (ctx.ticket.subject ?? "").toLowerCase();
  return LEAD_BROS_SUBJECT_MARKERS.some((m) => subject.includes(m));
}

/** Minimum guests to quote for this category. The Lead Bros floor is a
 * Math.max, not a replacement: it must never LOWER a minimum, so kids stay at
 * 10 and fundraisers stay at the company-wide 12. */
export function minimumGroupSizeFor(category: PrivateEventCategory, leadBros = false): number {
  const base =
    category === "fundraiser"
      ? FUNDRAISER_MINIMUM_GROUP_SIZE
      : category === "kids"
        ? KIDS_MINIMUM_GROUP_SIZE
        : DEFAULT_MINIMUM_GROUP_SIZE;
  return leadBros ? Math.max(base, LEAD_BROS_MINIMUM_GROUP_SIZE) : base;
}

/** The first pricing tier is written as "8-29" in the tier tables, but the
 * quote must not advertise a band that starts below the minimum we are
 * actually quoting - Tucson and Sacramento have always been 10-guest markets,
 * and Lead Bros inquiries are 10 everywhere. Rewrites the lower bound of the
 * first band to the effective minimum and leaves every later band alone
 * ("30-49", "50+" are unaffected). A band whose lower bound already matches,
 * or that has no leading number, is returned untouched. */
function tierRangeForDisplay(range: string, index: number, minimum: number): string {
  if (index !== 0) return range;
  return range.replace(/^\d+/, String(minimum));
}

/** Public-events calendar page per market - null where a location has no page
 * on file (never invent one). Lives here rather than in followups.ts because
 * both the follow-up sequence and the below-minimum reply need it. */
export const PRIVATE_EVENT_LOCATION_CALENDAR_LINKS: Record<PrivateEventLocationKey, string | null> = {
  "fort-myers": "https://wineandcanvas.com/florida/fort-myers/",
  naples: "https://wineandcanvas.com/florida/fort-myers/",
  tampa: "https://wineandcanvas.com/florida/tampa/",
  // NULL deliberately: the Florida site has no Sarasota page. Checked
  // 2026-10-26 - its Event Locations menu lists Fort Lauderdale, Fort Myers,
  // Miami, Orlando and Tampa Bay, and nothing else. Per this map's own rule
  // ("never invent one"), rather than guess /florida/sarasota/ or hand a
  // Sarasota customer Tampa's calendar, which is a 60-mile drive. Email 3 and
  // the below-minimum reply both fall back to the (866) 631-0226 /
  // support@wineandcanvas.com line instead. Sarasota is currently the ONLY
  // market on that fallback, so it is what tests it. Give it a link the
  // moment a Sarasota page exists.
  sarasota: null,
  // Served out of Sarasota, which has no page either - same null, same
  // phone/email fallback.
  "sarasota-travel": null,
  orlando: "https://wineandcanvas.com/florida/orlando/",
  "fort-lauderdale": "https://wineandcanvas.com/florida/fort-lauderdale/",
  miami: "https://wineandcanvas.com/florida/fort-lauderdale/",
  indianapolis: "https://wineandcanvas.com/indianapolis/events/",
  // Read off the Bloomington subsite's own nav on 2026-10-26 (its "Event
  // Calendar" link), not pattern-matched from Indianapolis's.
  bloomington: "https://wineandcanvas.com/bloomington/events/",
  // Served out of Bloomington, so the same public calendar.
  "bloomington-travel": "https://wineandcanvas.com/bloomington/events/",
  "grand-rapids": "https://wineandcanvas.com/michigan/grand-rapids/",
  // Served from Grand Rapids since 2026-10-19 - same public calendar.
  cadillac: "https://wineandcanvas.com/michigan/grand-rapids/",
};

/**
 * Reply for a party smaller than the group minimum: point them at public
 * classes instead of quoting a private event they cannot book.
 *
 * Wording follows Raimey's own hand-written reply on #30268 ("Since it's just
 * the two of you, one of our public paint and sip classes would be a great
 * fit. Private parties start at 8 guests...") rather than inventing a tone.
 * Where a market has no calendar page on file (Cadillac), falls back to the
 * phone/email line that location's knowledge-base file already points
 * customers to - never a guessed link.
 */
export function renderBelowMinimumReply(
  firstName: string,
  locationDisplayName: string | null,
  calendarLink: string | null,
  minimum: number,
  guests: number
): { plainBody: string; htmlBody: string } {
  const groupPhrase = guests === 2 ? "just the two of you" : `a group of ${guests}`;
  const browseLabel = locationDisplayName
    ? `Browse upcoming classes in ${locationDisplayName}`
    : "Browse upcoming classes";
  const lines: Array<string | null> = [
    `Hi ${firstName},`,
    ``,
    `What a fun idea! Since it's ${groupPhrase}, one of our public paint and sip classes would be a great fit — you get the same artist-led, step-by-step painting experience, and there's no minimum.`,
    ``,
    `Private parties start at ${minimum} guests, so a public class is the easier way to go for a smaller group.`,
    ``,
    calendarLink
      ? `${browseLabel}: ${calendarLink}`
      : `${browseLabel} — give us a call at (866) 631-0226 or email support@wineandcanvas.com and we'll send you the current schedule.`,
    ``,
    `If your plans grow and you end up with ${minimum} or more, just reply here and I'll put a private quote together.`,
    ``,
    `Cheers,`,
    ``,
    `Raimey — Private Event Coordinator`,
    ``,
    `The Wine & Canvas Team`,
  ];
  const plainBody = joinLinesPlain(lines);
  const links = calendarLink ? [{ label: browseLabel, url: calendarLink }] : [];
  return { plainBody, htmlBody: toHtml(joinLines(lines), links) };
}

export function renderPrivateEventQuote(
  ctx: TicketContext,
  category: PrivateEventCategory,
  locationKey: PrivateEventLocationKey
): RenderedQuote {
  const loc = getLocationInfo(locationKey);
  const firstName = getFirstName(ctx);
  const leadBros = isLeadBrosInquiry(ctx);

  switch (category) {
    case "corporate":
      return renderCorporateOrStandard(loc, locationKey, firstName, "corporate", leadBros);
    case "fundraiser":
      return renderFundraiser(loc, locationKey, firstName, mentionsGiftDonation(ctx), leadBros);
    case "kids":
      return renderKids(loc, locationKey, firstName, leadBros);
    case "standard":
    default:
      return renderCorporateOrStandard(loc, locationKey, firstName, "standard", leadBros);
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
  category: "corporate" | "standard",
  leadBros = false
): RenderedQuote {
  const minimum = minimumGroupSizeFor(category, leadBros);
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
      ? `Need a space? Here's our partner restaurant list for ${loc.displayName} — most don't charge extra beyond food and beverage costs per person. Take a look and let me know if anything works and I'll check availability.`
      : `Need a space? We'll send a partner restaurant list once we confirm which artist is available for your date, rather than guessing at one now.`,
    loc.restaurantListUrl ? `${restaurantLinkLabel(locationKey, loc)}: ${loc.restaurantListUrl}` : null,
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
    `Minimum group size: ${minimum} guests`,
    `Price per person: ${tiers.map((t, i) => `$${t.pricePerPerson}/person (${tierRangeForDisplay(t.range, i, minimum)} guests)`).join(", ")}`,
    `Tighter budget? Smaller canvas options are available at a lower per-person rate.`,
    travelFeeLine(loc),
    `Travel fees may apply outside the greater city limits.`,
    ``,
    `📋 To Book`,
    `A deposit locks in your date — it covers 2 seats or 20% of your expected headcount (whichever is higher). The balance is due the day before your event. The deposit is non-refundable but transferable for up to one year if your plans change.`,
    ``,
    `This quote is valid for 30 days.`,
    ``,
    `${PARTY_IN_ACTION_LABEL}: ${PARTY_IN_ACTION_URL}`,
    ``,
    `Ready to lock in your date? Just reply with your preferred date and approximate headcount and I'll check availability right away. Dates go fast, especially on weekends — I'd love to get yours on the calendar! 🎉`,
    ``,
    `Cheers,`,
    ``,
    `Raimey — Private Event Coordinator`,
    ``,
    `The Wine & Canvas Team`,
  ]);

  const links = [
    ...(loc.restaurantListUrl ? [{ label: restaurantLinkLabel(locationKey, loc), url: loc.restaurantListUrl }] : []),
    { label: PARTY_IN_ACTION_LABEL, url: PARTY_IN_ACTION_URL },
  ];
  const htmlBody = toHtml(plainBody, links);
  return { category, locationKey, plainBody, htmlBody, imageAssets: [] };
}

function renderFundraiser(
  loc: PrivateEventLocationInfo,
  locationKey: PrivateEventLocationKey,
  firstName: string,
  mentionsDonation: boolean,
  leadBros = false
): RenderedQuote {
  const minimum = minimumGroupSizeFor("fundraiser", leadBros);
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
      ? `If you're in need of a space, here's our partner restaurant list for ${loc.displayName}. Most do not charge for use of space but they do expect everyone to order food and drinks during the event.`
      : `If you're in need of a space, we'll send a partner restaurant list once we confirm which artist is available for your date, rather than guessing at one now.`,
    loc.restaurantListUrl ? `${restaurantLinkLabel(locationKey, loc)}: ${loc.restaurantListUrl}` : null,
    ``,
    `Materials: We provide all the art materials including table covers and aprons. We don't provide food/beverages or tables/chairs. Serving alcohol at the party is always optional.`,
    ``,
    `Painting: We can do canvas or glass painting for the quoted price. Our portfolio has 1,000's of images available. We will send a link once you are ready to book. If you don't see a design you like there is an extra $75 flat fee for custom paintings.`,
    ``,
    `Pricing: The group minimum is currently ${minimum} people to host a fundraising event. For fundraisers, we discount the retail rate by $5 and donate the difference to your cause — you can increase the retail rate to raise the donation amount if you like.`,
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
    `${PARTY_IN_ACTION_LABEL}: ${PARTY_IN_ACTION_URL}`,
    ``,
    `If you'd like to move forward with the planning process, don't hesitate to reach out and we can get you started! Dates go fast, especially on weekends — I'd love to get yours on the calendar! 🎉`,
    ``,
    `Cheers,`,
    `Raimey`,
    `The Wine & Canvas Team`,
  ];

  const plainBody = joinLinesPlain(bodyLines);
  const links = [
    ...(loc.restaurantListUrl ? [{ label: restaurantLinkLabel(locationKey, loc), url: loc.restaurantListUrl }] : []),
    { label: PARTY_IN_ACTION_LABEL, url: PARTY_IN_ACTION_URL },
  ];
  const htmlBody = toHtml(joinLines(bodyLines), links);

  return {
    category: "fundraiser",
    locationKey,
    plainBody,
    htmlBody,
    imageAssets: [{ key: "fundraiser-pet-portrait", filename: "fundraiser-pet-portrait-example.jpg", contentType: "image/jpeg" }],
  };
}

function renderKids(loc: PrivateEventLocationInfo, locationKey: PrivateEventLocationKey, firstName: string, leadBros = false): RenderedQuote {
  const price = loc.pricing.kidsPricePerPerson;
  const minimum = minimumGroupSizeFor("kids", leadBros);

  const bodyLines: Array<string | null> = [
    `Hi ${firstName},`,
    ``,
    `Thank you for reaching out about our Cookies & Canvas private events! We'd absolutely love to help you plan an exciting paint party. 🎉`,
    ``,
    `Here is some additional info about the process and pricing to help you make the best choice.`,
    ``,
    `Venue: We are 100% mobile so we do not have a studio space. We are available to host events at any of your preferred locations, including your home.`,
    loc.restaurantListUrl
      ? `If you're in need of a space, here's our partner restaurant list for ${loc.displayName}. Most don't charge for use of space but they do expect everyone to order food and drinks during the event.`
      : `If you're in need of a space, we'll send a partner restaurant list once we confirm which artist is available for your date, rather than guessing at one now.`,
    loc.restaurantListUrl ? `${restaurantLinkLabel(locationKey, loc)}: ${loc.restaurantListUrl}` : null,
    ``,
    `Materials: We provide all the art materials including table covers and aprons. We don't provide food/beverages or tables/chairs. This means we don't provide cookies either.`,
    ``,
    `Painting: We can do canvas for the quoted price. Our portfolio has 100's of images available. We will send a link once the deposit is paid. If you don't see a design you like there is an extra $75 flat fee for custom paintings.`,
    ``,
    `Below is just one of the examples from our portfolio, a colorful "Cutie Unicorn" 🦄`,
    `__EMBED_KIDS_UNICORN__`,
    ``,
    `Pricing for ${loc.displayName}:`,
    `The group minimum is currently ${minimum} people to host an event and the rate is $${price} per person.`,
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
    `Raimey`,
    `The Wine & Canvas Team`,
  ];

  const plainBody = joinLinesPlain(bodyLines);
  const links = loc.restaurantListUrl ? [{ label: restaurantLinkLabel(locationKey, loc), url: loc.restaurantListUrl }] : [];
  const htmlBody = toHtml(joinLines(bodyLines), links);
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
 * A visible "LABEL: URL" line in the plain-text body (see restaurantLink()
 * and the "See a Party in Action" line below) becomes a real <a href>
 * hyperlink around just the label in the HTML version - Christopher, when
 * reviewing the rendered templates: "can you not hyperlink [the raw URL]?
 * I feel like the URL doesn't look very professional. I usually type the
 * file name and hyperlink it." So the customer sees "Fort Lauderdale
 * Restaurant List Link" as clickable blue text, never the raw
 * drive.google.com URL. The plain-text fallback body keeps "LABEL: URL"
 * as literal text, since a plain-text email has no other way to carry a
 * working link.
 */
function toHtml(plainBody: string, links: Array<{ label: string; url: string }>): string {
  const escaped = escapeHtml(plainBody);
  let html = escaped.replace(/\n/g, "<br>\n");
  for (const { label, url } of links) {
    const escapedLabel = escapeHtml(label);
    const escapedUrl = escapeHtml(url);
    const pattern = `${escapedLabel}: ${escapedUrl}`;
    html = html.split(pattern).join(`<a href="${escapedUrl}">${escapedLabel}</a>`);
  }
  return `<p>${html}</p>`;
}

/** "Fort Lauderdale Restaurant List Link". The Cadillac special case went away
 * on 2026-10-19 when that market closed and its area moved to Grand Rapids -
 * it now sends the Grand Rapids restaurant list like any other Michigan quote. */
function restaurantLinkLabel(_locationKey: PrivateEventLocationKey, loc: PrivateEventLocationInfo): string {
  return `${loc.displayName} Restaurant List Link`;
}

const PARTY_IN_ACTION_LABEL = "📷 See a Party in Action";

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
