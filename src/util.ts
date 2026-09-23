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
  return `${ctx.ticket.subject ?? ""}\n${latestCustomerMessage?.body ?? ctx.ticket.description ?? ""}`.toLowerCase();
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
