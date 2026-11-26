import { createHash, randomUUID } from "node:crypto";

/** A short fingerprint of exactly what an approval card showed. */
export function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type Ticket = { digest: string; expires: number; granted: boolean; used: boolean };

/**
 * One-time approvals for actions that leave the app (a push, a pull request) or change the repository for an agent. The main process
 * issues a ticket for what it is about to show, only the approval window's answer can grant it, and it is redeemed once, for the same
 * fingerprint: if the repository moved while the card was open (a new commit, a changed branch), the redemption fails and nothing runs.
 */
export class ApprovalLedger {
  private readonly tickets = new Map<string, Ticket>();

  constructor(private readonly now: () => number = Date.now, private readonly lifetimeMs = 10 * 60_000) {}

  issue(digest: string): string {
    this.prune();
    const id = randomUUID();
    this.tickets.set(id, { digest, expires: this.now() + this.lifetimeMs, granted: false, used: false });
    return id;
  }

  /** The person approved the card with this ticket. */
  grant(id: string): boolean {
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.used || ticket.granted || this.now() > ticket.expires) return false;
    ticket.granted = true;
    return true;
  }

  /** True once, only for a granted ticket and the same fingerprint. */
  redeem(id: string, digest: string): boolean {
    const ticket = this.tickets.get(id);
    if (!ticket) return false;
    const valid = ticket.granted && !ticket.used && this.now() <= ticket.expires && ticket.digest === digest;
    ticket.used = true;
    this.tickets.delete(id);
    return valid;
  }

  revoke(id: string) { this.tickets.delete(id); }

  private prune() {
    for (const [id, ticket] of this.tickets) if (ticket.used || this.now() > ticket.expires) this.tickets.delete(id);
  }
}
