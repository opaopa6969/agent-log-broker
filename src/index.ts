/**
 * Agent Log Broker - Entry Point
 *
 * Central log broker for AskOS workspace ecosystem.
 * Receives LLM agent logs and fans out to consumers.
 *
 * "I'm a pipe, not a judge."
 */

export { BrokerCore } from "./broker/core.js";
export { SubscriptionManager } from "./broker/subscription.js";
export { ConsumerRegistry } from "./consumers/registry.js";
export {
  buildConsumerLifecycle,
  DELIVERY_SUCCESS,
  ERROR_COUNT,
  MESSAGES_DELIVERED,
  LAST_DELIVERY,
} from "./consumers/lifecycle.js";
export type { LifecycleConfig } from "./consumers/lifecycle.js";
export type {
  Consumer,
  ConsumerState,
  ConsumerCallback,
  DeliveryResult,
} from "./consumers/types.js";
export { FileWatcher } from "./adapters/file-watcher.js";
export { RedactionPipeline } from "./security/redaction.js";
