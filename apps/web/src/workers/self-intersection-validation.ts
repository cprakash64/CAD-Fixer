/**
 * BOUNDARY VALIDATION FOR THE DIAGNOSTIC WORKER.
 *
 * WHY THIS EXISTS WHEN THE PRODUCER IS OUR OWN WORKER. Everything downstream
 * indexes raw WebAssembly memory: a wrong length or an index past the end is
 * not a wrong answer, it is an out-of-bounds read. "The caller is internal" is
 * an assumption that outlives the code that made it, and a message arriving on
 * a port is a runtime value regardless of what its TypeScript type claims.
 *
 * Its own module so it can be exercised directly with the malformed inputs
 * TypeScript would refuse to construct. The kernel validates independently; this
 * is the outer of two layers.
 */

/** Returns a reason string when the message must be refused, otherwise undefined. */
export function describeMalformedGeometry(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return 'message is not an object';

  /*
   * READ AS `unknown`, NOT THROUGH THE DECLARED TYPE.
   *
   * `DiagnosticGeometryMessage` describes what a correct sender produces. A
   * value that arrived on a port is whatever it actually is, and narrowing it
   * to the declared shape first would let TypeScript prove away the very checks
   * that make this function worth having — `limits === null` becomes "provably
   * impossible" against a type that never admitted null in the first place.
   */
  const fields = message as Record<string, unknown>;

  if (typeof fields.operationId !== 'string') return 'operationId must be a string';
  if (typeof fields.modelId !== 'string') return 'modelId must be a string';
  if (!Number.isInteger(fields.modelRevision)) return 'modelRevision must be an integer';

  const positions = fields.positions;
  const triangles = fields.triangles;

  // The typed-array KIND matters, not just that it is array-like: a Float32Array
  // of positions would be silently reinterpreted as half as many Float64s.
  if (!(positions instanceof Float64Array)) return 'positions must be a Float64Array';
  if (!(triangles instanceof Uint32Array)) return 'triangles must be a Uint32Array';

  if (positions.length % 3 !== 0) return 'positions length must be a multiple of 3';
  if (triangles.length % 3 !== 0) return 'triangles length must be a multiple of 3';

  const vertexCount = positions.length / 3;
  if (triangles.length > 0 && vertexCount < 3) return 'a face needs at least three vertices';

  for (const index of triangles) {
    if (index >= vertexCount) return 'a face index addresses no vertex';
  }
  // Non-finite coordinates have no exact predicates and no meaningful bounding
  // box; the broadphase would produce nonsense rather than fail.
  for (const coordinate of positions) {
    if (!Number.isFinite(coordinate)) return 'positions must all be finite';
  }

  const limits = fields.limits;
  if (typeof limits !== 'object' || limits === null) return 'limits must be an object';
  const caps = limits as Record<string, unknown>;
  for (const key of ['maxCandidatePairs', 'maxTestedPairs', 'maxSamples'] as const) {
    const value = caps[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return `${key} must be a positive finite number`;
    }
  }

  return undefined;
}
