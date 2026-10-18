import type { Redis } from 'ioredis';
import { BUS_CHANNEL, type BusEvent } from '@sway/shared';

/** Publishes an id-only event; every API instance's WebSocket hub loads the row and fans it out. */
export async function publish(redis: Redis, ev: BusEvent): Promise<void> {
  await redis.publish(BUS_CHANNEL, JSON.stringify(ev));
}
