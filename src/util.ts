import type { TicketContext } from "./types.js";

/**
 * Text used for keyword matching across rules.ts and locations.ts: the
 * ticket subject plus the latest customer message (falling back to the
 * ticket description if there's no comment yet), lowercased.
 *
 * Subject is included because location-specific contact forms often carry
 * the location in the ticket's subject/title rather than the message body.
 */
export function getTicketMatchText(ctx: TicketContext): string {
  const latestCustomerMessage = [...ctx.comments]
    .reverse()
    .find((c) => c.author_id === ctx.ticket.requester_id);
  const text = `${ctx.ticket.subject ?? ""}\n${latestCustomerMessage?.body ?? ctx.ticket.description ?? ""}`.toLowerCase();
  // Append a state-normalised copy rather than replacing the original, so
  // both spellings are searchable and nothing already matching can break.
  return `${text}\n${withStateAbbreviations(text)}`;
}

// Spelled-out state names, for the normalisation below.
const STATE_NAME_TO_ABBREVIATION: Record<string, string> = {
  indiana: "in",
  michigan: "mi",
  florida: "fl",
  california: "ca",
  arizona: "az",
  missouri: "mo",
  tennessee: "tn",
  ohio: "oh",
  minnesota: "mn",
  nevada: "nv",
};

/**
 * Rewrites "Westfield indiana" and "Westfield, Indiana" to "westfield, in",
 * the form config/locations.yaml's satellite-city keywords are written in.
 *
 * Ticket #29229 (Molly Caulfield, 2026-09-22) is why this exists: her form
 * said "Location: Westfield indiana", the keyword was "westfield, in", so
 * nothing matched, no quote was generated and the whole thing fell to a
 * human. Christopher had to write an internal note reading "Westfield is
 * Northwest, Indianapolis."
 *
 * It matters just as much for the rules engine: an out-of-scope ticket
 * saying "Lansing Michigan" rather than "Lansing, MI" was slipping past
 * out_of_scope_location the same way.
 *
 * The \b word boundary is load-bearing - without it "indianapolis" would
 * be mangled into ", inpolis". A whole-word "indiana" cannot match inside
 * "indianapolis", so the city name survives untouched.
 */
export function withStateAbbreviations(text: string): string {
  let out = text;
  for (const [name, abbreviation] of Object.entries(STATE_NAME_TO_ABBREVIATION)) {
    out = out.replace(new RegExp(String.raw`,?\s*\b${name}\b`, "gi"), `, ${abbreviation}`);
  }
  return out;
}

/**
 * Extracts the dollar amount from a "Total: $NN.NN" line, as found in the
 * storefront's automated "New order" notification tickets (e.g. Wine and
 * Canvas's order-confirmation rule - see src/pipeline.ts). Deliberately
 * matches the standalone word "Total" so it does NOT match "Subtotal:" -
 * `\b` doesn't break between the "b" and "t" of "Subtotal" since both are
 * word characters, so only a line that starts with "Total" matches.
 * The separator between "Total:" and the dollar amount is matched loosely
 * ([\s|]*) since Wine and Canvas's order emails render this as a markdown
 * table (e.g. "| Total: | $76.00 |"), not just whitespace. Returns null if
 * no such line is found or it doesn't parse as a number.
 */
export function extractOrderTotal(text: string): number | null {
  const match = (text ?? "").match(/\btotal:[\s|]*\$?[\s|]*([\d,]+\.\d{2})/i);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isNaN(value) ? null : value;
}

/**
 * True when an email address looks like one of the brand's own internal
 * or licensee mailboxes (e.g. "wineandcanvas.gw@gmail.com",
 * "wineandcanvas.gr@gmail.com") rather than a real customer's personal
 * address - i.e. the local part (before the @) starts with the brand's
 * own name. Used to keep the "private_event_quote" pipeline branch from
 * auto-quoting a staff member or licensee's own outreach/internal chatter
 * just because it happens to use private-event vocabulary - see
 * PRIVATE_EVENT_INTERNAL_SENDER_PREFIX in src/config.ts for the real
 * tickets this was confirmed against.
 */
export function isInternalBrandSender(email: string | null | undefined, brandLocalPartPrefix: string): boolean {
  if (!email || !brandLocalPartPrefix) return false;
  const localPart = email.trim().toLowerCase().split("@")[0];
  return localPart.startsWith(brandLocalPartPrefix.toLowerCase());
}

/**
 * One product line from a storefront "New order" notification ticket.
 *
 * WooCommerce renders each purchased item as a line like:
 *
 *   Deposit - Covers 2 Seats (#180408-5135-DEPOSIT---COVERS-2-SEATS-)
 *   Birch Forest - LBC 10/4 (#179011-5135-BIRCH-FOREST---LBC-10/4)
 *
 * The parenthesised SKU always starts "#<event id>-", where <event id> is
 * the WooCommerce post ID of the EVENT the item belongs to (confirmed
 * against real tickets 2026-09-24: #29221/order #180710 -> event 180408
 * "Okemos Paint Party", #29323/order #180816 -> event 180811). That id is
 * what ties a later balance payment back to the deposit that preceded it.
 */
export interface OrderLineItem {
  /** Product name as shown before the SKU, e.g. "Deposit - Covers 2 Seats". */
  name: string;
  /** The event's WooCommerce post ID, e.g. "180408". */
  eventId: string;
}

// Matches "<product name> (#<event id>-<rest of sku>)" at the start of a
// line. The name is captured lazily so it stops at the SKU's opening
// paren, and the "#<digits>-" shape keeps this from matching the order's
// own "[Order #180710] (https://...)" link line or the event's
// "<Event Name> (https://.../event/slug/)" line.
const ORDER_LINE_ITEM_RE = /^(.+?)\s*\(#(\d+)-[^)\n]*\)/gm;

/**
 * Every product line in a "New order" notification body, in order.
 */
export function extractOrderLineItems(text: string): OrderLineItem[] {
  const items: OrderLineItem[] = [];
  const re = new RegExp(ORDER_LINE_ITEM_RE.source, ORDER_LINE_ITEM_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text ?? "")) !== null) {
    items.push({ name: m[1].trim(), eventId: m[2] });
  }
  return items;
}

/**
 * The first product line that is a private-event deposit/balance payment
 * rather than an ordinary seat purchase, or null if the order has none.
 *
 * Christopher, 2026-09-24, on how to spot private-event money: the
 * PRODUCT is the signal, not the event name. Checked against live data
 * before this was written - searching the word "private" anywhere in the
 * ticket matches 128 order tickets, nearly all of them ordinary $39
 * single-seat sales at events that merely have "Private" in their title
 * ("Private Painting Party- Upland Brewing", "Barrett's 9th Birthday
 * Private Party"). Worse, it MISSES the real case: order #180710, the
 * deposit that started this, is for "Okemos Paint Party" and contains the
 * word "private" nowhere at all. The 57 genuine deposit orders all name
 * the product "Deposit - 2 seats" / "Deposit (Covers 4 Seats)" / similar,
 * so that is what this matches.
 */
export function findDepositLineItem(text: string): OrderLineItem | null {
  return extractOrderLineItems(text).find((i) => /\bdeposit\b/i.test(i.name)) ?? null;
}
