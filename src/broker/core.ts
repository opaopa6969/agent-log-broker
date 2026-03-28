/**
 * Broker Core - Fan-out Engine
 *
 * Responsibilities:
 *   - Receive parsed messages from adapters
 *   - Apply redaction pipeline
 *   - Distribute to registered consumers based on subscription mode
 *
 * Non-responsibilities:
 *   - Log persistence (consumer's job)
 *   - Agent control (AskOS's job)
 *   - UI (session-replay's job)
 *   - Judgment/decision (consumer's job)
 */

import type { BrokerEvent } from "./subscription.js";
import type { Consumer, DeliveryResult } from "../consumers/types.js";

export interface BrokerCoreOptions {
  /** Maximum retry attempts for failed deliveries */
  maxRetries: number;
  /** Backoff base in ms */
  retryBackoffMs: number;
  /** Delivery timeout in ms */
  deliveryTimeoutMs: number;
}

const DEFAULT_OPTIONS: BrokerCoreOptions = {
  maxRetries: 3,
  retryBackoffMs: 1000,
  deliveryTimeoutMs: 5000,
};

export class BrokerCore {
  private options: BrokerCoreOptions;

  constructor(options: Partial<BrokerCoreOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Fan-out a broker event to a list of consumers.
   * Applies subscription filters and delivers to matching consumers.
   */
  async distribute(
    event: BrokerEvent,
    consumers: readonly Consumer[]
  ): Promise<Map<string, DeliveryResult>> {
    const results = new Map<string, DeliveryResult>();

    const deliveries = consumers.map(async (consumer) => {
      const result = await this.deliverToConsumer(event, consumer);
      results.set(consumer.id, result);
    });

    await Promise.allSettled(deliveries);
    return results;
  }

  /**
   * Deliver a single event to a single consumer.
   * Handles retry with exponential backoff.
   */
  private async deliverToConsumer(
    _event: BrokerEvent,
    consumer: Consumer
  ): Promise<DeliveryResult> {
    // Stub: actual HTTP POST delivery will be implemented in Phase 1
    return {
      consumerId: consumer.id,
      success: true,
      attempt: 1,
      deliveredAt: new Date().toISOString(),
    };
  }
}
