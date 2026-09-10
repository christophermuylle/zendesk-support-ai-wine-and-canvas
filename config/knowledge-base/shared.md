# Shared Support Knowledge Base (all locations)

> This file is combined with a location-specific file (see
> config/knowledge-base/locations/) for every ticket where a location was
> identified. Put anything true EVERYWHERE here; put pricing, booking
> links, and venue specifics in the per-location files instead - those vary
> a lot by city.
>
> The AI answers ONLY from what's written here plus the matched location
> file. If something isn't covered, it falls back to a "let me check"
> reply instead of guessing.

## What we are

Painting & Vino and Wine and Canvas are mobile (no storefront) paint-and-sip
brands. Licensees run events out of a vehicle/kit rather than a leased
studio, and events are hosted at partner venues (restaurants, breweries,
wine bars, etc.) that the licensee books into - not private in-home
parties.

Events are a fun, social, group setting where an artist/instructor guides
participants step by step in replicating the night's featured painting.
Standard events run about 2.5-3 hours with frequent breaks; arrive about
30 minutes early to get signed in, seated, and get food/drinks ordered.
Seating is limited per class, so advance booking is recommended.

## What's included / what to bring

Provided: artist/instructor, canvas, paint, brushes, easels, and an apron.
Food and beverages (including alcohol) are NOT included in the ticket
price - venues offer food/drinks for purchase separately. This is
intentional, to keep the ticket price accessible. BYOB is not allowed at
any studio or partner venue.

Wear something you wouldn't mind getting paint on - aprons are provided
but we're not responsible for paint on clothing. Paints used are water
based acrylics and non-toxic.

## Cancellation & refund policy

Source note: confirmed against the team's actual Zendesk macros (pulled
2026-09-09), which line up closely with the Florida FAQ page and with
Painting and Vino's own policy - treat this as accurate company-wide.

Two separate rules apply - don't conflate them:

- **Rescheduling/credit, based on time before the EVENT:** cancel or move
  a reservation by notifying customer service at least 48 hours before
  the class starts, and it can be moved to a different class at full
  value. Canceling with *less than* 48 hours' notice does not qualify for
  a move or full credit - instead we offer credit equal to 50% of the
  amount paid, usable toward a future regularly-priced class (no
  expiration, can't combine with other vouchers/codes, must be used for
  the same seat count).
- **Refund to original payment method, based on time since PURCHASE:**
  only honored if requested within 3 days of the original purchase date;
  after that window, store credit applies instead of a cash refund.

Even though refund requests are always escalated to a human by the rules
engine, the AI uses this text to set correct expectations while the human
follows up - so keep it accurate.

## Age requirements & alcohol policy

Standard events are an adult event - you must be at least 21 to attend
unless the hosting venue specifies otherwise; some venues don't allow
anyone under 21 at all. Check the individual event listing for specifics.
(source: wineandcanvas.com/florida FAQ)

<!-- TODO: confirm this 21+ policy is current/accurate everywhere - the
     source FAQ also mentioned a separate kid-friendly "Cookies and Canvas"
     product for younger guests; confirm whether that applies to your
     licensees or remove this note if not relevant. -->

## Private / corporate events

We're 100% mobile (no studio) - we bring supplies to the customer's home,
office, or a venue of their choice; we don't provide food, beverages,
tables, or chairs. If the customer needs a venue, we have partner
restaurant lists by city; point them to customer service or the private
events coordinator for that list rather than guessing at one.

**Minimum group size:** 8 guests, company-wide, including Cadillac
(confirmed by Christopher - this supersedes any lower/higher figures
seen in individual macros).

**Pricing (per person, 3-hour event, standard 16x20 canvas) - varies by
city and standard vs. corporate/business booking:**
- Standard: Indianapolis, Cadillac, Tampa, Fort Myers/Cape Coral, Fort
  Lauderdale $39/person; Lansing/Grand Rapids $40/person; Orlando,
  Naples/Bonita Springs, Miami $45/person.
- Corporate/Business: same cities at $44/person; Lansing/Grand Rapids
  $44/person; Orlando/Naples/Miami $50/person.
- Volume discounts apply at 30-49 guests and 50+ guests (roughly $4-9/
  person cheaper per tier - a human should confirm the exact tier a
  ticket needs rather than the AI calculating it).
- Kids' "Cookies and Canvas" private events: $29/person (10-person
  minimum), $27/person in Fort Lauderdale, $35/person in Orlando.
- A custom (non-portfolio) painting design costs an extra $50-75
  depending on event type.
- Because exact pricing depends on city, group size, and event type, the
  AI should NOT quote a specific number - point the customer to a private
  events quote from our team (see event_booking_question rule) rather
  than calculating one itself.

**Deposit:** the greater of 2 seats' worth or 20% of the expected
headcount. Non-refundable, but transferable to a future date for up to
one year. The remaining balance is due the day before the event. A late
start (an hour or more past the confirmed time) may incur a $50/hour late
fee.

**No-shows:** up to 3 no-shows can be refunded/credited off the final
invoice, as long as the group stays at or above the 8-person minimum.

**Fundraisers:** we keep $35 per ticket sold (the organization sets the
ticket price and keeps the difference) for standard step-by-step events,
or $45/ticket for pet portrait fundraisers (add $10 for Orlando pet
portraits); 8-person minimum.

Other formats available (ask a human for current pricing/details): glass
painting, board painting, pet portraits (great for animal rescue
fundraisers), custom murals.

## Becoming a licensee

<!-- FLAGGED: the 70/30 revenue split, no-fee, no-territorial-exclusivity
     terms below were not confirmed anywhere in the team's actual macros
     or FAQ pages during this review - please confirm before the AI
     states specific terms to a prospective licensee, or tell us to
     remove them so the AI just points people to apply instead. -->

We license the Wine and Canvas and Painting and Vino brands through one
shared application pipeline (confirmed by Christopher). Direct
interested applicants to apply at
paintingandvino.com/become-a-painting-and-vino-licensee/ - that's correct
for Wine and Canvas inquiries too, not a copy-paste mistake - rather than
the AI stating specific financial terms (revenue split, fees, territorial
exclusivity) itself.

## Locations we do NOT support

We only handle customer support directly for a subset of locations. The
following run their own local support and should never be answered or
solved by this system (this is enforced separately by the
out_of_scope_location rule, but noted here too for context): Las Vegas NV
/ Henderson NV, Toledo OH, Columbus OH, South Bend IN, Rochester MN,
Minneapolis MN, Bloomington IN.

If a ticket doesn't clearly match one of our managed locations below, do
NOT guess pricing, venues, or booking details - ask the customer which
location they mean, or fall back to pending for a human to sort out.

## Linking to the event calendar

When a customer asks how to find, sign up for, register for, or attend a
public event (this does NOT apply to private/corporate event bookings,
which go through the quote-request flow above instead) and a location was
matched, always include that location's direct calendar link - the "Direct
link" line under its Booking section - as a plain, clickable URL in the
reply. Don't just say "check our website" when we have the actual link on
file. Match this style (Christopher's example):

> Hi there! Thanks for reaching out! To sign up for an event in Fort
> Myers, just head to our website and browse the Fort Myers event
> listings. Here is a direct link to make it easy to find our event
> calendar: https://wineandcanvas.com/florida/fort-myers/. Each event has
> its own "Get Tickets" button that will take you to the registration
> page where you can book your spot. Seating is limited per class, so we
> recommend booking in advance! If you have any trouble finding an event
> or need help with anything else, just let me know!

If the matched location's Booking section has no "Direct link" on file (a
few locations don't have a public calendar page yet), do NOT guess or
invent one - say a team member will help them find the next available
date/location instead.

## Contact / escalation

Bonnie is our primary Customer Support representative and first point of
contact for any escalated tickets (refunds, upset customers, and anything
else the rules engine flags for human review). Amber is the secondary/
backup contact. When the AI escalates a ticket, it should let the customer
know that a member of our customer support team will follow up with them
personally - it should not name Bonnie or Amber specifically in the reply,
just route the internal note/tag so Bonnie sees it first.

<!-- TODO: what turnaround time should the AI promise (e.g. "within 1
     business day")? -->
