// CAD Fixer Stage 3C-1A-R1 — abortable read-only broadphase. RESEARCH ONLY.
//
// WHY THIS EXISTS. Geogram's `compute_facet_bbox_intersections` streams pairs
// one at a time, which bounds MEMORY — but its callback returns `void`, so once
// CAD Fixer's tested-pair cap fires there is no way to tell the traversal to
// stop. It keeps walking the tree and keeps invoking the callback for every
// remaining overlapping pair. On a pathological mesh that is an O(N^2) walk the
// user is already waiting through, performed entirely to discard its own
// results. Memory was bounded; CPU was not.
//
// This is the smallest thing that fixes that: a median-split AABB tree over
// face boxes whose traversal callback returns `bool`, and whose recursion
// unwinds IMMEDIATELY when that bool is false.
//
// WHAT IT DELIBERATELY IS NOT. Not a general geometry library, not a spatial
// index for anything else, and not an attempt to beat Geogram's tree at
// building or querying. It exists to own the stop condition. Its candidate set
// is validated against BOTH a brute-force all-pairs oracle and Geogram's own
// AABB, because a broadphase that misses pairs turns a defect into a clean bill
// of health.
//
// NO TOLERANCE ANYWHERE. Boxes are the exact min/max of the stored Float64
// coordinates, and overlap is INCLUSIVE (`<=`) so that faces touching exactly
// at a shared plane, edge or vertex remain candidates. Shrinking the test to a
// strict inequality would silently discard every exact contact this diagnostic
// exists to find.

#pragma once

#include <cstdint>
#include <algorithm>
#include <vector>

namespace cadfixer {

struct SiBox {
  double lo[3];
  double hi[3];
};

inline bool boxes_overlap(const SiBox& a, const SiBox& b) {
  // Inclusive on every axis: exact touching counts as overlapping.
  return a.lo[0] <= b.hi[0] && b.lo[0] <= a.hi[0] &&
         a.lo[1] <= b.hi[1] && b.lo[1] <= a.hi[1] &&
         a.lo[2] <= b.hi[2] && b.lo[2] <= a.hi[2];
}

/**
 * A read-only median-split AABB tree over face bounding boxes.
 *
 * The mesh is never touched: the tree owns its own permutation of face indices
 * and its own boxes, so nothing here can reorder or rewrite the caller's data
 * the way Geogram's AABB_INPLACE mode would.
 */
class SiBvh {
 public:
  void build(const std::vector<double>& pos, const std::vector<uint32_t>& tris) {
    const uint32_t faces = static_cast<uint32_t>(tris.size() / 3);
    boxes_.resize(faces);
    order_.resize(faces);
    for (uint32_t f = 0; f < faces; ++f) {
      order_[f] = f;
      SiBox& b = boxes_[f];
      for (int k = 0; k < 3; ++k) { b.lo[k] = 1e308; b.hi[k] = -1e308; }
      for (int c = 0; c < 3; ++c) {
        const uint32_t v = tris[3 * f + c];
        for (int k = 0; k < 3; ++k) {
          const double val = pos[3 * v + k];
          if (val < b.lo[k]) b.lo[k] = val;
          if (val > b.hi[k]) b.hi[k] = val;
        }
      }
    }
    nodes_.clear();
    if (faces == 0) return;
    nodes_.reserve(2 * faces);
    build_node(0, faces);
  }

  /**
   * Enumerates every pair of faces whose boxes overlap, normalised f1 < f2.
   *
   * `action` returns false to STOP. The return value is propagated all the way
   * out of the recursion, so the traversal ends at the next node boundary
   * rather than continuing to enumerate pairs nobody will look at.
   *
   * Returns true when the traversal completed, false when it was stopped.
   */
  template <typename Action>
  bool for_each_overlapping_pair(const Action& action) const {
    if (nodes_.empty()) return true;
    return descend(0, 0, action);
  }

  uint32_t face_count() const { return static_cast<uint32_t>(boxes_.size()); }

 private:
  struct Node {
    SiBox bounds;
    uint32_t begin;
    uint32_t end;
    uint32_t left;   // 0 when leaf
    uint32_t right;  // 0 when leaf
  };

  static constexpr uint32_t LEAF_SIZE = 8;

  uint32_t build_node(uint32_t begin, uint32_t end) {
    const uint32_t index = static_cast<uint32_t>(nodes_.size());
    nodes_.push_back(Node{});
    Node node{};
    node.begin = begin;
    node.end = end;
    node.left = 0;
    node.right = 0;

    for (int k = 0; k < 3; ++k) { node.bounds.lo[k] = 1e308; node.bounds.hi[k] = -1e308; }
    for (uint32_t i = begin; i < end; ++i) {
      const SiBox& b = boxes_[order_[i]];
      for (int k = 0; k < 3; ++k) {
        node.bounds.lo[k] = std::min(node.bounds.lo[k], b.lo[k]);
        node.bounds.hi[k] = std::max(node.bounds.hi[k], b.hi[k]);
      }
    }

    if (end - begin > LEAF_SIZE) {
      int axis = 0;
      double widest = -1;
      for (int k = 0; k < 3; ++k) {
        const double w = node.bounds.hi[k] - node.bounds.lo[k];
        if (w > widest) { widest = w; axis = k; }
      }
      const uint32_t mid = begin + (end - begin) / 2;
      // nth_element is a partial sort; the tie-break on face index keeps the
      // resulting order deterministic, which is what makes sampled pairs
      // reproducible across runs and machines.
      std::nth_element(
          order_.begin() + begin, order_.begin() + mid, order_.begin() + end,
          [&](uint32_t a, uint32_t b) {
            const double ca = boxes_[a].lo[axis] + boxes_[a].hi[axis];
            const double cb = boxes_[b].lo[axis] + boxes_[b].hi[axis];
            if (ca != cb) return ca < cb;
            return a < b;
          });
      node.left = build_node(begin, mid);
      node.right = build_node(mid, end);
    }

    nodes_[index] = node;
    return index;
  }

  template <typename Action>
  bool descend(uint32_t a, uint32_t b, const Action& action) const {
    const Node& na = nodes_[a];
    const Node& nb = nodes_[b];
    if (a != b && !boxes_overlap(na.bounds, nb.bounds)) return true;

    const bool a_leaf = na.left == 0;
    const bool b_leaf = nb.left == 0;

    if (a_leaf && b_leaf) {
      for (uint32_t i = na.begin; i < na.end; ++i) {
        // When both leaves are the same node, only walk the upper triangle so
        // no pair is emitted twice and no face is paired with itself.
        const uint32_t jstart = (a == b) ? i + 1 : nb.begin;
        for (uint32_t j = jstart; j < nb.end; ++j) {
          const uint32_t f1 = order_[i];
          const uint32_t f2 = order_[j];
          if (f1 == f2) continue;
          if (!boxes_overlap(boxes_[f1], boxes_[f2])) continue;
          if (!action(std::min(f1, f2), std::max(f1, f2))) return false;
        }
      }
      return true;
    }

    if (a == b) {
      // Self-intersection of one node: its two children against themselves and
      // against each other. Exactly once each, so no pair is generated twice.
      if (!descend(na.left, na.left, action)) return false;
      if (!descend(na.right, na.right, action)) return false;
      return descend(na.left, na.right, action);
    }

    if (b_leaf || (!a_leaf && (na.end - na.begin) >= (nb.end - nb.begin))) {
      if (!descend(na.left, b, action)) return false;
      return descend(na.right, b, action);
    }
    if (!descend(a, nb.left, action)) return false;
    return descend(a, nb.right, action);
  }

  std::vector<SiBox> boxes_;
  mutable std::vector<uint32_t> order_;
  std::vector<Node> nodes_;
};

}  // namespace cadfixer
