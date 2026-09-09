import fs from "node:fs";
import yaml from "js-yaml";
import type { TicketContext } from "./types.js";
import { getTicketMatchText } from "./util.js";

interface RawLocation {
  slug: string;
  display_name: string;
  file: string;
  match_keywords: string[];
}

interface LocationsFile {
  locations: RawLocation[];
}

export interface LocationMatch {
  slug: string;
  displayName: string;
  file: string;
}

/**
 * Resolves which managed location a ticket is about, from config/locations.yaml.
 * This is separate from (and runs after) the out_of_scope_location rule in
 * rules.yaml - by the time this runs, the ticket has already been confirmed
 * as one we support. This just figures out WHICH one, so the AI gets the
 * right pricing/booking/venue info instead of a generic answer.
 */
export class LocationResolver {
  private locations: RawLocation[];

  constructor(locationsPath: string) {
    const raw = fs.readFileSync(locationsPath, "utf-8");
    const parsed = yaml.load(raw) as LocationsFile;
    this.locations = parsed?.locations ?? [];
  }

  /** Returns the matched location, or null if the ticket text doesn't clearly name one. */
  resolve(ctx: TicketContext): LocationMatch | null {
    const text = getTicketMatchText(ctx);
    for (const loc of this.locations) {
      if (loc.match_keywords.some((k) => text.includes(k.toLowerCase()))) {
        return { slug: loc.slug, displayName: loc.display_name, file: loc.file };
      }
    }
    return null;
  }
}
