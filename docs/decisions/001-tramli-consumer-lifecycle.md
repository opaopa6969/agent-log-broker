# DD-001: Use tramli for consumer lifecycle state management

**Status**: Accepted
**Date**: 2026-04-19

---

## Context

Consumer health management in a fan-out broker is inherently stateful. A consumer transitions through states (`INITIALIZING → HEALTHY → UNHEALTHY → DEAD → REMOVED`) based on delivery outcomes. Without an explicit state machine, this logic tends to become:

- Ad-hoc conditionals scattered across `ConsumerRegistry`
- Implicit state transitions that are hard to test in isolation
- No compile-time guarantee that all state combinations are handled

Three options were considered:

1. **Ad-hoc flags** — `isHealthy: boolean`, `isDead: boolean` fields on the consumer object
2. **Hand-written state machine** — explicit transition table in `ConsumerRegistry`
3. **tramli** — the constraint-enforcing flow engine used elsewhere in the AskOS workspace

---

## Decision

Use tramli (`@unlaxer/tramli`) to implement the `ConsumerState` lifecycle as a `FlowDefinition<ConsumerState>`.

---

## Rationale

### 1. Build-time correctness

tramli's `build()` step validates:
- Every state has a defined processor or guard
- All `flowKey` dependencies are declared before they are read (`requires/produces` contract)
- No invalid transitions can exist

An ad-hoc approach cannot provide these guarantees. A hand-written state machine could, but requires maintaining the validation manually.

### 2. Data flow is declared, not implied

The `assessBranch` decision depends on `deliverySuccess` and `errorCount`. With tramli, this dependency is declared in `requires`:

```typescript
const assessBranch: BranchProcessor<ConsumerState> = {
  requires: [DELIVERY_SUCCESS, ERROR_COUNT],
  decide(ctx) { ... }
};
```

If `errorCount` is not produced before `ASSESSING` is entered, `build()` fails. This is caught at startup, not at runtime.

### 3. External input is explicit

The `deliverySuccess` value comes from outside the flow (from `recordDelivery()` calls). tramli's `externallyProvided()` directive makes this explicit and verifiable:

```typescript
Tramli.define<ConsumerState>("consumer-lifecycle", STATE_CONFIG)
  .externallyProvided(DELIVERY_SUCCESS)
  ...
```

Without this declaration, a processor that reads `deliverySuccess` without producing it would cause a build-time error.

### 4. Consistency with the workspace

tramli is already a dependency in the AskOS workspace. Using it for consumer lifecycle keeps the mental model consistent: **the broker uses the same constraint-enforcing flow engine as its consumers**.

### 5. LLM-friendly structure

tramli's `FlowDefinition` is a single, readable declaration. An LLM maintaining or extending the lifecycle reads `lifecycle.ts` (165 lines) — not a sprawl of conditionals across multiple files.

---

## Consequences

### Positive

- Consumer state transitions are auditable and testable in isolation
- `buildConsumerLifecycle()` fails fast at startup if the definition is invalid
- New states or transitions can be added without changing `ConsumerRegistry`

### Negative / Trade-offs

- `@unlaxer/tramli` is a dependency; the broker cannot run without it
- `InMemoryFlowStore` means lifecycle state is lost on process restart (same caveat as offsets)
- tramli's `FlowEngine` and `FlowStore` add indirection compared to direct state mutation

### Mitigations

- tramli is already a workspace dependency — no new dependency surface
- Persistent `FlowStore` (DB-backed) is Phase 2 work, enabling restart recovery
