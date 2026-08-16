// CAD Fixer Stage 3A-2 — experimental PMP binding.
//
// RESEARCH ONLY. Never linked into the application.
//
// PMP'S PRECONDITION IS THE POINT OF THIS BINDING. `pmp::SurfaceMesh`
// documents that it "only supports 2-manifold surface meshes with boundary",
// and `add_face` throws `TopologyException` when a face would break that. So
// several corpus fixtures — R11's non-manifold edge, R12's bow-tie vertex,
// R29's soup — cannot be represented at all.
//
// That is a ROLE FINDING, not a crash to be papered over. The build reports it
// as a distinct status so the harness can record UNSUPPORTED_INPUT_CLASS rather
// than counting it as an algorithmic failure, which would be an unfair
// comparison against kernels that accept arbitrary soup.
//
// HOLE FILLING IS EXPLICIT AND TARGETED. `fill_hole` takes a specific boundary
// halfedge. The binding never iterates every boundary and fills them all:
// deciding WHICH openings should be closed is CAD Fixer's product decision, and
// a kernel that made it would be doing the thing R09 exists to catch.

#include <cstdint>
#include <exception>
#include <vector>

#include <emscripten/emscripten.h>

#include <pmp/surface_mesh.h>
#include <pmp/algorithms/hole_filling.h>
#include <pmp/algorithms/remeshing.h>

namespace {

std::vector<double> g_out_positions;
std::vector<uint32_t> g_out_triangles;
int g_status = 0;
int g_filled_holes = 0;

// Status codes. Distinct values so the harness can tell "PMP cannot represent
// this input" from "PMP tried and failed".
constexpr int CF_OK = 0;
constexpr int CF_UNSUPPORTED_INPUT_CLASS = 10;
constexpr int CF_EXCEPTION = -1;

bool BuildMesh(pmp::SurfaceMesh& mesh, const double* positions, int vertex_count,
               const uint32_t* triangles, int triangle_count) {
  std::vector<pmp::Vertex> handles;
  handles.reserve(static_cast<size_t>(vertex_count));
  for (int v = 0; v < vertex_count; ++v) {
    handles.push_back(mesh.add_vertex(pmp::Point(static_cast<pmp::Scalar>(positions[v * 3]),
                                                 static_cast<pmp::Scalar>(positions[v * 3 + 1]),
                                                 static_cast<pmp::Scalar>(positions[v * 3 + 2]))));
  }

  for (int f = 0; f < triangle_count; ++f) {
    const uint32_t a = triangles[f * 3];
    const uint32_t b = triangles[f * 3 + 1];
    const uint32_t c = triangles[f * 3 + 2];
    if (a >= static_cast<uint32_t>(vertex_count) || b >= static_cast<uint32_t>(vertex_count) ||
        c >= static_cast<uint32_t>(vertex_count)) {
      return false;
    }
    try {
      mesh.add_triangle(handles[a], handles[b], handles[c]);
    } catch (const pmp::TopologyException&) {
      // The precondition failure. Reported as its own class, not as a crash.
      return false;
    }
  }
  return true;
}

void PublishMesh(const pmp::SurfaceMesh& mesh) {
  g_out_positions.clear();
  g_out_triangles.clear();

  // PMP keeps deleted elements until garbage collection, so indices are taken
  // from a compacted walk rather than assumed contiguous.
  std::vector<int> remap(mesh.vertices_size(), -1);
  int next = 0;
  for (auto v : mesh.vertices()) {
    const pmp::Point& p = mesh.position(v);
    g_out_positions.push_back(static_cast<double>(p[0]));
    g_out_positions.push_back(static_cast<double>(p[1]));
    g_out_positions.push_back(static_cast<double>(p[2]));
    remap[v.idx()] = next++;
  }

  for (auto f : mesh.faces()) {
    std::vector<int> corners;
    for (auto v : mesh.vertices(f)) corners.push_back(remap[v.idx()]);
    // Only triangles are published; a non-triangle would indicate the operation
    // produced something this flat representation cannot carry.
    if (corners.size() != 3) continue;
    for (int index : corners) g_out_triangles.push_back(static_cast<uint32_t>(index));
  }
}

}  // namespace

extern "C" {

enum CfPmpOperation {
  CF_P_INGEST = 0,          // precondition probe only
  CF_P_FILL_ALL_HOLES = 1,  // EXPLICIT request; used only on fixtures that ask
  CF_P_UNIFORM_REMESH = 2,
};

EMSCRIPTEN_KEEPALIVE
int cf_p_run(int operation, const double* positions, int vertex_count, const uint32_t* triangles,
             int triangle_count, double parameter) {
  g_filled_holes = 0;
  try {
    pmp::SurfaceMesh mesh;
    if (!BuildMesh(mesh, positions, vertex_count, triangles, triangle_count)) {
      g_status = CF_UNSUPPORTED_INPUT_CLASS;
      g_out_positions.clear();
      g_out_triangles.clear();
      return g_status;
    }

    if (operation == CF_P_FILL_ALL_HOLES) {
      // Only ever invoked when the fixture explicitly requests filling. Each
      // boundary loop is found once, by walking halfedges and filling one per
      // untouched loop.
      std::vector<pmp::Halfedge> starts;
      // `VertexProperty` is a free template in namespace pmp, not a nested
      // type of SurfaceMesh.
      pmp::VertexProperty<bool> seen = mesh.add_vertex_property<bool>("cf:seen", false);
      for (auto h : mesh.halfedges()) {
        if (!mesh.is_boundary(h)) continue;
        pmp::Vertex v = mesh.from_vertex(h);
        if (seen[v]) continue;
        starts.push_back(h);
        // Mark the whole loop so it is filled once, not once per edge.
        pmp::Halfedge walk = h;
        do {
          seen[mesh.from_vertex(walk)] = true;
          walk = mesh.next_halfedge(walk);
        } while (walk != h);
      }
      for (auto h : starts) {
        if (!mesh.is_boundary(h)) continue;
        try {
          pmp::fill_hole(mesh, h);
          ++g_filled_holes;
        } catch (const std::exception&) {
          // A loop PMP declines to fill is data, not a reason to abandon the
          // rest of the operation.
        }
      }
    } else if (operation == CF_P_UNIFORM_REMESH) {
      pmp::uniform_remeshing(mesh, static_cast<pmp::Scalar>(parameter));
    }

    mesh.garbage_collection();
    PublishMesh(mesh);
    g_status = CF_OK;
    return g_status;
  } catch (const std::exception&) {
    g_status = CF_EXCEPTION;
    g_out_positions.clear();
    g_out_triangles.clear();
    return g_status;
  } catch (...) {
    g_status = CF_EXCEPTION;
    g_out_positions.clear();
    g_out_triangles.clear();
    return g_status;
  }
}

EMSCRIPTEN_KEEPALIVE int cf_p_status() { return g_status; }
EMSCRIPTEN_KEEPALIVE int cf_p_vertex_count() { return static_cast<int>(g_out_positions.size() / 3); }
EMSCRIPTEN_KEEPALIVE int cf_p_triangle_count() { return static_cast<int>(g_out_triangles.size() / 3); }
EMSCRIPTEN_KEEPALIVE const double* cf_p_positions() { return g_out_positions.data(); }
EMSCRIPTEN_KEEPALIVE const uint32_t* cf_p_triangles() { return g_out_triangles.data(); }
EMSCRIPTEN_KEEPALIVE int cf_p_filled_holes() { return g_filled_holes; }

EMSCRIPTEN_KEEPALIVE
void cf_p_reset() {
  std::vector<double>().swap(g_out_positions);
  std::vector<uint32_t>().swap(g_out_triangles);
  g_status = 0;
  g_filled_holes = 0;
}

}  // extern "C"
