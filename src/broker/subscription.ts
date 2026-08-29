/**
 * Subscription Model
 *
 * Three subscription modes:
 *   - full_stream: All messages (used by session-replay)
 *   - filtered: Conditional messages (used by AskOS)
 *   - trigger: Fire on specific conditions (used by Slack)
 */

// ── Subscription Modes ──

export type SubscriptionMode = "full_stream" | "filtered" | "trigger";

export interface FilterConfig {
  /** Watch specific project path */
  projectPath?: string;
  /** Agent types to include */
  agentTypes?: string[];
  /** Roles to include: "user" | "assistant" */
  includeRoles?: string[];
  /** Fields to include in payload */
  includeFields?: string[];
  /** Fields to exclude from payload */
  excludeFields?: string[];
  /** Minimum interval between deliveries in ms */
  minIntervalMs?: number;
  /** Redaction level: minimal, standard, strict */
  redactionLevel?: RedactionLevel;
}

export type RedactionLevel = "minimal" | "standard" | "strict";

export interface TriggerCondition {
  field: string;
  op: "not_empty" | "exists_where" | "in" | "equals";
  subField?: string;
  value?: unknown;
}

export interface TriggerConfig {
  conditions: TriggerCondition[];
  conditionLogic?: "and" | "or";
  throttleSeconds?: number;
  cooldownPerSession?: boolean;
  format?: "json" | "slack";
  template?: Record<string, unknown>;
}

export interface CatchUpConfig {
  since?: string;
  sessions?: "all" | string[];
}

// ── Subscription Definition ──

export interface Subscription {
  consumerId: string;
  callbackUrl: string;
  mode: SubscriptionMode;
  filter?: FilterConfig;
  trigger?: TriggerConfig;
  catchUp?: CatchUpConfig;
  createdAt: string;
}

// ── Broker Event (message envelope) ──

export interface BrokerEnvelope {
  version: string;
  messageId: string;
  deliveredAt: string;
  deliveryAttempt: number;
}

export interface SessionMeta {
  sessionId: string;
  sessionPath: string;
  projectPath: string;
  agentType: string;
}

export interface IndexMeta {
  messageIndex: number;
  byteOffset: number;
}

export interface AgentMessage {
  role: "user" | "assistant" | "system";
  text?: string;
  toolUses?: unknown[];
  toolResults?: unknown[];
  thinking?: string[];
  timestamp: string;
}

export type BrokerEventType =
  | "message"
  | "session.discovered"
  | "session.idle"
  | "session.lost";

export interface BrokerEvent {
  _broker: BrokerEnvelope;
  _session: SessionMeta;
  _index?: IndexMeta;
  type: BrokerEventType;
  message?: AgentMessage;
  securityFlags?: unknown[];
  bannedWordHits?: unknown[];
}

// ── Subscription Manager ──

export class SubscriptionManager {
  private subscriptions = new Map<string, Subscription>();

  add(subscription: Subscription): void {
    this.subscriptions.set(subscription.consumerId, subscription);
  }

  remove(consumerId: string): boolean {
    return this.subscriptions.delete(consumerId);
  }

  get(consumerId: string): Subscription | undefined {
    return this.subscriptions.get(consumerId);
  }

  list(): readonly Subscription[] {
    return [...this.subscriptions.values()];
  }

  /**
   * Evaluate whether an event matches a subscription's filter/trigger.
   */
  matches(event: BrokerEvent, subscription: Subscription): boolean {
    switch (subscription.mode) {
      case "full_stream":
        return true;

      case "filtered":
        return this.matchesFilter(event, subscription.filter);

      case "trigger":
        return this.matchesTrigger(event, subscription.trigger);

      default:
        return false;
    }
  }

  private matchesFilter(
    event: BrokerEvent,
    filter?: FilterConfig
  ): boolean {
    if (!filter) return true;

    if (
      filter.projectPath &&
      event._session.projectPath !== filter.projectPath
    ) {
      return false;
    }

    if (
      filter.agentTypes &&
      !filter.agentTypes.includes(event._session.agentType)
    ) {
      return false;
    }

    if (
      filter.includeRoles &&
      (!event.message || !filter.includeRoles.includes(event.message.role))
    ) {
      return false;
    }

    return true;
  }

  private matchesTrigger(
    _event: BrokerEvent,
    _trigger?: TriggerConfig
  ): boolean {
    // Stub: trigger condition evaluation will be implemented in Phase 2
    return false;
  }
}
