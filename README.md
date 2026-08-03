[日本語版はこちら / Japanese](README-ja.md)

# agent-log-broker

Central log broker for the AskOS workspace ecosystem — fan-out Claude session logs to multiple consumers.

> **Design principle: "I am a pipe, not a judge."**
> The broker does not understand log content. It receives, optionally redacts PII, and delivers. That is all.

---

## Table of Contents

- [What it does](#what-it-does)
- [Ecosystem position](#ecosystem-position)
- [Subscription modes](#subscription-modes) — full\_stream / filtered / trigger
- [Consumer lifecycle](#consumer-lifecycle) — tramli state machine
- [tramli integration](#tramli-integration)
- [session-replay / replayer integration](#session-replay--replayer-integration)
- [Known limitations](#known-limitations)
- [Development](#development)
- [Roadmap](#roadmap)

---

## What it does

agent-log-broker's **design target** is to watch `~/.claude/projects/` for JSONL log files written by Claude Code (and future agents), parse each line into a common `AgentMessage` model, wrap it in a `BrokerEvent` envelope, and fan it out to registered consumers according to their subscription mode.

Today the individual building blocks exist as separate modules, but **they are not yet wired together into a running pipeline** (see the Status column below and [Known limitations](#known-limitations)).

The broker's seven responsibilities and their current implementation status:

| Responsibility | Description | Status |
|---|---|---|
| Discover | Locate agent log files under the base path | Implemented (`FileWatcher.discoverSessions()`; symlink resolution pending) |
| Watch | Detect file changes via `fs.watch` | Implemented (`FileWatcher.watchSession()`) |
| Parse | Convert raw JSONL lines to `AgentMessage` | **Not implemented** — the `AgentMessage` type is defined, but no code converts a JSONL line into one; `watchSession()` hands the raw string to `onLine` |
| Redact | Mask PII (minimal / standard / strict) | Implemented (`RedactionPipeline`: PII + credentials) |
| Flag | Detect dangerous commands and banned words | **Partial** — dangerous-command detection only; banned-word detection is not implemented (no word list, no scan) |
| Distribute | Fan-out `BrokerEvent` to matching consumers | **Stub** — `distribute()` fans out via `Promise.allSettled`, but delivery is a stub and it applies neither `SubscriptionManager.matches()` nor redaction |
| Offset Track | Remember how far each file has been read | Implemented in-memory (byte offsets; persistence remains a limitation) |

---

## Ecosystem position

```mermaid
flowchart TD
    Agent["Agent<br/>(Claude Code, Codex, Gemini, ...)"]
    Broker["agent-log-broker<br/>Discover → Watch → Parse<br/>→ Redact → Flag → Distribute"]
    AskOS["AskOS<br/>filtered: progress + anomalies only"]
    Replay["session-replay<br/>full_stream: all messages, accumulate + replay"]
    Slack["Slack webhook<br/>trigger: security alerts only"]
    Dash["Dashboard<br/>filtered: metadata only"]

    Agent -- "JSONL log file output" --> Broker
    Broker -- fan-out --> AskOS
    Broker -- fan-out --> Replay
    Broker -- fan-out --> Slack
    Broker -- fan-out --> Dash
```

> **Wiring status**: The diagram shows the target design. In the current code these stages exist as independent modules, but nothing connects them: `BrokerCore.distribute()` does not invoke parsing, redaction, flagging, or `SubscriptionManager.matches()`, and there is no orchestrator / `main` that runs `Discover → Watch → Parse → Redact → Flag → Distribute` end to end. `src/index.ts` only re-exports the modules. Of the chain above, only `Discover → Watch` is actually connected today (via `FileWatcher`).

---

## Subscription modes

### full\_stream

Receive every event from every session. Used by `session-replay`.

```json
{
  "consumerId": "session-replay",
  "callbackUrl": "http://localhost:4200/broker/events",
  "mode": "full_stream"
}
```

### filtered

Receive events matching project path, agent type, role, and field criteria. Used by AskOS.

```json
{
  "consumerId": "askos",
  "callbackUrl": "http://localhost:3000/broker/events",
  "mode": "filtered",
  "filter": {
    "projectPath": "/home/opa/work/my-project",
    "includeRoles": ["assistant"],
    "includeFields": ["toolUses", "text", "securityFlags"],
    "excludeFields": ["toolResults", "thinking"],
    "redactionLevel": "standard"
  }
}
```

> **Note**: `matchesFilter()` currently evaluates only `projectPath`, `agentTypes`, and `includeRoles`. `includeFields` / `excludeFields` (field projection), `redactionLevel` (per-consumer redaction), and `minIntervalMs` (rate limiting) are accepted by the `FilterConfig` type but are **not yet applied** — the event payload is passed through unchanged.

### trigger

Fire only when specific conditions match. Used by Slack webhook.

```json
{
  "consumerId": "slack-security",
  "callbackUrl": "https://hooks.slack.com/...",
  "mode": "trigger",
  "trigger": {
    "conditions": [
      { "field": "securityFlags", "op": "not_empty" }
    ],
    "throttleSeconds": 300
  }
}
```

> **Note**: trigger condition evaluation is a stub in the current implementation (Phase 2 work).

---

## Consumer lifecycle

Each consumer's health is tracked by a [tramli](https://github.com/opaopa6969/tramli) state machine:

```mermaid
stateDiagram-v2
    [*] --> INITIALIZING
    INITIALIZING --> HEALTHY : auto
    HEALTHY --> ASSESSING : external(delivery result)
    UNHEALTHY --> ASSESSING : external(delivery result)
    ASSESSING --> HEALTHY : branch
    ASSESSING --> UNHEALTHY : branch
    ASSESSING --> DEAD : branch
    DEAD --> REMOVED : external(cleanup)
    HEALTHY --> DEAD : any error
    ASSESSING --> DEAD : any error
    UNHEALTHY --> DEAD : any error
    REMOVED --> [*]
```

Branch logic in `ASSESSING`:
- Delivery success → `HEALTHY` (reset error count)
- Errors < `errorThreshold` (default 3) → stay `HEALTHY` (increment error count)
- Errors >= `errorThreshold` → `UNHEALTHY`
- Errors >= `maxRetries` (default 10) → `DEAD`

See [docs/consumer-lifecycle.md](docs/consumer-lifecycle.md) for the full state machine reference.

---

## tramli integration

The consumer lifecycle is implemented as a tramli `FlowDefinition<ConsumerState>`. tramli enforces at build time that:

- Every state has a defined processor or guard
- Every `flowKey` dependency is satisfied before it is read
- No invalid transitions can exist

The `ConsumerRegistry` uses `InMemoryFlowStore` and a single shared `FlowEngine`. Each registered consumer gets its own `FlowInstance`.

```typescript
import { ConsumerRegistry } from "@unlaxer/agent-log-broker";

const registry = new ConsumerRegistry({ errorThreshold: 3, maxRetries: 10 });
const consumer = await registry.register("my-consumer", "http://localhost:9000/events");
// consumer.status === "HEALTHY"

await registry.recordDelivery("my-consumer", false); // trigger ASSESSING
```

---

## session-replay / replayer integration

`session-replay` (claude-session-replay) is a first-class consumer of this broker:

- **Before**: session-replay read log files directly, maintaining its own parse and offset logic.
- **After**: The broker handles discovery, watching, parsing, and delivery. session-replay receives `BrokerEvent` objects via HTTP POST and focuses on accumulation and UI.

Log format adapters (`claude-log2model`, `codex-log2model`, etc.) migrate from session-replay into the broker's adapter layer.

The `BrokerEvent` schema (`schemas/broker-event.schema.json`, JSON Schema Draft 2020-12) is the contract between broker and consumers. See [docs/architecture.md](docs/architecture.md) for the full field reference.

---

## Known limitations

| Limitation | Detail |
|---|---|
| Pipeline is not wired end to end | `BrokerCore.distribute()` calls neither `SubscriptionManager.matches()` nor `RedactionPipeline`; there is no orchestrator / `main` connecting watch → parse → redact → flag → match → distribute. `src/index.ts` only re-exports modules. |
| Parse stage is missing | No code converts a JSONL line into `AgentMessage`. The type is defined; the converter is not written. `FileWatcher` emits the raw line string. |
| `filtered` field projection / redaction not applied | `matchesFilter()` evaluates `projectPath` / `agentTypes` / `includeRoles` only. `includeFields`, `excludeFields`, `redactionLevel`, and `minIntervalMs` are not applied. |
| Banned-word flagging not implemented | `RedactionPipeline` flags dangerous commands and PII/credentials only. The `banned_word` flag type and `bannedWordHits` field exist, but there is no word list and no detection code. |
| `deliverToConsumer` is a stub | HTTP POST delivery not yet implemented. Returns `success: true` unconditionally. Phase 1 work. |
| FileWatcher offsets are in-memory | Offsets are lost on process restart. A session will be re-read from offset 0 on startup. Persistent offset store is Phase 2 work. |
| Symlink resolution incomplete | `discoverSessions()` returns the raw directory hash as `projectPath`. Symlink resolution to the real project path is not yet implemented. |
| trigger evaluation is a stub | `matchesTrigger()` always returns `false`. Phase 2 work. |

---

## Development

```bash
npm install
npm run build       # TypeScript compile
npm run dev         # Watch mode (tsx)
npm test            # Vitest
npm run typecheck   # tsc --noEmit
```

### Project structure

```
src/
├── broker/
│   ├── core.ts          # BrokerCore — fan-out engine
│   ├── subscription.ts  # SubscriptionManager + BrokerEvent types
│   └── lifecycle.ts     # (reserved)
├── consumers/
│   ├── types.ts         # Consumer, ConsumerState, DeliveryResult
│   ├── lifecycle.ts     # tramli FlowDefinition<ConsumerState>
│   └── registry.ts      # ConsumerRegistry (tramli-backed)
├── adapters/
│   └── file-watcher.ts  # FileWatcher — JSONL tail adapter
├── security/
│   └── redaction.ts     # RedactionPipeline
└── index.ts             # Public API exports

schemas/
└── broker-event.schema.json  # JSON Schema Draft 2020-12
```

---

## Roadmap

### Phase 1 — File watcher + basic fan-out (current)

- [x] `FileWatcher` — `~/.claude/projects/` JSONL monitoring
- [x] `BrokerCore.distribute()` — fan-out with `Promise.allSettled` (delivery still a stub; no filter/redaction applied)
- [x] `SubscriptionManager` — full\_stream + filtered matching (filtered matches on project / agent / role only; field projection and per-consumer redaction not yet applied)
- [x] `ConsumerRegistry` — tramli-backed lifecycle
- [x] `RedactionPipeline` — PII / credential masking + dangerous-command flags (banned-word flagging not yet implemented)
- [x] `BrokerEvent` JSON Schema (Draft 2020-12)
- [ ] Parse stage — JSONL line → `AgentMessage` converter (type defined; converter not written)
- [ ] Pipeline wiring — orchestrator running watch → parse → redact → flag → match → distribute (components exist but are not connected; `index.ts` only re-exports)
- [ ] `deliverToConsumer` — real HTTP POST (stub currently)
- [ ] Persistent offset store

### Phase 2 — Subscription management + security

- [ ] trigger condition evaluation
- [ ] DLQ (Dead Letter Queue) + retry
- [ ] Consumer health check endpoint
- [ ] Persistent offset store

### Phase 3 — Enterprise features

- [ ] OIDC authentication
- [ ] Webhook delivery formatting (Slack template)
- [ ] auto-discover mode (all agents)
- [ ] Catch-up (replay past logs)
- [ ] Management API (`/api/status`, `/api/watch`, `/api/sessions`)

---

## License

UNLICENSED
