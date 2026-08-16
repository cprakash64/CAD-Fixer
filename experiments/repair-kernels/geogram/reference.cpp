// CAD Fixer Stage 3A-3A — NATIVE Geogram reference program.
//
// RESEARCH ONLY. Never linked into the application, never shipped.
//
// WHY THIS EXISTS. Stage 3A-2 observed Geogram's colocate path aborting on a
// `variable_exists` assertion at one epsilon and failing to return at others,
// and could not say whether the cause was our binding, our initialisation,
// Emscripten, or Geogram itself. This program removes three of those four
// variables: it is built from the SAME pinned commit, runs the SAME operation
// on the SAME geometry, and differs from the WASM candidate only in the
// compiler target.
//
// THE DECISIVE CONTROL IS `initMode`. Mode 0 reproduces exactly what the
// Stage 3A-2 binding did (`GEO::initialize()` and nothing else). Mode 1 adds
// the two argument groups the pinned source shows the colocate path reads. One
// binary, one input, one operation — only the initialisation differs. That is
// what makes the attribution a measurement rather than an assertion.
//
// GEOMETRY IS READ, NEVER REGENERATED. The corpus lives in TypeScript. A C++
// reimplementation of a fixture would be a second source of truth and could
// diverge silently, so this program reads the identical transfer buffers the
// Node harness hands the WASM candidate.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <string>
#include <vector>

#include <geogram/basic/command_line.h>
#include <geogram/basic/command_line_args.h>
#include <geogram/basic/common.h>
#include <geogram/mesh/mesh.h>
#include <geogram/mesh/mesh_repair.h>
#include <geogram/mesh/mesh_surface_intersection.h>

namespace {

// Operation codes are identical to the WASM binding's CfGeogramOperation, so a
// native row and a WASM row naming operation 2 mean the same Geogram call.
constexpr int kRepairTopology = 0;
constexpr int kRepairDupFacets = 1;
constexpr int kRepairColocate = 2;
constexpr int kReorient = 3;
constexpr int kIntersectSurface = 4;

/**
 * Initialisation under test.
 *
 * Mode 0 — Stage 3A-2's sequence, preserved verbatim as the negative control.
 * Mode 1 — adds `algo` and `sys`, and ONLY those two. The pinned source shows
 *   why each is required, and neither is guesswork:
 *
 *     mesh_repair.cpp:1192   epsilon != 0 selects Geom::colocate()
 *     colocate.cpp:231       -> NearestNeighborSearch::create(dim, "default")
 *     nn_search.cpp:133      -> CmdLine::get_arg("algo:nn_search")   [group "algo"]
 *     colocate.cpp:238       -> CmdLine::get_arg_bool("sys:multithread") [group "sys"]
 *
 *   Upstream corroborates: src/tests/test_nn_search/main.cpp imports "algo"
 *   before touching the same factory.
 *
 * Importing "standard" would also work, but it pulls global/nl/log/biblio that
 * this operation demonstrably does not read. Narrow on purpose.
 */
void Initialise(int init_mode) {
  GEO::initialize();
  if (init_mode >= 1) {
    GEO::CmdLine::import_arg_group("algo");
    GEO::CmdLine::import_arg_group("sys");
  }
}

void LoadMesh(GEO::Mesh& mesh, const std::vector<double>& positions,
              const std::vector<uint32_t>& triangles) {
  const int vertex_count = static_cast<int>(positions.size() / 3);
  const int triangle_count = static_cast<int>(triangles.size() / 3);

  mesh.clear();
  mesh.vertices.set_dimension(3);
  mesh.vertices.create_vertices(vertex_count);
  for (int v = 0; v < vertex_count; ++v) {
    double* p = mesh.vertices.point_ptr(static_cast<GEO::index_t>(v));
    p[0] = positions[static_cast<size_t>(v) * 3];
    p[1] = positions[static_cast<size_t>(v) * 3 + 1];
    p[2] = positions[static_cast<size_t>(v) * 3 + 2];
  }
  mesh.facets.create_triangles(triangle_count);
  for (int f = 0; f < triangle_count; ++f) {
    for (int c = 0; c < 3; ++c) {
      mesh.facets.set_vertex(
          static_cast<GEO::index_t>(f), static_cast<GEO::index_t>(c),
          static_cast<GEO::index_t>(triangles[static_cast<size_t>(f) * 3 + static_cast<size_t>(c)]));
    }
  }
  mesh.facets.connect();
}

}  // namespace

/*
 * Input format, deliberately dependency-free: a JSON parser pulled in for one
 * research program would be another dependency to licence-audit for no gain.
 *
 *   line 1: <operation> <epsilon> <initMode> <vertexCount> <triangleCount>
 *   then vertexCount*3 doubles, then triangleCount*3 unsigned ints.
 *
 * Output is key=value lines on stdout, which the Node comparison harness
 * parses. A crash produces no `outcome=` line, and the harness treats a missing
 * outcome as ABORTED rather than inventing a result.
 */
int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: geogram-reference <input-file>\n");
    return 64;
  }

  std::FILE* in = std::fopen(argv[1], "r");
  if (in == nullptr) {
    std::fprintf(stderr, "cannot open %s\n", argv[1]);
    return 66;
  }

  int operation = 0;
  double epsilon = 0.0;
  int init_mode = 0;
  int vertex_count = 0;
  int triangle_count = 0;
  if (std::fscanf(in, "%d %lf %d %d %d", &operation, &epsilon, &init_mode, &vertex_count,
                  &triangle_count) != 5) {
    std::fprintf(stderr, "malformed header\n");
    std::fclose(in);
    return 65;
  }

  std::vector<double> positions(static_cast<size_t>(vertex_count) * 3);
  for (double& value : positions) {
    if (std::fscanf(in, "%lf", &value) != 1) {
      std::fprintf(stderr, "malformed positions\n");
      std::fclose(in);
      return 65;
    }
  }
  std::vector<uint32_t> triangles(static_cast<size_t>(triangle_count) * 3);
  for (uint32_t& value : triangles) {
    if (std::fscanf(in, "%u", &value) != 1) {
      std::fprintf(stderr, "malformed triangles\n");
      std::fclose(in);
      return 65;
    }
  }
  std::fclose(in);

  std::printf("initMode=%d\n", init_mode);
  std::printf("operation=%d\n", operation);
  std::printf("epsilon=%.17g\n", epsilon);
  std::printf("inputVertices=%d\n", vertex_count);
  std::printf("inputTriangles=%d\n", triangle_count);
  // Flushed BEFORE the call: if Geogram aborts, this context still reaches the
  // harness instead of dying in a buffer.
  std::fflush(stdout);

  int status = 0;
  int moebius = 0;
  try {
    Initialise(init_mode);
    GEO::Mesh mesh;
    LoadMesh(mesh, positions, triangles);

    switch (operation) {
      case kRepairTopology:
        GEO::mesh_repair(mesh, GEO::MESH_REPAIR_TOPOLOGY, 0.0);
        break;
      case kRepairDupFacets:
        GEO::mesh_repair(mesh, GEO::MESH_REPAIR_DUP_F, 0.0);
        break;
      case kRepairColocate:
        GEO::mesh_repair(mesh, GEO::MESH_REPAIR_COLOCATE, epsilon);
        break;
      case kReorient: {
        GEO::vector<GEO::index_t> moebius_facets;
        GEO::mesh_reorient(mesh, &moebius_facets);
        for (GEO::index_t value : moebius_facets) {
          if (value != 0) ++moebius;
        }
        status = moebius == 0 ? 0 : 3;
        break;
      }
      case kIntersectSurface: {
        GEO::MeshSurfaceIntersection intersection(mesh);
        intersection.intersect();
        break;
      }
      default:
        std::printf("outcome=UNSUPPORTED_OPERATION\n");
        return 0;
    }

    GEO::index_t published = 0;
    for (GEO::index_t f = 0; f < mesh.facets.nb(); ++f) {
      if (mesh.facets.nb_vertices(f) == 3) ++published;
    }

    std::printf("outcome=RAN\n");
    std::printf("status=%d\n", status);
    std::printf("moebiusFacets=%d\n", moebius);
    std::printf("outputVertices=%u\n", static_cast<unsigned>(mesh.vertices.nb()));
    std::printf("outputTriangles=%u\n", static_cast<unsigned>(published));
    std::fflush(stdout);
    return 0;
  } catch (const std::exception& error) {
    // Reported, never swallowed: a caught abort is evidence about the kernel.
    std::printf("outcome=EXCEPTION\n");
    std::printf("message=%s\n", error.what());
    std::fflush(stdout);
    return 0;
  } catch (...) {
    std::printf("outcome=EXCEPTION\n");
    std::printf("message=unknown\n");
    std::fflush(stdout);
    return 0;
  }
}
