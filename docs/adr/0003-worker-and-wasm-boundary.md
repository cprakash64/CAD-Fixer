# 0003 — Worker and WebAssembly boundary

- Status: Accepted
- Date: 2026-08-14

## Context

Mesh repair on a multi-million-triangle model takes seconds to minutes. If any
of that runs on the UI thread the tab freezes: no progress, no cancel, no
scrolling, and eventually a browser "page unresponsive" prompt. For a tool whose
whole job is chewing through large malformed files, that is disqualifying.

We must therefore decide the worker boundary before writing geometry code, not
after. Retrofitting an off-thread architecture onto synchronous code is a
rewrite.

## Decision

**Heavy geometry work runs in Web Workers. The main thread never performs it.**

### Protocol

A typed message protocol in `packages/geometry-runtime`:

- Every message carries a `channel` tag and an `OperationId`.
- Request/response are correlated by that id, so several operations can be in
  flight on one worker.
- Message kinds: `request`, `cancel` (to worker); `progress`, `result`, `error`
  (from worker).
- Operations are declared in a compile-time `OperationMap`, so payload and
  result types are checked at every dispatch site.
- Errors cross as `SerializedAppError` and are rebuilt into typed `AppError`
  instances by the receiver, preserving the failure category.
- The worker host emits **exactly one** terminal message per operation, even
  when a handler throws.

### Cancellation

Cancellation is a protocol message plus a cooperative token. The client sends
`cancel`; the worker marks a `CancellationSource`; the running handler observes
it by polling `throwIfCancelled()` between chunks.

We do not use `AbortSignal`, because an `AbortSignal` cannot be transferred to a
worker — a protocol-level cancel message is required regardless. Our token is
the local half, and keeping it in-house lets the geometry packages compile
without the DOM lib.

A handler that never polls cannot be cancelled. That is a documented property,
not an oversight: pre-emptive termination means terminating the worker, which is
the escalation path for a truly stuck operation.

### Transport abstraction

The coordinator is written against a `MessageEndpoint` interface, not `Worker`.
This keeps `geometry-runtime` DOM-free and unit-testable with a pair of
in-memory endpoints, and leaves room for a worker pool, `MessagePort`, or
`SharedWorker` without protocol changes. The only `Worker` construction site in
the codebase is `apps/web/src/runtime/geometry-client.ts`.

### Transfers

Large buffers move by `Transferable`, not structured-clone copy. Ownership rules
are documented in [ARCHITECTURE.md](../ARCHITECTURE.md) §7: transferred buffers
are detached in the sender, senders must drop their references, transfer lists
are de-duplicated, and `SharedArrayBuffer` is rejected from transfer lists
explicitly.

### Transport failure

A worker that fails to load, or a message that cannot be cloned, produces no
protocol reply at all. `failAllPending()` exists so the transport adapter can
reject every in-flight operation instead of leaving the interface on a spinner
forever.

### WebAssembly boundary

No WASM module is adopted in Stage 0 and no geometry kernel is installed. The
boundary is nonetheless fixed now:

- WASM loads **inside the worker**, never on the main thread.
- It sits below `mesh-core` and speaks canonical mesh buffers. The UI, state
  layer, and coordinator must not know which kernel is in use.
- Its output is validated by `mesh-core` before acceptance, regardless of what
  the kernel claims about itself.
- Memory budgets are explicit; exceeding one raises `RESOURCE_LIMIT_EXCEEDED`
  rather than crashing the tab.
- If it uses pthreads it needs `SharedArrayBuffer`, hence cross-origin
  isolation — configured now in dev and preview, and required of production
  hosting.
- Its licence must permit proprietary commercial use.

## Alternatives considered

**Everything on the main thread, with `requestIdleCallback` chunking.**
Rejected: it does not give real parallelism, it makes every algorithm a state
machine, and rendering still stutters.

**One worker per operation, spawned on demand.** Simple isolation, but worker
startup plus module loading is expensive and would be paid repeatedly. The
current design keeps one worker with correlated operations; a pool can be added
behind `MessageEndpoint` without protocol change.

**Comlink or a similar RPC wrapper.** Ergonomic, but it hides the message
boundary — which is exactly the thing we need to stay conscious of for transfer
ownership, progress, and cancellation. It also would not have given us typed
cancellation or a single-terminal-message guarantee. The protocol is small
enough to own.

**`SharedArrayBuffer` for all mesh data instead of transfers.** Avoids
detachment entirely and would allow genuine shared-memory parallelism. Rejected
for now: it requires cross-origin isolation unconditionally, and shared mutable
mesh state across threads is a data-race surface we do not need before a
multithreaded kernel exists. We have prepared isolation so this stays open.

**Deferring the worker architecture until an algorithm needs it.** Rejected —
this is precisely the decision that cannot be retrofitted cheaply.

## Consequences

**Positive**

- The interface stays responsive by construction.
- Progress and cancellation are available to every future operation for free.
- Geometry code is testable without a browser.
- Transfers avoid copying large buffers.

**Negative**

- All geometry APIs are asynchronous, including ones that could have been
  synchronous.
- Transferred buffers are detached, which is a real footgun; it is documented
  and enforced where possible, but a caller can still hold a stale reference.
- Cooperative cancellation means a badly written handler is uninterruptible.
- Debugging across the worker boundary is harder than a single-threaded stack.
- Cross-origin isolation constrains hosting and every future third-party
  resource.
