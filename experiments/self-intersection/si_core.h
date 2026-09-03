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

#include <geogram/basic/common.h>
#include <geogram/basic/geometry.h>
#include <geogram/mesh/mesh.h>
#include <geogram/mesh/mesh_AABB.h>
#include <geogram/mesh/triangle_intersection.h>
#include <geogram/numerics/predicates.h>

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
    SiReport& out
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
  GEO::MeshFacetsAABB aabb(mesh);
  out.aabb_ms = ms_since(t_aabb);

  auto t_scan = Clock::now();
  bool limit_hit = false;

  // STREAMING. `compute_facet_bbox_intersections` invokes this callback per
  // overlapping pair on the serial path; it does NOT hand back an accumulated
  // vector of every pair. That is what keeps memory bounded on a mesh whose
  // boxes all overlap. See mesh_AABB.h:525.
  aabb.compute_facet_bbox_intersections(
      [&](GEO::index_t a, GEO::index_t b) {
        if (a == b) return;
        const uint32_t f1 = static_cast<uint32_t>(std::min(a, b));
        const uint32_t f2 = static_cast<uint32_t>(std::max(a, b));

        ++out.candidate_pair_count;
        if (limit_hit) return;
        if (out.candidate_pair_count > limits.max_candidate_pairs ||
            out.tested_pair_count >= limits.max_tested_pairs) {
          limit_hit = true;
          return;
        }

        // A pair containing a face the narrowphase cannot accept is not tested,
        // and is counted as skipped so the report can say so.
        if (degenerate[f1] || degenerate[f2]) {
          ++out.skipped_pair_count;
          return;
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
        if (shared_vertex_count(t1, t2) == 3) {
          ++out.tested_pair_count;
          ++out.duplicate_topology_defect;
          if (out.sample_pair_count < limits.max_samples) {
            out.samples.push_back(f1);
            out.samples.push_back(f2);
            out.samples.push_back(static_cast<uint32_t>(SI_DUPLICATE_TOPOLOGY_DEFECT));
            ++out.sample_pair_count;
          } else {
            out.samples_truncated = true;
          }
          return;
        }

        const GEO::vec3 p0(pos[3*t1[0]], pos[3*t1[0]+1], pos[3*t1[0]+2]);
        const GEO::vec3 p1(pos[3*t1[1]], pos[3*t1[1]+1], pos[3*t1[1]+2]);
        const GEO::vec3 p2(pos[3*t1[2]], pos[3*t1[2]+1], pos[3*t1[2]+2]);
        const GEO::vec3 q0(pos[3*t2[0]], pos[3*t2[0]+1], pos[3*t2[0]+2]);
        const GEO::vec3 q1(pos[3*t2[1]], pos[3*t2[1]+1], pos[3*t2[1]+2]);
        const GEO::vec3 q2(pos[3*t2[2]], pos[3*t2[2]+1], pos[3*t2[2]+2]);

        GEO::TriangleIsects isects;
        // The INDEXED overload. Passing global vertex indices is what lets
        // Geogram reason symbolically about vertices the two faces genuinely
        // share, instead of rediscovering coincidence from coordinates.
        const bool non_degenerate = GEO::triangles_intersections(
            p0, p1, p2, q0, q1, q2,
            t1[0], t1[1], t1[2], t2[0], t2[1], t2[2],
            isects
        );
        ++out.tested_pair_count;

        const int category = classify_pair(pos, t1, t2, isects, non_degenerate);

        switch (category) {
          case SI_PROPER_CROSSING: ++out.proper_crossing; break;
          case SI_COPLANAR_OVERLAP: ++out.coplanar_overlap; break;
          case SI_NON_ADJACENT_POINT_TOUCH: ++out.non_adjacent_point_touch; break;
          case SI_NON_ADJACENT_EDGE_TOUCH: ++out.non_adjacent_edge_touch; break;
          case SI_ADJACENT_OVERLAP_BEYOND_SHARED: ++out.adjacent_overlap_beyond_shared; break;
          case SI_DUPLICATE_TOPOLOGY_DEFECT: ++out.duplicate_topology_defect; break;
          case SI_LEGITIMATE_SHARED: ++out.legitimate_shared; return;
          default: return;  // SI_NONE
        }

        // Duplicates are a Stage 2 defect reported here for completeness; they
        // are deliberately NOT counted as self-intersections.
        if (category != SI_DUPLICATE_TOPOLOGY_DEFECT) {
          ++out.intersecting_pair_count;
          affected[f1] = 1;
          affected[f2] = 1;
        }

        // BOUNDED SAMPLES, first-N in deterministic traversal order. The cap
        // bounds MEMORY only: the aggregate counts above keep rising after it,
        // so "truncated samples" never becomes "fewer intersections".
        if (out.sample_pair_count < limits.max_samples) {
          out.samples.push_back(f1);
          out.samples.push_back(f2);
          out.samples.push_back(static_cast<uint32_t>(category));
          ++out.sample_pair_count;
        } else {
          out.samples_truncated = true;
        }
      }
  );

  out.scan_ms = ms_since(t_scan);

  for (uint32_t f = 0; f < face_count; ++f) {
    if (affected[f]) ++out.affected_face_count;
  }

  // STATUS IS DECIDED LAST, and pessimistically. An aborted search must never
  // be reported as a completed one that happened to find nothing.
  if (limit_hit) {
    out.status = SI_STATUS_RESOURCE_LIMIT;
  } else if (out.skipped_degenerate_face_count > 0 || out.skipped_pair_count > 0) {
    out.status = SI_STATUS_PARTIAL;
  } else {
    out.status = SI_STATUS_CHECKED;
  }
}

}  // namespace cadfixer
