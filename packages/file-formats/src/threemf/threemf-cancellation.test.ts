import { describe, expect, it } from 'vitest';
import { AppErrorCode, isAppError, type CancellationToken } from '@cadfixer/shared';
import { testReadContext } from '../test-context';
import { buildZip, CONTENT_TYPES, modelXml, RELS } from './zip-fixtures';
import { read3mf, ThreeMfImportPhase, type ThreeMfExpansionStats } from './threemf-reader';

/**
 * STAGE 6D-B2 — EVERY LONG LOOP IN THE 3MF READER CONSULTS THE REAL TOKEN.
 *
 * Making `model/import` interruptible gives the reader a flag that can change
 * mid-scan. That is necessary and not sufficient: a poll site has to EXIST in
 * each long loop, and two of them did not. `materialiseMeshes` and
 * `expandBuild` ran to completion whatever the token said.
 *
 * WHAT MAKES THESE TESTS DISCRIMINATING RATHER THAN DECORATIVE. `read3mf` calls
 * `throwIfCancelled` after expansion anyway, so "the import was cancelled" is
 * true whether or not the inner loops poll — a test asserting only that would
 * pass with both polls deleted. These assert on `ThreeMfExpansionStats`, which
 * records how far the work actually got: the poll in `materialiseMeshes` sits
 * BEFORE the counter it guards, so a cancel that lands there leaves the counter
 * at zero and a cancel that does not leaves it at one.
 *
 * The token is flipped by PHASE rather than by a timer: the reader reports its
 * own phase, the context flips the flag when the chosen phase arrives, and the
 * result is deterministic on any machine.
 */

/** A token whose flag flips the moment `arm()` is called. Nothing is timed. */
function armableToken(): { token: CancellationToken; arm: () => void; polls: () => number } {
  let cancelled = false;
  let polls = 0;
  return {
    token: {
      get isCancelled(): boolean {
        polls += 1;
        return cancelled;
      },
      onCancelled(): () => void {
        return (): void => undefined;
      },
    },
    arm: (): void => {
      cancelled = true;
    },
    polls: (): number => polls,
  };
}

/**
 * A read context that flips the token when the reader reports `phase`.
 *
 * `afterPolls` delays the flip by that many further polls, which is how a test
 * lands inside the SECOND loop of a phase rather than the first.
 */
function cancellingAtPhase(
  phase: string,
  afterPolls = 0,
): { context: ReturnType<typeof testReadContext>; polls: () => number } {
  const { token, arm, polls } = armableToken();
  let reached = false;
  let remaining = afterPolls;

  const armed: CancellationToken = {
    get isCancelled(): boolean {
      if (reached) {
        if (remaining > 0) {
          remaining -= 1;
        } else {
          arm();
        }
      }
      return token.isCancelled;
    },
    onCancelled(): () => void {
      return (): void => undefined;
    },
  };

  const base = testReadContext();
  return {
    context: {
      ...base,
      cancellation: armed,
      progress: {
        report: (_fraction: number, note?: string): void => {
          if (note === phase) reached = true;
        },
      },
    },
    polls,
  };
}

async function expectCancelled(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!isAppError(error)) throw error;
    expect(error.code).toBe(AppErrorCode.OperationCancelled);
    return;
  }
  throw new Error('expected a cancellation');
}

function stats(): ThreeMfExpansionStats {
  return { leafPlacementsVisited: 0, partsEmitted: 0, meshResourcesMaterialised: 0 };
}

/** One object placed by several build items, so expansion has steps to take. */
async function multiPlacement(placements: number): Promise<Uint8Array> {
  const build = Array.from(
    { length: placements },
    (_unused, index) =>
      `<item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${String(index * 10)} 0 0"/>`,
  ).join('');
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES, method: 8 },
    { name: '_rels/.rels', content: RELS, method: 8 },
    { name: '3D/3dmodel.model', content: modelXml({ build }), method: 8 },
  ]);
}

describe('B2: cancellation is observed in each phase of a 3MF import', () => {
  it('B2-P1: a cancel at the parsing phase stops before the document is built', async () => {
    const archive = await multiPlacement(4);
    const { context, polls } = cancellingAtPhase(ThreeMfImportPhase.Parsing);
    const recorded = stats();

    await expectCancelled(() => read3mf(archive, context, { stats: recorded }));

    // NOTHING WAS MATERIALISED OR EXPANDED. The phase is reported before the
    // decode, so a cancel there must stop the whole rest of the read.
    expect(recorded.meshResourcesMaterialised).toBe(0);
    expect(recorded.partsEmitted).toBe(0);
    expect(polls()).toBeGreaterThan(0);
  });

  it('B2-P2: a cancel at the building phase stops inside materialisation', async () => {
    const archive = await multiPlacement(4);
    const { context } = cancellingAtPhase(ThreeMfImportPhase.BuildingDocument);
    const recorded = stats();

    await expectCancelled(() => read3mf(archive, context, { stats: recorded }));

    /*
     * THE DISCRIMINATING ASSERTION. `materialiseMeshes` polls BEFORE it counts
     * the mesh it is about to build, so a zero here means the poll fired on the
     * first object. Without that poll the loop would run to completion and this
     * would be one, with `read3mf`'s own post-expansion check reporting the
     * cancellation afterwards — the same user-visible outcome reached by doing
     * all of the work first.
     */
    expect(recorded.meshResourcesMaterialised).toBe(0);
    expect(recorded.partsEmitted).toBe(0);
  });

  it('B2-P3: a cancel during expansion stops before every placement is emitted', async () => {
    const archive = await multiPlacement(8);
    /*
     * PAST MATERIALISATION, INTO EXPANSION. One object means materialisation
     * polls a handful of times; letting those through puts the flip inside
     * `expandBuild`'s walk, which is the second loop that had no poll at all.
     */
    const { context } = cancellingAtPhase(ThreeMfImportPhase.BuildingDocument, 6);
    const recorded = stats();

    await expectCancelled(() => read3mf(archive, context, { stats: recorded }));

    expect(recorded.meshResourcesMaterialised).toBe(1);
    // Stopped PART WAY. Eight placements were requested and the walk was
    // abandoned before it emitted them all.
    expect(recorded.partsEmitted).toBeLessThan(8);
  });

  it('B2-P4: an uncancelled read of the same fixture completes, so the tests above mean something', async () => {
    const archive = await multiPlacement(8);
    const recorded = stats();

    const result = await read3mf(archive, testReadContext(), { stats: recorded });

    expect(result.document.parts).toHaveLength(8);
    expect(recorded.meshResourcesMaterialised).toBe(1);
    expect(recorded.partsEmitted).toBe(8);
  });

  it('B2-P5: a cancelled read produces OPERATION_CANCELLED, never a malformed-file error', async () => {
    const archive = await multiPlacement(4);
    const { context } = cancellingAtPhase(ThreeMfImportPhase.Decompressing);

    try {
      await read3mf(archive, context);
      throw new Error('expected a cancellation');
    } catch (error) {
      if (!isAppError(error)) throw error;
      /*
       * A CANCEL IS NOT DAMAGE. Reporting it as `MALFORMED_FILE` would tell a
       * user their model is broken because they pressed Cancel, which is the
       * class of untruth the refusal vocabulary exists to prevent.
       */
      expect(error.code).toBe(AppErrorCode.OperationCancelled);
      expect(error.code).not.toBe(AppErrorCode.MalformedFile);
    }
  });
});

describe('B2: the phase vocabulary is what the reader actually emits', () => {
  it('B2-P6: every phase constant is reported by a successful read, in order', async () => {
    const archive = await multiPlacement(2);
    const seen: string[] = [];
    const base = testReadContext();

    await read3mf(archive, {
      ...base,
      progress: {
        report: (_fraction: number, note?: string): void => {
          if (note !== undefined) seen.push(note);
        },
      },
    });

    /*
     * PINNED AS A SEQUENCE, because MF-P24's proof depends on `Parsing` coming
     * after `Decompressing` — that ordering IS the statement "inflation has
     * finished". A reordering here would silently turn that end-to-end test
     * into a proof about nothing.
     */
    expect(seen).toEqual([
      ThreeMfImportPhase.ReadingPackage,
      ThreeMfImportPhase.Decompressing,
      ThreeMfImportPhase.Parsing,
      ThreeMfImportPhase.BuildingDocument,
      ThreeMfImportPhase.Complete,
    ]);
  });
});
