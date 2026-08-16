// CAD Fixer Stage 3A-2 — experimental Geogram binding.
//
// RESEARCH ONLY. Never linked into the application.
//
// OPERATION BOUNDARIES ARE EXPLICIT. Geogram's "repair" is not one thing:
// `mesh_repair` alone takes a mode bitmask covering vertex colocation, duplicate
// facet removal and triangulation, and orientation and intersection live in
// separate calls. Exposing a single function called "repair" would make the
// results uninterpretable — the bakeoff must record which API produced which
// change, so each is bound separately and named for what it does.
//
// COLOCATION EPSILON IS ALWAYS EXPLICIT. `mesh_repair`'s epsilon defaults to a
// non-zero value in some paths; the bakeoff always passes it deliberately,
// because an internal fixed epsilon presented as parameter-free correctness is
// exactly what REPAIR_POLICY.md §4 warns against.

#include <cstdint>
#include <exception>
#include <vector>

#include <emscripten/emscripten.h>

#include <geogram/basic/common.h>
#include <geogram/basic/geometry.h>
#include <geogram/mesh/mesh.h>
#include <geogram/mesh/mesh_repair.h>
#include <geogram/mesh/mesh_surface_intersection.h>

namespace {

std::vector<double> g_out_positions;
std::vector<uint32_t> g_out_triangles;
int g_status = 0;
int g_initialised = 0;
int g_intersection_count = -1;
int g_moebius_facets = 0;

void EnsureInitialised() {
  if (g_initialised == 0) {
    GEO::initialize();
    g_initialised = 1;
  }
}

void LoadMesh(GEO::Mesh& mesh, const double* positions, int vertex_count, const uint32_t* triangles,
              int triangle_count) {
  mesh.clear();
  mesh.vertices.set_dimension(3);
  mesh.vertices.create_vertices(vertex_count);
  for (int v = 0; v < vertex_count; ++v) {
    double* p = mesh.vertices.point_ptr(static_cast<GEO::index_t>(v));
    p[0] = positions[v * 3];
    p[1] = positions[v * 3 + 1];
    p[2] = positions[v * 3 + 2];
  }
  mesh.facets.create_triangles(triangle_count);
  for (int f = 0; f < triangle_count; ++f) {
    for (int c = 0; c < 3; ++c) {
      mesh.facets.set_vertex(static_cast<GEO::index_t>(f), static_cast<GEO::index_t>(c),
                             static_cast<GEO::index_t>(triangles[f * 3 + c]));
    }
  }
  mesh.facets.connect();
}

void PublishMesh(GEO::Mesh& mesh) {
  g_out_positions.clear();
  g_out_triangles.clear();

  const GEO::index_t vertex_count = mesh.vertices.nb();
  g_out_positions.reserve(static_cast<size_t>(vertex_count) * 3);
  for (GEO::index_t v = 0; v < vertex_count; ++v) {
    const double* p = mesh.vertices.point_ptr(v);
    g_out_positions.push_back(p[0]);
    g_out_positions.push_back(p[1]);
    g_out_positions.push_back(p[2]);
  }

  const GEO::index_t facet_count = mesh.facets.nb();
  g_out_triangles.reserve(static_cast<size_t>(facet_count) * 3);
  for (GEO::index_t f = 0; f < facet_count; ++f) {
    // Only triangles are published. Geogram can produce polygonal facets after
    // some operations; a non-triangle would be silently dropped here, so it is
    // reported instead by a vertex-count mismatch the harness can see.
    if (mesh.facets.nb_vertices(f) != 3) continue;
    for (GEO::index_t c = 0; c < 3; ++c) {
      g_out_triangles.push_back(static_cast<uint32_t>(mesh.facets.vertex(f, c)));
    }
  }
}

}  // namespace

extern "C" {

// Each code is ONE named Geogram API, not a generic "repair".
enum CfGeogramOperation {
  CF_G_REPAIR_TOPOLOGY = 0,     // mesh_repair(MESH_REPAIR_TOPOLOGY), epsilon 0
  CF_G_REPAIR_DUP_FACETS = 1,   // mesh_repair(MESH_REPAIR_DUP_F), epsilon 0
  CF_G_REPAIR_COLOCATE = 2,     // mesh_repair(MESH_REPAIR_COLOCATE), explicit epsilon
  CF_G_REORIENT = 3,            // mesh_reorient
  CF_G_INTERSECT_SURFACE = 4,   // mesh_intersect_surface (resolution)
};

EMSCRIPTEN_KEEPALIVE
int cf_g_run(int operation, const double* positions, int vertex_count, const uint32_t* triangles,
             int triangle_count, double epsilon) {
  try {
    EnsureInitialised();
    GEO::Mesh mesh;
    LoadMesh(mesh, positions, vertex_count, triangles, triangle_count);
    g_intersection_count = -1;
    g_moebius_facets = 0;

    switch (operation) {
      case CF_G_REPAIR_TOPOLOGY:
        // Epsilon 0: exact colocation only. Anything else would silently weld.
        GEO::mesh_repair(mesh, GEO::MESH_REPAIR_TOPOLOGY, 0.0);
        break;
      case CF_G_REPAIR_DUP_FACETS:
        GEO::mesh_repair(mesh, GEO::MESH_REPAIR_DUP_F, 0.0);
        break;
      case CF_G_REPAIR_COLOCATE:
        // The tolerance experiment. Epsilon comes from the caller, always.
        GEO::mesh_repair(mesh, GEO::MESH_REPAIR_COLOCATE, epsilon);
        break;
      case CF_G_REORIENT: {
        // `mesh_reorient` returns void; non-orientability is reported through
        // the optional out-vector, whose entries are non-zero for facets on an
        // edge that could not be consistently oriented. Asking for it is the
        // only way to distinguish "reoriented successfully" from "gave up on
        // part of the surface" — and REPAIR_POLICY.md requires that a
        // non-orientable component be refused rather than silently half-fixed.
        GEO::vector<GEO::index_t> moebius_facets;
        GEO::mesh_reorient(mesh, &moebius_facets);

        GEO::index_t inconsistent = 0;
        for (GEO::index_t value : moebius_facets) {
          if (value != 0) ++inconsistent;
        }
        g_moebius_facets = static_cast<int>(inconsistent);
        // 3 = non-orientable. A distinct status, not a generic failure.
        g_status = inconsistent == 0 ? 0 : 3;
        break;
      }
      case CF_G_INTERSECT_SURFACE: {
        GEO::MeshSurfaceIntersection intersection(mesh);
        intersection.intersect();
        break;
      }
      default:
        g_status = -2;
        return g_status;
    }

    PublishMesh(mesh);
    if (operation != CF_G_REORIENT) g_status = 0;
    return g_status;
  } catch (const std::exception&) {
    g_status = -1;
    g_out_positions.clear();
    g_out_triangles.clear();
    return -1;
  } catch (...) {
    g_status = -1;
    g_out_positions.clear();
    g_out_triangles.clear();
    return -1;
  }
}

EMSCRIPTEN_KEEPALIVE int cf_g_status() { return g_status; }
EMSCRIPTEN_KEEPALIVE int cf_g_vertex_count() { return static_cast<int>(g_out_positions.size() / 3); }
EMSCRIPTEN_KEEPALIVE int cf_g_triangle_count() { return static_cast<int>(g_out_triangles.size() / 3); }
EMSCRIPTEN_KEEPALIVE const double* cf_g_positions() { return g_out_positions.data(); }
EMSCRIPTEN_KEEPALIVE const uint32_t* cf_g_triangles() { return g_out_triangles.data(); }
EMSCRIPTEN_KEEPALIVE int cf_g_intersection_count() { return g_intersection_count; }
EMSCRIPTEN_KEEPALIVE int cf_g_moebius_facets() { return g_moebius_facets; }

EMSCRIPTEN_KEEPALIVE
void cf_g_reset() {
  std::vector<double>().swap(g_out_positions);
  std::vector<uint32_t>().swap(g_out_triangles);
  g_status = 0;
  g_intersection_count = -1;
  g_moebius_facets = 0;
}

}  // extern "C"
