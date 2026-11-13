---
name: architecture-refactor
description: Decompose god files and thin application entrypoints by defining explicit state, dependency, and module boundaries. Use when reducing a large main file, extracting controllers, introducing application context, or restructuring a frontend without changing behavior.
---

# Architecture refactor

Restructure around ownership boundaries, not arbitrary line ranges. Preserve observable behavior while achieving the requested target architecture.

## Before editing

1. Read the relevant entrypoint, tests, architecture documentation, and recent refactor plan.
2. Inventory:
   - mutable state and every function that reads or writes it
   - DOM ownership and event listeners
   - IPC, network, storage, and other side effects
   - imports, callers, and likely dependency cycles
3. Define the target role of the entrypoint and the owner of each extracted concern.
4. Establish the smallest baseline proof that covers the affected behavior.

Do not start by cutting contiguous line ranges. Do not call a cluster a module merely because its functions are adjacent.

## Target architecture

For a frontend entrypoint, prefer this dependency direction:

```text
entrypoint/composition root
  → application context and feature controllers
    → state owners and side-effect adapters
      → pure domain/editor helpers
```

The composition root may detect runtime mode, create dependencies, mount controllers, and connect top-level lifecycle events. It should not own feature rendering, persistence workflows, or long DOM event handlers.

Use an explicit state/context object or controller factory when module-level mutable variables prevent extraction. New types, factories, and narrow interfaces are in scope when they create a real ownership boundary. Do not replace them with a bag of callbacks or imports of mutable state from the entrypoint.

Each controller should have:

- one clear state owner
- explicit inputs and outputs
- ownership of its DOM subtree or event bindings
- a small interface used by neighboring controllers
- no import from the entrypoint

## Refactoring workflow

1. Write the ownership map and target dependency graph.
2. Introduce the smallest seam needed to isolate one concern without changing behavior.
3. Move the concern together with the state, event handlers, and side effects it owns.
4. Update callers and remove the old implementation in the same step.
5. Run focused tests and the build after each boundary.
6. Check the architecture invariants before starting the next boundary.
7. Stop when the target architecture is met; do not add unrelated cleanup or features.

If a proposed cut is not closed, identify the missing owner or dependency inversion. Do not stop with “not a closed set” while leaving the architectural requirement unmet. If a seam would require a behavior change, report that boundary and defer it rather than silently changing behavior.

## Preservation rules

- Keep UX, HTML structure, persistence format, IPC command names, and platform behavior unchanged unless explicitly requested.
- Preserve error handling, ordering, async cancellation/generation checks, and event timing.
- Do not add a UI framework to a vanilla DOM application.
- Do not create circular imports, broad global stores, or generic utility modules with unclear ownership.
- Keep public exports narrow; prefer private implementation details inside the owning module.
- Treat line count as a signal, not the sole success criterion.

## Completion criteria

The refactor is complete only when both behavior and architecture are proven:

- focused tests, build, and relevant UI tests pass
- the entrypoint contains composition/orchestration rather than feature implementation
- extracted modules do not import the entrypoint
- mutable feature state has an explicit owner
- no new dependency cycle or callback bag was introduced
- the requested file-size or import-boundary target is met
- no unrelated feature work was mixed into the refactor

Report the boundaries moved, the remaining architectural debt, the commands run, and any unverified risk.
