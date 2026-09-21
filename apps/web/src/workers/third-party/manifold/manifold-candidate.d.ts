interface ManifoldModule {
  HEAPF64: Float64Array;
  HEAPU32: Uint32Array;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  _cf_boolean(
    operation: number,
    aPositions: number,
    aVertices: number,
    aIndices: number,
    aTriangles: number,
    bPositions: number,
    bVertices: number,
    bIndices: number,
    bTriangles: number,
  ): number;
  _cf_vertex_count(): number;
  _cf_triangle_count(): number;
  _cf_positions(): number;
  _cf_triangles(): number;
  _cf_reset(): void;
}
export default function createManifoldCandidate(options?: {
  wasmBinary?: ArrayBuffer | Uint8Array;
}): Promise<ManifoldModule>;
