/**
 * Consumer Lifecycle State Machine
 *
 * Defines consumer health transitions using tramli.
 * Replaces ad-hoc status management with explicit, validated state machine.
 *
 * Flow:
 *   INITIALIZING ──auto──> HEALTHY
 *   HEALTHY ──external(delivery)──> ASSESSING ──branch──> HEALTHY | UNHEALTHY | DEAD
 *   UNHEALTHY ──external(delivery)──> ASSESSING ──branch──> HEALTHY | UNHEALTHY | DEAD
 *   DEAD ──external(cleanup)──> REMOVED
 *   any error ──> DEAD
 */

import {
  Tramli,
  FlowEngine,
  InMemoryFlowStore,
  flowKey,
  type FlowDefinition,
  type StateConfig,
  type StateProcessor,
  type TransitionGuard,
  type BranchProcessor,
} from "@unlaxer/tramli";

import type { ConsumerState } from "./types.js";

// ── Flow Keys ────────────────────────────────────────────

export const DELIVERY_SUCCESS = flowKey<boolean>("deliverySuccess");
export const ERROR_COUNT = flowKey<number>("errorCount");
export const MESSAGES_DELIVERED = flowKey<number>("messagesDelivered");
export const LAST_DELIVERY = flowKey<string | null>("lastDelivery");

// ── Config ───────────────────────────────────────────────

export interface LifecycleConfig {
  /** Consecutive errors before UNHEALTHY (default 3) */
  errorThreshold: number;
  /** Consecutive errors before DEAD (default 10) */
  maxRetries: number;
}

const DEFAULT_CONFIG: LifecycleConfig = {
  errorThreshold: 3,
  maxRetries: 10,
};

// ── State Config ─────────────────────────────────────────

const STATE_CONFIG: Record<ConsumerState, StateConfig> = {
  INITIALIZING: { initial: true, terminal: false },
  HEALTHY: { initial: false, terminal: false },
  ASSESSING: { initial: false, terminal: false },
  UNHEALTHY: { initial: false, terminal: false },
  DEAD: { initial: false, terminal: false },
  REMOVED: { initial: false, terminal: true },
};

// ── Factory ──────────────────────────────────────────────

export function buildConsumerLifecycle(
  config: Partial<LifecycleConfig> = {},
): FlowDefinition<ConsumerState> {
  const { errorThreshold, maxRetries } = { ...DEFAULT_CONFIG, ...config };

  const initProcessor: StateProcessor<ConsumerState> = {
    name: "initProcessor",
    requires: [],
    produces: [ERROR_COUNT, MESSAGES_DELIVERED, LAST_DELIVERY],
    process(ctx) {
      ctx.put(ERROR_COUNT, 0);
      ctx.put(MESSAGES_DELIVERED, 0);
      ctx.put(LAST_DELIVERY, null);
    },
  };

  const deliveryGuard: TransitionGuard<ConsumerState> = {
    name: "deliveryGuard",
    requires: [DELIVERY_SUCCESS],
    produces: [],
    maxRetries: 0,
    validate: () => ({ type: "accepted" }),
  };

  const assessBranch: BranchProcessor<ConsumerState> = {
    name: "assessBranch",
    requires: [DELIVERY_SUCCESS, ERROR_COUNT],
    decide(ctx) {
      const success = ctx.get(DELIVERY_SUCCESS);
      if (success) return "success";
      const nextErrors = ctx.get(ERROR_COUNT) + 1;
      if (nextErrors >= maxRetries) return "dead";
      if (nextErrors >= errorThreshold) return "unhealthy";
      return "degraded"; // under threshold — stay healthy but record error
    },
  };

  const successProcessor: StateProcessor<ConsumerState> = {
    name: "successProcessor",
    requires: [MESSAGES_DELIVERED],
    produces: [ERROR_COUNT, MESSAGES_DELIVERED, LAST_DELIVERY],
    process(ctx) {
      ctx.put(ERROR_COUNT, 0);
      ctx.put(MESSAGES_DELIVERED, ctx.get(MESSAGES_DELIVERED) + 1);
      ctx.put(LAST_DELIVERY, new Date().toISOString());
    },
  };

  const degradedProcessor: StateProcessor<ConsumerState> = {
    name: "degradedProcessor",
    requires: [ERROR_COUNT],
    produces: [ERROR_COUNT],
    process(ctx) {
      ctx.put(ERROR_COUNT, ctx.get(ERROR_COUNT) + 1);
    },
  };

  const unhealthyProcessor: StateProcessor<ConsumerState> = {
    name: "unhealthyProcessor",
    requires: [ERROR_COUNT],
    produces: [ERROR_COUNT],
    process(ctx) {
      ctx.put(ERROR_COUNT, ctx.get(ERROR_COUNT) + 1);
    },
  };

  const deadProcessor: StateProcessor<ConsumerState> = {
    name: "deadProcessor",
    requires: [ERROR_COUNT],
    produces: [ERROR_COUNT],
    process(ctx) {
      ctx.put(ERROR_COUNT, ctx.get(ERROR_COUNT) + 1);
    },
  };

  const cleanupGuard: TransitionGuard<ConsumerState> = {
    name: "cleanupGuard",
    requires: [],
    produces: [],
    maxRetries: 0,
    validate: () => ({ type: "accepted" }),
  };

  return Tramli.define<ConsumerState>("consumer-lifecycle", STATE_CONFIG)
    .externallyProvided(DELIVERY_SUCCESS)
    .from("INITIALIZING")
    .auto("HEALTHY", initProcessor)
    .from("HEALTHY")
    .external("ASSESSING", deliveryGuard)
    .from("UNHEALTHY")
    .external("ASSESSING", deliveryGuard)
    .from("ASSESSING")
    .branch(assessBranch)
    .to("HEALTHY", "success", successProcessor)
    .to("HEALTHY", "degraded", degradedProcessor)
    .to("UNHEALTHY", "unhealthy", unhealthyProcessor)
    .to("DEAD", "dead", deadProcessor)
    .endBranch()
    .from("DEAD")
    .external("REMOVED", cleanupGuard)
    .onAnyError("DEAD")
    .build();
}

// ── Engine Factory ───────────────────────────────────────

export function createLifecycleEngine(store: InMemoryFlowStore): FlowEngine {
  return Tramli.engine(store);
}
