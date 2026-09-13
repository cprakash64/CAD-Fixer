# Technical Preview triage

How a beta report becomes a product decision.

**This is a human process.** CAD Fixer has no telemetry, so nothing here is
assigned automatically. Every category below is applied by reading a report.

## Record for each report

| Field            | Notes                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Category**     | One of the taxonomy below                                                                                                                            |
| **Reproducible** | yes / no / not attempted — reports we cannot reproduce are still data, and repeated irreproducible reports of the same shape are themselves a signal |
| **Severity**     | S0–S3 below                                                                                                                                          |
| **Frequency**    | how many distinct testers have hit it                                                                                                                |
| **Workaround**   | what the user can do meanwhile, if anything                                                                                                          |
| **Roadmap area** | which capability this argues for                                                                                                                     |

## Categories

Drawn from CAD Fixer's own vocabulary, so a report maps onto something the
product actually does.

| Category                       | Meaning                                                              |
| ------------------------------ | -------------------------------------------------------------------- |
| `IMPORT_FAILURE`               | A file was refused or misread at import                              |
| `RESOURCE_LIMIT`               | A documented ceiling was reached — size, triangles, memory           |
| `UNSUPPORTED_REPAIR`           | The defect is real but outside the four conservative operations      |
| `TOPOLOGY_AMBIGUITY`           | Mesh health reported something the user disputes or cannot interpret |
| `NON_PLANAR_OPENING`           | Fill refused because the opening is not flat                         |
| `SELF_INTERSECTION_DIAGNOSTIC` | Anything about the read-only crossing check                          |
| `EXPORT_FAILURE`               | Export refused, or produced a file that will not reopen              |
| `BROWSER_ENVIRONMENT`          | Unsupported browser, isolation unavailable, WebGL loss               |
| `UI_CONFUSION`                 | The product did the right thing and the user could not tell          |
| `PERFORMANCE`                  | Too slow, unresponsive, or memory pressure                           |
| `UNKNOWN`                      | Not yet classifiable — do not force a guess                          |

## Severity

|        |                                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------------- |
| **S0** | Data loss, a privacy breach, or a security issue. Geometry leaving the browser would be S0 by definition. |
| **S1** | The application is unusable or crashes for supported input in a supported environment.                    |
| **S2** | A major operation is unavailable or produces an incorrect result.                                         |
| **S3** | Limited, cosmetic, or confusing behaviour.                                                                |

**Frustration is not severity.** A refusal that annoys someone is S3 if the
refusal was correct, however strongly it was expressed. An export that silently
produces a broken file is S2 even if reported calmly — the user may not have
noticed yet.

Two distinctions worth holding onto:

- **A refusal is usually correct behaviour.** CAD Fixer declines rather than
  guessing. That is a deliberate design position, not a defect. But a refusal
  users keep hitting on work they legitimately need is the strongest possible
  evidence for what to build next — it is a **roadmap signal recorded at S3**,
  not a bug.
- **A wrong result outranks a refused one.** Silently producing bad geometry is
  far worse than honestly declining, and should be rated accordingly.

## Turning patterns into roadmap decisions

One report is an anecdote. A recurring pattern across independent testers is
evidence. Prioritise by what people actually hit, not by what is interesting to
build.

| Recurring pattern                                          | What it argues for                                        |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| Many `NON_PLANAR_OPENING` refusals                         | Broader, non-planar opening filling                       |
| Many `SELF_INTERSECTION_DIAGNOSTIC` reports on real models | Actual self-intersection repair research                  |
| Repeated unit confusion                                    | Unit interpretation and conversion                        |
| Thin-wall problems found after printing                    | Wall-thickness and printability analysis                  |
| Large files hitting ceilings routinely                     | Performance and resource work                             |
| Frequent non-manifold refusals                             | A broader repair policy                                   |
| `UI_CONFUSION` on correct behaviour                        | Wording, not geometry — often the cheapest high-value fix |

**Nothing in that table is committed.** It is the mapping from evidence to
candidate work, so that a later roadmap decision can point at reports rather
than at intuition.

## Privacy

- **No public list of testers**, their names, or their files.
- **Do not copy a private message into a public issue** without the sender's
  agreement.
- **Do not record model filenames or proprietary details** from private
  channels in this repository.
- GitHub issues are public by nature, and the feedback form says so before a
  tester writes anything.

## Responding

Say which category and severity a report landed in, and what happens next —
including "this is working as designed, and here is why". A tester who
understands a refusal will send better reports afterwards. A tester who feels
ignored sends none.
