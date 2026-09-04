/**
 * Stage 4A-1-R1 — D01-D06, MD01-MD08, and the repair/diagnostic contract
 * prototypes. RESEARCH ONLY.
 *
 * The claim under test is narrow and specific: a document holding several parts
 * can keep ONE monotonic revision, and the Stage 2/3 stale-result model survives
 * the abstraction unchanged. Byte identity of untouched parts is asserted
 * literally, not by hash, because "the buffer is the same object" and "the
 * buffer happens to contain the same numbers" are different claims and only the
 * first one proves nothing was rebuilt.
 */
import {
  GeometryDocument,
  IDENTITY_TRANSFORM,
  StaleRevisionError,
  applyTransform,
  bindResult,
  canPublish,
  composeTransforms,
} from './document.mjs';

const say = (l = '') => process.stdout.write(`${l}\n`);
let pass = 0;
let total = 0;

function check(id, description, fn) {
  total += 1;
  try {
    fn();
    pass += 1;
    say(`${id.padEnd(6)} PASS  ${description}`);
  } catch (error) {
    say(`${id.padEnd(6)} ***FAIL*** ${description}\n         ${error.message}`);
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

function mesh(seed, faces = 2) {
  const positions = new Float32Array(faces * 9);
  for (let i = 0; i < positions.length; i += 1) positions[i] = seed + i * 0.5;
  const indices = new Uint32Array(faces * 3);
  for (let i = 0; i < indices.length; i += 1) indices[i] = i;
  return { positions, indices };
}

/** Literal byte comparison. Not a hash: this must be able to say "same bytes". */
function sameBytes(a, b) {
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
  return true;
}

function twoPartDocument() {
  return new GeometryDocument({
    id: 'doc-1',
    unit: 'millimeter',
    parts: [
      { id: 'A', name: 'part A', mesh: mesh(1), transform: IDENTITY_TRANSFORM },
      { id: 'B', name: 'part B', mesh: mesh(100), transform: IDENTITY_TRANSFORM },
    ],
  });
}

say('=== D: document revision semantics ===');

check('D01', 'a two-part document starts at revision 1', () => {
  const doc = twoPartDocument();
  assert(doc.revision === 1, `revision was ${String(doc.revision)}`);
  assert(doc.partCount === 2, 'expected two parts');
  assert(doc.unit === 'millimeter', 'unit not carried');
});

check('D02', 'editing part A leaves part B byte-identical and bumps ONE revision', () => {
  const doc = twoPartDocument();
  const bBefore = doc.part('B').mesh;
  const next = doc.replacePartMesh(doc.revision, 'A', mesh(7));

  assert(next === 2, `revision was ${String(next)}`);
  assert(doc.revision === 2, 'document revision did not advance');
  // Identity AND bytes: B was neither rebuilt nor copied.
  assert(doc.part('B').mesh === bBefore, 'part B mesh was replaced by a new object');
  assert(sameBytes(doc.part('B').mesh.positions, bBefore.positions), 'part B bytes changed');
  assert(!sameBytes(doc.part('A').mesh.positions, mesh(1).positions), 'part A did not change');
  // No per-part revision exists anywhere.
  assert(!('revision' in doc.part('A')), 'a per-part revision appeared');
});

check('D03', 'editing part B holds the same invariant', () => {
  const doc = twoPartDocument();
  const aBefore = doc.part('A').mesh;
  doc.replacePartMesh(doc.revision, 'B', mesh(9));
  assert(doc.revision === 2, 'revision did not advance');
  assert(doc.part('A').mesh === aBefore, 'part A was disturbed');
  assert(sameBytes(doc.part('A').mesh.positions, aBefore.positions), 'part A bytes changed');
});

check('D04', 'undo restores contents as a NEW, HIGHER revision', () => {
  const doc = twoPartDocument();
  const aOriginal = doc.part('A').mesh;
  doc.replacePartMesh(doc.revision, 'A', mesh(7));
  assert(doc.revision === 2, 'edit did not advance');

  const after = doc.undo(doc.revision);
  assert(after === 3, `undo produced revision ${String(after)}, expected 3`);
  // Contents restored...
  assert(sameBytes(doc.part('A').mesh.positions, aOriginal.positions), 'undo did not restore A');
  // ...but the revision moved FORWARDS, never back to 1.
  assert(doc.revision > 2, 'revision went backwards or stalled');
});

check('D05', 'a result built against revision N cannot publish once N+1 exists', () => {
  const doc = twoPartDocument();
  const staleRevision = doc.revision;
  const staleResult = bindResult(doc.id, staleRevision, 'A', { defects: 0 });

  doc.replacePartMesh(doc.revision, 'A', mesh(7));

  assert(!canPublish(staleResult, doc, 'A'), 'a stale result was publishable');
  // And a stale WRITE is refused by the document itself, not merely by a caller.
  let threw = false;
  try {
    doc.replacePartMesh(staleRevision, 'A', mesh(11));
  } catch (error) {
    threw = error instanceof StaleRevisionError;
  }
  assert(threw, 'a stale write was accepted');
});

check('D06', 'a transform-only change bumps the revision without touching mesh bytes', () => {
  const doc = twoPartDocument();
  const aMesh = doc.part('A').mesh;
  const moved = [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 20, 30];

  doc.replacePartTransform(doc.revision, 'A', moved);

  assert(doc.revision === 2, 'revision did not advance');
  // THE POINT: placement changed, geometry did not. Baking the transform into
  // the positions would have made these two statements impossible to separate.
  assert(doc.part('A').mesh === aMesh, 'mesh object was rebuilt for a placement change');
  assert(sameBytes(doc.part('A').mesh.positions, aMesh.positions), 'mesh bytes changed');
  assert(doc.part('A').transform[9] === 10, 'transform not stored');
});

say('');
say('=== MD: multi-part document behaviour ===');

check('MD01', 'two independent parts keep separate identities and buffers', () => {
  const doc = twoPartDocument();
  assert(doc.part('A').mesh !== doc.part('B').mesh, 'parts share a mesh object');
  assert(
    !sameBytes(doc.part('A').mesh.positions, doc.part('B').mesh.positions),
    'parts share bytes',
  );
});

check('MD02', 'two placements of ONE geometry share the mesh and differ only in transform', () => {
  const shared = mesh(5);
  const doc = new GeometryDocument({
    parts: [
      { id: 'left', mesh: shared, transform: IDENTITY_TRANSFORM },
      { id: 'right', mesh: shared, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 50, 0, 0] },
    ],
  });
  // STRUCTURAL SHARING, not duplication: one buffer, two placements.
  assert(doc.part('left').mesh === doc.part('right').mesh, 'geometry was duplicated');
  const local = [1, 2, 3];
  const l = applyTransform(doc.part('left').transform, local);
  const r = applyTransform(doc.part('right').transform, local);
  assert(l[0] === 1 && r[0] === 51, `placements wrong: ${String(l[0])}, ${String(r[0])}`);
});

check('MD03', 'transform-only change is covered by D06', () => {
  assert(true, '');
});

check('MD04', 'editing one part geometry is covered by D02/D03', () => {
  assert(true, '');
});

check('MD05', 'undo is covered by D04', () => {
  assert(true, '');
});

check('MD06', 'stale operation rejection is covered by D05', () => {
  assert(true, '');
});

check('MD07', 'a diagnostic result for part A cannot publish as part B', () => {
  const doc = twoPartDocument();
  const forA = bindResult(doc.id, doc.revision, 'A', { selfIntersections: 3 });
  assert(canPublish(forA, doc, 'A'), 'a valid result was refused');
  // THE CASE THAT MATTERS: same document, same revision, wrong part.
  assert(!canPublish(forA, doc, 'B'), "part A's result published as part B");
  // And a different document cannot claim it either.
  const other = new GeometryDocument({ id: 'doc-2' });
  assert(!canPublish(forA, other, 'A'), "one document's result published against another");
});

check('MD08', 'a repair candidate is bound to (document, revision, part) as well', () => {
  const doc = twoPartDocument();
  const candidate = bindResult(doc.id, doc.revision, 'A', { candidateMesh: mesh(42) });
  assert(canPublish(candidate, doc, 'A'), 'valid candidate refused');
  doc.replacePartTransform(doc.revision, 'B', [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0]);
  // A change to an UNRELATED part still invalidates the candidate, because the
  // document revision is what the guard compares. That is a deliberate cost of
  // the single-revision model, and it is the safe direction to err in.
  assert(!canPublish(candidate, doc, 'A'), 'candidate survived a document change');
});

say('');
say('=== repair transaction shape ===');

check('RX01', 'apply on part A leaves B untouched and advances one revision', () => {
  const doc = twoPartDocument();
  const startRevision = doc.revision;
  const bBefore = doc.part('B').mesh;

  // rev N -> candidate for A -> validated -> apply -> rev N+1
  const candidate = bindResult(doc.id, doc.revision, 'A', mesh(77));
  assert(canPublish(candidate, doc, 'A'), 'candidate not valid before apply');
  doc.replacePartMesh(candidate.revision, 'A', candidate.value);

  assert(doc.revision === startRevision + 1, 'more than one revision was consumed');
  assert(doc.part('B').mesh === bBefore, 'part B changed during a part A repair');
});

check('RX02', 'undo restores A while leaving B untouched', () => {
  const doc = twoPartDocument();
  const aBefore = doc.part('A').mesh;
  const bBefore = doc.part('B').mesh;
  doc.replacePartMesh(doc.revision, 'A', mesh(77));
  doc.undo(doc.revision);
  assert(sameBytes(doc.part('A').mesh.positions, aBefore.positions), 'A not restored');
  assert(doc.part('B').mesh === bBefore, 'B disturbed by undo');
});

check('RX03', 'a candidate built at rev N cannot apply after the document moves on', () => {
  const doc = twoPartDocument();
  const candidate = bindResult(doc.id, doc.revision, 'A', mesh(77));
  doc.replacePartMesh(doc.revision, 'B', mesh(88)); // document moves to N+1
  let threw = false;
  try {
    doc.replacePartMesh(candidate.revision, 'A', candidate.value);
  } catch (error) {
    threw = error instanceof StaleRevisionError;
  }
  assert(threw, 'a stale candidate applied');
});

say('');
say('=== transform composition (needed only if components are supported) ===');

check('TX01', 'composing translate-then-translate is additive', () => {
  const t1 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0];
  const t2 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 0];
  const composed = composeTransforms(t2, t1);
  const p = applyTransform(composed, [0, 0, 0]);
  assert(p[0] === 10 && p[1] === 5, `got ${JSON.stringify(p)}`);
});

check('TX02', 'composing scale-then-translate applies in the stated order', () => {
  const scale = [2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0];
  const move = [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0];
  // inner = scale, outer = move: point is scaled, then moved.
  const composed = composeTransforms(move, scale);
  const p = applyTransform(composed, [1, 1, 1]);
  assert(p[0] === 12 && p[1] === 2 && p[2] === 2, `got ${JSON.stringify(p)}`);
});

check('TX03', 'a 90-degree rotation about Z maps (1,0,0) to (0,1,0) exactly', () => {
  const rot = [0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0];
  const p = applyTransform(rot, [1, 0, 0]);
  assert(p[0] === 0 && p[1] === 1 && p[2] === 0, `got ${JSON.stringify(p)}`);
});

say('');
say(`document prototype: ${String(pass)}/${String(total)} checks passed`);
