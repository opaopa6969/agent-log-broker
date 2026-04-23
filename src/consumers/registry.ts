/**
 * Consumer Registry
 *
 * Manages registered consumers and their health state via tramli state machine.
 * One consumer's failure must not affect others (BRK-DLQ-PER-CONSUMER).
 */

import { InMemoryFlowStore, type FlowEngine, type FlowInstance, type FlowDefinition } from "@unlaxer/tramli";
import type { Consumer, ConsumerState } from "./types.js";
import {
  buildConsumerLifecycle,
  createLifecycleEngine,
  DELIVERY_SUCCESS,
  ERROR_COUNT,
  MESSAGES_DELIVERED,
  LAST_DELIVERY,
  type LifecycleConfig,
} from "./lifecycle.js";

interface ConsumerEntry {
  id: string;
  callbackUrl: string;
  flowId: string;
  flow: FlowInstance<ConsumerState>;
}

export class ConsumerRegistry {
  private entries = new Map<string, ConsumerEntry>();
  private store: InMemoryFlowStore;
  private engine: FlowEngine;
  private definition: FlowDefinition<ConsumerState>;

  constructor(config?: Partial<LifecycleConfig>) {
    this.store = new InMemoryFlowStore();
    this.engine = createLifecycleEngine(this.store);
    this.definition = buildConsumerLifecycle(config);
  }

  async register(id: string, callbackUrl: string): Promise<Consumer> {
    const flow = await this.engine.startFlow(
      this.definition,
      id,
      new Map(),
    );
    this.entries.set(id, { id, callbackUrl, flowId: flow.id, flow });
    return this.toConsumer(id);
  }

  unregister(id: string): boolean {
    return this.entries.delete(id);
  }

  get(id: string): Consumer | undefined {
    if (!this.entries.has(id)) return undefined;
    return this.toConsumer(id);
  }

  list(): readonly Consumer[] {
    return [...this.entries.keys()].map((id) => this.toConsumer(id));
  }

  async recordDelivery(id: string, success: boolean): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.flow.isCompleted) return;

    const externalData = new Map<string, unknown>([
      [DELIVERY_SUCCESS as string, success],
    ]);
    await this.engine.resumeAndExecute(entry.flowId, this.definition, externalData);
  }

  async remove(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.flow.currentState !== "DEAD") return;

    await this.engine.resumeAndExecute(entry.flowId, this.definition);
  }

  getState(id: string): ConsumerState | undefined {
    return this.entries.get(id)?.flow.currentState;
  }

  private toConsumer(id: string): Consumer {
    const entry = this.entries.get(id)!;
    const ctx = entry.flow.context;
    return {
      id: entry.id,
      callbackUrl: entry.callbackUrl,
      status: entry.flow.currentState,
      messagesDelivered: ctx.find(MESSAGES_DELIVERED) ?? 0,
      lastDelivery: ctx.find(LAST_DELIVERY) ?? null,
      errors: ctx.find(ERROR_COUNT) ?? 0,
    };
  }
}
