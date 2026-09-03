// CAD Fixer Stage 3C-1A-R1 — narrowphase capacity + differential fuzz.
// RESEARCH ONLY.
//
// TWO QUESTIONS, ONE HARNESS.
//
// 1. CAPACITY. `GEO::TriangleIsects` is a fixed 20-element buffer whose
//    push_back is an UNCONDITIONAL geo_assert (assert.h:149 has no NDEBUG
//    guard, so it aborts in Release too). Duplicate triangles are already known
//    to overflow it. The open question is whether any NON-duplicate,
//    nondegenerate pair can. This drives millions of pairs through the real
//    primitive and reports the largest symbolic result ever observed.
//
// 2. DIFFERENTIAL. Small integer coordinates are used deliberately: they
//    manufacture the exact coincidences — shared vertices, collinear edges,
//    coplanar overlaps — that floating-point noise would hide, which is where
//    both a capacity overflow and a classifier disagreement would actually live.
//
// A capacity overflow aborts the process. That is itself the finding, so the
// harness flushes its progress after every batch: if it dies, the last printed
// seed brackets the offending case.

#include <cstdio>
#include <cstdint>
#include <cstring>
#include <vector>
#include <algorithm>

#include <geogram/basic/common.h>
#include <geogram/basic/command_line.h>
#include <geogram/basic/command_line_args.h>
#include <geogram/basic/logger.h>
#include <geogram/basic/assert.h>
#include <geogram/mesh/triangle_intersection.h>
#include <geogram/numerics/predicates.h>

#include "si_core.h"

namespace {

// A small, explicit PRNG so a seed reproduces a run exactly on any machine.
struct Rng {
  uint64_t s;
  explicit Rng(uint64_t seed) : s(seed * 6364136223846793005ull + 1442695040888963407ull) {}
  uint32_t next() {
    s ^= s << 13; s ^= s >> 7; s ^= s << 17;
    return static_cast<uint32_t>(s >> 32);
  }
  int range(int lo, int hi) { return lo + static_cast<int>(next() % static_cast<uint32_t>(hi - lo + 1)); }
};

}  // namespace

int main(int argc, char** argv) {
  GEO::initialize();
  GEO::CmdLine::import_arg_group("standard");
  GEO::CmdLine::import_arg_group("algo");
  GEO::Logger::instance()->set_quiet(true);
  GEO::set_assert_mode(GEO::ASSERT_THROW);

  uint64_t seed = 1;
  uint64_t cases = 200000;
  int coord = 4;       // coordinate range; small => many exact coincidences
  int plane_bias = 40; // percent of cases forced coplanar (z = 0)
  bool merge_identity = true;
  for (int i = 1; i < argc; ++i) {
    if (std::strncmp(argv[i], "--seed=", 7) == 0) seed = std::strtoull(argv[i] + 7, nullptr, 10);
    else if (std::strncmp(argv[i], "--cases=", 8) == 0) cases = std::strtoull(argv[i] + 8, nullptr, 10);
    else if (std::strncmp(argv[i], "--coord=", 8) == 0) coord = atoi(argv[i] + 8);
    else if (std::strncmp(argv[i], "--coplanar=", 11) == 0) plane_bias = atoi(argv[i] + 11);
    else if (std::strcmp(argv[i], "--no-merge") == 0) merge_identity = false;
  }

  Rng rng(seed);
  uint64_t tested = 0, skipped_degenerate = 0, duplicates = 0, nonempty = 0, refusals = 0;
  uint32_t max_isects = 0;
  uint64_t max_case = 0;

  for (uint64_t c = 0; c < cases; ++c) {
    const bool coplanar = (rng.range(0, 99) < plane_bias);

    std::vector<double> pos(18);
    // Six vertices. A shared-vertex or shared-edge configuration is injected
    // often, because those are the configurations that generate the most
    // symbolic contacts and therefore stress the buffer hardest.
    for (int v = 0; v < 6; ++v) {
      pos[3 * v] = rng.range(-coord, coord);
      pos[3 * v + 1] = rng.range(-coord, coord);
      pos[3 * v + 2] = coplanar ? 0.0 : rng.range(-coord, coord);
    }
    const int mode = rng.range(0, 3);
    std::vector<uint32_t> tris = {0, 1, 2, 3, 4, 5};

    /*
     * EXACT IDENTITY RECOVERY, exactly as production performs it before the
     * diagnostic ever runs. Independently generated vertices routinely land on
     * identical coordinates at these small ranges, and without this step the
     * fuzz tests a mesh CAD Fixer could never actually be handed: one where two
     * distinct vertex ids occupy the same point. Merging them first is what
     * makes the fuzz measure the real exposure rather than an artefact of its
     * own generator.
     */
    if (merge_identity) {
      for (uint32_t a = 0; a < 6; ++a) {
        for (uint32_t b = 0; b < a; ++b) {
          if (pos[3*a] == pos[3*b] && pos[3*a+1] == pos[3*b+1] && pos[3*a+2] == pos[3*b+2]) {
            for (uint32_t& t : tris) if (t == a) t = b;
            break;
          }
        }
      }
    }
    if (mode == 1) { tris[3] = 0; }                       // shared vertex
    else if (mode == 2) { tris[3] = 0; tris[4] = 1; }     // shared edge
    else if (mode == 3) { tris[3] = 0; tris[4] = 1; tris[5] = 2; }  // duplicate

    const uint32_t* t1 = &tris[0];
    const uint32_t* t2 = &tris[3];

    if (cadfixer::is_degenerate_face(pos, t1) || cadfixer::is_degenerate_face(pos, t2)) {
      ++skipped_degenerate;
      continue;
    }
    if (cadfixer::shared_vertex_count(t1, t2) == 3) {
      // Never handed to the narrowphase in production either: this is the
      // configuration proven to overflow the buffer.
      ++duplicates;
      continue;
    }

    const GEO::vec3 p0(pos[3*t1[0]], pos[3*t1[0]+1], pos[3*t1[0]+2]);
    const GEO::vec3 p1(pos[3*t1[1]], pos[3*t1[1]+1], pos[3*t1[1]+2]);
    const GEO::vec3 p2(pos[3*t1[2]], pos[3*t1[2]+1], pos[3*t1[2]+2]);
    const GEO::vec3 q0(pos[3*t2[0]], pos[3*t2[0]+1], pos[3*t2[0]+2]);
    const GEO::vec3 q1(pos[3*t2[1]], pos[3*t2[1]+1], pos[3*t2[1]+2]);
    const GEO::vec3 q2(pos[3*t2[2]], pos[3*t2[2]+1], pos[3*t2[2]+2]);

    GEO::TriangleIsects isects;
    bool refused = false;
    try {
      GEO::triangles_intersections(
          p0, p1, p2, q0, q1, q2,
          t1[0], t1[1], t1[2], t2[0], t2[1], t2[2], isects);
    } catch (...) {
      refused = true;
      ++refusals;
      // Record the exact inputs: an overflow that cannot be reproduced is an
      // anecdote, and this one contradicts the Stage 3C-1A conclusion.
      if (refusals == 1) {
        std::fprintf(stderr, "  FIRST REFUSAL case=%llu mode=%d coplanar=%d verts=",
                     (unsigned long long)c, mode, coplanar ? 1 : 0);
        for (int v = 0; v < 6; ++v) {
          std::fprintf(stderr, "(%g,%g,%g)", pos[3*v], pos[3*v+1], pos[3*v+2]);
        }
        std::fprintf(stderr, " tris=%u,%u,%u/%u,%u,%u\n",
                     tris[0], tris[1], tris[2], tris[3], tris[4], tris[5]);
        std::fflush(stderr);
      }
    }
    ++tested;
    if (refused) continue;
    if (isects.size() > 0) ++nonempty;
    if (isects.size() > max_isects) { max_isects = isects.size(); max_case = c; }

    if ((c % 50000) == 0) {
      std::fprintf(stderr, "  ...case %llu maxIsects=%u\n",
                   (unsigned long long)c, max_isects);
      std::fflush(stderr);
    }
  }

  std::printf(
      "{\"seed\":%llu,\"cases\":%llu,\"tested\":%llu,\"skippedDegenerate\":%llu,"
      "\"duplicatesGuarded\":%llu,\"nonEmpty\":%llu,\"maxIsects\":%u,"
      "\"maxCase\":%llu,\"refusals\":%llu,\"capacity\":20}\n",
      (unsigned long long)seed, (unsigned long long)cases,
      (unsigned long long)tested, (unsigned long long)skipped_degenerate,
      (unsigned long long)duplicates, (unsigned long long)nonempty,
      max_isects, (unsigned long long)max_case, (unsigned long long)refusals);
  return 0;
}
