/**
 * Descriptors for the mesh interchange formats CAD Fixer targets.
 *
 * Stage 0 defines identity and capability metadata only. No parser or writer
 * exists yet, and `MeshFormatRegistry` is empty by design — see `registry.ts`.
 */

export const MeshFormatId = {
  Stl: 'stl',
  Obj: 'obj',
  ThreeMf: '3mf',
} as const;

export type MeshFormatId = (typeof MeshFormatId)[keyof typeof MeshFormatId];

export interface MeshFormatDescriptor {
  readonly id: MeshFormatId;
  readonly label: string;
  /** Lower-case, dot-prefixed. The first entry is the canonical export extension. */
  readonly extensions: readonly string[];
  /**
   * Media types seen in practice. Browsers report these inconsistently for CAD
   * files, so they are advisory for the file picker only and are never used as
   * a trust signal.
   */
  readonly mediaTypes: readonly string[];
  /** Whether the format can carry per-vertex or per-object colour information. */
  readonly supportsColor: boolean;
  /** Whether the format records a physical unit for its coordinates. */
  readonly carriesUnits: boolean;
  /** Whether the format can express multiple named objects in one file. */
  readonly supportsMultipleObjects: boolean;
}

const DESCRIPTORS: Readonly<Record<MeshFormatId, MeshFormatDescriptor>> = {
  [MeshFormatId.Stl]: {
    id: MeshFormatId.Stl,
    label: 'STL',
    extensions: ['.stl'],
    mediaTypes: ['model/stl', 'application/sla', 'application/vnd.ms-pki.stl'],
    supportsColor: false,
    carriesUnits: false,
    supportsMultipleObjects: false,
  },
  [MeshFormatId.Obj]: {
    id: MeshFormatId.Obj,
    label: 'OBJ',
    extensions: ['.obj'],
    mediaTypes: ['model/obj', 'text/plain'],
    supportsColor: false,
    carriesUnits: false,
    supportsMultipleObjects: true,
  },
  [MeshFormatId.ThreeMf]: {
    id: MeshFormatId.ThreeMf,
    label: '3MF',
    extensions: ['.3mf'],
    mediaTypes: ['model/3mf', 'application/vnd.ms-3mfdocument'],
    supportsColor: true,
    carriesUnits: true,
    supportsMultipleObjects: true,
  },
};

export const SUPPORTED_FORMATS: readonly MeshFormatDescriptor[] = Object.freeze([
  DESCRIPTORS[MeshFormatId.Stl],
  DESCRIPTORS[MeshFormatId.Obj],
  DESCRIPTORS[MeshFormatId.ThreeMf],
]);

export function describeFormat(id: MeshFormatId): MeshFormatDescriptor {
  return DESCRIPTORS[id];
}

/** Every recognised extension, dot-prefixed and lower-case. */
export const SUPPORTED_EXTENSIONS: readonly string[] = Object.freeze(
  SUPPORTED_FORMATS.flatMap((format) => [...format.extensions]),
);

/** Value for an `<input type="file">` accept attribute. */
export const FILE_INPUT_ACCEPT: string = SUPPORTED_EXTENSIONS.join(',');
