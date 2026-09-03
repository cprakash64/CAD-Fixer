// CAD Fixer Stage 3C-1A — read-only self-intersection diagnostic core.
//
// RESEARCH ONLY. Never linked into the application.
//
// WHAT THIS IS. A candidate architecture for a READ-ONLY self-intersection
// diagnostic built on the pinned Geogram v1.10.0
// (c8529bb00838186938ab31d96008a59b6a892dee). It answers "does this mesh
// intersect itself, and where" WITHOUT modifying the mesh, without welding,
// without tolerance, and without retriangulating anything.
//
// WHY NOT MeshSurfaceIntersection. That class takes `Mesh&` and its
// `intersect()` rewrites the mesh it was given — it is a RESOLVER, not a
// detector. Using it to answer a diagnostic question would mean mutating
// authoritative geometry to find out whether it was broken, which is exactly
// backwards. See docs/adr/0012.
//
// THE TWO GEOGRAM ENTRY POINTS USED, and why each is safe:
//
//   MeshFacetsAABB(const Mesh&)          mesh_AABB.h:484
//     Delegates to initialize(..., AABB_INDIRECT), whose documented contract is
//     "leave mesh untouched, store order in separate vector". The mutating mode
//     is AABB_INPLACE, which calls mesh_reorder(); we never select it.
//
//   triangles_intersections(p0..q2, indices, result)   triangle_intersection.h:256
//     Takes bare vec3 values and global vertex indices. It holds no mesh and
//     cannot write to one. It returns SYMBOLIC structure — pairs of
//     TriangleRegion — which is what lets this classifier distinguish a
//     legitimate shared edge from an actual overlap without inventing a
//     tolerance.
//
// PRECONDITION WE MUST RESPECT. The pinned header states the inputs "are
// supposed to be non-degenerate (their three vertices are supposed to be
// distinct and not co-linear)". Degenerate faces are therefore SKIPPED and
// COUNTED, and a mesh with skipped faces can never report CHECKED. Truthful
// incompleteness over false confidence.

#pragma once

#include <cstdint>
#include <algorithm>
#include <vector>
#include <chrono>
#include <array>

#include <geogram/basic/common.h>
#include <geogram/basic/geometry.h>
#include <geogram/mesh/mesh.h>
#include <geogram/mesh/mesh_AABB.h>
#include <geogram/mesh/triangle_intersection.h>
#include <geogram/basic/assert.h>
#include <geogram/numerics/predicates.h>

#include "si_bvh.h"

namespace cadfixer {

// The frozen taxonomy. Every classified pair lands in exactly one bucket.
enum SiCategory {
  SI_NONE = 0,
  SI_PROPER_CROSSING = 1,
  SI_COPLANAR_OVERLAP = 2,
  SI_NON_ADJACENT_POINT_TOUCH = 3,
  SI_NON_ADJACENT_EDGE_TOUCH = 4,
  SI_ADJACENT_OVERLAP_BEYOND_SHARED = 5,
  SI_DUPLICATE_TOPOLOGY_DEFECT = 6,
  SI_LEGITIMATE_SHARED = 7,
  SI_SKIPPED_DEGENERATE = 8
};

enum SiStatus {
  SI_STATUS_CHECKED = 0,
  SI_STATUS_PARTIAL = 1,
  SI_STATUS_RESOURCE_LIMIT = 2,
  SI_STATUS_INTERNAL_FAILURE = 3
};

/**
 * Research switches for the Stage 3C-1A-R1 prefilters.
 *
 * OFF BY DEFAULT so the Stage 3C-1A classifier remains reachable unchanged as
 * the differential ORACLE. An optimisation that cannot be compared against the
 * thing it replaced is not an optimisation, it is a rewrite.
 */
struct SiOptions {
  /*
   * BOTH PREFILTERS ARE OFF BY DEFAULT BECAUSE BOTH WERE MEASURED AND REJECTED.
   * They are retained, unreachable in the default path, as the evidence behind
   * that rejection rather than as a feature.
   *
   * `fast_shared_edge` is mathematically sound (see the proof on
   * `provably_legitimate_shared_edge`) but removed only ~6% of narrowphase
   * calls on a corrugated surface and NONE on a planar one, where every
   * shared-edge pair is coplanar and must be analysed anyway. It measured
   * SLOWER than the path it replaced.
   *
   * `plane_prefilter` is also sound, and removed 35% of narrowphase calls at a
   * million faces — yet bought only ~5% of wall clock, because an exact
   * `orient_3d` costs a large fraction of the `triangles_intersections` call it
   * avoids. It also moves pairs out of `legitimateShared`, which the
   * differential harness caught: 26 fixtures disagreed with the oracle on that
   * field. A prefilter that changes a reported number is not an optimisation.
   *
   * The conclusion is the useful part: this cost is NOT prefilterable. It lives
   * inside the exact narrowphase, and the production answer is a bounded,
   * explicitly-invoked diagnostic rather than a faster one.
   */
  bool fast_shared_edge = false;
  bool plane_prefilter = false;

  /**
   * Use CAD Fixer's own ABORTABLE broadphase instead of Geogram's AABB.
   *
   * ON BY DEFAULT AS OF STAGE 3C-1A-R1, on measured grounds.
   *
   * The candidate SET is identical to Geogram's — validated against a
   * brute-force oracle and against Geogram itself on 26 fixtures, samples
   * included — and the runtime is equal within noise at every size from 20k to
   * 1M faces. What differs is only what happens AFTER the work cap fires:
   * Geogram's callback returns void, so its traversal keeps enumerating pairs
   * into a callback that now discards them. Measured at 6,000 pathological
   * faces that was 17,994,999 wasted callbacks; it grows as O(N^2). This tree
   * stops within one pair.
   *
   * Set false to run the original Geogram broadphase for comparison.
   */
  bool abortable_broadphase = true;
};

struct SiLimits {
  // Deterministic WORK caps, not a wall clock: the same mesh must produce the
  // same verdict on a fast machine and a slow one.
  uint64_t max_candidate_pairs = 40000000ull;
  uint64_t max_tested_pairs = 20000000ull;
  uint32_t max_samples = 4096;
};

struct SiReport {
  int status = SI_STATUS_CHECKED;

  uint64_t candidate_pair_count = 0;
  uint64_t tested_pair_count = 0;

  uint64_t intersecting_pair_count = 0;

  uint64_t proper_crossing = 0;
  uint64_t coplanar_overlap = 0;
  uint64_t non_adjacent_point_touch = 0;
  uint64_t non_adjacent_edge_touch = 0;
  uint64_t adjacent_overlap_beyond_shared = 0;
  uint64_t duplicate_topology_defect = 0;
  uint64_t legitimate_shared = 0;

  uint32_t skipped_degenerate_face_count = 0;
  uint64_t skipped_pair_count = 0;

  /*
   * THE FUNNEL. Stage 3C-1A measured 8.9M candidates costing ~54 s and could
   * not say why. These counters attribute every candidate to the stage that
   * disposed of it, which is the difference between optimising and guessing.
   */
  uint64_t funnel_duplicate = 0;        // settled by exact topology alone
  uint64_t funnel_degenerate = 0;       // outside the narrowphase precondition
  uint64_t funnel_shared_edge = 0;      // topologically adjacent across an edge
  uint64_t funnel_shared_vertex = 0;    // topologically adjacent at a vertex
  uint64_t funnel_disjoint = 0;         // no shared topology
  uint64_t funnel_plane_separated = 0;  // proven apart by an exact predicate
  uint64_t funnel_narrowphase = 0;      // actually reached triangles_intersections

  /** Broadphase callbacks that arrived AFTER the work cap had already fired. */
  /**
   * Pairs the narrowphase REFUSED to classify by throwing.
   *
   * `GEO::TriangleIsects` is a fixed 20-element buffer and its push_back is an
   * unconditional `geo_assert`. Stage 3C-1A believed only duplicate triangles
   * could overflow it; a 1.2M-case fuzz over small integer coordinates proved
   * otherwise — ordinary nondegenerate coplanar pairs can too. Each such pair is
   * counted and forces PARTIAL, because a pair that could not be examined must
   * never be reported as a pair with no defect.
   */
  uint64_t narrowphase_refusals = 0;
  uint64_t callbacks_after_cap = 0;
  /** Milliseconds spent in the broadphase after the cap fired. */
  double wasted_after_cap_ms = 0;
  bool used_abortable_broadphase = false;

  // Normalised (f1 < f2) sample pairs, flattened as f1,f2,category.
  std::vector<uint32_t> samples;
  uint64_t sample_pair_count = 0;
  bool samples_truncated = false;

  uint32_t affected_face_count = 0;

  // Phase timings, so scaling evidence can attribute cost rather than guess.
  double degeneracy_ms = 0;
  double aabb_ms = 0;
  double scan_ms = 0;
};

/**
 * Exact-coordinate degeneracy, decided the same way Stage 2 decides it.
 *
 * Two tests, and both matter. A REPEATED POSITION is two corners of the face
 * carrying the identical topological vertex — the face has no third distinct
 * point. COLLINEAR is three distinct vertices on one line, which has zero area
 * and no plane. Geogram's narrowphase documents both as outside its
 * preconditions, so a face failing either is skipped rather than guessed at.
 *
 * No epsilon. Collinearity is decided by exact predicates on the stored
 * coordinates, not by a small-area threshold.
 */
inline bool is_degenerate_face(
    const std::vector<double>& pos, const uint32_t* tri
) {
  const uint32_t a = tri[0], b = tri[1], c = tri[2];
  if (a == b || b == c || a == c) return true;

  const GEO::vec3 p0(pos[3 * a], pos[3 * a + 1], pos[3 * a + 2]);
  const GEO::vec3 p1(pos[3 * b], pos[3 * b + 1], pos[3 * b + 2]);
  const GEO::vec3 p2(pos[3 * c], pos[3 * c + 1], pos[3 * c + 2]);

  // Collinear iff the triangle is flat in all three coordinate planes. Each
  // orient_2d is an exact sign predicate; a zero in all three means no plane.
  const double xy0[2] = {p0.x, p0.y}, xy1[2] = {p1.x, p1.y}, xy2[2] = {p2.x, p2.y};
  const double yz0[2] = {p0.y, p0.z}, yz1[2] = {p1.y, p1.z}, yz2[2] = {p2.y, p2.z};
  const double zx0[2] = {p0.z, p0.x}, zx1[2] = {p1.z, p1.x}, zx2[2] = {p2.z, p2.x};

  return GEO::PCK::orient_2d(xy0, xy1, xy2) == GEO::ZERO &&
         GEO::PCK::orient_2d(yz0, yz1, yz2) == GEO::ZERO &&
         GEO::PCK::orient_2d(zx0, zx1, zx2) == GEO::ZERO;
}

/** Topological vertices shared by two faces. 0, 1, 2 or 3. */
inline int shared_vertex_count(const uint32_t* t1, const uint32_t* t2) {
  int shared = 0;
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      if (t1[i] == t2[j]) { ++shared; break; }
    }
  }
  return shared;
}

/**
 * EXACT PLANE SEPARATION. Returns true only when the triangles PROVABLY cannot
 * meet.
 *
 * THE CLAIM. If all three vertices of `t2` lie strictly on one side of the
 * supporting plane of `t1`, then `t2` lies strictly within one open half-space
 * of that plane. `t1` lies entirely within the plane. A set strictly inside an
 * open half-space is disjoint from the plane bounding it, so the triangles
 * cannot share a point. The test is symmetric and is tried both ways.
 *
 * ONE-SIDED BY CONSTRUCTION. It answers only "definitely disjoint" or "do not
 * know"; the second answer always falls through to the full narrowphase. It can
 * therefore never produce a false negative — the failure mode this stage cares
 * about — no matter how adversarial the input.
 *
 * NO EPSILON. `orient_3d` is an exact sign predicate. `ZERO` means the vertex
 * is ON the plane, which is precisely the uncertain case, and it is never
 * treated as separation.
 */
inline bool provably_plane_separated(
    const std::vector<double>& pos, const uint32_t* t1, const uint32_t* t2
) {
  auto separated = [&](const uint32_t* plane, const uint32_t* other) {
    const double* a = &pos[3 * plane[0]];
    const double* b = &pos[3 * plane[1]];
    const double* c = &pos[3 * plane[2]];
    const GEO::Sign s0 = GEO::PCK::orient_3d(a, b, c, &pos[3 * other[0]]);
    if (s0 == GEO::ZERO) return false;
    const GEO::Sign s1 = GEO::PCK::orient_3d(a, b, c, &pos[3 * other[1]]);
    if (s1 != s0) return false;
    const GEO::Sign s2 = GEO::PCK::orient_3d(a, b, c, &pos[3 * other[2]]);
    return s2 == s0;
  };
  return separated(t1, t2) || separated(t2, t1);
}

/**
 * LEGITIMATE SHARED VERTEX, proven by a half-space argument that IGNORES the
 * shared vertex.
 *
 * WHY THE PLAIN SEPARATION TEST CANNOT WORK HERE, measured rather than guessed:
 * on a conforming surface 53% of all AABB candidates are pairs sharing exactly
 * one topological vertex. That vertex is a vertex of BOTH triangles, so it lies
 * exactly ON the other's supporting plane and `orient_3d` returns ZERO for it —
 * which makes a "all three vertices strictly one side" test fail every single
 * time. The Stage 3C-1A-R1 funnel measured exactly that: the prefilter fired
 * zero times on a million-face surface.
 *
 * THE PROOF, restricted to the vertices that are NOT shared. Let A = (u,a,b) and
 * B = (u,c,d) share exactly the topological vertex u. Suppose c and d lie
 * strictly on the SAME side of the supporting plane P of A.
 *
 *   1. B is the convex hull of {u, c, d}. u ∈ P; c and d are strictly inside one
 *      open half-space H of P.
 *   2. Any point of B is a convex combination λ_u·u + λ_c·c + λ_d·d. If
 *      λ_c + λ_d > 0 the point is strictly inside H, because a convex
 *      combination of points in the closed half-space with positive weight on a
 *      strictly interior point is strictly interior.
 *   3. So the only point of B lying in P is the one with λ_c = λ_d = 0, namely u.
 *      Hence B ∩ P = {u}.
 *   4. A ⊆ P, therefore A ∩ B ⊆ B ∩ P = {u}. Since u belongs to both, A ∩ B is
 *      exactly {u} — the legitimate shared vertex, and nothing more.
 *
 * One-sided as required: a ZERO sign, or two opposite signs, means "do not
 * know" and falls through to the full narrowphase. The symmetric test is tried
 * as well, since either triangle's plane may be the separating one.
 */
inline bool provably_legitimate_shared_vertex(
    const std::vector<double>& pos, const uint32_t* t1, const uint32_t* t2
) {
  auto only_touches_at_shared = [&](const uint32_t* plane, const uint32_t* other) {
    const double* a = &pos[3 * plane[0]];
    const double* b = &pos[3 * plane[1]];
    const double* c = &pos[3 * plane[2]];
    GEO::Sign seen = GEO::ZERO;
    for (int j = 0; j < 3; ++j) {
      const uint32_t v = other[j];
      // Skip the vertices this face genuinely shares with the plane's face:
      // they are ON the plane by construction and carry no information.
      bool is_shared = false;
      for (int i = 0; i < 3; ++i) {
        if (plane[i] == v) { is_shared = true; break; }
      }
      if (is_shared) continue;
      const GEO::Sign s = GEO::PCK::orient_3d(a, b, c, &pos[3 * v]);
      if (s == GEO::ZERO) return false;
      if (seen == GEO::ZERO) seen = s;
      else if (s != seen) return false;
    }
    return seen != GEO::ZERO;
  };
  return only_touches_at_shared(t1, t2) || only_touches_at_shared(t2, t1);
}

/**
 * The third vertex of `tri` that is not one of `a` or `b`.
 * Returns UINT32_MAX when the face does not have exactly one such vertex.
 */
inline uint32_t opposite_vertex(const uint32_t* tri, uint32_t a, uint32_t b) {
  uint32_t found = UINT32_MAX;
  int count = 0;
  for (int i = 0; i < 3; ++i) {
    const uint32_t v = tri[i];
    if (v != a && v != b) { found = v; ++count; }
  }
  return count == 1 ? found : UINT32_MAX;
}

/**
 * LEGITIMATE NON-COPLANAR SHARED EDGE. Returns true only when the pair is
 * PROVABLY nothing more than the topological edge it is entitled to share.
 *
 * THE PROOF. Let A = (u,v,w) and B = (u,v,x) share exactly the topological edge
 * e = uv, both nondegenerate, and suppose their supporting planes are DISTINCT.
 *
 *   1. Two distinct planes meet in at most a line. Both planes contain u and v,
 *      so that line is exactly line(u,v).
 *   2. A ∩ B lies in both planes, hence A ∩ B ⊆ line(u,v).
 *   3. A is convex with vertices u, v, w, and w ∉ line(u,v) because A is
 *      nondegenerate. A convex hull meets a line through two of its vertices in
 *      exactly the segment between them, so A ∩ line(u,v) = [u,v]. The same
 *      argument gives B ∩ line(u,v) = [u,v].
 *   4. Therefore A ∩ B = [u,v] — exactly the shared edge, and nothing beyond it.
 *
 * So a NON-COPLANAR shared-edge pair cannot overlap beyond its edge, and needs
 * no generic intersection test.
 *
 * THE HYPOTHESIS THAT MATTERS. Distinctness of the planes is checked exactly,
 * with a single `orient_3d(u, v, w, x)`. When it returns ZERO the planes
 * coincide, step 1 collapses, and the pair falls through to the full analysis —
 * which is exactly the SI14 configuration, where coplanar neighbours DO fold
 * back and overlap in area.
 */
inline bool provably_legitimate_shared_edge(
    const std::vector<double>& pos, const uint32_t* t1, const uint32_t* t2
) {
  // Identify the two shared vertices.
  uint32_t shared[3];
  int n = 0;
  for (int i = 0; i < 3; ++i) {
    for (int j = 0; j < 3; ++j) {
      if (t1[i] == t2[j]) { if (n < 3) shared[n] = t1[i]; ++n; break; }
    }
  }
  if (n != 2) return false;

  const uint32_t u = shared[0];
  const uint32_t v = shared[1];
  const uint32_t w = opposite_vertex(t1, u, v);
  const uint32_t x = opposite_vertex(t2, u, v);
  if (w == UINT32_MAX || x == UINT32_MAX) return false;

  // Distinct supporting planes ⇒ the proof above applies.
  return GEO::PCK::orient_3d(&pos[3 * u], &pos[3 * v], &pos[3 * w], &pos[3 * x]) != GEO::ZERO;
}

/** True when every vertex of both triangles lies in one common plane. */
inline bool exactly_coplanar(
    const std::vector<double>& pos, const uint32_t* t1, const uint32_t* t2
) {
  const double* a = &pos[3 * t1[0]];
  const double* b = &pos[3 * t1[1]];
  const double* c = &pos[3 * t1[2]];
  for (int j = 0; j < 3; ++j) {
    const double* q = &pos[3 * t2[j]];
    if (GEO::PCK::orient_3d(a, b, c, q) != GEO::ZERO) return false;
  }
  return true;
}

}  // namespace cadfixer

namespace cadfixer {

/**
 * Classifies one candidate pair from Geogram's SYMBOLIC intersection result.
 *
 * THE WHOLE POINT OF THIS FUNCTION. A triangulated surface is made almost
 * entirely of triangles that touch each other — that is what "conforming" means.
 * A detector that reported every touching pair would report every clean mesh as
 * broken. So the question is never "do these two triangles meet" but "do they
 * meet in MORE than the topological primitive they are entitled to share".
 *
 * Adjacency comes from Stage 2's exact stored-coordinate vertex identity — the
 * SAME identity the rest of CAD Fixer uses. No second, fuzzier merging scheme
 * is introduced here; a diagnostic that welded differently from the analyser
 * would disagree with it about what the model even is.
 */
inline int classify_pair(
    const std::vector<double>& pos,
    const uint32_t* t1, const uint32_t* t2,
    const GEO::TriangleIsects& isects,
    bool /*non_degenerate_flag*/
) {
  const int shared = shared_vertex_count(t1, t2);

  // Three shared topological vertices IS the same triangle, in one winding or
  // the other. Stage 2 already reports duplicates as their own defect; counting
  // them again as ordinary crossings would double-report one problem under two
  // names and inflate the intersection count.
  if (shared == 3) return SI_DUPLICATE_TOPOLOGY_DEFECT;

  if (isects.size() == 0) return SI_NONE;

  // What did the intersection actually touch?
  bool interior_involved = false;
  GEO::coord_index_t max_dim = 0;
  for (const GEO::TriangleIsect& I : isects) {
    if (I.first == GEO::T1_RGN_T || I.second == GEO::T2_RGN_T) {
      interior_involved = true;
    }
    max_dim = std::max(max_dim, GEO::region_dim(I.first));
    max_dim = std::max(max_dim, GEO::region_dim(I.second));
  }

  /*
   * THE LEGITIMATE-NEIGHBOUR FAST PATH COMES FIRST, and the ordering is a
   * measured decision rather than a stylistic one.
   *
   * On any conforming surface the overwhelming majority of candidate pairs are
   * edge or vertex neighbours that are perfectly fine. Deciding those from the
   * symbolic result alone — which is already in hand — costs a few integer
   * comparisons. Running the exact coplanarity predicate first instead cost
   * three orient_3d calls on every one of them, which on a 1M-face grid is
   * millions of exact predicate evaluations spent confirming that a normal mesh
   * is normal. Measured effect is recorded in the Stage 3C-1A report.
   */
  if (shared == 2) {
    // A conforming manifold neighbour pair. Entitled to share exactly its edge:
    // a contact of dimension <= 1 that never reaches either interior IS that
    // edge. Anything more is an overlap the surface should not have.
    if (!interior_involved && max_dim <= 1) return SI_LEGITIMATE_SHARED;
    return SI_ADJACENT_OVERLAP_BEYOND_SHARED;
  }

  if (shared == 1) {
    // Entitled to share exactly one point. A single 0-dimensional contact is
    // that point; a segment or an interior hit is not.
    if (!interior_involved && max_dim == 0) return SI_LEGITIMATE_SHARED;
    return SI_ADJACENT_OVERLAP_BEYOND_SHARED;
  }

  // COPLANAR AREA OVERLAP. Two coplanar triangles sharing more than a segment
  // overlap over real area. Geogram returns the overlap polygon's corners, so
  // more than two distinct symbolic contacts on a common plane means area, not
  // a touch. This is the case a naive "do the planes cross" test misses
  // entirely, and it is a genuine defect.
  if (exactly_coplanar(pos, t1, t2) && (isects.size() > 2 || interior_involved)) {
    return SI_COPLANAR_OVERLAP;
  }

  // shared == 0: the faces share no topology, so ANY contact is a geometric
  // finding. Only the KIND is still open.
  if (interior_involved) return SI_PROPER_CROSSING;

  // POINT OR SEGMENT, decided by how many distinct symbolic contacts came back.
  // A single 0-dimensional contact is a point. TWO of them are the endpoints of
  // a shared segment — Geogram reports a coincident edge as its two vertex
  // correspondences rather than as one edge region, so reading `region_dim`
  // alone would call a full edge overlap a point touch.
  if (max_dim >= 1 || isects.size() >= 2) return SI_NON_ADJACENT_EDGE_TOUCH;
  return SI_NON_ADJACENT_POINT_TOUCH;
}

/**
 * Runs the read-only diagnostic over a disposable Geogram mesh.
 *
 * `mesh` is a WORKING COPY the caller owns and throws away. Nothing in here
 * writes to it, and the caller proves that separately by hashing the ORIGINAL
 * buffers before and after — an immutability claim resting on a `const`
 * qualifier alone is a claim about a type, not about behaviour.
 */
inline void run_self_intersection(
    const GEO::Mesh& mesh,
    const std::vector<double>& pos,
    const std::vector<uint32_t>& tris,
    const SiLimits& limits,
    SiReport& out,
    const SiOptions& options = SiOptions()
) {
  const uint32_t face_count = static_cast<uint32_t>(tris.size() / 3);

  // Degeneracy is decided once per face, not once per pair: it is a property of
  // the face, and re-deciding it per pair would be quadratic work for an answer
  // that cannot change.
  using Clock = std::chrono::steady_clock;
  auto ms_since = [](Clock::time_point t) {
    return std::chrono::duration<double, std::milli>(Clock::now() - t).count();
  };

  auto t_deg = Clock::now();
  // Throw rather than abort, explicitly. The default happens to be THROW, but a
  // diagnostic that survives malformed input only by accident is not a design.
  GEO::set_assert_mode(GEO::ASSERT_THROW);

  std::vector<uint8_t> degenerate(face_count, 0);
  for (uint32_t f = 0; f < face_count; ++f) {
    if (is_degenerate_face(pos, &tris[3 * f])) {
      degenerate[f] = 1;
      ++out.skipped_degenerate_face_count;
    }
  }

  out.degeneracy_ms = ms_since(t_deg);
  std::vector<uint8_t> affected(face_count, 0);

  // READ-ONLY BROADPHASE. The const constructor selects AABB_INDIRECT, which
  // stores its ordering in a side vector instead of permuting the mesh.
  auto t_aabb = Clock::now();
  SiBvh bvh;
  if (options.abortable_broadphase) {
    bvh.build(pos, tris);
  }
  // Geogram's tree is built either way when it is the selected broadphase.
  GEO::MeshFacetsAABB aabb(mesh);
  out.aabb_ms = ms_since(t_aabb);
  out.used_abortable_broadphase = options.abortable_broadphase;

  auto t_scan = Clock::now();
  bool limit_hit = false;
  Clock::time_point cap_reached_at;

  /*
   * SAMPLES ARE A PROPERTY OF THE MESH, NOT OF THE TREE.
   *
   * Stage 3C-1A kept the first N pairs in TRAVERSAL order, which quietly made
   * the reported samples depend on which broadphase produced them: swapping
   * Geogram's AABB for the abortable tree changed the sample list for R16 and
   * R17 while every aggregate count stayed identical. A user-visible field that
   * moves when an internal data structure is replaced is not reproducible.
   *
   * The bounded set is therefore the N lexicographically smallest (f1, f2)
   * pairs, kept in a bounded max-heap and sorted at the end. Any correct
   * broadphase — in any order, on any machine — now yields the same samples,
   * and the cap still bounds memory rather than the counts.
   */
  std::vector<std::array<uint32_t, 3>> heap;
  heap.reserve(limits.max_samples);
  const auto worse = [](const std::array<uint32_t, 3>& a,
                        const std::array<uint32_t, 3>& b) {
    return a[0] != b[0] ? a[0] < b[0] : a[1] < b[1];
  };
  auto record_sample = [&](uint32_t f1, uint32_t f2, uint32_t category) {
    const std::array<uint32_t, 3> entry{f1, f2, category};
    if (heap.size() < limits.max_samples) {
      heap.push_back(entry);
      std::push_heap(heap.begin(), heap.end(), worse);
      return;
    }
    out.samples_truncated = true;
    if (worse(entry, heap.front())) {
      std::pop_heap(heap.begin(), heap.end(), worse);
      heap.back() = entry;
      std::push_heap(heap.begin(), heap.end(), worse);
    }
  };

  // STREAMING. `compute_facet_bbox_intersections` invokes this callback per
  // overlapping pair on the serial path; it does NOT hand back an accumulated
  // vector of every pair. That is what keeps memory bounded on a mesh whose
  // boxes all overlap. See mesh_AABB.h:525.
  /*
   * ONE CLASSIFIER, TWO BROADPHASES. The body below is identical whichever tree
   * produced the pair, so a candidate-set difference cannot hide behind a
   * behavioural difference. It returns false to request a STOP; Geogram's
   * callback signature discards that answer, which is the whole defect.
   */
  auto handle_pair = [&](uint32_t a, uint32_t b) -> bool {
        if (a == b) return true;
        const uint32_t f1 = static_cast<uint32_t>(std::min(a, b));
        const uint32_t f2 = static_cast<uint32_t>(std::max(a, b));

        ++out.candidate_pair_count;
        if (limit_hit) {
          // Only reachable on the NON-abortable path: Geogram keeps calling.
          ++out.callbacks_after_cap;
          return false;
        }
        if (out.candidate_pair_count > limits.max_candidate_pairs ||
            out.tested_pair_count >= limits.max_tested_pairs) {
          limit_hit = true;
          cap_reached_at = Clock::now();
          return false;
        }

        // A pair containing a face the narrowphase cannot accept is not tested,
        // and is counted as skipped so the report can say so.
        if (degenerate[f1] || degenerate[f2]) {
          ++out.skipped_pair_count;
          ++out.funnel_degenerate;
          return true;
        }

        const uint32_t* t1 = &tris[3 * f1];
        const uint32_t* t2 = &tris[3 * f2];

        /*
         * THE DUPLICATE GUARD, AND IT IS LOAD-BEARING.
         *
         * `GEO::TriangleIsects` is a FIXED 20-element stack buffer whose
         * push_back is `geo_assert(size_ < capacity_)` — an always-on assertion,
         * not a debug one (triangle_intersection.h:151,185). Two identical
         * triangles generate more transient symbolic vertices than that and
         * ABORT the process; under Emscripten that kills the module outright.
         *
         * A pair sharing all three topological vertices IS the same triangle, so
         * its classification is already decided by topology and the narrowphase
         * has nothing to add. Returning before the call is therefore both the
         * correct classification and the thing that keeps the kernel alive.
         */
        const int shared_now = shared_vertex_count(t1, t2);
        if (shared_now == 3) {
          ++out.tested_pair_count;
          ++out.funnel_duplicate;
          ++out.duplicate_topology_defect;
          record_sample(f1, f2, static_cast<uint32_t>(SI_DUPLICATE_TOPOLOGY_DEFECT));
          return true;
        }

        if (shared_now == 2) ++out.funnel_shared_edge;
        else if (shared_now == 1) ++out.funnel_shared_vertex;
        else ++out.funnel_disjoint;

        /*
         * PREFILTER 1 — non-coplanar shared edge. Proven above to be exactly
         * the shared edge and nothing more, so it is classified without the
         * generic routine. Coplanar neighbours are deliberately excluded and
         * still take the full path.
         */
        if (options.fast_shared_edge && shared_now == 2 &&
            provably_legitimate_shared_edge(pos, t1, t2)) {
          ++out.tested_pair_count;
          ++out.legitimate_shared;
          return true;
        }

        /*
         * PREFILTER 2 — exact half-space arguments.
         *
         * Applied to SHARED-VERTEX pairs, which the funnel showed to be the
         * single largest category on any conforming surface (53% at a million
         * faces). For topologically disjoint pairs the plain separation test is
         * deliberately NOT run: the funnel measured it firing zero times, since
         * the AABB broadphase has already discarded everything far enough apart
         * for it to succeed, and an prefilter that never fires is pure cost.
         */
        if (options.plane_prefilter && shared_now == 1 &&
            provably_legitimate_shared_vertex(pos, t1, t2)) {
          ++out.tested_pair_count;
          ++out.legitimate_shared;
          ++out.funnel_plane_separated;
          return true;
        }

        ++out.funnel_narrowphase;
        const GEO::vec3 p0(pos[3*t1[0]], pos[3*t1[0]+1], pos[3*t1[0]+2]);
        const GEO::vec3 p1(pos[3*t1[1]], pos[3*t1[1]+1], pos[3*t1[1]+2]);
        const GEO::vec3 p2(pos[3*t1[2]], pos[3*t1[2]+1], pos[3*t1[2]+2]);
        const GEO::vec3 q0(pos[3*t2[0]], pos[3*t2[0]+1], pos[3*t2[0]+2]);
        const GEO::vec3 q1(pos[3*t2[1]], pos[3*t2[1]+1], pos[3*t2[1]+2]);
        const GEO::vec3 q2(pos[3*t2[2]], pos[3*t2[2]+1], pos[3*t2[2]+2]);

        GEO::TriangleIsects isects;
        bool non_degenerate = false;
        /*
         * THE CAPACITY GUARD. `geo_assertion_failed` THROWS under
         * ASSERT_THROW (assert.cpp:109), which is set explicitly below rather
         * than assumed — the other modes call abort() and would take the whole
         * worker down. Catching here turns a fixed-buffer overflow into ONE
         * unclassified pair plus a PARTIAL verdict, instead of a dead module and
         * a lost diagnosis.
         */
        try {
          // The INDEXED overload. Passing global vertex indices is what lets
          // Geogram reason symbolically about vertices the two faces genuinely
          // share, instead of rediscovering coincidence from coordinates.
          non_degenerate = GEO::triangles_intersections(
              p0, p1, p2, q0, q1, q2,
              t1[0], t1[1], t1[2], t2[0], t2[1], t2[2],
              isects
          );
        } catch (...) {
          ++out.narrowphase_refusals;
          ++out.tested_pair_count;
          return true;
        }
        ++out.tested_pair_count;

        const int category = classify_pair(pos, t1, t2, isects, non_degenerate);

        switch (category) {
          case SI_PROPER_CROSSING: ++out.proper_crossing; break;
          case SI_COPLANAR_OVERLAP: ++out.coplanar_overlap; break;
          case SI_NON_ADJACENT_POINT_TOUCH: ++out.non_adjacent_point_touch; break;
          case SI_NON_ADJACENT_EDGE_TOUCH: ++out.non_adjacent_edge_touch; break;
          case SI_ADJACENT_OVERLAP_BEYOND_SHARED: ++out.adjacent_overlap_beyond_shared; break;
          case SI_DUPLICATE_TOPOLOGY_DEFECT: ++out.duplicate_topology_defect; break;
          case SI_LEGITIMATE_SHARED: ++out.legitimate_shared; return true;
          default: return true;  // SI_NONE
        }

        // Duplicates are a Stage 2 defect reported here for completeness; they
        // are deliberately NOT counted as self-intersections.
        if (category != SI_DUPLICATE_TOPOLOGY_DEFECT) {
          ++out.intersecting_pair_count;
          affected[f1] = 1;
          affected[f2] = 1;
        }

        record_sample(f1, f2, static_cast<uint32_t>(category));
        return true;
  };

  if (options.abortable_broadphase) {
    // The stop request is HONOURED: the traversal unwinds at the next node.
    bvh.for_each_overlapping_pair(
        [&](uint32_t a, uint32_t b) { return handle_pair(a, b); });
  } else {
    // Geogram's callback returns void, so the stop request is DISCARDED and the
    // tree walk continues to completion. `callbacks_after_cap` measures exactly
    // how much work that wastes.
    aabb.compute_facet_bbox_intersections(
        [&](GEO::index_t a, GEO::index_t b) {
          (void)handle_pair(static_cast<uint32_t>(a), static_cast<uint32_t>(b));
        });
  }

  std::sort(heap.begin(), heap.end(),
            [](const std::array<uint32_t, 3>& a, const std::array<uint32_t, 3>& b) {
              return a[0] != b[0] ? a[0] < b[0] : a[1] < b[1];
            });
  out.sample_pair_count = heap.size();
  out.samples.clear();
  out.samples.reserve(heap.size() * 3);
  for (const auto& e : heap) {
    out.samples.push_back(e[0]);
    out.samples.push_back(e[1]);
    out.samples.push_back(e[2]);
  }

  out.scan_ms = ms_since(t_scan);
  if (limit_hit) {
    out.wasted_after_cap_ms =
        std::chrono::duration<double, std::milli>(Clock::now() - cap_reached_at).count();
  }

  for (uint32_t f = 0; f < face_count; ++f) {
    if (affected[f]) ++out.affected_face_count;
  }

  // STATUS IS DECIDED LAST, and pessimistically. An aborted search must never
  // be reported as a completed one that happened to find nothing.
  if (limit_hit) {
    out.status = SI_STATUS_RESOURCE_LIMIT;
  } else if (out.skipped_degenerate_face_count > 0 || out.skipped_pair_count > 0 ||
             out.narrowphase_refusals > 0) {
    out.status = SI_STATUS_PARTIAL;
  } else {
    out.status = SI_STATUS_CHECKED;
  }
}

}  // namespace cadfixer
