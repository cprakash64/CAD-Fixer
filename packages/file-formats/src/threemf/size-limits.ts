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
 * THE PER-MODEL-ENTRY EXPANSION CEILING — 256 MiB.
 *
 * ADR 0013's number, unchanged here. What changed in Stage 6E-A4 is that it now
 * lives in ONE place: `DEFAULT_ZIP_LIMITS.maxEntryBytes` reads it, the 3MF
 * WRITER bounds its model XML by it, the end-to-end fixtures derive from it,
 * and every refusal message comes from it. Before that the reader and the
 * writer each had their own idea of how big a model entry could be, and they
 * disagreed — see `MAX_THREEMF_PACKAGE_BYTES` and the writer's own note.
 *
 * IT MAY NEVER EXCEED `MAX_THREEMF_PACKAGE_BYTES`, and a boundary test asserts
 * that: an entry ceiling above the package ceiling would describe a file that
 * passes the per-entry check and can never pass the package one, which is a
 * limit that cannot be reached and therefore is not a limit.
 */
export const MAX_THREEMF_MODEL_ENTRY_BYTES = 256 * 1024 * 1024;

/**
 * THE WHOLE-PACKAGE EXPANSION CEILING — 512 MiB, unchanged since Stage 4A.
 *
 * Every reachable model part, the relationships and every other entry this
 * import inflates are charged to ONE budget against this number.
 */
export const MAX_THREEMF_PACKAGE_BYTES = 512 * 1024 * 1024;
