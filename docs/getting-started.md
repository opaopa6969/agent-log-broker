[日本語版はこちら / Japanese](getting-started-ja.md)

# Getting Started

## Prerequisites

- Node.js 20+
- npm 10+
- A Claude Code installation (or any agent that writes JSONL logs to `~/.claude/projects/`)

---

## Installation

```bash
# Clone the repository
git clone https://github.com/opaopa6969/agent-log-broker.git
cd agent-log-broker

# Install dependencies
npm install

# Build TypeScript
npm run build
```

---

## Quick start

### 1. Start the broker

```bash
npm run dev
```

The broker starts watching `~/.claude/projects/` for JSONL log files.

### 2. Register a consumer

Send a `POST /api/subscribe` request with a subscription definition.

**full\_stream** — receive every event:

```bash
curl -X POST http://localhost:3100/api/subscribe \
  -H "Content-Type: application/json" \
  -d '{
    "consumerId": "my-consumer",
    "callbackUrl": "http://localhost:9000/events",
    "mode": "full_stream"
  }'
```

**filtered** — receive only assistant messages from a specific project:

```bash
curl -X POST http://localhost:3100/api/subscribe \
  -H "Content-Type: application/json" \
  -d '{
    "consumerId": "askos",
    "callbackUrl": "http://localhost:3000/broker/events",
    "mode": "filtered",
    "filter": {
      "projectPath": "/home/opa/work/my-project",
      "includeRoles": ["assistant"],
      "includeFields": ["toolUses", "text", "securityFlags"],
      "redactionLevel": "standard"
    }
  }'
```

**trigger** — fire when security flags appear:

```bash
curl -X POST http://localhost:3100/api/subscribe \
  -H "Content-Type: application/json" \
  -d '{
    "consumerId": "slack-security",
    "callbackUrl": "https://hooks.slack.com/services/...",
    "mode": "trigger",
    "trigger": {
      "conditions": [
        { "field": "securityFlags", "op": "not_empty" }
      ],
      "throttleSeconds": 300
    }
  }'
```

> **Note**: The HTTP API server is not yet implemented. The type definitions and subscription data model are ready, but the Express/Fastify server layer is Phase 1 work. Use `ConsumerRegistry` directly from code in the meantime.

### 3. Receive events

Your consumer must accept `POST` requests at the registered `callbackUrl`.

Request body will be a `BrokerEvent` object:

```json
{
  "_broker": {
    "version": "1.0",
    "messageId": "b1c2d3e4-...",
    "deliveredAt": "2026-04-19T10:00:00.000Z",
    "deliveryAttempt": 1
  },
  "_session": {
    "sessionId": "abc123",
    "sessionPath": "/home/opa/.claude/projects/-home-opa-work-my-project/sessions/abc123/log.jsonl",
    "projectPath": "-home-opa-work-my-project",
    "agentType": "claude"
  },
  "_index": {
    "messageIndex": 5,
    "byteOffset": 1024
  },
  "type": "message",
  "message": {
    "role": "assistant",
    "text": "I will create the file now.",
    "toolUses": [...],
    "timestamp": "2026-04-19T09:59:58.000Z"
  },
  "securityFlags": []
}
```

Return `2xx` for success, `5xx` for transient errors (will retry), `4xx` for permanent errors (will skip).

---

## Using ConsumerRegistry directly

```typescript
import { ConsumerRegistry } from "@unlaxer/agent-log-broker";

const registry = new ConsumerRegistry({
  errorThreshold: 3,   // errors before UNHEALTHY
  maxRetries: 10,      // errors before DEAD
});

// Register a consumer
const consumer = await registry.register(
  "my-consumer",
  "http://localhost:9000/events"
);
console.log(consumer.status); // "HEALTHY"

// Record delivery result
await registry.recordDelivery("my-consumer", true);   // success
await registry.recordDelivery("my-consumer", false);  // failure

// Check health
const state = registry.getState("my-consumer");
// "HEALTHY" | "UNHEALTHY" | "DEAD" | ...

// List all consumers
const all = registry.list();

// Remove a dead consumer
await registry.remove("my-consumer"); // only works from DEAD state
```

---

## Using FileWatcher directly

```typescript
import { FileWatcher } from "@unlaxer/agent-log-broker";

const watcher = new FileWatcher({
  basePath: "/home/opa/.claude/projects",  // default
  scanIntervalSeconds: 30,
});

// Discover existing sessions
const sessions = await watcher.discoverSessions();
for (const session of sessions) {
  console.log(session.sessionId, session.sessionPath);

  // Watch for new lines
  watcher.watchSession(session.sessionPath, (line, offset) => {
    const parsed = JSON.parse(line);
    console.log("new line at offset", offset, parsed);
  });
}

// Stop a specific session
watcher.unwatchSession(sessions[0].sessionPath);

// Stop all
watcher.close();
```

> **Note**: Offsets are in-memory only. On restart, all sessions will be re-read from the beginning.

---

## Development commands

```bash
npm run build       # TypeScript compile (tsc)
npm run dev         # Watch mode (tsx watch)
npm test            # Vitest
npm run typecheck   # Type-check without emitting
```

---

## Next steps

- [Architecture](architecture.md) — BrokerCore, FileWatcher, BrokerEvent schema
- [Consumer Lifecycle](consumer-lifecycle.md) — tramli state machine reference
- [Design Decisions](decisions/) — why tramli, why JSON Schema Draft 2020-12
