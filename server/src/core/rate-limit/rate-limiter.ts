/**
 * Layered rate limiting (Part 8, decision 2).
 *
 * Behind an interface with an in-process store for now. The same warning as
 * the cache applies, and more sharply: with two instances behind a load
 * balancer, each keeps its own counters, so the effective limit is the
 * configured one multiplied by the instance count. For the login tier that
 * directly weakens brute-force protection, which is why this must move to
 * Redis before a second instance runs.
 *
 * `rate-limiter-flexible` is used because it implements the sliding window
 * Part 8 asks for and has a Redis backend with the same interface, so the swap
 * is a constructor change rather than a rewrite.
 */

import { RateLimiterMemory, type RateLimiterAbstract } from 'rate-limiter-flexible';
import type { RequestHandler } from 'express';
import { RateLimitedError } from '../errors';
import { securityLogger } from '../logging/logger';
import { getContext } from '../http/request-context';

/**
 * The tiers from Part 8.
 *
 * `points` is requests allowed, `duration` the window in seconds. The numbers
 * are starting points chosen for a single-campus school — a few hundred staff
 * and a few thousand guardians — not for a public API.
 */
export const RATE_LIMIT_TIERS = {
  /** Tier 1: a blunt per-IP ceiling on everything. */
  global: { points: 300, duration: 60 },

  /**
   * Tier 2: login, refresh, password reset. Deliberately harsh.
   *
   * Five attempts a minute per IP. This works alongside the per-account
   * lockout, not instead of it: lockout stops one account being ground down,
   * this stops one IP spraying many accounts, and neither covers the other.
   */
  auth: { points: 5, duration: 60 },

  /** Tier 2b: keyed by username, so a distributed attack on one account still trips. */
  authPerAccount: { points: 10, duration: 300 },

  /** Tier 3: normal authenticated use, staff and admin. */
  userStandard: { points: 600, duration: 60 },

  /** Tier 3b: portal accounts. Lower — a guardian legitimately reads a handful of pages. */
  userPortal: { points: 120, duration: 60 },

  /** Tier 4: reports, exports, PDF generation, bulk reads. Each one is expensive. */
  expensive: { points: 10, duration: 60 },

  /** Tier 4b: search and typeahead. Frequent but must stay cheap. */
  search: { points: 60, duration: 60 },

  /** Tier 5: writes that create money records. */
  money: { points: 60, duration: 60 },

  /** Tier 6: notification sending, which costs real money per message. */
  notify: { points: 20, duration: 300 },

  /** File uploads. */
  upload: { points: 20, duration: 300 },

  /** Public verification endpoints (Part 12). Unauthenticated, so very tight. */
  publicVerify: { points: 10, duration: 60 },
} as const;

export type RateLimitTier = keyof typeof RATE_LIMIT_TIERS;

export interface RateLimiterStore {
  /**
   * Consume one point. Throws RateLimitedError when the window is exhausted.
   */
  consume(tier: RateLimitTier, key: string): Promise<void>;
  /** Reset a key's counter — used after a successful login. */
  reset(tier: RateLimitTier, key: string): Promise<void>;
}

export class InProcessRateLimiterStore implements RateLimiterStore {
  private readonly limiters = new Map<RateLimitTier, RateLimiterAbstract>();

  private limiterFor(tier: RateLimitTier): RateLimiterAbstract {
    let limiter = this.limiters.get(tier);
    if (!limiter) {
      const { points, duration } = RATE_LIMIT_TIERS[tier];
      limiter = new RateLimiterMemory({ points, duration, keyPrefix: tier });
      this.limiters.set(tier, limiter);
    }
    return limiter;
  }

  async consume(tier: RateLimitTier, key: string): Promise<void> {
    try {
      await this.limiterFor(tier).consume(key, 1);
    } catch (rejection) {
      // The library rejects with its own result object, not an Error.
      const msBeforeNext = (rejection as { msBeforeNext?: number }).msBeforeNext ?? 60_000;
      throw new RateLimitedError(Math.ceil(msBeforeNext / 1000));
    }
  }

  async reset(tier: RateLimitTier, key: string): Promise<void> {
    await this.limiterFor(tier).delete(key);
  }
}

/** Never limits. For tests, where tripping a limiter looks like a logic bug. */
export class NullRateLimiterStore implements RateLimiterStore {
  async consume(): Promise<void> {}
  async reset(): Promise<void> {}
}

/**
 * The key a tier counts against.
 *
 * Authenticated tiers key on the user id so one user on a shared school IP
 * cannot exhaust everyone else's budget; unauthenticated tiers have only the
 * IP to go on.
 */
function keyFor(tier: RateLimitTier, req: { ip?: string | undefined }): string {
  const ip = req.ip ?? 'unknown-ip';
  const userId = getContext()?.actor?.userId;

  switch (tier) {
    case 'userStandard':
    case 'userPortal':
    case 'expensive':
    case 'search':
    case 'money':
    case 'notify':
    case 'upload':
      return userId != null ? `u:${userId}` : `ip:${ip}`;
    default:
      return `ip:${ip}`;
  }
}

/**
 * Rate-limit middleware for a tier.
 *
 * A 429 is logged to the security channel rather than the request log: a burst
 * of them is a signal worth alerting on, and it should not have to be picked
 * out of ordinary traffic.
 */
export function rateLimit(tier: RateLimitTier, store: RateLimiterStore): RequestHandler {
  return (req, _res, next) => {
    const key = keyFor(tier, req);
    store
      .consume(tier, key)
      .then(() => next())
      .catch((err) => {
        if (err instanceof RateLimitedError) {
          securityLogger.warn(
            { tier, key, route: req.originalUrl, method: req.method },
            'Rate limit exceeded',
          );
        }
        next(err);
      });
  };
}
