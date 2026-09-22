// Literal templates for the private event "no response" follow-up
// sequence (see src/followups.ts), verbatim from Christopher 2026-09-22 -
// do not paraphrase or restructure these, only fill in the placeholders,
// same rule as every other literal macro template in this codebase.
//
// Unlike the AI-drafted knowledge base templates, these are NOT run through
// the AI at all - they're fixed text the poller sends directly, the same
// way this brand's own private-event quotes (src/private-event-quotes.ts)
// are fixed mechanical replies rather than AI judgment calls. That's
// deliberate: a "did you get my email" nudge and a re-engagement email
// with a discount code shouldn't vary ticket to ticket.
//
// Two fixes applied to what Christopher pasted, both confirmed with him
// 2026-09-22:
//   - The Corporate 72h email's "CLICK HERE TO SEE ANOTHER FUN PIC FROM AN
//     EVENT" link came through corrupted (its own body text pasted in
//     place of a URL) - he confirmed reusing the Standard 72h email's
//     photo link (EVENT_PHOTO_LINK below) for Corporate too.
//   - The Standard 72h email said "Painting and Vino specializes in..." -
//     a copy-paste mix-up from that brand's own equivalent doc. Confirmed
//     a mistake and fixed to "Wine and Canvas" here.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Wraps an array of paragraph strings (may contain inline HTML like <a> or <br>) into a full HTML body. */
function wrapHtml(paragraphs: string[]): string {
  return paragraphs.map((p) => `<p>${p}</p>`).join("\n");
}

/**
 * Email 1 - sent 24h after the quote if the ticket is still pending with no
 * customer reply. Plain text (no links), sent via postComment's regular
 * `body`, not `htmlBody` - matches Christopher's pasted copy exactly.
 */
export function renderEmail1(): string {
  return [
    "Greetings,",
    "",
    "I wanted to follow up on the painting party quote I sent yesterday. With so many emails getting caught in spam filters these days, I just wanted to make sure it reached you.",
    "",
    "If you could reply with a quick confirmation that it landed safely, I’d really appreciate it.",
    "",
    "I realize you may still be reviewing the details, so I’ll follow up with you tomorrow in case you have any questions or would like to hop on a call to discuss your party ideas.",
    "",
    "Have a lovely day,",
    "Bonnie Davila",
    "Private Event Coordinator",
    "Wine & Canvas",
  ].join("\n");
}

// Confirmed by Christopher 2026-09-22 to also be the Corporate email's
// photo link, after its original URL came through corrupted.
const EVENT_PHOTO_LINK = "https://drive.google.com/file/d/1WJQ-RYpWcWyNpiJGHBrnfx5rYbb5ykrW/view?usp=sharing";

/**
 * Email 2 - sent 72h after the quote if still pending with no reply. Two
 * variants picked by the poller from the ticket's private-event category
 * tag (corporate vs everything else - see renderEmail2 below). Sent as
 * HTML (`htmlBody`) so the "CLICK HERE..." / "HERE IS ANOTHER..." links are
 * actually clickable, which a plain-text Zendesk comment can't do.
 */
function renderEmail2Corporate(firstName: string): string {
  const name = escapeHtml(firstName);
  return wrapHtml([
    `Hi ${name},`,
    "I sent you a text or called if it was a landline/office phone about your party quote. Did you get it? I wanted to follow up on my previous message and see if you might be interested in planning an unforgettable experience with us! Whether it’s for your clients, your team, or your community, we specialize in creating unique events that bring people together in fun, meaningful ways.",
    "We’ve had the pleasure of working with amazing organizations like IU Health, Salesforce, Pfizer, KRG Law, PWC, Indy Vet and more! - and many more—helping them elevate everything from team outings to client appreciation events.",
    "Here’s what a few of our happy clients have said:",
    '“We had so much fun. The instructor was great and easy to follow along with. We will be attending another event because we had so much fun.”<br>— Amanda D.',
    '“I had an amazing experience with my co-workers at our private Paint &amp; Sip event. I am not a painter at all, but Ayleen was amazing at helping us all become Picasso\'s. I loved every minute of it. Looking forward to booking another session with my family.”<br>— Jodi Chastain',
    "If you are hesitant due to budget restrictions let us know what you are thinking. We do have shorter projects on smaller canvases and will do our best to work with any budget.",
    "We’d love the chance to bring the same energy and creativity to your next event. Do you have 15 minutes this week or next to chat about options?",
    `<a href="${EVENT_PHOTO_LINK}">CLICK HERE TO SEE ANOTHER FUN PIC FROM AN EVENT</a>`,
    "Looking forward to hearing from you!",
    "Warm regards,<br>Bonnie Davila<br>Private Event Coordinator<br>Wine and Canvas",
  ]);
}

function renderEmail2Standard(firstName: string): string {
  const name = escapeHtml(firstName);
  return wrapHtml([
    `Hi ${name},`,
    "I sent you a text about your party quote. Did you get it? Just wanted to follow up to lock in plans for your celebration — whether it’s a birthday, bachelorette party, girls’ night, or something else fun you’ve got coming up - let us help make it extra memorable!",
    // Fixed from "Painting and Vino" (copy-paste mix-up, confirmed by
    // Christopher 2026-09-22) to this brand's actual name.
    "Wine and Canvas specializes in fun, creative experiences that bring people together. Whether you're toasting a bride-to-be or just getting the gang together for a night out, we make it easy to relax, sip, and get artsy with your favorite people.",
    "Here’s what a few of our guests had to say:",
    '“Emi was great; patient, fun and informative. Would suggest this to anyone, so fun!”<br>— Ben Dailey',
    '“Ayleen was amazing!!!! We booked for an office outing and the service was wonderful. Our artist knew how to take care of us, teach us, and show us a good time. We will definitely book again!”<br>— Stephanie Caban',
    "Let us know if you are working with a specific budget — we offer smaller canvas options and shorter sessions, and are happy to work with you so we can create something that fits your needs.",
    "When would be a good time to set up a quick 15-minute chat this week so we can lock in your special occasion?",
    `<a href="${EVENT_PHOTO_LINK}">HERE IS ANOTHER FUN PARTY PIC</a>`,
    "Warm regards,<br>Bonnie Davila<br>Private Event Coordinator<br>Wine and Canvas",
  ]);
}

/**
 * `category` is this brand's PrivateEventCategory (see
 * src/private-event-quotes.ts): "kids" | "fundraiser" | "corporate" |
 * "standard". Only "corporate" gets the Corporate variant - kids and
 * fundraiser use the Standard/personal variant, same reasoning Painting
 * and Vino's equivalent uses (Christopher only gave two variants -
 * Corporate vs "any other quote" - so this is the natural mapping; flag it
 * to him if kids/fundraiser should ever get their own wording).
 */
export function renderEmail2(firstName: string, category: "kids" | "fundraiser" | "corporate" | "standard"): string {
  return category === "corporate" ? renderEmail2Corporate(firstName) : renderEmail2Standard(firstName);
}

/**
 * Email 3 - sent 120h after the quote if still pending with no reply. Also
 * solves the ticket (see followups.ts). Sent as HTML for the calendar
 * link. `locationName`/`locationCalendarLink` come from
 * PRIVATE_EVENT_LOCATION_CALENDAR_LINKS below, keyed by the location tag
 * applied at quote time - Christopher's pasted copy listed all six Florida/
 * Indianapolis/Grand Rapids links at once, but his own instruction on this
 * template was "take off the website links not relevant to the location",
 * so this renders just the one link for the ticket's actual location
 * (matching Painting and Vino's equivalent pattern) rather than dumping
 * every city. Cadillac has no public event calendar page on file (see
 * config/knowledge-base/locations/cadillac.md) - falls back to a generic
 * line with the phone/email that file already points customers to, rather
 * than guessing a link or omitting the location entirely.
 */
export function renderEmail3(promoCode: string, locationName: string | null, locationCalendarLink: string | null): string {
  const browseLine =
    locationName && locationCalendarLink
      ? `Browse upcoming events in ${escapeHtml(locationName)} and choose the date that works best for you:<br>🎨 <a href="${locationCalendarLink}">${escapeHtml(locationName)}</a>`
      : locationName
        ? `Browse upcoming events and choose the date that works best for you - for ${escapeHtml(locationName)}, give us a call at (866) 631-0226 or email support@wineandcanvas.com and we'll get you the current schedule.`
        : "Browse upcoming events and choose the date that works best for you at <a href=\"https://wineandcanvas.com/\">wineandcanvas.com</a>.";

  return wrapHtml([
    "We know life gets busy, and sometimes plans (or schedules!) don’t line up perfectly. 😊",
    "Since we haven’t connected about your private event, we wanted to send a little something your way — because we’d still love you to experience one of our upcoming Wine & Canvas events!",
    `Come experience the fun, creativity, and connection for yourself with $10 off your ticket.<br>Use code: <strong>${escapeHtml(promoCode)}</strong>`,
    browseLine,
    "We’d love for you to join us, relax, sip, create, and see why our guests keep coming back! 🍷🖌️ If you decide to book a private party down the road simply respond to this email.",
    "Your $10 off code is valid for 30 days and can be used for public events (not valid for private parties or fundraisers).<br>Hope to paint with you soon!",
    "Stay Colorful! 🎨<br>Bonnie",
  ]);
}
