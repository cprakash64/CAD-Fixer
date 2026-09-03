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
