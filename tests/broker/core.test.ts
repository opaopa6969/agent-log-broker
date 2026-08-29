import { describe, it, expect } from "vitest";
import { BrokerCore, type BrokerCoreOptions } from "../../src/broker/core.js";
import type { Consumer } from "../../src/consumers/types.js";
import type { BrokerEvent } from "../../src/broker/subscription.js";

// ── Helpers ──

function makeEvent(): BrokerEvent {
  return {
    _broker: {
      version: "1.0",
      messageId: "msg-1",
      deliveredAt: new Date().toISOString(),
      deliveryAttempt: 1,
    },
    _session: {
      sessionId: "session-1",
      sessionPath: "/sessions/session-1",
      projectPath: "/projects/my-project",
      agentType: "claude",
    },
    type: "message",
    message: {
      role: "user",
      text: "Hello",
      timestamp: new Date().toISOString(),
    },
  };
}

function makeConsumer(overrides: Partial<Consumer> = {}): Consumer {
  return {
    id: "consumer-1",
    callbackUrl: "http://localhost:9000/callback",
    status: "HEALTHY",
    messagesDelivered: 0,
    lastDelivery: null,
    errors: 0,
    ...overrides,
  };
}

// ── Tests ──

describe("BrokerCore", () => {
  describe("DEFAULT_OPTIONS merge", () => {
    it("uses default options when constructed with no arguments", () => {
      const core = new BrokerCore();
      const opts = (core as unknown as { options: BrokerCoreOptions }).options;
      expect(opts).toEqual({
        maxRetries: 3,
        retryBackoffMs: 1000,
        deliveryTimeoutMs: 5000,
      });
    });

    it("uses default options when constructed with empty object", () => {
      const core = new BrokerCore({});
      const opts = (core as unknown as { options: BrokerCoreOptions }).options;
      expect(opts).toEqual({
        maxRetries: 3,
        retryBackoffMs: 1000,
        deliveryTimeoutMs: 5000,
      });
    });

    it("partially overrides defaults — only provided fields change", () => {
      const core = new BrokerCore({ maxRetries: 10 });
      const opts = (core as unknown as { options: BrokerCoreOptions }).options;
      expect(opts).toEqual({
        maxRetries: 10,
        retryBackoffMs: 1000,
        deliveryTimeoutMs: 5000,
      });
    });

    it("fully overrides defaults when all fields are provided", () => {
      const core = new BrokerCore({
        maxRetries: 5,
        retryBackoffMs: 500,
        deliveryTimeoutMs: 10000,
      });
      const opts = (core as unknown as { options: BrokerCoreOptions }).options;
      expect(opts).toEqual({
        maxRetries: 5,
        retryBackoffMs: 500,
        deliveryTimeoutMs: 10000,
      });
    });
  });

  describe("distribute()", () => {
    it("returns an empty Map for an empty consumer list", async () => {
      const core = new BrokerCore();
      const result = await core.distribute(makeEvent(), []);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it("delivers to a single consumer and returns a Map with its result", async () => {
      const core = new BrokerCore();
      const consumer = makeConsumer({ id: "c1" });
      const result = await core.distribute(makeEvent(), [consumer]);
      expect(result.size).toBe(1);
      expect(result.get("c1")).toEqual({
        consumerId: "c1",
        success: true,
        attempt: 1,
        deliveredAt: expect.any(String),
      });
    });

    it("delivers to multiple consumers — Map contains a result per consumer", async () => {
      const core = new BrokerCore();
      const consumers = [
        makeConsumer({ id: "c1" }),
        makeConsumer({ id: "c2" }),
        makeConsumer({ id: "c3" }),
      ];
      const result = await core.distribute(makeEvent(), consumers);
      expect(result.size).toBe(3);
      for (const c of consumers) {
        expect(result.get(c.id)).toEqual({
          consumerId: c.id,
          success: true,
          attempt: 1,
          deliveredAt: expect.any(String),
        });
      }
    });

    // Regression-prone edge case: results is a Map keyed by consumer.id, so
    // duplicate IDs collide. Pin the current behavior (last-writer-wins, only
    // one entry in the Map) so a silent change in the dedup semantics is
    // caught.
    it("collapses duplicate consumer IDs to a single Map entry", async () => {
      const core = new BrokerCore();
      const consumers = [
        makeConsumer({ id: "dup" }),
        makeConsumer({ id: "dup" }),
      ];
      const result = await core.distribute(makeEvent(), consumers);
      // Two deliveries happen but the Map only keeps one entry per id.
      expect(result.size).toBe(1);
      expect(result.has("dup")).toBe(true);
      expect(result.get("dup")).toEqual({
        consumerId: "dup",
        success: true,
        attempt: 1,
        deliveredAt: expect.any(String),
      });
    });
  });

  describe("deliverToConsumer() stub return value", () => {
    it("returns success:true with attempt:1 and matching consumerId", async () => {
      const core = new BrokerCore();
      const consumer = makeConsumer({ id: "alpha" });
      const result = await core.distribute(makeEvent(), [consumer]);
      const r = result.get("alpha")!;
      expect(r.consumerId).toBe("alpha");
      expect(r.success).toBe(true);
      expect(r.attempt).toBe(1);
      expect(typeof r.deliveredAt).toBe("string");
      expect(new Date(r.deliveredAt).toString()).not.toBe("Invalid Date");
    });
  });
});
