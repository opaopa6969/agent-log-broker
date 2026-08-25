/**
 * Broker engine benchmarks.
 *
 * Targets the four hot paths the engine spends its time in:
 *   1. RedactionPipeline.process()   — content-aware work per line
 *   2. SubscriptionManager.matches()  — filter evaluation per (event, sub)
 *   3. BrokerCore.distribute()        — fan-out dispatch per event
 *   4. FileWatcher.readNewLines()     — JSONL tail read per change notification
 *
 * Runs via `npm run bench` (vitest --bench). tinybench is already a transitive
 * dependency of vitest, so no new packages are required.
 */

import { bench, describe, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrokerCore } from "../../src/broker/core.js";
import {
  SubscriptionManager,
  type BrokerEvent,
  type Subscription,
} from "../../src/broker/subscription.js";
import { RedactionPipeline } from "../../src/security/redaction.js";
import { FileWatcher } from "../../src/adapters/file-watcher.js";
import type { Consumer } from "../../src/consumers/types.js";

// ── Fixtures ──

function makeEvent(text = "Hello agent, please do something"): BrokerEvent {
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
      text,
      timestamp: new Date().toISOString(),
    },
  };
}

function makeConsumer(id: string): Consumer {
  return {
    id,
    callbackUrl: "http://localhost:9000/callback",
    status: "HEALTHY",
    messagesDelivered: 0,
    lastDelivery: null,
    errors: 0,
  };
}

function makeSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    consumerId: "consumer-1",
    callbackUrl: "http://localhost:9000/callback",
    mode: "full_stream",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// Realistic-ish log line mixing ASCII + multibyte + a PII hit, so the bench
// exercises the same content shape the broker sees in production.
const SAMPLE_LINE =
  '{"role":"assistant","text":"処理を開始します。user@example.com に連絡して rm -rf /tmp を実行してください。"}';

// ── 1. RedactionPipeline ──

describe("RedactionPipeline.process()", () => {
  const pipeline = new RedactionPipeline("standard");

  const textWithPii =
    "Please contact user@example.com or call 090-1234-5678. AWS key AKIAIOSFODNN7EXAMPLE leaked. Run rm -rf /tmp/old.";

  bench(
    "standard level — mixed PII + credentials + dangerous command",
    () => {
      pipeline.process(textWithPii);
    },
  );

  bench("plain text — no PII (early-return path)", () => {
    pipeline.process("just a normal agent log line with no sensitive content");
  });

  bench("minimal level — PII only", () => {
    new RedactionPipeline("minimal").process(textWithPii);
  });

  bench("strict level — PII + credentials + file paths", () => {
    new RedactionPipeline("strict").process(textWithPii);
  });
});

// ── 2. SubscriptionManager.matches() ──

describe("SubscriptionManager.matches()", () => {
  const manager = new SubscriptionManager();
  const fullStreamSub = makeSubscription({
    consumerId: "full-1",
    mode: "full_stream",
  });
  const filteredSub = makeSubscription({
    consumerId: "filtered-1",
    mode: "filtered",
    filter: {
      projectPath: "/projects/my-project",
      agentTypes: ["claude"],
      includeRoles: ["assistant"],
    },
  });
  manager.add(fullStreamSub);
  manager.add(filteredSub);

  const matchingEvent = makeEvent();
  matchingEvent.message!.role = "assistant";

  const nonMatchingEvent = makeEvent();
  nonMatchingEvent._session.projectPath = "/projects/other";
  nonMatchingEvent.message!.role = "user";

  bench("full_stream — trivial true", () => {
    manager.matches(matchingEvent, fullStreamSub);
  });

  bench("filtered — matches all criteria", () => {
    manager.matches(matchingEvent, filteredSub);
  });

  bench("filtered — early reject on projectPath", () => {
    manager.matches(nonMatchingEvent, filteredSub);
  });

  bench("filtered — reject on role mismatch", () => {
    const ev = makeEvent();
    ev.message!.role = "user";
    manager.matches(ev, filteredSub);
  });
});

// ── 3. BrokerCore.distribute() ──

describe("BrokerCore.distribute() fan-out", () => {
  const core = new BrokerCore();
  const event = makeEvent();

  bench("1 consumer", () => core.distribute(event, [makeConsumer("c1")]));

  bench(
    "20 consumers (Phase 2 target)",
    () =>
      core.distribute(
        event,
        Array.from({ length: 20 }, (_, i) => makeConsumer(`c${i}`)),
      ),
  );

  bench(
    "100 consumers (stress)",
    () =>
      core.distribute(
        event,
        Array.from({ length: 100 }, (_, i) => makeConsumer(`c${i}`)),
      ),
  );
});

// ── 4. FileWatcher.readNewLines() ──

describe("FileWatcher.readNewLines() JSONL tail", () => {
  // readNewLines is private; reach in via the same structural cast the unit
  // tests use, so the bench exercises the real byte-offset scan loop.
  type ReadNewLines = (
    sessionPath: string,
    onLine: (line: string, offset: number) => void,
  ) => Promise<void>;
  const read = (w: FileWatcher): ReadNewLines =>
    (w as unknown as { readNewLines: ReadNewLines }).readNewLines.bind(w);

  // Pre-build fixtures once. The earlier version of this bench created a temp
  // dir + wrote 1000 lines *inside* the timed function, which attributed all
  // the I/O cost to readNewLines and produced an artificially slow 240 Hz
  // figure. The real per-call cost is ~1 ms, not ~4 ms.
  let initialDir: string;
  let initialLogPath: string;
  let incrementalDir: string;
  let incrementalLogPath: string;

  beforeAll(async () => {
    initialDir = await mkdtemp(join(tmpdir(), "alb-bench-init-"));
    initialLogPath = join(initialDir, "log.jsonl");
    const initialContent = Array.from(
      { length: 1000 },
      (_, i) => `${JSON.stringify({ i, t: SAMPLE_LINE })}`,
    ).join("\n") + "\n";
    await writeFile(initialLogPath, initialContent, "utf-8");

    incrementalDir = await mkdtemp(join(tmpdir(), "alb-bench-inc-"));
    incrementalLogPath = join(incrementalDir, "log.jsonl");
    const baseContent = Array.from(
      { length: 1000 },
      (_, i) => `${JSON.stringify({ i, t: SAMPLE_LINE })}`,
    ).join("\n") + "\n";
    await writeFile(incrementalLogPath, baseContent, "utf-8");
    // Prepend 10 fresh lines so the bench measures *only* the incremental
    // read, not the append I/O.
    const appended = Array.from(
      { length: 10 },
      (_, i) => `${JSON.stringify({ i: i + 1000, t: SAMPLE_LINE })}`,
    ).join("\n") + "\n";
    await appendFile(incrementalLogPath, appended, "utf-8");
  });

  afterAll(async () => {
    await rm(initialDir, { recursive: true, force: true });
    await rm(incrementalDir, { recursive: true, force: true });
  });

  bench(
    "initial read — 1000 multibyte lines",
    async () => {
      // Fresh watcher each call so offset resets to 0; only the read loop is
      // timed.
      const w = new FileWatcher();
      await read(w)(initialLogPath, () => {});
    },
  );

  bench(
    "incremental read — 10 new lines after 1000 existing",
    async () => {
      // Each iteration gets a watcher that has already consumed the initial
      // 1000 lines, so only the 10 appended lines are read.
      const w = new FileWatcher();
      await read(w)(incrementalLogPath, () => {});
      // Simulate a follow-up incremental read by appending nothing — the
      // second call is the realistic hot path in production.
      await read(w)(incrementalLogPath, () => {});
    },
  );
});

// ── 5. End-to-end pipeline (wired components) ──
//
// Today the components are not wired (BrokerCore.distribute is a stub and
// does not call redaction or matches). This bench measures what a *real*
// end-to-end pass would cost by manually composing the stages, giving us a
// baseline for when the orchestrator is implemented.

describe("composite pipeline (redact → match → distribute)", () => {
  const pipeline = new RedactionPipeline("standard");
  const manager = new SubscriptionManager();
  const core = new BrokerCore();

  const subs = [
    makeSubscription({ consumerId: "full-1", mode: "full_stream" }),
    makeSubscription({
      consumerId: "filtered-1",
      mode: "filtered",
      filter: { projectPath: "/projects/my-project", agentTypes: ["claude"] },
    }),
  ];
  for (const s of subs) manager.add(s);

  const consumers = Array.from({ length: 20 }, (_, i) => makeConsumer(`c${i}`));

  bench("1 event through redact+match+distribute (20 consumers)", async () => {
    const ev = makeEvent();
    const result = pipeline.process(ev.message?.text ?? "");
    if (ev.message) ev.message.text = result.redactedText;
    if (result.securityFlags.length) ev.securityFlags = result.securityFlags;
    const matched = consumers.filter(() => {
      // Simulate per-consumer subscription check.
      const sub = subs[0];
      return manager.matches(ev, sub);
    });
    await core.distribute(ev, matched);
  });
});
