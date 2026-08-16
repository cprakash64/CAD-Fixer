# Cancellation findings

Stage 3A-2. **The production worker architecture was not changed.** This
measures the cost of the fallback before any decision is taken.

## The finding, from an accident

Stage 3A-1 predicted that a long synchronous WASM call cannot observe a cancel
message. The first full bakeoff run demonstrated it at full force:

> Geogram's `mesh_repair(MESH_REPAIR_COLOCATE, ε)` on fixture R19 consumed
> **28 minutes of CPU** in a single call. Nothing in the hosting process could
> stop it. The only way to end it was to kill the process.

That is the hazard, measured rather than argued.

## Consequences observed in the harness

With one wall-clock budget per _candidate_, the R19 hang consumed the whole
budget and **twelve later fixtures were recorded as TIMEOUT** — one pathological
case erased real data about unrelated fixtures.

Re-running with one budget per _(candidate, fixture)_ contained the damage to
the three tolerance fixtures. Isolation granularity is not a detail; it decides
how much work a single hang destroys.

## What this validates

The disposable-worker model is the only cancellation that worked, and it worked
at process granularity:

| Property                 | Observed                                                          |
| ------------------------ | ----------------------------------------------------------------- |
| Cooperative callback     | **none available** in any of the three bindings                   |
| Chunked operation        | not offered by any candidate's API                                |
| Termination              | **effective** — SIGKILL ended a 28-minute call immediately        |
| Harness survival         | yes; the parent continued to the next fixture                     |
| Source mesh unchanged    | yes; input lives in the parent, the child only receives a copy    |
| Recreation               | yes; a fresh child ran the next fixture normally                  |
| Completed work preserved | yes, because results are appended per case before the next begins |

Measured overheads, per child process: Node startup plus WASM instantiation
totalled roughly 1–2 s per fixture-batch; candidate initialisation alone was
1.7–8.7 ms (Manifold), 6.7–15.0 ms (Geogram), 2.3–5.6 ms (PMP).

## What this does NOT establish

- These were **OS processes**, not Web Workers. Worker `terminate()` is expected
  to behave equivalently but was **not measured in a browser** in this stage.
- Input-copy cost was not isolated from process startup.
- No worker pooling was evaluated, so the per-operation cost of a fresh worker
  versus a warm pool is unknown.

## Implication for the production architecture

Any repair using a candidate kernel must run in a **disposable compute worker**
that owns nothing authoritative and can be terminated without consulting it.
That worker cannot be the resident-geometry worker, because terminating it would
destroy the user's model — precisely the outcome ADR 0008 exists to prevent.

This is now supported by measurement rather than by prediction. **It is still not
a decision**: the browser-side equivalent must be measured first.
