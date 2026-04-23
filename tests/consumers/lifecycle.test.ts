import { describe, it, expect, beforeEach } from "vitest";
import { ConsumerRegistry } from "../../src/consumers/registry.js";

describe("ConsumerRegistry with tramli lifecycle", () => {
  let registry: ConsumerRegistry;

  beforeEach(() => {
    registry = new ConsumerRegistry({ errorThreshold: 3, maxRetries: 5 });
  });

  it("starts in HEALTHY after register", async () => {
    const consumer = await registry.register("c1", "http://localhost:8080");
    expect(consumer.status).toBe("HEALTHY");
    expect(consumer.messagesDelivered).toBe(0);
    expect(consumer.errors).toBe(0);
    expect(consumer.lastDelivery).toBeNull();
  });

  it("stays HEALTHY on successful delivery", async () => {
    await registry.register("c1", "http://localhost:8080");
    await registry.recordDelivery("c1", true);

    const consumer = registry.get("c1")!;
    expect(consumer.status).toBe("HEALTHY");
    expect(consumer.messagesDelivered).toBe(1);
    expect(consumer.errors).toBe(0);
    expect(consumer.lastDelivery).not.toBeNull();
  });

  it("stays HEALTHY when errors are below threshold", async () => {
    await registry.register("c1", "http://localhost:8080");

    await registry.recordDelivery("c1", false); // errors: 1
    expect(registry.get("c1")!.status).toBe("HEALTHY");

    await registry.recordDelivery("c1", false); // errors: 2
    expect(registry.get("c1")!.status).toBe("HEALTHY");
    expect(registry.get("c1")!.errors).toBe(2);
  });

  it("transitions to UNHEALTHY at error threshold", async () => {
    await registry.register("c1", "http://localhost:8080");

    await registry.recordDelivery("c1", false); // 1
    await registry.recordDelivery("c1", false); // 2
    await registry.recordDelivery("c1", false); // 3 → UNHEALTHY

    const consumer = registry.get("c1")!;
    expect(consumer.status).toBe("UNHEALTHY");
    expect(consumer.errors).toBe(3);
  });

  it("recovers from UNHEALTHY to HEALTHY on success", async () => {
    await registry.register("c1", "http://localhost:8080");

    // Drive to UNHEALTHY
    for (let i = 0; i < 3; i++) {
      await registry.recordDelivery("c1", false);
    }
    expect(registry.get("c1")!.status).toBe("UNHEALTHY");

    // Recover
    await registry.recordDelivery("c1", true);
    const consumer = registry.get("c1")!;
    expect(consumer.status).toBe("HEALTHY");
    expect(consumer.errors).toBe(0);
    expect(consumer.messagesDelivered).toBe(1);
  });

  it("transitions to DEAD at maxRetries", async () => {
    await registry.register("c1", "http://localhost:8080");

    for (let i = 0; i < 5; i++) {
      await registry.recordDelivery("c1", false);
    }

    const consumer = registry.get("c1")!;
    expect(consumer.status).toBe("DEAD");
    expect(consumer.errors).toBe(5);
  });

  it("DEAD consumer can be removed", async () => {
    await registry.register("c1", "http://localhost:8080");

    for (let i = 0; i < 5; i++) {
      await registry.recordDelivery("c1", false);
    }
    expect(registry.get("c1")!.status).toBe("DEAD");

    await registry.remove("c1");
    expect(registry.get("c1")!.status).toBe("REMOVED");
  });

  it("ignores delivery events for unknown consumer", async () => {
    await registry.recordDelivery("nonexistent", true);
    // No error thrown
  });

  it("ignores delivery events for completed (REMOVED) consumer", async () => {
    await registry.register("c1", "http://localhost:8080");
    for (let i = 0; i < 5; i++) {
      await registry.recordDelivery("c1", false);
    }
    await registry.remove("c1");

    await registry.recordDelivery("c1", true);
    expect(registry.get("c1")!.status).toBe("REMOVED");
  });

  it("remove is no-op for non-DEAD consumer", async () => {
    await registry.register("c1", "http://localhost:8080");
    await registry.remove("c1");
    expect(registry.get("c1")!.status).toBe("HEALTHY");
  });

  it("unregister removes consumer from registry", async () => {
    await registry.register("c1", "http://localhost:8080");
    expect(registry.unregister("c1")).toBe(true);
    expect(registry.get("c1")).toBeUndefined();
  });

  it("list returns all consumers", async () => {
    await registry.register("c1", "http://a");
    await registry.register("c2", "http://b");

    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  it("getState returns current lifecycle state", async () => {
    await registry.register("c1", "http://localhost:8080");
    expect(registry.getState("c1")).toBe("HEALTHY");

    for (let i = 0; i < 3; i++) {
      await registry.recordDelivery("c1", false);
    }
    expect(registry.getState("c1")).toBe("UNHEALTHY");
  });

  it("getState returns undefined for unknown consumer", () => {
    expect(registry.getState("nonexistent")).toBeUndefined();
  });

  it("successful delivery increments counter accurately", async () => {
    await registry.register("c1", "http://localhost:8080");

    for (let i = 0; i < 5; i++) {
      await registry.recordDelivery("c1", true);
    }

    const consumer = registry.get("c1")!;
    expect(consumer.messagesDelivered).toBe(5);
    expect(consumer.errors).toBe(0);
  });

  it("success after failures resets error count", async () => {
    await registry.register("c1", "http://localhost:8080");

    await registry.recordDelivery("c1", false); // errors: 1
    await registry.recordDelivery("c1", false); // errors: 2
    await registry.recordDelivery("c1", true); // errors reset to 0

    const consumer = registry.get("c1")!;
    expect(consumer.status).toBe("HEALTHY");
    expect(consumer.errors).toBe(0);
    expect(consumer.messagesDelivered).toBe(1);
  });

  it("uses default config when none provided", async () => {
    const defaultRegistry = new ConsumerRegistry();
    await defaultRegistry.register("c1", "http://localhost:8080");

    // Default errorThreshold=3, maxRetries=10
    for (let i = 0; i < 3; i++) {
      await defaultRegistry.recordDelivery("c1", false);
    }
    expect(defaultRegistry.get("c1")!.status).toBe("UNHEALTHY");

    // Not dead yet at 9 errors
    for (let i = 0; i < 6; i++) {
      await defaultRegistry.recordDelivery("c1", false);
    }
    expect(defaultRegistry.get("c1")!.status).toBe("UNHEALTHY");

    // Dead at 10
    await defaultRegistry.recordDelivery("c1", false);
    expect(defaultRegistry.get("c1")!.status).toBe("DEAD");
  });
});
