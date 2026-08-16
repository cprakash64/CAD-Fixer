import { createIndexArray, createPositionArray, IDENTITY_MATRIX4 } from '@cadfixer/mesh-core';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import {
  LicenceClass,
  RepairOperation,
  RepairStatus,
  SelfIntersectionCapability,
  ThreadingMode,
  type CandidateMetadata,
  type RepairKernelCandidate,
  type RepairOutcome,
  type RepairParameters,
} from './contract';

/**
 * MOCK CANDIDATES — for testing the HARNESS, and for nothing else.
 *
 * These are not models of any real kernel and produce no evidence about one.
 * They exist because the harness makes claims — "a crash is recorded and the
 * run continues", "NaN is a hard failure", "a candidate that fixes the target
 * while breaking something else is rejected" — and those claims need to be
 * demonstrated against inputs engineered to trigger them. A real kernel cannot
 * be made to emit NaN on demand.
 *
 * Every mock is deliberately obvious about what it does wrong.
 */

function metadata(id: string, overrides: Partial<CandidateMetadata> = {}): CandidateMetadata {
  return {
    candidateId: id,
    displayName: `Mock: ${id}`,
    upstreamVersion: 'mock-0',
    licence: 'not-applicable',
    licenceClass: LicenceClass.Permissive,
    buildMode: 'typescript mock',
    wasmByteLength: 0,
    threading: ThreadingMode.Serial,
    supportedOperations: [
      RepairOperation.RemoveDuplicateFaces,
      RepairOperation.RemoveDegenerateFaces,
      RepairOperation.UnifyWinding,
    ],
    unsupportedOperations: [],
    inputRequirements: [],
    notes: ['Harness test double. Says nothing about any real kernel.'],
    ...overrides,
  };
}

function outcome(
  mesh: CanonicalMesh | undefined,
  overrides: Partial<RepairOutcome> = {},
): RepairOutcome {
  return {
    status: RepairStatus.Completed,
    kernelReportedSuccess: true,
    warnings: [],
    mesh,
    elapsedMs: 1,
    peakWasmHeapBytes: undefined,
    reconstructed: false,
    ...overrides,
  };
}

function cloneMesh(mesh: CanonicalMesh): CanonicalMesh {
  const positions = createPositionArray(mesh.positions.length);
  positions.set(mesh.positions);
  const indices = createIndexArray(mesh.indices.length);
  indices.set(mesh.indices);
  return { positions, indices, metadata: { sourceFormat: 'stl', transform: IDENTITY_MATRIX4 } };
}

/** Removes triangles by index, rebuilding soup indices. */
function withoutTriangles(mesh: CanonicalMesh, drop: ReadonlySet<number>): CanonicalMesh {
  const faces = Math.floor(mesh.indices.length / 3);
  const kept: number[] = [];
  for (let f = 0; f < faces; f += 1) if (!drop.has(f)) kept.push(f);

  const positions = createPositionArray(kept.length * 9);
  let write = 0;
  for (const face of kept) {
    for (let corner = 0; corner < 3; corner += 1) {
      const source = (mesh.indices[face * 3 + corner] ?? 0) * 3;
      positions[write] = mesh.positions[source] ?? 0;
      positions[write + 1] = mesh.positions[source + 1] ?? 0;
      positions[write + 2] = mesh.positions[source + 2] ?? 0;
      write += 3;
    }
  }
  const indices = createIndexArray(kept.length * 3);
  for (let i = 0; i < indices.length; i += 1) indices[i] = i;

  return { positions, indices, metadata: { sourceFormat: 'stl', transform: IDENTITY_MATRIX4 } };
}

/** Returns the mesh untouched. The "does nothing" baseline. */
export function passthroughCandidate(): RepairKernelCandidate {
  return {
    metadata: metadata('mock-passthrough'),
    selfIntersection: SelfIntersectionCapability.None,
    initialize: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    repair: (mesh) => Promise.resolve(outcome(cloneMesh(mesh))),
  };
}

/**
 * Genuinely removes exact duplicate and degenerate faces.
 *
 * The only mock that does real work, so the harness has a case that should
 * actually pass. Deliberately simple and exact — no tolerance anywhere.
 */
export function competentCandidate(): RepairKernelCandidate {
  return {
    metadata: metadata('mock-competent'),
    selfIntersection: SelfIntersectionCapability.None,
    initialize: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    repair: (mesh, operation): Promise<RepairOutcome> => {
      if (
        operation !== RepairOperation.RemoveDuplicateFaces &&
        operation !== RepairOperation.RemoveDegenerateFaces
      ) {
        return Promise.resolve(outcome(undefined, { status: RepairStatus.Unsupported }));
      }

      const faces = Math.floor(mesh.indices.length / 3);
      const drop = new Set<number>();
      const seen = new Map<string, number>();

      for (let f = 0; f < faces; f += 1) {
        const corners: [number, number, number][] = [];
        for (let c = 0; c < 3; c += 1) {
          const base = (mesh.indices[f * 3 + c] ?? 0) * 3;
          corners.push([
            mesh.positions[base] ?? 0,
            mesh.positions[base + 1] ?? 0,
            mesh.positions[base + 2] ?? 0,
          ]);
        }
        const [p0, p1, p2] = corners;
        if (p0 === undefined || p1 === undefined || p2 === undefined) continue;

        if (operation === RepairOperation.RemoveDegenerateFaces) {
          const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]] as const;
          const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]] as const;
          const nx = e1[1] * e2[2] - e1[2] * e2[1];
          const ny = e1[2] * e2[0] - e1[0] * e2[2];
          const nz = e1[0] * e2[1] - e1[1] * e2[0];
          if (nx === 0 && ny === 0 && nz === 0) drop.add(f);
          continue;
        }

        // Same-winding duplicate: identical cyclic order of identical points.
        const rotations = [
          [p0, p1, p2],
          [p1, p2, p0],
          [p2, p0, p1],
        ].map((r) => r.map((p) => p.join(',')).join('|'));
        const key = rotations.slice().sort()[0] ?? '';
        const previous = seen.get(key);
        if (previous === undefined) seen.set(key, f);
        else drop.add(f);
      }

      return Promise.resolve(outcome(withoutTriangles(mesh, drop)));
    },
  };
}

/** Claims success, returns the input unchanged. Tests that we do not believe it. */
export function lyingCandidate(): RepairKernelCandidate {
  return {
    metadata: metadata('mock-lying'),
    selfIntersection: SelfIntersectionCapability.None,
    initialize: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    repair: (mesh) =>
      Promise.resolve(
        outcome(cloneMesh(mesh), { kernelReportedSuccess: true, warnings: ['all good'] }),
      ),
  };
}

/** Fixes the target defect but tears a hole doing it. */
export function collateralDamageCandidate(): RepairKernelCandidate {
  return {
    metadata: metadata('mock-collateral'),
    selfIntersection: SelfIntersectionCapability.None,
    initialize: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    repair: (mesh): Promise<RepairOutcome> => {
      // Drops the first two faces: removes any duplicate at index 0 and, on a
      // closed shell, opens it.
      return Promise.resolve(outcome(withoutTriangles(mesh, new Set([0, 1]))));
    },
  };
}

/** Throws. The run must record it and continue. */
export function throwingCandidate(): RepairKernelCandidate {
  return {
    metadata: metadata('mock-throwing'),
    selfIntersection: SelfIntersectionCapability.None,
    initialize: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    repair: () => Promise.reject(new Error('simulated WASM trap')),
  };
}

/** Emits NaN coordinates. Hard failure. */
export function nanCandidate(): RepairKernelCandidate {
  return {
    metadata: metadata('mock-nan'),
    selfIntersection: SelfIntersectionCapability.None,
    initialize: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    repair: (mesh): Promise<RepairOutcome> => {
      const broken = cloneMesh(mesh);
      broken.positions[0] = Number.NaN;
      return Promise.resolve(outcome(broken));
    },
  };
}

/** Returns an empty mesh. Hard failure unless the fixture expects it. */
export function emptyingCandidate(): RepairKernelCandidate {
  return {
    metadata: metadata('mock-emptying'),
    selfIntersection: SelfIntersectionCapability.None,
    initialize: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    repair: (mesh): Promise<RepairOutcome> =>
      Promise.resolve(
        outcome(withoutTriangles(mesh, new Set(Array.from({ length: 10_000 }, (_, i) => i)))),
      ),
  };
}

/** Produces a different result each call. Determinism failure. */
export function nonDeterministicCandidate(): RepairKernelCandidate {
  let call = 0;
  return {
    metadata: metadata('mock-nondeterministic'),
    selfIntersection: SelfIntersectionCapability.None,
    initialize: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    repair: (mesh): Promise<RepairOutcome> => {
      call += 1;
      // Drops one more face on each successive call.
      return Promise.resolve(
        outcome(withoutTriangles(mesh, new Set(Array.from({ length: call }, (_, i) => i)))),
      );
    },
  };
}

/** Reports a timeout without producing a mesh. */
export function timingOutCandidate(): RepairKernelCandidate {
  return {
    metadata: metadata('mock-timeout'),
    selfIntersection: SelfIntersectionCapability.None,
    initialize: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    repair: () =>
      Promise.resolve(
        outcome(undefined, { status: RepairStatus.TimedOut, kernelReportedSuccess: false }),
      ),
  };
}

/**
 * Ignores the input and returns a closed cube.
 *
 * The "return something clean instead of repairing" failure — a real pattern in
 * repair tools that reconstruct rather than fix. On a fixture with intentional
 * openings this removes every boundary edge, which is exactly what filling an
 * opening looks like from the outside.
 */
export function substitutingCandidate(): RepairKernelCandidate {
  return {
    metadata: metadata('mock-substituting'),
    selfIntersection: SelfIntersectionCapability.None,
    initialize: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    repair: (): Promise<RepairOutcome> => {
      const corners: [number, number, number][] = [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
        [0, 0, 10],
        [10, 0, 10],
        [10, 10, 10],
        [0, 10, 10],
      ];
      const faces: [number, number, number][] = [
        [0, 3, 2],
        [0, 2, 1],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [3, 7, 6],
        [3, 6, 2],
        [0, 4, 7],
        [0, 7, 3],
        [1, 2, 6],
        [1, 6, 5],
      ];
      const positions = createPositionArray(faces.length * 9);
      let write = 0;
      for (const face of faces) {
        for (const index of face) {
          const corner = corners[index];
          if (corner === undefined) continue;
          positions[write] = corner[0];
          positions[write + 1] = corner[1];
          positions[write + 2] = corner[2];
          write += 3;
        }
      }
      const indices = createIndexArray(faces.length * 3);
      for (let i = 0; i < indices.length; i += 1) indices[i] = i;

      return Promise.resolve(
        outcome(
          { positions, indices, metadata: { sourceFormat: 'stl', transform: IDENTITY_MATRIX4 } },
          { reconstructed: true, warnings: ['returned a rebuilt solid'] },
        ),
      );
    },
  };
}

/** Merges everything it is given by welding aggressively. Preservation failure. */
export function overWeldingCandidate(): RepairKernelCandidate {
  return {
    metadata: metadata('mock-overwelding', {
      supportedOperations: [RepairOperation.WeldWithinTolerance],
    }),
    selfIntersection: SelfIntersectionCapability.None,
    initialize: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    repair: (mesh, _operation, parameters: RepairParameters): Promise<RepairOutcome> => {
      // Snaps every coordinate to a coarse grid regardless of the requested
      // tolerance — the classic "weld everything" failure.
      void parameters;
      const welded = cloneMesh(mesh);
      for (let i = 0; i < welded.positions.length; i += 1) {
        welded.positions[i] = Math.round((welded.positions[i] ?? 0) / 5) * 5;
      }
      return Promise.resolve(
        outcome(welded, { warnings: ['welded at a fixed internal tolerance'] }),
      );
    },
  };
}
