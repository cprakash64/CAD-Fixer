// CAD Fixer — PRODUCTION WASM binding for the read-only self-intersection
// diagnostic.
//
// Promoted unchanged in algorithm from the Stage 3C-1A-R1 qualification; the
// classifier, broadphase and capacity guard in si_core.h / si_bvh.h are the
// files that qualification exercised. What is production-specific is here: the
// flat C ABI, the input validation, and the refusal to expose the research
// prefilters that were measured and rejected.
//
// THIS RUNS ONLY INSIDE THE DISPOSABLE DIAGNOSTIC WORKER. It is never reachable
// from the main-thread bundle, and the production boundary scan asserts that.
//
// The C ABI is deliberately flat: the caller writes positions and triangles
// into the WASM heap, calls run, then reads scalar results back. No geometry is
// ever returned, because a DIAGNOSTIC has no business handing back a mesh.

#include <cstdint>
#include <cstring>
#include <vector>
#include <exception>
#include <cmath>

#include <emscripten/emscripten.h>

#include <geogram/basic/common.h>
#include <geogram/basic/command_line.h>
#include <geogram/basic/command_line_args.h>
#include <geogram/basic/logger.h>

#include "si_core.h"

namespace {
cadfixer::SiReport g_report;
int g_initialised = 0;
int g_failed = 0;
uint32_t g_face_count = 0;

void ensure_init() {
  if (g_initialised) return;
  GEO::initialize();
  GEO::CmdLine::import_arg_group("standard");
  GEO::CmdLine::import_arg_group("algo");
  GEO::CmdLine::import_arg_group("sys");
  GEO::Logger::instance()->set_quiet(true);
  g_initialised = 1;
}
}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
int cf_si_run(
    const double* positions, uint32_t vertex_count,
    const uint32_t* triangles, uint32_t face_count,
    double max_candidate_pairs, double max_tested_pairs, uint32_t max_samples
) {
  ensure_init();
  g_report = cadfixer::SiReport();
  g_failed = 0;

  /*
   * BOUNDARY VALIDATION, even though the producer is our own worker.
   *
   * Defence in depth: everything below indexes raw WASM memory, so a malformed
   * count or an out-of-range index is not a wrong answer, it is an out-of-bounds
   * read. The caller is internal today; it is still validated, because "the
   * caller is trusted" is an assumption that outlives the code that made it.
   */
  if (positions == nullptr || triangles == nullptr) {
    g_failed = 1;
    g_report.status = cadfixer::SI_STATUS_INTERNAL_FAILURE;
    return g_report.status;
  }
  // A face needs three vertices; an empty mesh is legal and trivially checked.
  if (face_count > 0 && vertex_count < 3) {
    g_failed = 1;
    g_report.status = cadfixer::SI_STATUS_INTERNAL_FAILURE;
    return g_report.status;
  }

  std::vector<double> pos(positions, positions + static_cast<size_t>(vertex_count) * 3);
  std::vector<uint32_t> tris(triangles, triangles + static_cast<size_t>(face_count) * 3);

  // Every index must address a real vertex. An index past the end would make
  // the classifier read outside the position array.
  for (const uint32_t v : tris) {
    if (v >= vertex_count) {
      g_failed = 1;
      g_report.status = cadfixer::SI_STATUS_INTERNAL_FAILURE;
      return g_report.status;
    }
  }
  // Non-finite coordinates have no exact predicates and no meaningful boxes.
  for (const double c : pos) {
    if (!std::isfinite(c)) {
      g_failed = 1;
      g_report.status = cadfixer::SI_STATUS_INTERNAL_FAILURE;
      return g_report.status;
    }
  }

  g_face_count = face_count;
  cadfixer::SiLimits limits;
  limits.max_candidate_pairs = static_cast<uint64_t>(max_candidate_pairs);
  limits.max_tested_pairs = static_cast<uint64_t>(max_tested_pairs);
  limits.max_samples = max_samples;

  // THE DISPOSABLE WORKING MESH. Built inside the diagnostic worker from copied
  // values; the authoritative buffers never cross this boundary.
  try {
    GEO::Mesh mesh;
    mesh.vertices.set_dimension(3);
    mesh.vertices.create_vertices(vertex_count);
    for (uint32_t v = 0; v < vertex_count; ++v) {
      double* p = mesh.vertices.point_ptr(v);
      p[0] = pos[3 * v]; p[1] = pos[3 * v + 1]; p[2] = pos[3 * v + 2];
    }
    mesh.facets.create_triangles(face_count);
    for (uint32_t f = 0; f < face_count; ++f) {
      for (uint32_t c = 0; c < 3; ++c) {
        mesh.facets.set_vertex(f, c, tris[3 * f + c]);
      }
    }
    cadfixer::run_self_intersection(mesh, pos, tris, limits, g_report);
  } catch (...) {
    g_failed = 1;
    g_report.status = cadfixer::SI_STATUS_INTERNAL_FAILURE;
  }
  return g_report.status;
}

EMSCRIPTEN_KEEPALIVE int cf_si_failed() { return g_failed; }
EMSCRIPTEN_KEEPALIVE double cf_si_candidate_pairs() { return (double)g_report.candidate_pair_count; }
EMSCRIPTEN_KEEPALIVE double cf_si_tested_pairs() { return (double)g_report.tested_pair_count; }
EMSCRIPTEN_KEEPALIVE double cf_si_intersecting_pairs() { return (double)g_report.intersecting_pair_count; }
EMSCRIPTEN_KEEPALIVE uint32_t cf_si_affected_faces() { return g_report.affected_face_count; }
EMSCRIPTEN_KEEPALIVE double cf_si_proper_crossing() { return (double)g_report.proper_crossing; }
EMSCRIPTEN_KEEPALIVE double cf_si_coplanar_overlap() { return (double)g_report.coplanar_overlap; }
EMSCRIPTEN_KEEPALIVE double cf_si_point_touch() { return (double)g_report.non_adjacent_point_touch; }
EMSCRIPTEN_KEEPALIVE double cf_si_edge_touch() { return (double)g_report.non_adjacent_edge_touch; }
EMSCRIPTEN_KEEPALIVE double cf_si_adjacent_beyond() { return (double)g_report.adjacent_overlap_beyond_shared; }
EMSCRIPTEN_KEEPALIVE double cf_si_duplicate() { return (double)g_report.duplicate_topology_defect; }
EMSCRIPTEN_KEEPALIVE double cf_si_legitimate() { return (double)g_report.legitimate_shared; }
EMSCRIPTEN_KEEPALIVE uint32_t cf_si_skipped_faces() { return g_report.skipped_degenerate_face_count; }
EMSCRIPTEN_KEEPALIVE double cf_si_skipped_pairs() { return (double)g_report.skipped_pair_count; }
EMSCRIPTEN_KEEPALIVE double cf_si_unclassified_pairs() { return (double)g_report.narrowphase_refusals; }
EMSCRIPTEN_KEEPALIVE uint32_t cf_si_face_count() { return (uint32_t)(g_report.candidate_pair_count > 0 || true ? g_face_count : 0); }
EMSCRIPTEN_KEEPALIVE double cf_si_sample_pairs() { return (double)g_report.sample_pair_count; }
EMSCRIPTEN_KEEPALIVE int cf_si_samples_truncated() { return g_report.samples_truncated ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE const uint32_t* cf_si_samples() { return g_report.samples.data(); }
EMSCRIPTEN_KEEPALIVE double cf_si_aabb_ms() { return g_report.aabb_ms; }
EMSCRIPTEN_KEEPALIVE double cf_si_scan_ms() { return g_report.scan_ms; }

}  // extern "C"

/* ===================================================================== */
/* PATCH-ATTRIBUTED PAIR CLASSIFICATION — Stage 4B-1B1.                  */
/* ===================================================================== */

/*
 * WHY THIS ENTRY POINT EXISTS, and why it is not a second detector.
 *
 * Hole filling asks a DIFFERENT question from the diagnostic above. The
 * diagnostic asks "does this whole mesh self-intersect", scans every pair its
 * own broadphase produces, and returns aggregate counts. Hole filling asks
 * "does any face THIS OPERATION MANUFACTURED participate in an invalid
 * intersection" — a question about at most a few hundred triangles, whose
 * answer must be attributed to the patch rather than blamed on a defect the
 * user's file already had.
 *
 * Those two questions cannot share one call. `cf_si_run` returns totals, and a
 * total cannot say which pair it came from; the samples it retains are capped
 * at 4,096 and truncate, so a patch crossing could be pushed out of the list by
 * pre-existing source crossings and read as clean. Attribution by subtracting
 * one run from another would be the same aggregate reasoning ADR 0018 rejects.
 *
 * SO THE SPLIT IS: CAD Fixer's TypeScript broadphase decides which PAIRS are
 * worth testing — it can query with a patch box, which `si_bvh.h` has no API
 * for — and this entry point classifies exactly those pairs with the SAME exact
 * predicates the qualified diagnostic uses.
 *
 * EVERYTHING SAFETY-CRITICAL IS THE QUALIFIED CODE, UNCHANGED:
 *   - `cadfixer::is_degenerate_face`   — the same exact-predicate degeneracy;
 *   - `cadfixer::shared_vertex_count`  — the same adjacency, from Stage 2's
 *                                        exact stored-coordinate identity;
 *   - `GEO::triangles_intersections`   — the same exact symbolic narrowphase,
 *                                        called with the same INDEXED overload;
 *   - `cadfixer::classify_pair`        — the same frozen taxonomy, so a
 *                                        legitimate shared edge, a coplanar
 *                                        overlap and a non-adjacent touch all
 *                                        mean here exactly what they mean there;
 *   - the same duplicate guard and the same capacity guard, for the same
 *     reasons: a three-shared-vertex pair overflows Geogram's fixed 20-element
 *     symbolic buffer, and an overflow must degrade to PARTIAL rather than kill
 *     the worker.
 *
 * `si_core.h` AND `si_bvh.h` ARE NOT TOUCHED. They stay byte-identical to
 * `experiments/self-intersection/`, which `kernel-integrity.test.ts` asserts, so
 * the Stage 3C evidence still describes what ships. `cf_si_run` is not modified
 * and does not observe any of the state below.
 *
 * THE PREFILTERS STAY OFF, exactly as `SiOptions` defaults them. They were
 * measured and rejected, and turning one on here would make this path classify
 * a pair differently from the diagnostic — which is precisely the divergence
 * this design exists to avoid.
 */

namespace {

struct PatchScan {
  std::vector<double> pos;
  std::vector<uint32_t> tris;
  std::vector<uint8_t> degenerate;
  uint32_t face_count = 0;
  uint32_t patch_face_start = 0;
  bool active = false;

  uint64_t tested_pairs = 0;
  uint64_t skipped_pairs = 0;
  uint64_t ignored_non_patch_pairs = 0;
  uint64_t narrowphase_refusals = 0;

  uint64_t invalid_patch_source = 0;
  uint64_t invalid_patch_patch = 0;

  uint64_t proper_crossing = 0;
  uint64_t coplanar_overlap = 0;
  uint64_t point_touch = 0;
  uint64_t edge_touch = 0;
  uint64_t adjacent_beyond = 0;
  uint64_t duplicate_defect = 0;
  uint64_t legitimate_shared = 0;

  std::vector<uint32_t> samples;
  uint64_t sample_pairs = 0;
  bool samples_truncated = false;
};

PatchScan g_patch;
int g_patch_failed = 0;
int g_patch_status = cadfixer::SI_STATUS_CHECKED;

/**
 * A category that means the patch is WRONG.
 *
 * `SI_NONE` and `SI_LEGITIMATE_SHARED` are the only acceptable outcomes. A
 * duplicate IS counted as invalid here, unlike in the whole-mesh diagnostic
 * where it is reported as a separate Stage 2 defect: a patch face that
 * duplicates an existing face is geometry this operation manufactured on top of
 * geometry that was already there, which is never something to accept.
 */
bool is_invalid_category(int category) {
  return category != cadfixer::SI_NONE && category != cadfixer::SI_LEGITIMATE_SHARED;
}

}  // namespace

extern "C" {

/**
 * Uploads the candidate geometry and prepares a patch-attributed scan.
 *
 * `patch_face_start` freezes provenance: faces `[0, patch_face_start)` are the
 * user's, `[patch_face_start, face_count)` are what this operation made. Every
 * attribution below reads it, so the boundary is stated once rather than
 * inferred per pair.
 */
EMSCRIPTEN_KEEPALIVE
int cf_hf_begin(
    const double* positions, uint32_t vertex_count,
    const uint32_t* triangles, uint32_t face_count,
    uint32_t patch_face_start
) {
  ensure_init();
  g_patch = PatchScan();
  g_patch_failed = 0;
  g_patch_status = cadfixer::SI_STATUS_CHECKED;

  // BOUNDARY VALIDATION, even though the producer is our own worker. Everything
  // below indexes raw WASM memory, so a malformed count is not a wrong answer,
  // it is an out-of-bounds read.
  if (positions == nullptr || triangles == nullptr ||
      patch_face_start > face_count ||
      (face_count > 0 && vertex_count < 3)) {
    g_patch_failed = 1;
    g_patch_status = cadfixer::SI_STATUS_INTERNAL_FAILURE;
    return g_patch_status;
  }

  try {
    g_patch.pos.assign(positions, positions + static_cast<size_t>(vertex_count) * 3);
    g_patch.tris.assign(triangles, triangles + static_cast<size_t>(face_count) * 3);
  } catch (...) {
    g_patch_failed = 1;
    g_patch_status = cadfixer::SI_STATUS_INTERNAL_FAILURE;
    return g_patch_status;
  }

  for (const uint32_t v : g_patch.tris) {
    if (v >= vertex_count) {
      g_patch_failed = 1;
      g_patch_status = cadfixer::SI_STATUS_INTERNAL_FAILURE;
      return g_patch_status;
    }
  }
  for (const double c : g_patch.pos) {
    if (!std::isfinite(c)) {
      g_patch_failed = 1;
      g_patch_status = cadfixer::SI_STATUS_INTERNAL_FAILURE;
      return g_patch_status;
    }
  }

  // Throw rather than abort, chosen explicitly rather than inherited: the other
  // assertion modes call abort() and would take the worker with them.
  GEO::set_assert_mode(GEO::ASSERT_THROW);

  // Degeneracy is a property of the FACE, decided once. Deciding it per pair
  // would be repeated work for an answer that cannot change.
  g_patch.degenerate.assign(face_count, 0);
  for (uint32_t f = 0; f < face_count; ++f) {
    if (cadfixer::is_degenerate_face(g_patch.pos, &g_patch.tris[3 * f])) {
      g_patch.degenerate[f] = 1;
    }
  }

  g_patch.face_count = face_count;
  g_patch.patch_face_start = patch_face_start;
  g_patch.active = true;
  return g_patch_status;
}

/**
 * Classifies one BATCH of caller-supplied face pairs.
 *
 * BATCHED ON PURPOSE. The broadphase streams candidates and must never
 * materialise the full product: a batch buffer of fixed size is uploaded,
 * classified and reused, so memory stays flat however many candidates a
 * pathological part produces. `pairs` holds `pair_count` flattened (f1, f2)
 * entries.
 *
 * A PAIR WITH NO PATCH FACE IS IGNORED AND COUNTED. The broadphase does not
 * produce one, and this is defence in depth rather than a code path: a
 * source/source crossing the user's file already had is not something this
 * operation did, and silently counting one would make a pre-existing defect
 * block a correct fill.
 */
EMSCRIPTEN_KEEPALIVE
int cf_hf_classify(const uint32_t* pairs, uint32_t pair_count, uint32_t max_samples) {
  if (!g_patch.active || pairs == nullptr) {
    g_patch_failed = 1;
    g_patch_status = cadfixer::SI_STATUS_INTERNAL_FAILURE;
    return g_patch_status;
  }

  try {
    for (uint32_t index = 0; index < pair_count; ++index) {
      uint32_t a = pairs[2 * index];
      uint32_t b = pairs[2 * index + 1];
      if (a >= g_patch.face_count || b >= g_patch.face_count || a == b) {
        g_patch_failed = 1;
        g_patch_status = cadfixer::SI_STATUS_INTERNAL_FAILURE;
        return g_patch_status;
      }
      const uint32_t f1 = a < b ? a : b;
      const uint32_t f2 = a < b ? b : a;

      const bool f1_patch = f1 >= g_patch.patch_face_start;
      const bool f2_patch = f2 >= g_patch.patch_face_start;
      if (!f1_patch && !f2_patch) {
        ++g_patch.ignored_non_patch_pairs;
        continue;
      }

      if (g_patch.degenerate[f1] || g_patch.degenerate[f2]) {
        ++g_patch.skipped_pairs;
        continue;
      }

      const uint32_t* t1 = &g_patch.tris[3 * f1];
      const uint32_t* t2 = &g_patch.tris[3 * f2];

      /*
       * THE DUPLICATE GUARD, load-bearing for the same reason it is in
       * `si_core.h`: two identical triangles generate more transient symbolic
       * vertices than Geogram's fixed 20-element buffer holds, and the assert
       * that fires is an always-on one. Classifying by topology before the call
       * is both the correct answer and what keeps the module alive.
       */
      const int shared = cadfixer::shared_vertex_count(t1, t2);
      if (shared == 3) {
        ++g_patch.tested_pairs;
        ++g_patch.duplicate_defect;
        if (f1_patch && f2_patch) ++g_patch.invalid_patch_patch;
        else ++g_patch.invalid_patch_source;
        if (g_patch.sample_pairs < max_samples) {
          g_patch.samples.push_back(f1);
          g_patch.samples.push_back(f2);
          g_patch.samples.push_back(
              static_cast<uint32_t>(cadfixer::SI_DUPLICATE_TOPOLOGY_DEFECT));
          ++g_patch.sample_pairs;
        } else {
          g_patch.samples_truncated = true;
        }
        continue;
      }

      const GEO::vec3 p0(g_patch.pos[3*t1[0]], g_patch.pos[3*t1[0]+1], g_patch.pos[3*t1[0]+2]);
      const GEO::vec3 p1(g_patch.pos[3*t1[1]], g_patch.pos[3*t1[1]+1], g_patch.pos[3*t1[1]+2]);
      const GEO::vec3 p2(g_patch.pos[3*t1[2]], g_patch.pos[3*t1[2]+1], g_patch.pos[3*t1[2]+2]);
      const GEO::vec3 q0(g_patch.pos[3*t2[0]], g_patch.pos[3*t2[0]+1], g_patch.pos[3*t2[0]+2]);
      const GEO::vec3 q1(g_patch.pos[3*t2[1]], g_patch.pos[3*t2[1]+1], g_patch.pos[3*t2[1]+2]);
      const GEO::vec3 q2(g_patch.pos[3*t2[2]], g_patch.pos[3*t2[2]+1], g_patch.pos[3*t2[2]+2]);

      GEO::TriangleIsects isects;
      bool non_degenerate = false;
      /*
       * THE CAPACITY GUARD. A fixed-buffer overflow becomes ONE unclassified
       * pair plus a PARTIAL verdict, never a dead module and a lost answer. A
       * pair that could not be examined must never be absorbed into a clean
       * result, so PARTIAL is what the caller sees.
       */
      try {
        non_degenerate = GEO::triangles_intersections(
            p0, p1, p2, q0, q1, q2,
            t1[0], t1[1], t1[2], t2[0], t2[1], t2[2],
            isects
        );
      } catch (...) {
        ++g_patch.narrowphase_refusals;
        ++g_patch.tested_pairs;
        continue;
      }
      ++g_patch.tested_pairs;

      const int category = cadfixer::classify_pair(g_patch.pos, t1, t2, isects, non_degenerate);

      switch (category) {
        case cadfixer::SI_PROPER_CROSSING: ++g_patch.proper_crossing; break;
        case cadfixer::SI_COPLANAR_OVERLAP: ++g_patch.coplanar_overlap; break;
        case cadfixer::SI_NON_ADJACENT_POINT_TOUCH: ++g_patch.point_touch; break;
        case cadfixer::SI_NON_ADJACENT_EDGE_TOUCH: ++g_patch.edge_touch; break;
        case cadfixer::SI_ADJACENT_OVERLAP_BEYOND_SHARED: ++g_patch.adjacent_beyond; break;
        case cadfixer::SI_DUPLICATE_TOPOLOGY_DEFECT: ++g_patch.duplicate_defect; break;
        case cadfixer::SI_LEGITIMATE_SHARED: ++g_patch.legitimate_shared; break;
        default: break;
      }

      if (!is_invalid_category(category)) continue;

      if (f1_patch && f2_patch) ++g_patch.invalid_patch_patch;
      else ++g_patch.invalid_patch_source;

      if (g_patch.sample_pairs < max_samples) {
        g_patch.samples.push_back(f1);
        g_patch.samples.push_back(f2);
        g_patch.samples.push_back(static_cast<uint32_t>(category));
        ++g_patch.sample_pairs;
      } else {
        g_patch.samples_truncated = true;
      }
    }
  } catch (...) {
    g_patch_failed = 1;
    g_patch_status = cadfixer::SI_STATUS_INTERNAL_FAILURE;
    return g_patch_status;
  }

  // STATUS IS DECIDED LAST, and a refusal is never absorbed into CHECKED.
  if (g_patch_failed == 0) {
    g_patch_status = g_patch.narrowphase_refusals > 0 ? cadfixer::SI_STATUS_PARTIAL
                                                     : cadfixer::SI_STATUS_CHECKED;
  }
  return g_patch_status;
}

/** Releases the uploaded geometry. The scan cannot be resumed afterwards. */
EMSCRIPTEN_KEEPALIVE void cf_hf_end() {
  g_patch = PatchScan();
}

EMSCRIPTEN_KEEPALIVE int cf_hf_failed() { return g_patch_failed; }
EMSCRIPTEN_KEEPALIVE int cf_hf_status() { return g_patch_status; }
EMSCRIPTEN_KEEPALIVE double cf_hf_tested_pairs() { return (double)g_patch.tested_pairs; }
EMSCRIPTEN_KEEPALIVE double cf_hf_skipped_pairs() { return (double)g_patch.skipped_pairs; }
EMSCRIPTEN_KEEPALIVE double cf_hf_ignored_pairs() { return (double)g_patch.ignored_non_patch_pairs; }
EMSCRIPTEN_KEEPALIVE double cf_hf_unclassified_pairs() { return (double)g_patch.narrowphase_refusals; }
EMSCRIPTEN_KEEPALIVE double cf_hf_invalid_patch_source() { return (double)g_patch.invalid_patch_source; }
EMSCRIPTEN_KEEPALIVE double cf_hf_invalid_patch_patch() { return (double)g_patch.invalid_patch_patch; }
EMSCRIPTEN_KEEPALIVE double cf_hf_proper_crossing() { return (double)g_patch.proper_crossing; }
EMSCRIPTEN_KEEPALIVE double cf_hf_coplanar_overlap() { return (double)g_patch.coplanar_overlap; }
EMSCRIPTEN_KEEPALIVE double cf_hf_point_touch() { return (double)g_patch.point_touch; }
EMSCRIPTEN_KEEPALIVE double cf_hf_edge_touch() { return (double)g_patch.edge_touch; }
EMSCRIPTEN_KEEPALIVE double cf_hf_adjacent_beyond() { return (double)g_patch.adjacent_beyond; }
EMSCRIPTEN_KEEPALIVE double cf_hf_duplicate() { return (double)g_patch.duplicate_defect; }
EMSCRIPTEN_KEEPALIVE double cf_hf_legitimate() { return (double)g_patch.legitimate_shared; }
EMSCRIPTEN_KEEPALIVE double cf_hf_sample_pairs() { return (double)g_patch.sample_pairs; }
EMSCRIPTEN_KEEPALIVE int cf_hf_samples_truncated() { return g_patch.samples_truncated ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE const uint32_t* cf_hf_samples() { return g_patch.samples.data(); }

}  // extern "C"
