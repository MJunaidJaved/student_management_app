/**
 * Immediate revocation for stateless access tokens (Part 6.2).
 *
 * An access token is valid until it expires; nothing about it can be withdrawn.
 * That is usually fine because they are short-lived, but logout and "this
 * account is compromised" both need the token to stop working *now*.
 *
 * Entries only need to outlive the token, so each is held for the access-token
 * TTL plus a small margin and then dropped. That bounds the memory: at a
 * 15-minute TTL the list holds at most 15 minutes of logouts.
 *
 * Per-user revocation is by timestamp rather than by enumerating that user's
 * tokens. A token issued before the cutoff is refused. It is one comparison,
 * needs no knowledge of which tokens exist, and handles "revoke everything"
 * correctly even for tokens the server never recorded.
 */

import { config } from '../config';
import type { TokenDenylist } from '../http/authenticate';

/** Parse "15m", "900s", "1h" into milliseconds. */
function ttlToMs(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!match) return 15 * 60_000;
  const value = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const factor = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return value * factor;
}

export interface TokenDenylistStore extends TokenDenylist {
  /** Deny one specific access token. */
  revoke(jti: string): Promise<void>;
  /** Deny every access token issued to this user before now. */
  revokeAllForUser(userId: string): Promise<void>;
  /** True when this token was issued before the user's revocation cutoff. */
  isUserRevokedSince(userId: string, issuedAtSeconds: number): Promise<boolean>;
}

export class InProcessTokenDenylist implements TokenDenylistStore {
  private readonly jtis = new Map<string, number>();
  private readonly userCutoffs = new Map<string, number>();
  private readonly retentionMs: number;

  constructor() {
    // Margin covers clock skew between issuing and checking.
    this.retentionMs = ttlToMs(config.ACCESS_TOKEN_TTL) + 60_000;
  }

  async revoke(jti: string): Promise<void> {
    this.jtis.set(jti, Date.now() + this.retentionMs);
    this.sweep();
  }

  async isRevoked(jti: string): Promise<boolean> {
    const expiry = this.jtis.get(jti);
    if (expiry === undefined) return false;
    if (expiry <= Date.now()) {
      this.jtis.delete(jti);
      return false;
    }
    return true;
  }

  async revokeAllForUser(userId: string): Promise<void> {
    this.userCutoffs.set(userId, Date.now());
    this.sweep();
  }

  async isUserRevokedSince(userId: string, issuedAtSeconds: number): Promise<boolean> {
    const cutoff = this.userCutoffs.get(userId);
    if (cutoff === undefined) return false;
    if (cutoff + this.retentionMs <= Date.now()) {
      this.userCutoffs.delete(userId);
      return false;
    }
    return issuedAtSeconds * 1000 < cutoff;
  }

  /**
   * Drop expired entries.
   *
   * On write rather than on a timer, so the process has nothing keeping it
   * alive at shutdown. Volumes here are small — logouts, not requests.
   */
  private sweep(): void {
    const now = Date.now();
    for (const [jti, expiry] of this.jtis) {
      if (expiry <= now) this.jtis.delete(jti);
    }
    for (const [userId, cutoff] of this.userCutoffs) {
      if (cutoff + this.retentionMs <= now) this.userCutoffs.delete(userId);
    }
  }

  /** Test helper. */
  get size(): number {
    return this.jtis.size + this.userCutoffs.size;
  }
}
