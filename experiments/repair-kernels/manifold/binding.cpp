// CAD Fixer Stage 3A-2 — experimental Manifold binding.
//
// RESEARCH ONLY. This is not production code and is never linked into the
// application.
//
// DESIGN: flat arrays and a bounded number of boundary crossings. An Embind
// object graph would be more convenient to write and would cost a JS/WASM
// crossing per triangle; a repair of a two-million-triangle model must cross a
// small constant number of times, so the contract is:
//
//   1. JS allocates an input buffer in the WASM heap and copies the mesh in.
//   2. JS calls one operation function.
//   3. JS reads the output pointer and lengths, and copies the mesh out.
//
// Three crossings per operation, independent of mesh size.
//
// PRECISION: MeshGL64 is used deliberately, so the experiment can feed float64
// coordinates and observe what comes back. That is the evidence ADR 0004 needs;
// using the float32 MeshGL would have thrown the question away at the door.

#include <cstdint>
#include <cstring>
#include <vector>

#include <emscripten/emscripten.h>

#include "manifold/manifold.h"
#include "manifold/mesh.h"

namespace {

// The result of the most recent operation. Held in a namespace-scope buffer so
// the pointers handed to JS stay valid until the next call — the alternative,
// returning malloc'd memory JS must free, invites leaks in a harness that also
// has to survive candidate crashes.
std::vector<double> g_out_positions;
std::vector<uint32_t> g_out_triangles;
int g_status = 0;
int g_kernel_reported_success = 0;
int g_genus = 0;
double g_volume = 0.0;
double g_surface_area = 0.0;
int g_decomposed_count = 0;
// -1 = Merge was not invoked for this operation, 0 = ran and changed nothing,
// 1 = ran and modified the mesh.
int g_merge_changed = -1;

manifold::MeshGL64 MakeMeshGL64(const double* positions, int vertex_count,
                                const uint32_t* triangles, int triangle_count) {
  manifold::MeshGL64 mesh;
  mesh.numProp = 3;
  mesh.vertProperties.assign(positions, positions + static_cast<size_t>(vertex_count) * 3);
  mesh.triVerts.assign(triangles, triangles + static_cast<size_t>(triangle_count) * 3);
  return mesh;
}

void PublishManifold(const manifold::Manifold& value) {
  g_status = static_cast<int>(value.Status());
  // RECORDED, NOT TRUSTED. CAD Fixer's own validators decide success; this is
  // the kernel's opinion, carried across so the two can be compared.
  g_kernel_reported_success = value.Status() == manifold::Manifold::Error::NoError ? 1 : 0;

  const manifold::MeshGL64 mesh = value.GetMeshGL64();
  g_out_positions.assign(mesh.vertProperties.begin(), mesh.vertProperties.end());
  g_out_triangles.assign(mesh.triVerts.begin(), mesh.triVerts.end());

  g_genus = value.Genus();
  g_volume = value.Volume();
  g_surface_area = value.SurfaceArea();
  g_decomposed_count = static_cast<int>(value.Decompose().size());
}

void PublishFailure(int status) {
  g_status = status;
  g_kernel_reported_success = 0;
  g_out_positions.clear();
  g_out_triangles.clear();
  g_genus = 0;
  g_volume = 0.0;
  g_surface_area = 0.0;
  g_decomposed_count = 0;
}

}  // namespace

extern "C" {

// Operation codes. Named for the DEFECT or intent, not for a Manifold method,
// so the bakeoff records what was asked for rather than how it was spelled.
enum CfOperation {
  CF_OP_INGEST = 0,        // construct only; reports whether input was accepted
  CF_OP_MERGE_INGEST = 1,  // EXPLICIT Merge() first. Never invisible.
  /*
   * INVALID_EXPERIMENT — retained deliberately, excluded from all scoring.
   *
   * Stage 3A-2 implemented "self-union" as `Boolean(Manifold(), OpType::Add)`.
   * A default-constructed Manifold is EMPTY, and union with the empty set is
   * the identity: the call returned its input unchanged (R16 went 24 -> 24
   * triangles, 2 -> 2 components) and was then read as evidence that Manifold
   * could not resolve interpenetrating shells. It was measuring nothing.
   *
   * Upstream exposes no self-union operation, and inventing one here would be
   * worse than admitting the gap. Resolving interpenetration means unioning the
   * DECOMPOSED solids against each other, which is what `cf_boolean` does and
   * what the R16 experiment now performs.
   *
   * Kept rather than deleted so the results file can carry the correction: a
   * silently removed experiment teaches nobody why the number was wrong.
   */
  CF_OP_SELF_UNION_INVALID = 2,
};

EMSCRIPTEN_KEEPALIVE
int cf_run(int operation, const double* positions, int vertex_count, const uint32_t* triangles,
           int triangle_count) {
  try {
    manifold::MeshGL64 mesh = MakeMeshGL64(positions, vertex_count, triangles, triangle_count);

    g_merge_changed = -1;
    if (operation == CF_OP_MERGE_INGEST) {
      // Reported as its own operation in the results. Manifold's Merge only
      // recovers input that is ALREADY nearly manifold; treating it as a repair
      // would overstate what the kernel does.
      //
      // The RETURN VALUE is recorded. `MeshGL64::Merge()` (mesh.h:182) reports
      // whether it actually changed anything, which separates "Merge ran and
      // did nothing" from "Merge repaired the input" — a distinction Stage 3A-2
      // could not make, because it discarded the bool.
      g_merge_changed = mesh.Merge() ? 1 : 0;
    }

    manifold::Manifold value(mesh);
    if (value.Status() != manifold::Manifold::Error::NoError) {
      PublishFailure(static_cast<int>(value.Status()));
      return g_status;
    }

    if (operation == CF_OP_SELF_UNION_INVALID) {
      // RETAINED ONLY TO REPRODUCE THE INVALID STAGE 3A-2 RESULT. This unions
      // against a default-constructed (EMPTY) Manifold, which is the identity:
      // the value returned is the input. Kept so the correction can be
      // demonstrated rather than merely asserted, and excluded from scoring.
      value = value.Boolean(manifold::Manifold(), manifold::OpType::Add);
    }

    PublishManifold(value);
    return g_status;
  } catch (const std::exception&) {
    // -1 distinguishes a C++ throw from any Manifold::Error value.
    PublishFailure(-1);
    return -1;
  } catch (...) {
    PublishFailure(-1);
    return -1;
  }
}

// Boolean micro-suite (spec §36): two meshes in, one out.
EMSCRIPTEN_KEEPALIVE
int cf_boolean(int op_type, const double* a_pos, int a_verts, const uint32_t* a_tris, int a_count,
               const double* b_pos, int b_verts, const uint32_t* b_tris, int b_count) {
  try {
    manifold::Manifold a(MakeMeshGL64(a_pos, a_verts, a_tris, a_count));
    manifold::Manifold b(MakeMeshGL64(b_pos, b_verts, b_tris, b_count));
    if (a.Status() != manifold::Manifold::Error::NoError) {
      PublishFailure(static_cast<int>(a.Status()));
      return g_status;
    }
    if (b.Status() != manifold::Manifold::Error::NoError) {
      PublishFailure(static_cast<int>(b.Status()));
      return g_status;
    }

    manifold::OpType op = manifold::OpType::Add;
    if (op_type == 1) op = manifold::OpType::Subtract;
    if (op_type == 2) op = manifold::OpType::Intersect;

    PublishManifold(a.Boolean(b, op));
    return g_status;
  } catch (...) {
    PublishFailure(-1);
    return -1;
  }
}

EMSCRIPTEN_KEEPALIVE int cf_status() { return g_status; }
EMSCRIPTEN_KEEPALIVE int cf_kernel_reported_success() { return g_kernel_reported_success; }
EMSCRIPTEN_KEEPALIVE int cf_vertex_count() { return static_cast<int>(g_out_positions.size() / 3); }
EMSCRIPTEN_KEEPALIVE int cf_triangle_count() { return static_cast<int>(g_out_triangles.size() / 3); }
EMSCRIPTEN_KEEPALIVE const double* cf_positions() { return g_out_positions.data(); }
EMSCRIPTEN_KEEPALIVE const uint32_t* cf_triangles() { return g_out_triangles.data(); }
EMSCRIPTEN_KEEPALIVE int cf_genus() { return g_genus; }
EMSCRIPTEN_KEEPALIVE double cf_volume() { return g_volume; }
EMSCRIPTEN_KEEPALIVE double cf_surface_area() { return g_surface_area; }
EMSCRIPTEN_KEEPALIVE int cf_component_count() { return g_decomposed_count; }
EMSCRIPTEN_KEEPALIVE int cf_merge_changed() { return g_merge_changed; }

// Releases the retained result. The harness calls this between cases so peak
// heap reflects one operation rather than an accumulating history.
EMSCRIPTEN_KEEPALIVE
void cf_reset() {
  std::vector<double>().swap(g_out_positions);
  std::vector<uint32_t>().swap(g_out_triangles);
  PublishFailure(0);
}

}  // extern "C"
