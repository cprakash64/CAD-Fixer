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

---

## Stage 3A-3A update

**The 28-minute uninterruptible call is no longer reproducible, and the reason
matters.** It was Geogram's colocate path aborting on an assertion caused by our
own missing `CmdLine::import_arg_group("algo")` — not an algorithmic hang. With
initialisation corrected, every colocate run completes in ~5-15 ms against a
20 s budget. See RESULTS.md, "Geogram colocate — ROOT CAUSE FOUND".

That removes the most acute observed instance of the hazard. **It does not
remove the hazard.** A synchronous WASM call still cannot be interrupted from
inside its own process, and nothing here changes that.

**Isolation was tightened.** Stage 3A-2 ran a whole fixture per process, so one
non-returning call took every later case down with it and those cases were
recorded as TIMEOUT without being attempted — a fixture's result depended on
which fixture ran before it. Stage 3A-3A runs **one operation per process**
(`run-geogram-single.mjs`, `run-manifold-single.mjs`, `run-idempotence.mjs`), so
a hang costs exactly one row.

**Still not measured, and required before any architecture decision:**

- `Worker.terminate()` in a real browser: time to termination, page
  responsiveness during and after, and whether a fresh worker re-initialises.
- Whether the authoritative source mesh survives a cancellation byte-identical.
- Persistent-worker versus disposable-per-operation cost.

All of that is Stage 3A-3B. **`CANCELLATION_GATE` remains unresolved**;
process-kill at Node granularity is not evidence about browser workers.
