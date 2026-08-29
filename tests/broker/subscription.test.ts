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

  // ── matches: filtered includeRoles ──

  describe("matches() for filtered includeRoles", () => {
    it("returns true when event message role is in filter includeRoles", () => {
      const sub = makeSubscription({
        mode: "filtered",
        filter: { includeRoles: ["assistant"] },
      });
      const event = makeEvent();
      event.message = {
        role: "assistant",
        text: "Hi",
        timestamp: new Date().toISOString(),
      };
      expect(manager.matches(event, sub)).toBe(true);
    });

    it("returns false when event message role is NOT in filter includeRoles", () => {
      const sub = makeSubscription({
        mode: "filtered",
        filter: { includeRoles: ["assistant"] },
      });
      const event = makeEvent();
      event.message = {
        role: "user",
        text: "Hi",
        timestamp: new Date().toISOString(),
      };
      expect(manager.matches(event, sub)).toBe(false);
    });

    it("returns false when includeRoles is set but event has no message (session.discovered)", () => {
      const sub = makeSubscription({
        mode: "filtered",
        filter: { includeRoles: ["assistant"] },
      });
      const event: BrokerEvent = {
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
        type: "session.discovered",
      };
      expect(manager.matches(event, sub)).toBe(false);
    });

    it("returns false when includeRoles is set but event has no message (session.idle)", () => {
      const sub = makeSubscription({
        mode: "filtered",
        filter: { includeRoles: ["user"] },
      });
      const event: BrokerEvent = {
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
        type: "session.idle",
      };
      expect(manager.matches(event, sub)).toBe(false);
    });
  });

  // ── matches: trigger (stub) ──
  // `matchesTrigger()` is a documented stub (Phase 2 work) that always
  // returns false. Pin this behavior so a future implementation does not
  // silently start firing on events that used to be suppressed.

  describe("matches() for trigger subscriptions", () => {
    it("returns false for a trigger subscription with not_empty condition", () => {
      const sub = makeSubscription({
        mode: "trigger",
        trigger: {
          conditions: [{ field: "securityFlags", op: "not_empty" }],
        },
      });
      const event = makeEvent();
      event.securityFlags = [{ type: "dangerous_command" }];
      expect(manager.matches(event, sub)).toBe(false);
    });

    it("returns false even when the event would seem to satisfy the condition", () => {
      const sub = makeSubscription({
        mode: "trigger",
        trigger: {
          conditions: [
            { field: "securityFlags", op: "not_empty" },
            { field: "text", op: "equals", value: "danger" },
          ],
          conditionLogic: "and",
        },
      });
      const event = makeEvent();
      event.message = {
        role: "user",
        text: "danger",
        timestamp: new Date().toISOString(),
      };
      event.securityFlags = [{ type: "dangerous_command" }];
      expect(manager.matches(event, sub)).toBe(false);
    });

    it("returns false for a trigger subscription with no trigger config", () => {
      const sub = makeSubscription({ mode: "trigger", trigger: undefined });
      const event = makeEvent();
      expect(manager.matches(event, sub)).toBe(false);
    });

    it("returns false regardless of throttle / cooldown / format settings", () => {
      const sub = makeSubscription({
        mode: "trigger",
        trigger: {
          conditions: [{ field: "securityFlags", op: "not_empty" }],
          throttleSeconds: 300,
          cooldownPerSession: true,
          format: "slack",
        },
      });
      const event = makeEvent();
      event.securityFlags = [{ type: "dangerous_command" }];
      expect(manager.matches(event, sub)).toBe(false);
    });
  });

  // ── matches: full_stream ignores filter/trigger config ──
  // full_stream short-circuits to true before consulting filter or trigger.
  // A consumer that accidentally attaches a filter or trigger to a
  // full_stream subscription must still receive all events.

  describe("matches() for full_stream ignores attached filter/trigger", () => {
    it("returns true when a filter that would reject the event is attached", () => {
      const sub = makeSubscription({
        mode: "full_stream",
        filter: { projectPath: "/projects/other-project" },
      });
      const event = makeEvent({ projectPath: "/projects/my-project" });
      expect(manager.matches(event, sub)).toBe(true);
    });

    it("returns true when a trigger config is attached", () => {
      const sub = makeSubscription({
        mode: "full_stream",
        trigger: {
          conditions: [{ field: "securityFlags", op: "not_empty" }],
        },
      });
      const event = makeEvent();
      expect(manager.matches(event, sub)).toBe(true);
    });

    it("returns true when both filter and trigger are attached", () => {
      const sub = makeSubscription({
        mode: "full_stream",
        filter: { agentTypes: ["gpt"] },
        trigger: { conditions: [{ field: "x", op: "exists_where" }] },
      });
      const event = makeEvent({ agentType: "claude" });
      expect(manager.matches(event, sub)).toBe(true);
    });
  });
});
