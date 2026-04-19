# DD-002: Use JSON Schema Draft 2020-12 for BrokerEvent

**Status**: Accepted
**Date**: 2026-04-19

---

## Context

The `BrokerEvent` is the contract between the broker and all consumers. Every consumer — session-replay, AskOS, Slack webhook, Dashboard — must agree on the shape of the data they receive.

Three options were considered:

1. **TypeScript interface only** — types live in `src/broker/subscription.ts`, no runtime schema
2. **JSON Schema Draft 07** — the most widely supported version (used by many validators and IDEs)
3. **JSON Schema Draft 2020-12** — the current stable specification

---

## Decision

Use JSON Schema Draft 2020-12, published at `schemas/broker-event.schema.json` with `$id: "https://askos.dev/schemas/broker-event.schema.json"`.

---

## Rationale

### 1. Language-agnostic contract

The broker is TypeScript, but consumers may be written in any language. A JSON Schema file provides a language-agnostic contract that can be used to:
- Generate types in consumer languages (TypeScript via `json-schema-to-typescript`, Python via `datamodel-code-generator`, etc.)
- Validate incoming events at consumer startup
- Document the protocol in a machine-readable form

TypeScript interfaces alone are not consumable outside the TypeScript ecosystem.

### 2. Draft 2020-12 over Draft 07

Draft 2020-12 provides:
- `$dynamicRef` / `$dynamicAnchor` for better composability (not used yet, but available)
- Cleaner `prefixItems` for tuple validation
- `unevaluatedProperties` / `unevaluatedItems` for strict schemas
- The current stable specification — new tooling targets this version

The `BrokerEvent` schema does not use features exclusive to 2020-12 today, but starting on the current spec avoids a future migration.

### 3. Consistency with the workspace

The AskOS workspace uses Draft 2020-12 as its schema standard. The broker schema follows this convention.

---

## Schema location

`schemas/broker-event.schema.json`

The schema is co-located with the source code, not in a separate schema registry. This is appropriate for Phase 1 — a schema registry (with versioning) is Phase 3 work.

---

## Consequences

### Positive

- Consumers can validate received events against the schema
- New language clients can generate types from the schema
- Schema versioning is explicit (`"version": "1.0"` const in `_broker`)

### Negative / Trade-offs

- Draft 2020-12 support in validators is not universal (ajv requires `ajv@8` + `ajv-formats`)
- The schema must be kept in sync with the TypeScript interfaces manually (no auto-generation yet)

### Mitigations

- The `_broker.version` const field allows schema evolution without breaking consumers
- Auto-generation from TypeScript interfaces (e.g. `ts-json-schema-generator`) is straightforward if sync drift becomes a problem
