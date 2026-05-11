[日本語版はこちら / Japanese](architecture-ja.md)

# Architecture

## Design principles

### 1. The broker is a pipe (BRK-PIPE)

The broker has exactly seven responsibilities. It does not understand log content — it routes it.

| Responsibility | Owner |
|---|---|
| Discover log files | `FileWatcher.discoverSessions()` |
| Watch for changes | `FileWatcher.watchSession()` |
| Parse JSONL lines | adapter layer |
| Redact PII | `RedactionPipeline` |
| Flag dangerous content | `RedactionPipeline` |
| Distribute events | `BrokerCore.distribute()` |
| Track read offsets | `FileWatcher` (in-memory, see [Limitations](#limitations)) |

What the broker does **not** do:
- Persist logs (consumer's job)
- Control agents (AskOS's job)
- Render UI (session-replay's job)
- Make decisions (consumer's job)

### 2. Agent-agnostic (BRK-AGENT-AGNOSTIC)

The broker requires zero changes to agents. It reads log files from the outside.
Adding support for a new agent means writing one adapter — nothing else changes.

### 3. Fault isolation

- A broker crash does not affect running agents — logs accumulate in files.
- One consumer failure does not block delivery to other consumers (`Promise.allSettled`).
- On restart, the broker can re-read sessions from offset 0 (persistent offset store is Phase 2).

---

## Module structure

```
src/
├── broker/
│   ├── core.ts          # BrokerCore — fan-out engine
│   └── subscription.ts  # SubscriptionManager + all type definitions
├── consumers/
│   ├── types.ts         # Consumer, ConsumerState, DeliveryResult
│   ├── lifecycle.ts     # tramli FlowDefinition<ConsumerState>
│   └── registry.ts      # ConsumerRegistry (tramli-backed)
├── adapters/
│   └── file-watcher.ts  # FileWatcher (Claude JSONL adapter)
└── security/
    └── redaction.ts     # RedactionPipeline

schemas/
└── broker-event.schema.json  # JSON Schema Draft 2020-12
```

---

## Data flow

```mermaid
flowchart TD
    JSONL["JSONL file on disk"]
    FW["FileWatcher"]
    Parse["parse raw JSON → AgentMessage"]
    Redact["RedactionPipeline.process()<br/>PII masking + security flags"]
    Event["BrokerEvent constructed<br/>{ _broker, _session, _index,<br/>type, message, securityFlags }"]
    Match["SubscriptionManager.matches(event, subscription)<br/>evaluated per registered consumer"]
    Distribute["BrokerCore.distribute(event, matchingConsumers)<br/>Promise.allSettled — one failure does not block others"]
    Deliver["deliverToConsumer(event, consumer)<br/>HTTP POST stub (Phase 1)"]
    OK["2xx → ConsumerRegistry.recordDelivery(id, true)"]
    Retry["5xx → retry (maxRetries=3) → DLQ (Phase 2)"]
    Perm["4xx → permanent error → skip"]

    JSONL -- "fs.watch triggers readNewLines()" --> FW
    FW -- "new line at byte offset N" --> Parse
    Parse --> Redact
    Redact --> Event
    Event --> Match
    Match --> Distribute
    Distribute --> Deliver
    Deliver --> OK
    Deliver --> Retry
    Deliver --> Perm
```

---

## BrokerCore

`src/broker/core.ts`

The fan-out engine. Stateless — it holds configuration only.

```typescript
class BrokerCore {
  distribute(event: BrokerEvent, consumers: readonly Consumer[]): Promise<Map<string, DeliveryResult>>
}
```

`distribute()` calls `deliverToConsumer()` for each consumer concurrently via `Promise.allSettled`.

> **Current limitation**: `deliverToConsumer` is a stub that returns `{ success: true }` without making any HTTP request. Real delivery will be implemented in Phase 1.

### BrokerCoreOptions

| Option | Default | Description |
|---|---|---|
| `maxRetries` | 3 | Max delivery attempts before DLQ |
| `retryBackoffMs` | 1000 | Exponential backoff base (ms) |
| `deliveryTimeoutMs` | 5000 | Per-request timeout (ms) |

---

## FileWatcher

`src/adapters/file-watcher.ts`

Watches `~/.claude/projects/**` for JSONL log files. Agent-agnostic — reads files without any agent cooperation.

```typescript
class FileWatcher {
  discoverSessions(): Promise<DiscoveredSession[]>
  watchSession(sessionPath: string, onLine: (line: string, offset: number) => void): void
  unwatchSession(sessionPath: string): void
  close(): void
}
```

### Directory layout expected

```
~/.claude/projects/
  <hash>/                  ← URL-encoded project path hash
    sessions/
      <sessionId>/
        log.jsonl          ← watched file
```

### Offset tracking

Offsets (byte positions) are stored in `Map<string, number>` keyed by session path. **This is in-memory only.** On process restart, offsets reset to 0 and all sessions are re-read from the beginning.

> **Known limitation**: Persistent offset store (file or DB) is Phase 2 work.

### Symlink resolution

`discoverSessions()` currently returns the raw directory hash as `projectPath`. The hash is a URL-encoded form of the actual project path (e.g. `/home/opa/work/my-project` → `-home-opa-work-my-project`).

> **Known limitation**: Symlink resolution to the human-readable project path is not yet implemented.

---

## Consumer

Consumer interface and lifecycle state.

```typescript
interface Consumer {
  id: string;
  callbackUrl: string;
  status: ConsumerState;      // managed by tramli state machine
  messagesDelivered: number;
  lastDelivery: string | null;
  errors: number;
}

type ConsumerState =
  | "INITIALIZING"  // just registered
  | "HEALTHY"       // receiving deliveries
  | "ASSESSING"     // branch evaluation (transient)
  | "UNHEALTHY"     // error rate above threshold
  | "DEAD"          // max retries exceeded
  | "REMOVED";      // cleanup complete (terminal)
```

### tramli state machine

The `ConsumerState` lifecycle is a tramli `FlowDefinition`. Each consumer gets its own `FlowInstance` in `InMemoryFlowStore`.

Full state machine documentation: [docs/consumer-lifecycle.md](consumer-lifecycle.md)

---

## BrokerEvent schema

`schemas/broker-event.schema.json` — JSON Schema Draft 2020-12

Every event delivered to consumers is wrapped in this envelope.

### Top-level fields

| Field | Required | Type | Description |
|---|---|---|---|
| `_broker` | yes | object | Broker envelope metadata |
| `_session` | yes | object | Session identification |
| `_index` | no | object | Position in the log file |
| `type` | yes | string | Event type |
| `message` | no | object | Agent message (present when `type === "message"`) |
| `securityFlags` | no | array | Security flag objects |
| `bannedWordHits` | no | array | Banned word hit objects |

### `_broker` fields

| Field | Type | Description |
|---|---|---|
| `version` | `"1.0"` | Schema version (const) |
| `messageId` | string | UUID per delivery |
| `deliveredAt` | date-time | ISO 8601 delivery timestamp |
| `deliveryAttempt` | integer ≥ 1 | Attempt number (1 = first try) |

### `_session` fields

| Field | Type | Description |
|---|---|---|
| `sessionId` | string | Unique session identifier |
| `sessionPath` | string | Absolute path to log.jsonl |
| `projectPath` | string | Project path (hash until symlink resolution is implemented) |
| `agentType` | string | `"claude"` (extensible) |

### `_index` fields

| Field | Type | Description |
|---|---|---|
| `messageIndex` | integer ≥ 0 | Zero-based line number in the file |
| `byteOffset` | integer ≥ 0 | Byte offset at start of this line |

### `type` values

| Value | When emitted |
|---|---|
| `message` | A new JSONL line was parsed |
| `session.discovered` | A new session file was found |
| `session.idle` | File not updated for N minutes |
| `session.lost` | File was deleted or moved |

### `message` fields

| Field | Type | Description |
|---|---|---|
| `role` | `"user"` \| `"assistant"` \| `"system"` | Message author |
| `text` | string | Text content (may be redacted) |
| `toolUses` | array | Tool call objects |
| `toolResults` | array | Tool result objects |
| `thinking` | string[] | Extended thinking blocks |
| `timestamp` | date-time | Original message timestamp |

---

## Subscription modes

### full\_stream

No filtering. Every event from every session is delivered. Used by session-replay.

### filtered

Events are delivered only when they match all present filter criteria:

- `projectPath` — exact match on `_session.projectPath`
- `agentTypes` — `_session.agentType` must be in the list
- `includeRoles` — `message.role` must be in the list
- `includeFields` / `excludeFields` — payload field projection (Phase 2)
- `redactionLevel` — override redaction level for this consumer

### trigger

> **Current limitation**: Trigger condition evaluation is not yet implemented (`matchesTrigger()` always returns `false`). Phase 2 work.

Intended behavior: deliver only when `conditions` evaluate to true, with optional `throttleSeconds` and `cooldownPerSession`.

---

## Redaction levels

| Level | Patterns applied |
|---|---|
| `minimal` | PII only: email, phone (US + JP), SSN |
| `standard` | PII + credentials: AWS key, generic secret/token/password |
| `strict` | PII + credentials + file paths (Phase 2) |

Security flags are generated at all levels (dangerous command detection does not redact — it flags).

---

## Limitations

| Limitation | Impact | Planned fix |
|---|---|---|
| `deliverToConsumer` stub | No events reach consumers | Phase 1 |
| In-memory offsets | Sessions re-read from start on restart | Phase 2 |
| Symlink resolution missing | `projectPath` is a hash string | Phase 2 |
| trigger evaluation stub | trigger consumers never fire | Phase 2 |
