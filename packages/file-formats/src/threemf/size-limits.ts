/**
 * HOW BIG A 3MF PACKAGE AND ITS MODEL ENTRIES MAY BE — the one source of truth.
 *
 * A LEAF MODULE THAT IMPORTS NOTHING, for the same reason `ingestion-route.ts`
 * is one: these numbers are read by the READER, which allocates against them,
 * and by the WRITER, which must never produce a file the reader would refuse.
 * Before Stage 6E-A4 the two disagreed, and the disagreement was reachable —
 * see `MAX_THREEMF_MODEL_ENTRY_BYTES` below.
 *
 * THESE ARE RESOURCE CEILINGS, NOT A ROUTING POLICY. Which path an eligible
 * entry takes is `routeModelEntryIngestion`'s question and is decided
 * separately; these decide what is eligible at all.
 */

/**
 * THE PER-MODEL-ENTRY EXPANSION CEILING — 320 MiB (335,544,320 bytes).
 *
 * Raised from 256 MiB by Stage 6E-A4, on full-product measurements recorded in
 * `docs/release/RESOURCE_POLICY.md`. Nothing may restate this number:
 * `DEFAULT_ZIP_LIMITS.maxEntryBytes` reads it, the 3MF writer bounds its model
 * XML by it, the end-to-end fixtures derive from it, and every refusal message
 * comes from it.
 *
 * WHY IT COULD MOVE AT ALL. Until Stage 6E the reader held a model part twice
 * over at its peak — once inflated, once decoded, and at two bytes a character
 * if any character exceeded U+00FF — so the ceiling was a statement about the
 * BUFFERED path. Stage 6D-B3 rejected 384 MiB on exactly that basis, measuring
 * 2,679–3,071 MiB for a 376 MiB entry. Since 6E-A3 every entry at or above
 * `THREEMF_STREAMING_THRESHOLD_BYTES` is streamed and never held whole, and
 * that same file now costs about half as much.
 *
 * WHY 320 AND NOT 384. Because the entry is no longer what bounds the peak —
 * the GEOMETRY it describes is — and the two are not proportional. A 480 MiB
 * TEXT-HEAVY entry around four triangles peaks at 452–461 MiB. A MAXIMALLY
 * DENSE one is a different question: 3MF shares vertices, so an indexed grid
 * carries a triangle every ~70 bytes, twice what unshared soup manages, and the
 * 3MF Consortium's own large positive cases are exactly that shape. Measured on
 * the 8 GiB host, renderer / whole-browser peak, three fresh browsers each:
 *
 *   entry        triangles     renderer max    whole browser max
 *   240.28 MiB   3,623,432     1,157           1,541
 *   286.66 MiB   4,304,178     1,135           1,567
 *   302.05 MiB   4,530,050     1,194           1,641
 *   321.20 MiB   4,811,202     1,591           2,056
 *   336.60 MiB   5,037,138     1,595           2,077
 *   363.94 MiB   5,438,402     1,998           2,506
 *
 * THERE IS A CLIFF BETWEEN 336.60 MiB AND 363.94 MiB, and 384 MiB is past it.
 * A ceiling of 320 MiB is measured directly — 321.20 MiB is the first size a
 * file at this ceiling could reach — at 1,591 MiB of renderer footprint, inside
 * the band this project has accepted before and about 400 MiB below it, and
 * 44 MiB of declared size below the first size measured unsafe.
 *
 * THE MARGIN OVER BETA-002 IS 23 MiB, AND THAT IS THIN ON PURPOSE. The tester
 * class is a model entry expanding to about 297 MiB; 320 MiB clears it and the
 * next credible step up does not. Widening that margin would mean accepting the
 * 2.0–2.5 GiB region, which is a worse trade than a narrow margin on a class
 * that is now supported at all.
 *
 * IT MAY NEVER EXCEED `MAX_THREEMF_PACKAGE_BYTES`, and a boundary test asserts
 * that: an entry ceiling above the package ceiling would describe a file that
 * passes the per-entry check and can never pass the package one, which is a
 * limit that cannot be reached and therefore is not a limit.
 */
export const MAX_THREEMF_MODEL_ENTRY_BYTES = 320 * 1024 * 1024;

/**
 * THE WHOLE-PACKAGE EXPANSION CEILING — 512 MiB, unchanged since Stage 4A.
 *
 * Every reachable model part, the relationships and every other entry this
 * import inflates are charged to ONE budget against this number. Stage 6E-A4
 * deliberately did not move it: raising the per-entry ceiling widens what a
 * single part may be, and leaving the package total where it is keeps the total
 * claim on the machine exactly where it was qualified.
 */
export const MAX_THREEMF_PACKAGE_BYTES = 512 * 1024 * 1024;
