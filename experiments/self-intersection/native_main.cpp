// CAD Fixer Stage 3C-1A — native harness for the read-only self-intersection
// diagnostic. RESEARCH ONLY.
//
// Reads a fixture as JSON-ish on stdin (positions, triangles), runs the
// diagnostic, and prints one JSON object. The harness also performs the
// IMMUTABILITY CHECK: it hashes the input buffers before and after and reports
// both, so the caller can assert byte-identity rather than trust a const.

#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#include <iostream>
#include <sstream>

#include <geogram/basic/common.h>
#include <geogram/basic/command_line.h>
#include <geogram/basic/command_line_args.h>
#include <geogram/basic/logger.h>

#include "si_core.h"

namespace {

/** FNV-1a over raw bytes. Only used to detect change, never for security. */
uint64_t hash_bytes(const void* data, size_t len) {
  const uint8_t* p = static_cast<const uint8_t*>(data);
  uint64_t h = 1469598103934665603ull;
  for (size_t i = 0; i < len; ++i) {
    h ^= p[i];
    h *= 1099511628211ull;
  }
  return h;
}

std::vector<double> read_doubles(std::istream& in, size_t n) {
  std::vector<double> v(n);
  for (size_t i = 0; i < n; ++i) in >> v[i];
  return v;
}

std::vector<uint32_t> read_uints(std::istream& in, size_t n) {
  std::vector<uint32_t> v(n);
  for (size_t i = 0; i < n; ++i) in >> v[i];
  return v;
}

}  // namespace

int main(int argc, char** argv) {
  GEO::initialize();
  GEO::CmdLine::import_arg_group("standard");
  GEO::CmdLine::import_arg_group("algo");
  GEO::CmdLine::import_arg_group("sys");
  GEO::Logger::instance()->set_quiet(true);

  cadfixer::SiLimits limits;
  cadfixer::SiOptions options;
  for (int i = 1; i < argc; ++i) {
    if (std::strcmp(argv[i], "--fast") == 0) {
      options.fast_shared_edge = true;
      options.plane_prefilter = true;
    } else if (std::strcmp(argv[i], "--fast-shared-edge") == 0) {
      options.fast_shared_edge = true;
    } else if (std::strcmp(argv[i], "--plane-prefilter") == 0) {
      options.plane_prefilter = true;
    } else if (std::strcmp(argv[i], "--abortable") == 0) {
      options.abortable_broadphase = true;
    } else if (std::strcmp(argv[i], "--geogram-broadphase") == 0) {
      options.abortable_broadphase = false;
    }
    if (std::strncmp(argv[i], "--max-tested=", 13) == 0) {
      limits.max_tested_pairs = std::strtoull(argv[i] + 13, nullptr, 10);
    } else if (std::strncmp(argv[i], "--max-candidates=", 17) == 0) {
      limits.max_candidate_pairs = std::strtoull(argv[i] + 17, nullptr, 10);
    } else if (std::strncmp(argv[i], "--max-samples=", 14) == 0) {
      limits.max_samples = static_cast<uint32_t>(std::strtoul(argv[i] + 14, nullptr, 10));
    }
  }

  size_t vertex_count = 0, face_count = 0;
  std::cin >> vertex_count >> face_count;
  std::vector<double> pos = read_doubles(std::cin, vertex_count * 3);
  std::vector<uint32_t> tris = read_uints(std::cin, face_count * 3);

  const uint64_t pos_hash_before = hash_bytes(pos.data(), pos.size() * sizeof(double));
  const uint64_t tri_hash_before = hash_bytes(tris.data(), tris.size() * sizeof(uint32_t));

  /*
   * LITERAL BYTES, KEPT. A hash proves difference, not identity: two distinct
   * buffers can collide, and a 64-bit FNV is not a proof of equality. Stage
   * 3C-1A reported "byte-for-byte" on hashes alone, which overstated what was
   * actually shown. These copies allow a real memcmp afterwards.
   */
  const std::vector<double> pos_copy = pos;
  const std::vector<uint32_t> tri_copy = tris;
  const size_t pos_bytes_before = pos.size() * sizeof(double);
  const size_t tri_bytes_before = tris.size() * sizeof(uint32_t);
  const size_t vertex_count_before = vertex_count;
  const size_t face_count_before = face_count;

  // THE DISPOSABLE WORKING COPY. Geogram gets its own mesh built from the
  // caller's values; the caller's buffers are never handed to the kernel.
  GEO::Mesh mesh;
  mesh.vertices.set_dimension(3);
  mesh.vertices.create_vertices(static_cast<GEO::index_t>(vertex_count));
  for (size_t v = 0; v < vertex_count; ++v) {
    double* p = mesh.vertices.point_ptr(static_cast<GEO::index_t>(v));
    p[0] = pos[3 * v];
    p[1] = pos[3 * v + 1];
    p[2] = pos[3 * v + 2];
  }
  mesh.facets.create_triangles(static_cast<GEO::index_t>(face_count));
  for (size_t f = 0; f < face_count; ++f) {
    for (int c = 0; c < 3; ++c) {
      mesh.facets.set_vertex(
          static_cast<GEO::index_t>(f), static_cast<GEO::index_t>(c),
          static_cast<GEO::index_t>(tris[3 * f + c]));
    }
  }

  cadfixer::SiReport report;
  int failed = 0;
  try {
    cadfixer::run_self_intersection(mesh, pos, tris, limits, report, options);
  } catch (const std::exception& e) {
    failed = 1;
    report.status = cadfixer::SI_STATUS_INTERNAL_FAILURE;
    std::fprintf(stderr, "EXCEPTION: %s\n", e.what());
  } catch (...) {
    failed = 1;
    report.status = cadfixer::SI_STATUS_INTERNAL_FAILURE;
    std::fprintf(stderr, "EXCEPTION: unknown\n");
  }

  const uint64_t pos_hash_after = hash_bytes(pos.data(), pos.size() * sizeof(double));
  const uint64_t tri_hash_after = hash_bytes(tris.data(), tris.size() * sizeof(uint32_t));

  // Byte length, then every byte, then the counts derived from them.
  const bool pos_len_same = (pos.size() * sizeof(double)) == pos_bytes_before;
  const bool tri_len_same = (tris.size() * sizeof(uint32_t)) == tri_bytes_before;
  const bool pos_bytes_same =
      pos_len_same &&
      std::memcmp(pos.data(), pos_copy.data(), pos_bytes_before) == 0;
  const bool tri_bytes_same =
      tri_len_same &&
      std::memcmp(tris.data(), tri_copy.data(), tri_bytes_before) == 0;
  const bool counts_same =
      vertex_count == vertex_count_before && face_count == face_count_before;

  // The number of differing bytes, so the report can state zero rather than
  // merely assert equality.
  size_t differing = 0;
  if (pos_len_same) {
    const uint8_t* a = reinterpret_cast<const uint8_t*>(pos.data());
    const uint8_t* b = reinterpret_cast<const uint8_t*>(pos_copy.data());
    for (size_t i = 0; i < pos_bytes_before; ++i) if (a[i] != b[i]) ++differing;
  }
  if (tri_len_same) {
    const uint8_t* a = reinterpret_cast<const uint8_t*>(tris.data());
    const uint8_t* b = reinterpret_cast<const uint8_t*>(tri_copy.data());
    for (size_t i = 0; i < tri_bytes_before; ++i) if (a[i] != b[i]) ++differing;
  }

  std::ostringstream samples;
  samples << "[";
  for (size_t i = 0; i < report.samples.size(); ++i) {
    if (i) samples << ",";
    samples << report.samples[i];
  }
  samples << "]";

  std::printf(
      "{\"status\":%d,\"candidatePairCount\":%llu,\"testedPairCount\":%llu,"
      "\"intersectingPairCount\":%llu,\"affectedFaceCount\":%u,"
      "\"properCrossing\":%llu,\"coplanarOverlap\":%llu,"
      "\"nonAdjacentPointTouch\":%llu,\"nonAdjacentEdgeTouch\":%llu,"
      "\"adjacentOverlapBeyondShared\":%llu,\"duplicateTopologyDefect\":%llu,"
      "\"legitimateShared\":%llu,\"skippedDegenerateFaceCount\":%u,"
      "\"skippedPairCount\":%llu,\"samplePairCount\":%llu,"
      "\"samplesTruncated\":%s,\"samples\":%s,"
      "\"degeneracyMs\":%.3f,\"aabbMs\":%.3f,\"scanMs\":%.3f,"
      "\"funnelDuplicate\":%llu,\"funnelDegenerate\":%llu,\"funnelSharedEdge\":%llu,"
      "\"funnelSharedVertex\":%llu,\"funnelDisjoint\":%llu,\"funnelPlaneSeparated\":%llu,"
      "\"funnelNarrowphase\":%llu,\"callbacksAfterCap\":%llu,\"wastedAfterCapMs\":%.3f,"
      "\"abortableBroadphase\":%s,\"narrowphaseRefusals\":%llu,"
      "\"bytesDiffering\":%zu,\"lengthsUnchanged\":%s,"
      "\"bytesIdentical\":%s,\"countsUnchanged\":%s,"
      "\"positionsUnchanged\":%s,\"indicesUnchanged\":%s,\"failed\":%d}\n",
      report.status,
      (unsigned long long)report.candidate_pair_count,
      (unsigned long long)report.tested_pair_count,
      (unsigned long long)report.intersecting_pair_count,
      report.affected_face_count,
      (unsigned long long)report.proper_crossing,
      (unsigned long long)report.coplanar_overlap,
      (unsigned long long)report.non_adjacent_point_touch,
      (unsigned long long)report.non_adjacent_edge_touch,
      (unsigned long long)report.adjacent_overlap_beyond_shared,
      (unsigned long long)report.duplicate_topology_defect,
      (unsigned long long)report.legitimate_shared,
      report.skipped_degenerate_face_count,
      (unsigned long long)report.skipped_pair_count,
      (unsigned long long)report.sample_pair_count,
      report.samples_truncated ? "true" : "false",
      samples.str().c_str(),
      report.degeneracy_ms, report.aabb_ms, report.scan_ms,
      (unsigned long long)report.funnel_duplicate,
      (unsigned long long)report.funnel_degenerate,
      (unsigned long long)report.funnel_shared_edge,
      (unsigned long long)report.funnel_shared_vertex,
      (unsigned long long)report.funnel_disjoint,
      (unsigned long long)report.funnel_plane_separated,
      (unsigned long long)report.funnel_narrowphase,
      (unsigned long long)report.callbacks_after_cap,
      report.wasted_after_cap_ms,
      report.used_abortable_broadphase ? "true" : "false",
      (unsigned long long)report.narrowphase_refusals,
      differing,
      (pos_len_same && tri_len_same) ? "true" : "false",
      (pos_bytes_same && tri_bytes_same) ? "true" : "false",
      counts_same ? "true" : "false",
      (pos_hash_before == pos_hash_after) ? "true" : "false",
      (tri_hash_before == tri_hash_after) ? "true" : "false",
      failed);
  return 0;
}
