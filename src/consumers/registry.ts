/**
 * Consumer Registry
 *
 * Manages registered consumers and their health state.
 * One consumer's failure must not affect others (BRK-DLQ-PER-CONSUMER).
 */

import type { Consumer, ConsumerStatus } from "./types.js";

export class ConsumerRegistry {
  private consumers = new Map<string, Consumer>();

  register(id: string, callbackUrl: string): Consumer {
    const consumer: Consumer = {
      id,
      callbackUrl,
      status: "unknown",
      messagesDelivered: 0,
      lastDelivery: null,
      errors: 0,
    };
    this.consumers.set(id, consumer);
    return consumer;
  }

  unregister(id: string): boolean {
    return this.consumers.delete(id);
  }

  get(id: string): Consumer | undefined {
    return this.consumers.get(id);
  }

  list(): readonly Consumer[] {
    return [...this.consumers.values()];
  }

  updateStatus(id: string, status: ConsumerStatus): void {
    const consumer = this.consumers.get(id);
    if (consumer) {
      consumer.status = status;
    }
  }

  recordDelivery(id: string, success: boolean): void {
    const consumer = this.consumers.get(id);
    if (!consumer) return;

    if (success) {
      consumer.messagesDelivered++;
      consumer.lastDelivery = new Date().toISOString();
      consumer.status = "healthy";
    } else {
      consumer.errors++;
      if (consumer.errors >= 3) {
        consumer.status = "unhealthy";
      }
    }
  }
}
