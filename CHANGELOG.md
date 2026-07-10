# Changelog

All notable changes to agent-log-broker are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Planned
- Real HTTP POST delivery in `deliverToConsumer` (Phase 1)
- Persistent offset store (Phase 2)
- trigger condition evaluation (Phase 2)
- DLQ + retry per consumer (Phase 2)

## [0.1.0] - 2026-04-19

### Added
- `FileWatcher` — tail `~/.claude/projects/**/*.jsonl` via `node:fs.watch`; in-memory read-offset tracking per session path (see Known stubs re: byte/char inconsistency)
- `BrokerCore.distribute()` — fan-out with `Promise.allSettled`; per-consumer `DeliveryResult`. Note: does not yet apply `SubscriptionManager.matches()` or redaction (no orchestrator wires the pipeline)
- `SubscriptionManager` — `full_stream`, `filtered`, `trigger` modes; `matches()` method defined. `filtered` evaluates `projectPath` / `agentTypes` / `includeRoles` only (no field projection or per-consumer redaction); `trigger` is a stub
- `ConsumerRegistry` — tramli `FlowDefinition<ConsumerState>`-backed health tracking; `InMemoryFlowStore`
- Consumer lifecycle state machine: `INITIALIZING → HEALTHY → ASSESSING → HEALTHY | UNHEALTHY | DEAD → REMOVED`
- `RedactionPipeline` — PII patterns (email, phone, SSN, JP phone), credential patterns (AWS key, generic secret), dangerous command detection (banned-word detection not implemented)
- `BrokerEvent` JSON Schema Draft 2020-12 (`schemas/broker-event.schema.json`)
- `DiscoveredSession` interface — `sessionId`, `sessionPath`, `projectPath`, `agentType`
- `AgentMessage` interface — `role`, `text`, `toolUses`, `toolResults`, `thinking`, `timestamp` (type only; no JSONL-line → `AgentMessage` converter exists yet)

### Known stubs (Phase 1 / 2 work)
- Pipeline not wired: `BrokerCore.distribute()` calls neither `matches()` nor `RedactionPipeline`; no orchestrator / `main` connects watch → parse → redact → flag → match → distribute (`index.ts` only re-exports)
- Parse stage missing: no code converts a JSONL line into `AgentMessage` despite the interface being defined
- Banned words not implemented: `banned_word` flag type and `bannedWordHits` field exist, but there is no word list or detection code
- `filtered` field projection / per-consumer redaction (`includeFields`, `excludeFields`, `redactionLevel`, `minIntervalMs`) not applied
- `deliverToConsumer`: HTTP POST not implemented; returns `{ success: true }` unconditionally
- `matchesTrigger()`: always returns `false`
- `discoverSessions()`: `projectPath` returns raw directory hash (symlink resolution not implemented)
- FileWatcher offsets are in-memory only — lost on process restart
- Offset unit inconsistency: `readNewLines()` slices by UTF-16 code unit but advances the offset by `Buffer.byteLength() + 1` (bytes); consistent only for ASCII, drifts on multi-byte content (suspected code bug, not yet fixed)
