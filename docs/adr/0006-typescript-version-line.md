# 0006 — TypeScript version line

- Status: Accepted
- Date: 2026-08-14
- Review trigger: typescript-eslint ships TypeScript 7 support

## Context

At the time of Stage 0, `typescript@latest` is **7.0.2** — the Go-native port,
roughly 10× faster to compile and materially lighter on memory. Taking the
latest version would normally be automatic for a greenfield project.

It is not automatic here. TypeScript 7.0 does not yet expose a stable
programmatic compiler API. Tools built on that API therefore cannot use it, and
`typescript-eslint` is one of them:

- `typescript-eslint@8.67.0` declares `typescript: ">=4.8.4 <6.1.0"`.
- Its canary channel (`8.67.1-alpha.4`) declares the same range.
- TypeScript 7 support is [open issue #12518](https://github.com/typescript-eslint/typescript-eslint/issues/12518).
- Microsoft publishes `@typescript/typescript6` as a compatibility shim so tools
  can keep using the 6.0 API while a project compiles with 7.0, and a new
  programmatic API is expected in TypeScript 7.1.

So the real choice is between compile speed and **type-aware linting**.

Type-aware linting is not a nicety for this codebase. Rules like
`no-floating-promises`, `no-misused-promises`, `no-unnecessary-condition`, and
`no-unsafe-*` operate on type information, and this project is heavily
asynchronous across a worker boundary where an unawaited promise means an
operation that silently never completes. Those rules already caught real defects
during Stage 0.

Compile speed, meanwhile, is worth little today: the entire codebase typechecks
in a couple of seconds.

## Decision

**Pin TypeScript to the 6.0 line (`~6.0.3`).**

It is the most recent line with a stable programmatic API, `typescript-eslint`
supports it natively with no shim, and it carries the modern defaults
(`strict`, `module: esnext`, `types: []`) that this project wants anyway.

The pin is a tilde range, so patch updates flow but a minor bump into 6.1+ —
which would break the typescript-eslint peer range — cannot happen accidentally.

**Revisit when `typescript-eslint` ships TypeScript 7 support.** At that point,
moving to TS 7 is expected to be straightforward and worth doing.

## Alternatives considered

**TypeScript 7.0.2 with no type-aware linting.** Fastest compiles, latest
version. Rejected: giving up `no-floating-promises` on a worker-based
architecture trades a real correctness control for speed we do not need at this
codebase size.

**TypeScript 7.0.2 for build plus `@typescript/typescript6` for the linter.**
Both fast compiles and type-aware linting, at least in principle. Rejected for
Stage 0: it puts two compiler versions in the tree, and `typescript-eslint`
declares its peer dependency on `typescript`, not on the shim — so wiring it up
means an alias or override that the toolchain does not officially support yet.
That is an unnecessary failure mode in the foundation of a commercial product.
Worth reconsidering once the path is documented by the tools themselves.

**A third-party TS 7 type-aware linter (`tsgolint`, `jetlint`).** Both build on
the native compiler and port typescript-eslint's typed rules. Rejected: too new
to put in the required-CI path of a production codebase. Worth watching.

**Staying on TypeScript 5.9.** Rejected — no benefit over 6.0, which is
supported by the same tooling and has better defaults.

## Consequences

**Positive**

- Full type-aware linting works with no shims or overrides.
- One compiler in the dependency tree.
- Modern TS 6 defaults align with the project's strictness goals.
- The upgrade trigger is explicit rather than a vague "upgrade someday".

**Negative**

- We are a major version behind, and forgo the native port's large compile-speed
  and memory improvements.
- A future migration to TS 7 is still owed, including whatever deprecations it
  enforces as hard errors.
- Any dependency that begins requiring TS 7 syntax would force the decision
  early.
