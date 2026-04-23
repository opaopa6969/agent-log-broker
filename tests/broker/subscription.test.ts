import { describe, it, expect, beforeEach } from "vitest";
import {
  SubscriptionManager,
  type Subscription,
  type BrokerEvent,
} from "../../src/broker/subscription.js";

// ── Helpers ──

function makeEvent(
  overrides: Partial<BrokerEvent["_session"]> = {}
): BrokerEvent {
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
      ...overrides,
    },
    type: "message",
    message: {
      role: "user",
      text: "Hello",
      timestamp: new Date().toISOString(),
    },
  };
}

function makeSubscription(
  overrides: Partial<Subscription> = {}
): Subscription {
  return {
    consumerId: "consumer-1",
    callbackUrl: "http://localhost:9000/callback",
    mode: "full_stream",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ──

describe("SubscriptionManager", () => {
  let manager: SubscriptionManager;

  beforeEach(() => {
    manager = new SubscriptionManager();
  });

  // ── CRUD ──

  describe("add / get / remove / list", () => {
    it("add stores a subscription and get retrieves it", () => {
      const sub = makeSubscription({ consumerId: "c1" });
      manager.add(sub);
      expect(manager.get("c1")).toBe(sub);
    });

    it("get returns undefined for unknown consumerId", () => {
      expect(manager.get("nonexistent")).toBeUndefined();
    });

    it("remove returns true and deletes the subscription", () => {
      const sub = makeSubscription({ consumerId: "c1" });
      manager.add(sub);
      expect(manager.remove("c1")).toBe(true);
      expect(manager.get("c1")).toBeUndefined();
    });

    it("remove returns false when consumerId is not found", () => {
      expect(manager.remove("nonexistent")).toBe(false);
    });

    it("list returns all added subscriptions", () => {
      const s1 = makeSubscription({ consumerId: "c1" });
      const s2 = makeSubscription({ consumerId: "c2" });
      manager.add(s1);
      manager.add(s2);
      const list = manager.list();
      expect(list).toHaveLength(2);
      expect(list).toContain(s1);
      expect(list).toContain(s2);
    });

    it("list returns empty array when no subscriptions exist", () => {
      expect(manager.list()).toHaveLength(0);
    });

    it("add overwrites existing subscription for same consumerId", () => {
      const s1 = makeSubscription({
        consumerId: "c1",
        callbackUrl: "http://old",
      });
      const s2 = makeSubscription({
        consumerId: "c1",
        callbackUrl: "http://new",
      });
      manager.add(s1);
      manager.add(s2);
      expect(manager.get("c1")!.callbackUrl).toBe("http://new");
      expect(manager.list()).toHaveLength(1);
    });
  });

  // ── matches: full_stream ──

  describe("matches() for full_stream subscriptions", () => {
    it("always returns true regardless of event content", () => {
      const sub = makeSubscription({ mode: "full_stream" });
      const event = makeEvent();
      expect(manager.matches(event, sub)).toBe(true);
    });

    it("returns true even when event has a different projectPath", () => {
      const sub = makeSubscription({ mode: "full_stream" });
      const event = makeEvent({ projectPath: "/projects/other" });
      expect(manager.matches(event, sub)).toBe(true);
    });
  });

  // ── matches: filtered ──

  describe("matches() for filtered subscriptions", () => {
    it("returns true when no filter config is set", () => {
      const sub = makeSubscription({ mode: "filtered", filter: undefined });
      const event = makeEvent();
      expect(manager.matches(event, sub)).toBe(true);
    });

    it("returns true when event projectPath matches filter", () => {
      const sub = makeSubscription({
        mode: "filtered",
        filter: { projectPath: "/projects/my-project" },
      });
      const event = makeEvent({ projectPath: "/projects/my-project" });
      expect(manager.matches(event, sub)).toBe(true);
    });

    it("returns false when event projectPath does not match filter", () => {
      const sub = makeSubscription({
        mode: "filtered",
        filter: { projectPath: "/projects/my-project" },
      });
      const event = makeEvent({ projectPath: "/projects/other-project" });
      expect(manager.matches(event, sub)).toBe(false);
    });

    it("returns true when event agentType is in filter agentTypes", () => {
      const sub = makeSubscription({
        mode: "filtered",
        filter: { agentTypes: ["claude", "gpt"] },
      });
      const event = makeEvent({ agentType: "claude" });
      expect(manager.matches(event, sub)).toBe(true);
    });

    it("returns false when event agentType is NOT in filter agentTypes", () => {
      const sub = makeSubscription({
        mode: "filtered",
        filter: { agentTypes: ["gpt"] },
      });
      const event = makeEvent({ agentType: "claude" });
      expect(manager.matches(event, sub)).toBe(false);
    });

    it("returns true when both projectPath and agentType match", () => {
      const sub = makeSubscription({
        mode: "filtered",
        filter: {
          projectPath: "/projects/my-project",
          agentTypes: ["claude"],
        },
      });
      const event = makeEvent({
        projectPath: "/projects/my-project",
        agentType: "claude",
      });
      expect(manager.matches(event, sub)).toBe(true);
    });

    it("returns false when projectPath matches but agentType does not", () => {
      const sub = makeSubscription({
        mode: "filtered",
        filter: {
          projectPath: "/projects/my-project",
          agentTypes: ["gpt"],
        },
      });
      const event = makeEvent({
        projectPath: "/projects/my-project",
        agentType: "claude",
      });
      expect(manager.matches(event, sub)).toBe(false);
    });
  });
});
