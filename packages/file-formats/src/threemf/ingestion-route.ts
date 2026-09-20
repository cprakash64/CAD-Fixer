/**
 * WHICH INGESTION PATH ONE 3MF MODEL ENTRY TAKES — Stage 6E-A3.
 *
 * Stage 6E-A2 qualified a streamed reader and shipped it switched off, because
 * the two paths are not ordered: streaming is dramatically cheaper for a large
 * model part and slightly more expensive for a small one. A3's job was to find
 * where they cross and to route each entry automatically.
 *
 * A LEAF MODULE THAT IMPORTS NOTHING. The threshold, the mode names and the
 * decision live together in one file so there is exactly one answer to "which
 * path does this entry take", and so a test can put the decision itself under
 * oath without constructing an archive.
 *
 * THE DECISION IS PER MODEL ENTRY, NOT PER PACKAGE. A package legitimately
 * holds one large root beside several tiny referenced parts, and a package-wide
 * choice would either make the small parts pay two passes or make the large one
 * hold a quarter of a gibibyte. `readThreeMfPackage` asks this question once
 * per model part it opens, so root and child may take different paths.
 *
 * THE INPUT IS THE DECLARED UNCOMPRESSED SIZE — the one figure known BEFORE a
 * byte is decompressed, so the route is fixed before any allocation depends on
 * it. It is also ATTACKER-CONTROLLED, and this module does not pretend
 * otherwise: it is a routing hint and nothing else. Every safety property — the
 * 256 MiB per-entry ceiling, the 512 MiB package ceiling, the 200:1 ratio, the
 * package inflation budget, the overrun check against the declaration and the
 * shortfall check at the end of the stream — is enforced by `zip.ts` on BOTH
 * paths and is unaffected by which one a declaration steers towards. A file
 * that lies is refused by the route it lied its way into.
 *
 * NOTHING ELSE MAY ENTER THIS DECISION. Not available memory, not heap
 * estimates, not elapsed time, not host load, not the file name, not the
 * producer, not the compression ratio, not whether the part holds characters
 * above U+00FF. The route must be a deterministic function of the archive's own
 * metadata, or the same file would import two different ways on two machines
 * and a refusal would stop being reproducible.
 */

/**
 * How a model part's bytes become XML events.
 *
 * `Buffered` — v0.2.0's path: the entry is inflated into one buffer, decoded
 * into one string and scanned. Simple, one pass, and it holds the part twice
 * over at its peak (and at two bytes a character if any character exceeds
 * U+00FF).
 *
 * `Streaming` — Stage 6E-A2's path: the entry is read twice through
 * `openTwoPassEntry`, a security pass then an element pass, and is never held
 * whole in bytes or in text. Cheaper in memory above the threshold, and it pays
 * a second decompression.
 *
 * `Auto` — Stage 6E-A3, and what the product registers: each model entry takes
 * whichever of the two its declared size selects.
 */
export const ThreeMfIngestion = {
  Buffered: 'buffered',
  Streaming: 'streaming',
  Auto: 'auto',
} as const;
export type ThreeMfIngestion = (typeof ThreeMfIngestion)[keyof typeof ThreeMfIngestion];

/** The two paths an entry can actually take. `Auto` resolves to one of these. */
export type ThreeMfIngestionRoute =
  typeof ThreeMfIngestion.Buffered | typeof ThreeMfIngestion.Streaming;

/**
 * THE ROUTING THRESHOLD: a model entry declaring this many uncompressed bytes
 * or more is streamed; below it, buffered. 128 MiB.
 *
 * DERIVED FROM MEASUREMENT, AND THE MEASUREMENTS ARE IN
 * `docs/design/STAGE_6E_STREAMING_3MF_IMPORT.md`. Renderer
 * `phys_footprint_peak` through the WHOLE product — page, worker, render upload
 * and the automatic topology analysis — on the 8 GiB Apple M1 support host,
 * modes interleaved per case, three fresh browsers per point, medians quoted:
 *
 *   entry     dense buf/str     text buf/str      CJK-named buf/str
 *   63 MiB      519 / 427         503 / 263         —
 *   96 MiB      670 / 563         695 / 265         —
 *   126 MiB     568 / 669         915 / 273         908 / 631
 *   138 MiB     599 / 669         —                 —
 *   142 MiB   1,024 / 732         —                 —
 *   157 MiB     907 / 802       1,050 / 285       1,089 / 795
 *   218 MiB   1,421 / 845       1,409 / 332       1,673 / 846
 *   242 MiB   1,320 / 870       1,543 / 341       1,812 / 949
 *
 * THE STREAMED PATH IS FLAT AND THE BUFFERED PATH IS NOT. Streamed peaks stay
 * between 263 and 949 MiB across the whole supported range; buffered peaks
 * climb with the entry and reach 1,543 MiB for text-heavy XML and 1,812 MiB for
 * an otherwise identical part carrying one character above U+00FF — both past
 * the 1,536 MiB working budget this host is qualified against.
 *
 * WHERE THE PATHS ACTUALLY CROSS. For DENSE geometry, between 138 MiB and
 * 142 MiB, and the step is sharp: buffered moves from 599 MiB to 1,024 MiB
 * across those four megabytes while streamed stays at ~670. For TEXT-HEAVY XML
 * there is no crossover in the supported range — streaming wins from 63 MiB
 * upwards, by 240 MiB there and by 1,202 MiB at 242 MiB. For a part carrying
 * ANY character above U+00FF there is none either, because the buffered path
 * must hold it at two bytes a character and the streamed path never holds it.
 * The only region where buffering measurably wins is dense geometry between
 * 126 MiB and 138 MiB, by 70–101 MiB.
 *
 * WHY 128 MiB AND NOT THE CROSSOVER. The errors are not symmetric. Streaming a
 * little too early costs at most ~101 MiB and is bounded, because the streamed
 * peak barely moves with size; buffering a little too late costs 292 MiB at
 * 142 MiB and grows without limit thereafter. So the margin is taken on the
 * streaming side: 128 MiB sits about ten megabytes BELOW the sharp buffered
 * step, so no supported input depends on buffered behaviour near it. Under this
 * threshold the worst buffered peak any eligible file can reach is ~915 MiB —
 * text-heavy XML just under the line — against 1,812 MiB without routing.
 *
 * WHY NOT LOWER, WHEN STREAMING ALSO WINS AT 63 AND 96 MiB. Two reasons, and
 * neither is peak memory. Buffered is v0.2.0's path, qualified in Stage 6D-A4
 * against 2,130 real and reference files and shipped; real producer output is a
 * few megabytes, so a threshold here leaves essentially every file users
 * actually open on the proven path. And a second pass is real work: it is
 * within run-to-run noise on this host, but it is never free, and there is
 * nothing to buy with it below the line — a buffered import under 128 MiB has
 * never been near the envelope.
 *
 * NOT A UNICODE RULE, AND DELIBERATELY SO. A part with a CJK name costs the
 * buffered path twice what an identical ASCII part costs, which is exactly the
 * kind of thing a special case would be written for. The size threshold already
 * covers it: the shapes that suffer most are the shapes that grow, and at
 * 126 MiB the CJK case still buffers at 908 MiB — inside the envelope. Routing
 * on content rather than on the declaration would also mean the path could not
 * be chosen until after decompression, which is the one thing it must precede.
 *
 * NOT A RESOURCE CEILING AND NOT A GATE. Crossing it refuses nothing and admits
 * nothing. `ZipLimits.maxEntryBytes` decides what may be imported; this decides
 * only how.
 */
export const THREEMF_STREAMING_THRESHOLD_BYTES = 128 * 1024 * 1024;

/**
 * The path one model entry takes.
 *
 * `Buffered` and `Streaming` are honoured exactly — qualification and the
 * differential suites force a path and must get it whatever the size — so the
 * threshold is consulted for `Auto` alone.
 */
export function routeModelEntryIngestion(
  declaredUncompressedBytes: number,
  mode: ThreeMfIngestion,
): ThreeMfIngestionRoute {
  if (mode !== ThreeMfIngestion.Auto) return mode;
  return declaredUncompressedBytes >= THREEMF_STREAMING_THRESHOLD_BYTES
    ? ThreeMfIngestion.Streaming
    : ThreeMfIngestion.Buffered;
}
