/**
 * Consumer Callback Contract
 *
 * Consumer must accept POST to callback_url:
 *   Body: BrokerEvent (Broker -> Consumer Message Format)
 *   Response:
 *     2xx -> delivery success
 *     4xx -> permanent error (consumer's problem, not retried)
 *     5xx -> transient error -> retry -> DLQ
 *   Timeout: 5 seconds (configurable)
 */

export type ConsumerStatus = "healthy" | "unhealthy" | "unknown";

export interface Consumer {
  id: string;
  callbackUrl: string;
  status: ConsumerStatus;
  messagesDelivered: number;
  lastDelivery: string | null;
  errors: number;
}

export interface ConsumerCallback {
  /** URL to POST broker events to */
  url: string;
  /** Timeout in ms for the callback */
  timeoutMs: number;
}

export interface DeliveryResult {
  consumerId: string;
  success: boolean;
  attempt: number;
  deliveredAt: string;
  error?: string;
  /** If true, message was sent to DLQ */
  dlq?: boolean;
}
