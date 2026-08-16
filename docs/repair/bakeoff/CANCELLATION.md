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

---

## Stage 3A-3B — the browser cancellation gate is now MEASURED, and PASSED

`CANCELLATION_GATE: PASS` for all three candidates, in real Chromium, against
real candidate WASM work.

The architecture tested is the one the product would use: the **page holds the
authoritative geometry**, a dedicated Worker receives a structured-clone copy,
and cancellation is `Worker.terminate()` from the page. No attempt is made to
interrupt synchronous WASM from inside the blocked thread, because that is not
possible and pretending otherwise would design in a hang.

|                                        | manifold            | geogram                 | pmp                   |
| -------------------------------------- | ------------------- | ----------------------- | --------------------- |
| Real workload                          | 210,680-tri boolean | 57,120-tri intersection | 487,900-tri hole fill |
| Kernel duration if left alone          | 713 ms              | 570 ms                  | **48,829 ms**         |
| Confirmed still computing at terminate | yes                 | yes                     | yes                   |
| `terminate()` call returns in          | 0.33 ms             | 0.01 ms                 | 0.33 ms               |
| Late messages, 1.2 s quiet window      | 0                   | 0                       | 0                     |
| Authoritative geometry digest          | unchanged           | unchanged               | unchanged             |
| Fresh worker re-initialises            | 87.0 ms             | 32.5 ms                 | 16.4 ms               |
| Recovery operation succeeds            | yes                 | yes                     | yes                   |

**Wording discipline.** Termination is NOT described as instant. What was
measured is that the `terminate()` call returns in well under a millisecond and
that nothing further arrived during a quiet window. The platform exposes no
termination event, so the observation is a **bound**, not a kernel-stop time.

**The main thread stayed responsive** throughout — a DOM write plus a frame
completed in 0.48–13.8 ms while kernels ran. That is the whole justification for
paying the copying cost of an off-thread kernel.

### Stale results

Every message carries `(sessionId, opId)`; the page drops anything not matching
a live session. A terminated worker's replacement returned its own result
(4 triangles), never the dead worker's boolean.

Precisely: **0 stale messages were observed.** `terminate()` stopped the worker
posting at all, so the guard was not exercised by a real late message here. It
is retained and asserted regardless — the guard is cheap and the failure it
prevents is one that produces plausible, wrong evidence.

### Disposable workers are affordable

| Candidate | Persistent per-op | Disposable per-op | Penalty  |
| --------- | ----------------- | ----------------- | -------- |
| manifold  | 3.19 ms           | 10.42 ms          | +7.2 ms  |
| geogram   | 5.20 ms           | 21.61 ms          | +16.4 ms |
| pmp       | 1.74 ms           | 8.21 ms           | +6.5 ms  |

6–17 ms per operation against repairs that take hundreds of milliseconds to
tens of seconds. **The assumption that disposable workers are too expensive is
not supported.**

### What this changes about the hazard

The uninterruptible synchronous call is still real — PMP's 48.8-second hole fill
is proof. What has changed is that a safe, measured, recoverable cancellation
now exists for it in the browser. The hazard is no longer a blocker; it is a
constraint the architecture must respect.
