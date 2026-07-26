/**
 * Redis implementation of DedupeStore.
 *
 * This is the difference between one text message and two.
 *
 * The outbox relay guarantees AT-LEAST-once delivery, so the same event will
 * arrive more than once — that is by design, not a bug. Deduplication is what
 * turns at-least-once into effectively-once. With the in-memory store, each
 * replica keeps its own `Set`, so two replicas both see the same event as new
 * and the customer receives two "your rider has arrived" messages. We pay
 * Hubtel for both.
 *
 * `SET key value NX PX ttl` is one atomic command and the only thing in the
 * stack that can arbitrate this across processes.
 */

import type Redis from 'ioredis';
import type { DedupeStore } from './dispatcher.ts';

export class RedisDedupeStore implements DedupeStore {
  constructor(
    private readonly redis: Redis,
    /**
     * Fail OPEN or fail CLOSED when Redis itself is unreachable?
     *
     * Open (default): send anyway, risking a duplicate. Closed: stay silent,
     * risking the customer never learning their rider is outside.
     *
     * Open is right for notifications. A duplicate text is an annoyance and a
     * few pesewas; a missed arrival notification is cold food and a support
     * call. The two are not symmetric, so we do not treat them as if they are.
     */
    private readonly failOpen = true,
  ) {}

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      const res = await this.redis.set(key, '1', 'EX', ttlSeconds, 'NX');
      return res === 'OK';
    } catch (err) {
      if (!this.failOpen) return false;
      // Loud, because a silent fallback here means we are paying for
      // duplicate SMS without anything on a dashboard saying so.
      console.error(
        '[svc-messaging] dedupe store unreachable, sending WITHOUT dedupe '
        + '(duplicates possible, each one billable):',
        (err as Error).message,
      );
      return true;
    }
  }
}
