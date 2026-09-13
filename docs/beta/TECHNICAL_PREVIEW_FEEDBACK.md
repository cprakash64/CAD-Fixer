# Sending feedback on the CAD Fixer Technical Preview

**<https://fixcad.thelunai.com>**

Thank you for testing. This guide is for everyone — you do not need to be a
programmer to file useful feedback.

## Why we have to ask

CAD Fixer has **no analytics and no telemetry**. Your model is processed
entirely in your browser and never reaches a server, which is the whole point of
the product — and it also means **we genuinely cannot see what happened to
you.** If you do not tell us, we will not know.

## Never send us a model you are not free to share

Most CAD files are confidential. **Do not upload, attach or paste a model unless
you personally have the right to share it** and have chosen to.

Almost every useful report can be written without the model at all. If sharing
one would help and you are permitted to, a simplified or scrubbed version is
usually enough.

GitHub issues are **public**. Treat anything you attach there as published.

## The single most useful thing you can send

**The exact message CAD Fixer showed you.**

CAD Fixer refuses work deliberately and explains why — for example that an
opening is not flat enough to fill, or that a file exceeds a limit. That wording
identifies the precise decision the software made. Copy it exactly, rather than
paraphrasing it.

A screenshot of the panel is just as good.

## What to include

**Your setup** — browser and version, operating system, and roughly how much
memory the machine has if you know.

**The file** — STL, OBJ or 3MF; roughly how big; and the triangle count if CAD
Fixer displayed one. Not the file itself.

**What you were doing** — one of: import · mesh health · repair preview ·
repair Apply · repair Undo · opening inventory · planar fill preview · fill
Apply · fill Undo · self-intersection check · STL export · OBJ export ·
3MF export.

**What you expected**, and **what actually happened**.

**How to reproduce it** — the shortest sequence of clicks that shows the
problem. "Import, then click Check" is perfect.

**If you exported a file** — did it reopen? In which program? Did the geometry
look right? An export that silently produces a broken file matters far more to
us than one that refuses honestly.

## Where to send it

**On GitHub** — open an issue using the **Beta feedback** template, which asks
these questions directly:
<https://github.com/cprakash64/CAD-Fixer/issues/new/choose>

**Anywhere else** — email, chat, or however you normally reach us. Copy this and
fill in what you can:

```text
Browser:
OS:
Memory (if known):
File type (STL / OBJ / 3MF):
File size:
Triangle count (if shown):
Operation:
Expected:
Actual:
Exact message CAD Fixer showed:
Steps to reproduce:
If exported — did it reopen, and where?:
Screenshot attached?:
```

Partial reports are welcome. A one-line "the fill button refused and said the
opening is not planar" is genuinely useful.

## Things that are already known

You do not need to report these; they are documented limitations of this
preview:

- **Firefox, Safari and mobile are not supported yet.** Use a Chromium-based
  desktop browser (Chrome, Edge).
- **Repair is four specific conservative operations**, not general mesh repair.
- **Opening fill handles flat openings only**, one at a time. There is no
  "fill everything" button on purpose.
- **Self-intersections are reported, not repaired.**
- **CAD Fixer never says a model is "printable" or "watertight"**, because it
  does not check wall thickness or printability.
- **Undo is one step**, and there is no redo.
- Splitting, hollowing, texturing, booleans and remeshing are not implemented.

**A refusal is usually CAD Fixer working correctly**, not a bug — it declines
rather than guessing at your geometry. Refusals are still worth reporting: if
the software keeps refusing something you genuinely need, that is exactly the
evidence that should shape what gets built next.

## What happens to your report

Reports are categorised, checked for reproducibility, and rated for severity.
Recurring patterns drive what gets built next — see
[the triage process](BETA_TRIAGE.md). We do not keep a public list of testers or
their files.
