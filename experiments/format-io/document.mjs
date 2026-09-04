/**
 * Stage 4A-1-R1 — executable multi-part geometry document. RESEARCH ONLY.
 *
 * WHAT THIS PROTOTYPE EXISTS TO SETTLE. Stage 4A-1 argued from the shape of the
 * production code that a document holding several parts could keep ONE monotonic
 * revision, and that every staleness guard in the product would survive the
 * change. That was reasoning, not evidence. This is small enough to read in one
 * sitting and complete enough to run the argument against.
 *
 * DELIBERATELY NOT A COPY OF THE PRODUCTION STORE. It borrows the one idea that
 * matters — a monotonic revision that only moves forwards, against which stale
 * results are rejected — and nothing else. Copying the workspace store would
 * test the store, not the idea.
 */

/** A length unit a document may declare. `undefined` means the source said none. */
export const DocumentUnit = {
  Micrometre: 'micron',
  Millimetre: 'millimeter',
  Centimetre: 'centimeter',
  Metre: 'meter',
  Inch: 'inch',
  Foot: 'foot',
};

/** The 3MF core spec's permitted `unit` values, spelled as the format spells them. */
export const THREE_MF_UNITS = Object.freeze([
  'micron',
  'millimeter',
  'centimeter',
  'inch',
  'foot',
  'meter',
]);

export const IDENTITY_TRANSFORM = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);

/**
 * A part's placement, as 3MF spells it: a row-major 3x4 affine matrix, twelve
 * numbers, the last three being translation.
 *
 * FLOAT64, NOT FLOAT32, AND DELIBERATELY SO. Mesh coordinates are Float32
 * because that is what the canonical model stores and what every exactness
 * guarantee is defined against. A transform is not mesh data — it is read from
 * text and written back to text, and narrowing it to Float32 in between would
 * introduce a rounding error the source never had, for no benefit. The numeric
 * contract for the two is therefore different, and stated separately.
 */
export function isValidTransform(values) {
  if (!Array.isArray(values) || values.length !== 12) return false;
  return values.every((v) => typeof v === 'number' && Number.isFinite(v));
}

/** Applies a 3x4 row-major transform to a point. Used only to CHECK placement. */
export function applyTransform(t, [x, y, z]) {
  return [
    t[0] * x + t[3] * y + t[6] * z + t[9],
    t[1] * x + t[4] * y + t[7] * z + t[10],
    t[2] * x + t[5] * y + t[8] * z + t[11],
  ];
}

/** Composes two 3x4 transforms: `outer` applied after `inner`. */
export function composeTransforms(outer, inner) {
  const out = new Array(12).fill(0);
  for (let col = 0; col < 3; col += 1) {
    for (let row = 0; row < 3; row += 1) {
      out[row * 3 + col] =
        inner[row * 3 + 0] * outer[0 * 3 + col] +
        inner[row * 3 + 1] * outer[1 * 3 + col] +
        inner[row * 3 + 2] * outer[2 * 3 + col];
    }
  }
  for (let col = 0; col < 3; col += 1) {
    out[9 + col] =
      inner[9] * outer[0 * 3 + col] +
      inner[10] * outer[1 * 3 + col] +
      inner[11] * outer[2 * 3 + col] +
      outer[9 + col];
  }
  return out;
}

export class StaleRevisionError extends Error {
  constructor(expected, actual) {
    super(
      `stale revision: operation was built against ${String(expected)}, document is at ${String(actual)}`,
    );
    this.name = 'StaleRevisionError';
  }
}

export class UnknownPartError extends Error {
  constructor(partId) {
    super(`no such part: ${String(partId)}`);
    this.name = 'UnknownPartError';
  }
}

/**
 * The authoritative document.
 *
 * ONE REVISION FOR THE WHOLE DOCUMENT. Not one per part. Every committed change
 * — a mesh edit, a transform edit, an undo — produces exactly one new revision,
 * and revisions only ever increase. That single rule is what lets an operation
 * carry `(documentId, revision, partId)` and be checked with one comparison,
 * exactly as Stage 2 and Stage 3 check `(modelId, revision)` today.
 */
export class GeometryDocument {
  #parts;
  #revision;
  #unit;
  #id;
  #history;

  constructor({ id = 'doc-1', unit = undefined, parts = [] } = {}) {
    this.#id = id;
    this.#unit = unit;
    this.#revision = 1;
    this.#parts = parts.map((p) => Object.freeze({ ...p }));
    // One entry per committed change, holding the FULL previous part list.
    // A prototype may afford that; production would keep an inverse patch, as
    // Stage 3B repair already does.
    this.#history = [];
  }

  get id() {
    return this.#id;
  }
  get revision() {
    return this.#revision;
  }
  get unit() {
    return this.#unit;
  }
  get partCount() {
    return this.#parts.length;
  }
  get parts() {
    return this.#parts;
  }
  get canUndo() {
    return this.#history.length > 0;
  }

  part(partId) {
    const found = this.#parts.find((p) => p.id === partId);
    if (found === undefined) throw new UnknownPartError(partId);
    return found;
  }

  /** Throws unless `revision` is still current. The whole staleness contract. */
  assertCurrent(revision) {
    if (revision !== this.#revision) throw new StaleRevisionError(revision, this.#revision);
  }

  #commit(nextParts) {
    this.#history.push(this.#parts);
    this.#parts = nextParts.map((p) => Object.freeze({ ...p }));
    this.#revision += 1;
    return this.#revision;
  }

  /** Replaces one part's mesh. Every other part keeps its identity AND its buffers. */
  replacePartMesh(revision, partId, mesh) {
    this.assertCurrent(revision);
    this.part(partId);
    return this.#commit(this.#parts.map((p) => (p.id === partId ? { ...p, mesh } : p)));
  }

  /** Replaces one part's placement. Mesh buffers are not touched at all. */
  replacePartTransform(revision, partId, transform) {
    this.assertCurrent(revision);
    if (!isValidTransform(transform)) throw new TypeError('transform must be 12 finite numbers');
    this.part(partId);
    return this.#commit(this.#parts.map((p) => (p.id === partId ? { ...p, transform } : p)));
  }

  addPart(revision, part) {
    this.assertCurrent(revision);
    return this.#commit([...this.#parts, part]);
  }

  /**
   * Restores the previous part list as a NEW, HIGHER revision.
   *
   * The revision never goes backwards, for the same reason ADR 0011 gives for
   * repair undo: every staleness guard is a comparison against a number that
   * only increases, and reactivating an old revision would make a stale result
   * from that revision suddenly valid again.
   */
  undo(revision) {
    this.assertCurrent(revision);
    const previous = this.#history.pop();
    if (previous === undefined) throw new Error('nothing to undo');
    this.#parts = previous;
    this.#revision += 1;
    return this.#revision;
  }
}

/**
 * A result produced against a particular document, revision and part.
 *
 * Diagnostics and repair candidates both need exactly this: an answer is only
 * about the geometry it was computed from, and publishing it anywhere else is
 * how a user ends up reading one part's health beside another part's shape.
 */
export function bindResult(documentId, revision, partId, value) {
  return Object.freeze({ documentId, revision, partId, value });
}

export function canPublish(result, document, partId) {
  return (
    result.documentId === document.id &&
    result.revision === document.revision &&
    result.partId === partId
  );
}
