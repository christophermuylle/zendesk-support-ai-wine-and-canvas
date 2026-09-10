// Thin client around the Zendesk REST API (https://developer.zendesk.com/api-reference/).
// Auth uses an agent/admin email + API token, per Zendesk's basic-auth token scheme:
// https://developer.zendesk.com/api-reference/introduction/security-and-auth/#api-token

import type {
  ZendeskComment,
  ZendeskRequester,
  ZendeskTicket,
  TicketContext,
  ActionType,
} from "./types.js";

export interface ZendeskConfig {
  subdomain: string;
  email: string;
  apiToken: string;
  brand: string;
}

export type ZendeskStatus = "new" | "open" | "pending" | "hold" | "solved" | "closed";

/** Minimal surface the pipeline depends on - lets tests/mocks swap in a fake. */
export interface IZendeskClient {
  getTicketContext(ticketId: number): Promise<TicketContext>;
  postComment(
    ticketId: number,
    body: string,
    opts: { isPublic: boolean; status?: ActionType; addTags?: string[] }
  ): Promise<void>;
  /** Update status, tags, and/or custom fields WITHOUT posting a comment (used for out-of-scope tickets and rule-driven field updates like order confirmations). */
  updateTicket(
    ticketId: number,
    opts: { status?: ZendeskStatus; addTags?: string[]; fields?: Array<{ id: number; value: string | null }> }
  ): Promise<void>;
}

export class ZendeskClient implements IZendeskClient {
  private baseUrl: string;
  private authHeader: string;
  private brand: string;

  constructor(cfg: ZendeskConfig) {
    this.baseUrl = `https://${cfg.subdomain}.zendesk.com/api/v2`;
    const token = Buffer.from(`${cfg.email}/token:${cfg.apiToken}`).toString("base64");
    this.authHeader = `Basic ${token}`;
    this.brand = cfg.brand;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Zendesk API ${init.method ?? "GET"} ${path} failed: ${res.status} ${res.statusText} ${body}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async getTicket(ticketId: number): Promise<ZendeskTicket> {
    const data = await this.request<{ ticket: ZendeskTicket }>(`/tickets/${ticketId}.json`);
    return data.ticket;
  }

  async getComments(ticketId: number): Promise<ZendeskComment[]> {
    const data = await this.request<{ comments: ZendeskComment[] }>(
      `/tickets/${ticketId}/comments.json?sort_order=asc`
    );
    return data.comments;
  }

  async getRequester(userId: number): Promise<ZendeskRequester | null> {
    try {
      const data = await this.request<{ user: ZendeskRequester }>(`/users/${userId}.json`);
      return data.user;
    } catch {
      return null;
    }
  }

  /** Fetch everything the rules engine + AI need in one shot. */
  async getTicketContext(ticketId: number): Promise<TicketContext> {
    const ticket = await this.getTicket(ticketId);
    const [comments, requester] = await Promise.all([
      this.getComments(ticketId),
      this.getRequester(ticket.requester_id),
    ]);
    return { ticket, comments, requester, brand: this.brand };
  }

  /**
   * Post a comment on a ticket.
   * `isPublic: false` posts an internal note (visible only to agents) - this is what
   * MODE=draft uses so a human can review before anything reaches the customer.
   */
  async postComment(
    ticketId: number,
    body: string,
    opts: { isPublic: boolean; status?: ActionType; addTags?: string[] }
  ): Promise<void> {
    const statusMap: Record<string, string> = { solve: "solved", pending: "pending", escalate: "open" };
    const ticket: Record<string, unknown> = {
      comment: { body, public: opts.isPublic },
    };
    if (opts.status && statusMap[opts.status]) {
      ticket.status = statusMap[opts.status];
    }
    if (opts.addTags?.length) {
      ticket.additional_tags = opts.addTags;
    }
    await this.request(`/tickets/${ticketId}.json`, {
      method: "PUT",
      body: JSON.stringify({ ticket }),
    });
  }

  /**
   * Update status and/or tags without posting a comment - used for
   * out-of-scope tickets (e.g. wrong location) that should stay silent but
   * still land in the right queue for a human to redirect.
   *
   * Uses the `additional_tags` field on the ticket update, which ADDS tags
   * without touching existing ones. (The separate PUT /tickets/{id}/tags.json
   * endpoint instead REPLACES the whole tag list - deliberately not used
   * here, since that could wipe tags set by other Zendesk triggers/apps.)
   *
   * `fields` sets Zendesk custom ticket fields (e.g. the "Reason for
   * Customer Contacting Us" tagger field) - passed straight through as the
   * `fields` array the ticket API expects: [{ id, value }, ...].
   */
  async updateTicket(
    ticketId: number,
    opts: { status?: ZendeskStatus; addTags?: string[]; fields?: Array<{ id: number; value: string | null }> }
  ): Promise<void> {
    const ticket: Record<string, unknown> = {};
    if (opts.status) ticket.status = opts.status;
    if (opts.addTags?.length) ticket.additional_tags = opts.addTags;
    if (opts.fields?.length) ticket.fields = opts.fields;
    if (Object.keys(ticket).length === 0) return;
    await this.request(`/tickets/${ticketId}.json`, {
      method: "PUT",
      body: JSON.stringify({ ticket }),
    });
  }
}
