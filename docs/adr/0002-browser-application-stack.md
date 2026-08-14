# 0002 — Browser application stack

- Status: Accepted
- Date: 2026-08-14

## Context

Stage 0 starts from an empty directory, so there is no existing codebase to
adapt. We need a stack that supports a long-lived commercial application: strict
typing, first-class Web Worker and WebAssembly support, a credible testing
story, and the ability to enforce a hard boundary between UI code and geometry
code.

## Decision

**TypeScript (strict) + React + Vite + Three.js, in an npm-workspaces monorepo,
with ESLint, Prettier, Vitest, and Playwright.**

### Monorepo layout

```
apps/web/                 browser application (React, Three.js)
packages/shared/          typed errors, units, ids, cancellation
packages/mesh-core/       canonical mesh + structural validation
packages/file-formats/    format descriptors, screening, codec seams
packages/geometry-runtime/ worker protocol, coordinator, worker host
```

Workspaces were chosen because the boundary they create is the point. The
geometry packages have no React, no Three.js, and no DOM in their dependency
graph, and a Vitest project runs them under Node with no DOM at all — so a
browser dependency creeping into geometry code breaks the test run rather than
passing review. An ESLint `no-restricted-imports` rule makes the same constraint
explicit.

Internal packages are consumed directly as TypeScript source via workspace
symlinks and the `exports` field. They are never published, so there is no
per-package build step and no stale `dist` to debug.

### Strictness

`tsconfig.base.json` enables `strict` plus `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`,
`noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`,
`verbatimModuleSyntax`, and `erasableSyntaxOnly`.

`noUncheckedIndexedAccess` is the notable one: it makes typed-array indexing
return `number | undefined`, which is friction, but index-handling bugs are
exactly the class of defect that corrupts a mesh. Where the friction is real,
the fix has been to iterate rather than index — which is also faster.

### Worker typechecking

DOM and WebWorker lib definitions declare conflicting globals, so they cannot
share one TypeScript project. Worker code lives under
`apps/web/src/workers/` with its own `tsconfig.json`, which is also what
typescript-eslint's project service resolves for those files.

## Alternatives considered

**Next.js.** Rejected: its value is server rendering and routing, neither of
which a local-first single-view workspace tool needs. It would add a server
concept to a product whose central claim is that there is no server.

**Plain Vite + vanilla TS, no framework.** Genuinely viable for a shell this
small. Rejected because the eventual UI — parameter panels, operation history,
undo, progress across concurrent operations — is real application state, and
hand-rolling that is a false economy.

**Svelte or Solid.** Smaller and faster. Rejected on ecosystem and hiring depth
for a commercial product; React's `useSyncExternalStore` also gives us exactly
the framework-free state boundary we want.

**A single package instead of a monorepo.** Rejected: directory conventions do
not stop an import. Package boundaries do.

**babylon.js instead of Three.js.** Strong engine with good built-in tooling.
Three.js chosen for ecosystem size and because our rendering needs are modest —
the viewport displays meshes, it does not own them.

**A state management library (Zustand, Redux, Jotai).** Rejected for now. The
store is around 90 lines over `useSyncExternalStore`. Revisit if the undo stack
and operation history make it genuinely complex.

## Consequences

**Positive**

- The UI/geometry boundary is enforced by tooling, not discipline.
- Geometry packages are testable without a browser.
- Vite handles module workers and WASM natively and lets us set cross-origin
  isolation headers in dev and preview.
- Strict typing catches whole categories of geometry indexing errors.

**Negative**

- Monorepo indirection: contributors must understand workspaces and the split
  tsconfigs.
- Three.js dominates bundle size (~724 kB raw, ~195 kB gzipped). Acceptable for
  a professional tool; revisit if it affects first load.
- Three.js is pre-1.0 and its minor releases carry breaking changes.
- The strict flags occasionally require restructuring rather than a quick cast.
  That is the intended trade.
- Our TypeScript version is constrained by typescript-eslint — see
  [ADR 0006](0006-typescript-version-line.md).
