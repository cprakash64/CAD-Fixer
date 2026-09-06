/**
 * TYPE SHAPE FOR THE FROZEN STAGE 3C CORPUS. TEST-ONLY.
 *
 * `experiments/self-intersection/fixtures.mjs` is plain JavaScript on purpose:
 * it is evidence, written to be read in one sitting and run under `node` with
 * no build step, and giving it a build step would make the evidence depend on a
 * toolchain. `noImplicitAny` would otherwise make every field of that corpus an
 * `any`, which is exactly the silent unchecked access this repository bans.
 *
 * DELIBERATELY PARTIAL. Only the fields the kernel differential reads are
 * declared. Mirroring the whole research surface would create a second
 * definition to keep in step with a tree that is finished and will not change.
 *
 * The same arrangement `packages/file-formats/src/research-oracles.d.ts` uses
 * for the Stage 4A format oracles.
 */

declare module '*/experiments/self-intersection/fixtures.mjs' {
  export interface SelfIntersectionFixture {
    readonly id: string;
    readonly name: string;
    readonly positions: readonly number[];
    readonly triangles: readonly number[];
  }

  export const FIXTURES: readonly SelfIntersectionFixture[];
}
