"""The mesh a fill simulation runs on: the contract between STEP extraction and `fill_solver`, and the checks a mesh must pass first.

No OpenCASCADE here: the solver and these checks work on arrays, so a mesh from any source (STEP, a mesh file, a test) can be simulated.
One mesh is one skin of a thin-walled part (the dual-domain idea): triangles on the part surface, each carrying the local wall thickness.
"""
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np


class TookTooLong(ValueError):
    """A run passed its time budget. It stops with this, well before the engine's own watchdog would end the whole process."""


def check_time(deadline: Optional[float], doing: str) -> None:
    """`deadline` is a time.monotonic() value, or None for no limit."""
    if deadline is not None and time.monotonic() > deadline:
        raise TookTooLong(f"The simulation ran out of time while {doing}: this part needs more elements than one run is allowed.")


@dataclass(frozen=True)
class FillMesh:
    nodes_mm: np.ndarray      # (N, 3) welded: triangles that meet share node ids
    triangles: np.ndarray     # (M, 3) node ids, counter-clockwise seen from outside the material
    thickness_mm: np.ndarray  # (M,) local wall thickness at each triangle
    face_id: np.ndarray       # (M,) STEP face ordinal: the numbering the 3D viewer and every other detector use
    centre_mm: np.ndarray = field(default_factory=lambda: np.zeros(3))  # bounding-box centre of the part; heatmap points are measured from it

    def corners(self) -> np.ndarray:
        return self.nodes_mm[self.triangles]

    def areas_mm2(self) -> np.ndarray:
        c = self.corners()
        return np.linalg.norm(np.cross(c[:, 1] - c[:, 0], c[:, 2] - c[:, 0]), axis=1) / 2

    def volume_mm3(self) -> float:
        """What the solver fills: sum of triangle area x thickness."""
        return float((self.areas_mm2() * self.thickness_mm).sum())

    def triangle_centroids_mm(self) -> np.ndarray:
        return self.corners().mean(axis=1)

    def longest_edge_mm(self) -> float:
        c = self.corners()
        return float(max(np.linalg.norm(c[:, i] - c[:, (i + 1) % 3], axis=1).max() for i in range(3)))

    def refined(self, target_edge_mm: float, max_triangles: int) -> "FillMesh":
        """Longest-edge bisection (Rivara) with Delaunay edge flips, until no edge is longer than the target or `max_triangles` is reached.

        A CAD tessellator leaves a flat face with a hole as needles fanning from the corners to the hole. Bisection alone keeps a needle's
        small angle; cutting only edges that every triangle on them agrees is its longest keeps the mesh conforming, and flipping after each
        pass turns the cut fan into well-shaped triangles.
        """
        nodes, tri, thickness, face = self.nodes_mm, self.triangles, self.thickness_mm, self.face_id
        while len(tri) < max_triangles:
            corners = nodes[tri]
            length = np.linalg.norm(corners[:, [1, 2, 0]] - corners, axis=2)             # edge k joins corners k and k+1
            edges, edge_of = np.unique(np.sort(np.stack([tri, tri[:, [1, 2, 0]]], axis=2), axis=2).reshape(-1, 2), axis=0, return_inverse=True)
            edge_of = edge_of.reshape(-1, 3)
            edge_length = np.zeros(len(edges))
            edge_length[edge_of.ravel()] = length.ravel()
            rank = np.empty(len(edges), int)
            rank[np.lexsort((edges[:, 1], edges[:, 0], edge_length))] = np.arange(len(edges))   # one order all neighbours agree on
            slot = rank[edge_of].argmax(axis=1)                                                  # each triangle's longest edge
            longest = edge_of[np.arange(len(tri)), slot]
            votes = np.bincount(longest, minlength=len(edges))
            cut = (votes == np.bincount(edge_of.ravel(), minlength=len(edges))) & (edge_length > target_edge_mm)
            if not cut.any():
                break
            room = max_triangles - len(tri)
            if votes[cut].sum() > room:                                                          # keep the longest cuts that still fit
                order = np.flatnonzero(cut)[np.argsort(-rank[cut])]
                cut = np.zeros(len(edges), bool)
                cut[order[np.cumsum(votes[order]) <= room]] = True
                if not cut.any():
                    break
            middle = np.full(len(edges), -1)
            middle[cut] = len(nodes) + np.arange(cut.sum())
            nodes = np.vstack([nodes, nodes[edges[cut]].mean(axis=1)])
            hit = np.flatnonzero(cut[longest])
            k = slot[hit]
            a, b, c, m = tri[hit, k], tri[hit, (k + 1) % 3], tri[hit, (k + 2) % 3], middle[longest[hit]]
            keep = ~cut[longest]
            tri = np.vstack([tri[keep], np.column_stack([a, m, c]), np.column_stack([m, b, c])])
            thickness = np.concatenate([thickness[keep], thickness[hit], thickness[hit]])
            face = np.concatenate([face[keep], face[hit], face[hit]])
            tri, thickness = _delaunay_flips(nodes, tri, thickness, face)
        return FillMesh(nodes, tri, thickness, face, self.centre_mm)

    def cleaned(self, min_edge_mm: float, passes: int = 40) -> "FillMesh":
        """Every edge shorter than `min_edge_mm` collapsed to its midpoint, and the triangles that vanish with it removed.

        Small CAD faces and fillets leave edges of a hundredth of a millimetre in the skin (a real back cover: 156 triangles with an edge under
        0.1 mm, the worst a 0.00008 sliver). They carry no flow, and they made each pressure solve take five times the iterations. An edge far
        shorter than the wall is below what the fill resolves, so merging its ends changes nothing that is read off the result.

        The shape is kept: an end that lies on a crease or on a free edge of the skin stays where it is and the other end moves to it
        (two such ends, or two plain ones, meet half way). Meeting half way everywhere rounded off the corner between a cup's base and its wall.
        """
        nodes, tri, thickness, face = self.nodes_mm.copy(), self.triangles.copy(), self.thickness_mm, self.face_id
        for _ in range(passes):
            pair = np.unique(np.sort(np.stack([tri, tri[:, [1, 2, 0]]], axis=2), axis=2).reshape(-1, 2), axis=0)
            length = np.linalg.norm(nodes[pair[:, 0]] - nodes[pair[:, 1]], axis=1)
            short = np.flatnonzero(length < min_edge_mm)
            if not short.size:
                break
            # edges that share a node cannot collapse in one pass: an edge goes when it is the shortest short edge at both its ends
            shortest = np.full(len(nodes), np.inf)
            np.minimum.at(shortest, pair[short].ravel(), np.repeat(length[short], 2))
            go = short[(shortest[pair[short, 0]] == length[short]) & (shortest[pair[short, 1]] == length[short])]
            claims = np.bincount(pair[go].ravel(), minlength=len(nodes))
            go = go[(claims[pair[go, 0]] == 1) & (claims[pair[go, 1]] == 1)]
            if not go.size:                                                      # equal lengths at a shared node: take the one shortest edge
                go = short[[int(np.argmin(length[short]))]]
            keep_node, drop_node = pair[go, 0], pair[go, 1]
            fixed = _on_feature(nodes, tri)
            stays, moves = fixed[keep_node] & ~fixed[drop_node], fixed[drop_node] & ~fixed[keep_node]
            nodes[keep_node] = np.where(stays[:, None], nodes[keep_node], np.where(moves[:, None], nodes[drop_node], (nodes[keep_node] + nodes[drop_node]) / 2))
            remap = np.arange(len(nodes))
            remap[drop_node] = keep_node
            tri = remap[tri]
            real = (tri[:, 0] != tri[:, 1]) & (tri[:, 1] != tri[:, 2]) & (tri[:, 2] != tri[:, 0])
            tri, thickness, face = tri[real], thickness[real], face[real]
        _, inverse, count = np.unique(np.sort(tri, axis=1), axis=0, return_inverse=True, return_counts=True)
        single = count[inverse.ravel()] == 1                                     # two triangles folded onto the same three nodes: neither is a wall
        tri, thickness, face = tri[single], thickness[single], face[single]
        used, tri = np.unique(tri, return_inverse=True)
        return FillMesh(nodes[used], tri.reshape(-1, 3), thickness, face, self.centre_mm)

    # Gate mapping: where the engineer clicked, or which face they chose, to the nodes the melt enters through.
    def nearest_node(self, point_mm) -> int:
        return int(np.argmin(np.linalg.norm(self.nodes_mm - np.asarray(point_mm, float), axis=1)))

    def nodes_near(self, point_mm, radius_mm: float) -> np.ndarray:
        near = np.flatnonzero(np.linalg.norm(self.nodes_mm - np.asarray(point_mm, float), axis=1) <= radius_mm)
        return near if near.size else np.array([self.nearest_node(point_mm)])

    def nodes_on_face(self, face_id: int) -> np.ndarray:
        return np.unique(self.triangles[self.face_id == face_id])


_CREASE = np.cos(np.radians(30))   # two triangles turning more than this across their shared edge make a crease


def _on_feature(nodes: np.ndarray, tri: np.ndarray) -> np.ndarray:
    """Nodes that carry the shape: those on a free edge of the skin (an edge of one triangle) and those on a crease."""
    c = nodes[tri]
    normal = np.cross(c[:, 1] - c[:, 0], c[:, 2] - c[:, 0])
    normal /= np.maximum(np.linalg.norm(normal, axis=1, keepdims=True), 1e-300)
    pair = np.sort(np.stack([tri, tri[:, [1, 2, 0]]], axis=2), axis=2).reshape(-1, 2)
    order = np.lexsort((pair[:, 1], pair[:, 0]))
    same = (pair[order][1:] == pair[order][:-1]).all(axis=1)
    alone = np.ones(len(order), bool)
    alone[1:] &= ~same
    alone[:-1] &= ~same
    twin = np.flatnonzero(same)
    sharp = (normal[order[twin] // 3] * normal[order[twin + 1] // 3]).sum(axis=1) < _CREASE
    out = np.zeros(len(nodes), bool)
    out[pair[order[alone]].ravel()] = True
    out[pair[order[twin[sharp]]].ravel()] = True
    return out


_FLAT = np.cos(np.radians(0.5))   # an edge is flipped only between coplanar triangles of one CAD face: across a facet ridge a flip dents the surface


def _delaunay_flips(nodes: np.ndarray, tri: np.ndarray, thickness: np.ndarray, face: np.ndarray, passes: int = 30):
    """Flip every interior edge whose two opposite angles add up to more than 180 degrees, until none is left: of all triangulations of the
    same points this one has the largest smallest angle. A flip stays inside one flat patch of one CAD face, so the surface itself never moves
    (measured: flipping across the facets of a cylinder read a 3 mm wall as 2.3 mm); the two new triangles share the pair's mean thickness."""
    tri, thickness = tri.copy(), thickness.copy()
    for _ in range(passes):
        m = len(tri)
        pair = np.sort(np.stack([tri, tri[:, [1, 2, 0]]], axis=2), axis=2).reshape(-1, 2)
        order = np.lexsort((pair[:, 1], pair[:, 0]))
        twin = np.flatnonzero((pair[order][1:] == pair[order][:-1]).all(axis=1))
        ta, ka, tb, kb = order[twin] // 3, order[twin] % 3, order[twin + 1] // 3, order[twin + 1] % 3
        u, v, w1, w2 = tri[ta, ka], tri[ta, (ka + 1) % 3], tri[ta, (ka + 2) % 3], tri[tb, (kb + 2) % 3]

        def cot(apex):   # cotangent of the angle at `apex` looking at edge u-v
            p, q = nodes[u] - nodes[apex], nodes[v] - nodes[apex]
            return (p * q).sum(axis=1) / np.maximum(np.linalg.norm(np.cross(p, q), axis=1), 1e-300)

        c = nodes[tri]
        normal = np.cross(c[:, 1] - c[:, 0], c[:, 2] - c[:, 0])
        normal /= np.maximum(np.linalg.norm(normal, axis=1, keepdims=True), 1e-300)
        badness = -(cot(w1) + cot(w2))
        n = len(nodes)
        new_edge = np.minimum(w1, w2) * n + np.maximum(w1, w2)
        exists = np.isin(new_edge, pair[:, 0] * n + pair[:, 1])                  # on a closed wall the other diagonal may already be an edge
        can = (badness > 1e-9) & (face[ta] == face[tb]) & ((normal[ta] * normal[tb]).sum(axis=1) > _FLAT) & (tri[tb, kb] == v) & ~exists
        if not can.any():
            break
        ta, tb, u, v, w1, w2, badness = ta[can], tb[can], u[can], v[can], w1[can], w2[can], badness[can]
        worst = np.zeros(m)                                                      # a triangle takes part in one flip per pass: its worst edge
        np.maximum.at(worst, ta, badness)
        np.maximum.at(worst, tb, badness)
        go = (worst[ta] == badness) & (worst[tb] == badness)
        claimed = np.bincount(np.concatenate([ta[go], tb[go]]), minlength=m)     # equal badness on two edges of one triangle: take neither
        go &= (claimed[ta] == 1) & (claimed[tb] == 1)
        _, first, count = np.unique(new_edge[can][go], return_index=True, return_counts=True)
        once = np.zeros(int(go.sum()), bool)
        once[first[count == 1]] = True                                           # two flips must not make the same new edge
        go[np.flatnonzero(go)[~once]] = False
        if not go.any():
            break
        ta, tb, u, v, w1, w2 = ta[go], tb[go], u[go], v[go], w1[go], w2[go]
        tri[ta], tri[tb] = np.column_stack([u, w2, w1]), np.column_stack([w2, v, w1])
        thickness[ta] = thickness[tb] = (thickness[ta] + thickness[tb]) / 2
    return tri, thickness


@dataclass(frozen=True)
class Issue:
    code: str                 # degenerate_triangle | invalid_thickness | disconnected | non_manifold | inconsistent_orientation | no_triangles
    message: str
    triangles: List[int]      # the first few offenders, for highlighting

    def as_dict(self) -> Dict[str, object]:
        return {"code": self.code, "message": self.message, "triangles": self.triangles}


MIN_ALTITUDE_RATIO = 0.02   # shortest altitude / longest edge: below this the triangle is a sliver
MAX_THICKNESS_OVER_SIZE = 0.5  # a wall thicker than half the part's largest extent is not a thin wall
_SHOW = 8


def joined_at_nodes(triangles: np.ndarray) -> np.ndarray:
    """Group label per triangle, triangles being in one group when they share a node (label propagation, no graph library)."""
    label = np.arange(len(triangles))
    node_label = np.full(triangles.max() + 1, len(triangles))
    while True:
        node_label[:] = len(triangles)
        np.minimum.at(node_label, triangles.ravel(), np.repeat(label, 3))
        new = node_label[triangles].min(axis=1)
        if (new == label).all():
            return label
        label = new


def components(triangles: np.ndarray) -> np.ndarray:
    """Piece label per triangle: two triangles are one piece when they share an EDGE. Touching at a single node does not count, because melt
    cannot pass through a point: on a real part the sides of ribs touched the skin at single nodes, the last 1 % of the volume was forced
    through those points, and the gate pressure read 800 MPa where the part needed 115."""
    label = np.arange(len(triangles))
    if len(triangles) == 0:
        return label
    pair = np.sort(np.stack([triangles, triangles[:, [1, 2, 0]]], axis=2), axis=2).reshape(-1, 2)
    order = np.lexsort((pair[:, 1], pair[:, 0]))
    twin = np.flatnonzero((pair[order][1:] == pair[order][:-1]).all(axis=1))
    a, b = order[twin] // 3, order[twin + 1] // 3
    while True:
        new = label.copy()
        np.minimum.at(new, a, label[b])
        np.minimum.at(new, b, label[a])
        new = new[new]                                           # follow each label to its own label: halves the passes needed
        if (new == label).all():
            return label
        label = new


def check(mesh: FillMesh) -> List[Issue]:
    """Everything wrong with the mesh that would make a fill result wrong or meaningless; an empty list means it can be simulated."""
    m = len(mesh.triangles)
    if m == 0:
        return [Issue("no_triangles", "the mesh has no triangles", [])]
    issues: List[Issue] = []
    c = mesh.corners()
    edges = np.stack([c[:, 1] - c[:, 0], c[:, 2] - c[:, 1], c[:, 0] - c[:, 2]], axis=1)
    longest = np.linalg.norm(edges, axis=2).max(axis=1)
    altitude = 2 * mesh.areas_mm2() / np.maximum(longest, 1e-12)
    bad = np.flatnonzero(~np.isfinite(altitude) | (altitude / np.maximum(longest, 1e-12) < MIN_ALTITUDE_RATIO))
    if bad.size:
        issues.append(Issue("degenerate_triangle", f"{bad.size} sliver or zero-area triangles", bad[:_SHOW].tolist()))

    t = mesh.thickness_mm
    size = float(np.ptp(mesh.nodes_mm, axis=0).max())
    bad = np.flatnonzero(~np.isfinite(t) | (t <= 0) | (t > MAX_THICKNESS_OVER_SIZE * size))
    if bad.size:
        issues.append(Issue("invalid_thickness", f"{bad.size} triangles with no, zero, negative or implausible wall thickness", bad[:_SHOW].tolist()))

    directed = np.stack([mesh.triangles[:, [0, 1]], mesh.triangles[:, [1, 2]], mesh.triangles[:, [2, 0]]], axis=1).reshape(-1, 2)
    owner = np.repeat(np.arange(m), 3)
    undirected = np.sort(directed, axis=1)
    _, inverse, count = np.unique(undirected, axis=0, return_inverse=True, return_counts=True)
    over = np.flatnonzero(count[inverse] > 2)
    if over.size:
        issues.append(Issue("non_manifold", f"{np.unique(owner[over]).size} triangles on an edge shared by more than two triangles", np.unique(owner[over])[:_SHOW].tolist()))
    _, dir_count = np.unique(directed, axis=0, return_counts=True)
    if (dir_count > 1).any():
        issues.append(Issue("inconsistent_orientation", "two neighbouring triangles run the same way along their shared edge (one is flipped)", []))

    label = components(mesh.triangles)
    sizes = np.bincount(np.unique(label, return_inverse=True)[1])
    if len(sizes) > 1:
        issues.append(Issue("disconnected", f"{len(sizes)} separate regions of {sorted(sizes.tolist(), reverse=True)} triangles: melt cannot cross between them", []))
    return issues
