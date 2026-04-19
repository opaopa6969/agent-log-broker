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
- `FileWatcher` — tail `~/.claude/projects/**/*.jsonl` via `node:fs.watch`; in-memory byte-offset tracking per session path
- `BrokerCore.distribute()` — fan-out with `Promise.allSettled`; per-consumer `DeliveryResult`
- `SubscriptionManager` — `full_stream`, `filtered`, `trigger` modes; `matches()` evaluates per-event
- `ConsumerRegistry` — tramli `FlowDefinition<ConsumerState>`-backed health tracking; `InMemoryFlowStore`
- Consumer lifecycle state machine: `INITIALIZING → HEALTHY → ASSESSING → HEALTHY | UNHEALTHY | DEAD → REMOVED`
- `RedactionPipeline` — PII patterns (email, phone, SSN, JP phone), credential patterns (AWS key, generic secret), dangerous command detection
- `BrokerEvent` JSON Schema Draft 2020-12 (`schemas/broker-event.schema.json`)
- `DiscoveredSession` interface — `sessionId`, `sessionPath`, `projectPath`, `agentType`
- `AgentMessage` interface — `role`, `text`, `toolUses`, `toolResults`, `thinking`, `timestamp`

### Known stubs (Phase 1 / 2 work)
- `deliverToConsumer`: HTTP POST not implemented; returns `{ success: true }` unconditionally
- `matchesTrigger()`: always returns `false`
- `discoverSessions()`: `projectPath` returns raw directory hash (symlink resolution not implemented)
- FileWatcher offsets are in-memory only — lost on process restart
