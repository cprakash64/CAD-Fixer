import { MeshFormatId } from './formats';

/**
 * Which formats this build can actually read and write.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE REGISTRY: the registry is a module-level
 * map, and modules are per-realm. Codecs are registered inside the geometry
 * WORKER, which is where parsing belongs — so on the main thread the registry is
 * legitimately empty, and `canRead()` there would answer "no" for every format.
 * The user interface runs on the main thread and still has to know what the
 * application supports, in order to say "OBJ import is not implemented" instead
 * of starting an import that cannot finish.
 *
 * Answering that question by importing the codecs on the main thread would pull
 * the whole parser into the initial bundle to satisfy a label, which is the
 * wrong trade. So capability is declared here as data.
 *
 * A declaration that can drift from reality is worse than none, so
 * `capabilities.test.ts` registers the real codecs and asserts this list matches
 * exactly what got registered. The two cannot disagree without failing a test.
 */
export const IMPLEMENTED_FORMATS: readonly MeshFormatId[] = Object.freeze([
  MeshFormatId.Stl,
  MeshFormatId.Obj,
  MeshFormatId.ThreeMf,
]);

/**
 * Formats this build can WRITE, which is a different and smaller list.
 *
 * Stage 4A-2B1 added OBJ and 3MF import; export for them is 4A-2B2. Keeping the
 * two lists separate is what stops the interface offering a Save As for a
 * format that has a reader and no writer.
 */
export const WRITABLE_FORMATS: readonly MeshFormatId[] = Object.freeze([MeshFormatId.Stl]);

export function isFormatWritable(formatId: MeshFormatId): boolean {
  return WRITABLE_FORMATS.includes(formatId);
}

export function isFormatImplemented(formatId: MeshFormatId): boolean {
  return IMPLEMENTED_FORMATS.includes(formatId);
}
