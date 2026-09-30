/** Conservative byte bound for the existing Float32 formatting and global indices.
 * Includes UTF-8 names, material switches, run ends and the fixed header. */
export const SMALL_OBJ_MAX_BYTES = 32 * 1024 * 1024;
export interface ObjPartCost {
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly groupCount: number;
}
export function estimateObjBytes(parts: readonly ObjPartCost[]): number {
  return parts.reduce(
    (sum, part) =>
      sum + part.vertexCount * 80 + part.triangleCount * 40 + (part.groupCount * 2 + 1) * 3100,
    128,
  );
}
export function objNeedsFileSink(parts: readonly ObjPartCost[]): boolean {
  return estimateObjBytes(parts) > SMALL_OBJ_MAX_BYTES;
}
