"""STEP shape -> FillMesh: one skin of the part, welded, moved to the wall's mid-surface, each triangle carrying its local wall thickness.

Reused as is: `tessellate_faces` (oriented triangles and the viewer's face numbering), `measure_wall_thickness` (shrinking ball; each triangle is handed to it as its own
face, so every triangle gets its own reading) and `measure_solid` (the CAD volume). New here: choosing the skin, the mid-surface, and the report.

How the skin is chosen
  1. The whole surface is welded and refined first, so thickness is measured on small triangles, not on the few huge ones a CAD tessellator leaves on a flat face.
     Every triangle is measured on a part of ordinary size; on a detailed one, the largest triangle of every face and then the largest of the rest
     (`_rays_for`): the work is bounded by the rays cast, never by refusing a part for its triangle count.
  2. A triangle faces a far wall if a surface facing back lies at p - n t (t its ball thickness). Rims, rib sides and hole walls do not.
  3. The decision is taken per CAD face, by area: a face mostly facing a far wall is a wall skin, and is kept whole. The strip of a floor that lies under a wall has no
     far wall of its own, yet it belongs to the floor: deciding triangle by triangle would cut the floor loose from the wall there.
  4. Of two faces facing each other the outer one is kept (larger outward offset from the part centre).
  5. Only the largest piece is kept, a piece being triangles joined edge to edge (melt cannot pass through a single shared node). A rib's side face is a wall
     skin too, but it stands on the inner surface, which was dropped: ribs and bosses are not flow channels here, they show as a slightly thicker wall where
     they sit, and the report says what share of the volume that leaves out.
  6. The mid-surface mesh is cleaned (edges far shorter than the target merged away) and refined to the target, twice, and cleaned once more.
"""
from typing import Any, Dict, Optional, Tuple

import numpy as np

from injection_molding.recognition.mesh import FaceMesh, Triangle, tessellate_faces
from injection_molding.recognition.pull_direction import choose_pull_direction
from injection_molding.recognition.wall_thickness import measure_wall_thickness
from shared.solid_measures import measure_solid

from .fill_mesh import FillMesh, check, check_time, components

# Thickness costs rays x surface triangles, so it is the rays that are limited, not the part. A real part's triangle count has a floor set by its
# number of faces (a back cover: 10 121 however coarsely it is tessellated), and a limit on triangles simply refused such parts.
MEASURE_ALL = 8000           # up to this many surface triangles, every one gets its own thickness ray
RAY_WORK = MEASURE_ALL ** 2  # rays x triangles spent on thickness beyond that (measured: about 8 s)
RAY_WORK_MAX = 6 * RAY_WORK  # every CAD face needs one ray at least to be decided; a part needing more work than this is refused, in words
SURFACE_LIMIT = 40000        # a tessellation above this is retried more coarsely, then refused
REFINE_EXTRA = 6000          # triangles the refinement before measuring may add to a detailed part: its few huge flat triangles still get cut
MAX_FILL_TRIANGLES = 6000    # what the solver is given: about 10 s of fill on one core
MEASURE_PER_DIAGONAL = 20    # the surface is refined to edges of diagonal / this before thickness is measured
EDGE_PER_WALL = 2.0          # target element edge of the fill mesh, in wall thicknesses
MIN_EDGE_SHARE = 1 / 3       # edges under this share of the target are merged away first: the mesh then runs from a third of the target to the target
WALL_FACE_SHARE = 0.5        # a CAD face is a wall skin when at least this share of its area faces a far wall
THIN_WALL_SHARE = 0.5        # a mesh holding less than this share of the CAD volume is not a model of the part: no simulation
COVERED_SHARE = 0.9          # below this share (or as far above 1) the difference is reported with the mesh
_PARTNER_TOL = 0.1           # the far wall is found within this share of the thickness (plus the mesh deflection)
MIN_WALL_SHARE = 0.1         # a gap under this share of the part's usual wall is a knife edge or a fold, not a wall to flow through
PULL_MAX_TRIANGLES = 6000    # the mold opening direction is chosen automatically up to this many surface triangles (4 000 took 2 s, 16 000 took 17 s)
UNDRAFTED_DEG = 0.3          # the plastic domain's own threshold (InjectionMoldedFeatureExtractor.UNDRAFTED_DEG), for the opening direction
_SMOOTH = 0.98               # mean length of the unit normals around a node: below this the node is on a crease (about 11 degrees either way)
_SLIDE_PASSES = 30           # how far the sideways move of a crease spreads, in elements (about its square root)


def _welded(corners: np.ndarray, face_of: np.ndarray, grid: float, centre: np.ndarray) -> FillMesh:
    """Triangles given by their corner coordinates as a mesh with shared nodes; a triangle that collapses onto an edge is dropped."""
    _, first, ids = np.unique(np.round(corners.reshape(-1, 3) / grid).astype(np.int64), axis=0, return_index=True, return_inverse=True)
    tri = ids.reshape(-1, 3)
    real = (tri[:, 0] != tri[:, 1]) & (tri[:, 1] != tri[:, 2]) & (tri[:, 2] != tri[:, 0])
    return FillMesh(corners.reshape(-1, 3)[first], tri[real], np.zeros(int(real.sum())), face_of[real], centre)


def _rays_for(face: np.ndarray, area: np.ndarray) -> np.ndarray:
    """Which triangles get a thickness ray. All of them on a part of ordinary size. On a detailed one: the largest triangle of every CAD face (so
    every face can be decided), then the largest of the rest while the work allows; the small ones left take their thickness from their neighbours."""
    n = len(area)
    faces = int(len(np.unique(face)))
    rays = max(faces, min(n, RAY_WORK // max(n, 1)))
    if rays * n > RAY_WORK_MAX:
        raise ValueError(f"This part is too detailed to mesh for a fill simulation yet: {n} surface triangles on {faces} faces.")
    if rays >= n:
        return np.ones(n, bool)
    chosen = np.zeros(n, bool)
    order = np.lexsort((-area, face))
    chosen[order[np.concatenate([[True], face[order][1:] != face[order][:-1]])]] = True
    rest = np.flatnonzero(~chosen)
    chosen[rest[np.argsort(-area[rest])[:max(0, rays - int(chosen.sum()))]]] = True
    return chosen


def _triangle_thickness(corners: np.ndarray, normal: np.ndarray, area: np.ndarray, deflection: float, chosen: np.ndarray) -> np.ndarray:
    """Shrinking-ball thickness of the chosen triangles (NaN for the others, and where no ray left the material), through the existing
    wall-thickness code: each chosen triangle is handed to it as a face of its own, so each gets its own reading; the rest go in as one more
    face, there for the rays to hit."""
    as_tuple = lambda p: (float(p[0]), float(p[1]), float(p[2]))
    triangle = lambda k: Triangle(as_tuple(corners[k].mean(axis=0)), as_tuple(normal[k]), float(area[k]), tuple(as_tuple(p) for p in corners[k]))
    own = np.flatnonzero(chosen)
    meshes = [FaceMesh(index=i, surface="other", area=float(area[k]), triangles=[triangle(k)]) for i, k in enumerate(own)]
    others = np.flatnonzero(~chosen)
    if len(others):
        meshes.append(FaceMesh(index=len(own), surface="other", area=float(area[others].sum()), triangles=[triangle(k) for k in others]))
    out = np.full(len(corners), np.nan)
    for f in measure_wall_thickness(meshes, deflection)["faces"]:
        if f["face_id"] < len(own):
            out[own[f["face_id"]]] = f["thickness_mm"]
    return out


def _partners(v: np.ndarray, n: np.ndarray, t: np.ndarray, tol: np.ndarray, deadline: Optional[float] = None) -> Tuple[np.ndarray, np.ndarray]:
    """For each triangle, the triangle facing it on the far side of the wall (or -1): the one containing the point p - n t, with its normal opposed;
    and the gap to it, which is the wall thickness there. The ball thickness t only says where to look: within half a wall of a free edge the ball
    is cut short by the rim (a 2.5 mm wall read 2.19 mm), the gap is not."""
    centroid = v.mean(axis=1)
    lo, hi = v.min(axis=1), v.max(axis=1)
    e1, e2 = v[:, 1] - v[:, 0], v[:, 2] - v[:, 0]
    d00, d01, d11 = (e1 * e1).sum(1), (e1 * e2).sum(1), (e2 * e2).sum(1)
    inv = 1.0 / np.maximum(d00 * d11 - d01 * d01, 1e-18)
    partner, gap = np.full(len(v), -1), np.full(len(v), np.nan)
    for count, i in enumerate(np.flatnonzero(np.isfinite(t))):
        if count % 256 == 0:
            check_time(deadline, "pairing the two sides of each wall")
        q = centroid[i] - n[i] * t[i]
        cand = np.flatnonzero(np.all((lo - tol[i] <= q) & (hi + tol[i] >= q), axis=1) & ((n @ n[i]) < -0.8) & (np.abs(((q - v[:, 0]) * n).sum(1)) <= tol[i]))
        if not cand.size:
            continue
        w = q - v[cand, 0]
        a, b = (w * e1[cand]).sum(1), (w * e2[cand]).sum(1)
        s = (d11[cand] * a - d01[cand] * b) * inv[cand]
        u = (d00[cand] * b - d01[cand] * a) * inv[cand]
        slack = tol[i] / np.sqrt(np.maximum(d00[cand], 1e-18))
        inside = (s >= -slack) & (u >= -slack) & (s + u <= 1 + slack)
        if inside.any():
            partner[i] = cand[inside][0]
            gap[i] = abs(float((centroid[i] - v[partner[i], 0]) @ n[partner[i]]))
    return partner, gap


def _wall_faces(face: np.ndarray, area: np.ndarray, outward: np.ndarray, partner: np.ndarray, measured: np.ndarray) -> np.ndarray:
    """Which triangles to keep: every triangle of the CAD faces that are the outer skin of a wall (steps 3 and 4 of the module note). A face is
    judged on its measured triangles: the share of their area that faces a far wall."""
    n_faces = int(face.max()) + 1
    paired = partner >= 0
    total = np.bincount(face[measured], area[measured], n_faces)
    facing = np.bincount(face[paired], area[paired], n_faces)
    offset = np.bincount(face[paired], (area * outward)[paired], n_faces) / np.maximum(facing, 1e-300)
    across = np.zeros((n_faces, n_faces))                                   # area of face f whose far wall is face g
    np.add.at(across, (face[paired], face[partner[paired]]), area[paired])
    opposite = across.argmax(axis=1)
    wall = facing >= WALL_FACE_SHARE * np.maximum(total, 1e-300)
    ids = np.arange(n_faces)
    outer = (offset > offset[opposite]) | ((offset == offset[opposite]) & (ids < opposite))
    keep_face = wall & (opposite != ids) & (outer | ~wall[opposite])       # a face facing itself is a solid bar, not a wall
    return keep_face[face]


def _spread_thickness(tri: np.ndarray, thickness: np.ndarray, known: np.ndarray) -> np.ndarray:
    """Thickness for the kept triangles that face no far wall (the strip of a floor under a wall): the mean of their neighbours that have one, spreading outward."""
    thickness = np.where(known, thickness, np.nan)
    pair = np.sort(np.stack([tri, tri[:, [1, 2, 0]]], axis=2), axis=2).reshape(-1, 2)
    order = np.lexsort((pair[:, 1], pair[:, 0]))
    twin = np.flatnonzero((pair[order][1:] == pair[order][:-1]).all(axis=1))
    a, b = order[twin] // 3, order[twin + 1] // 3
    left, right = np.concatenate([a, b]), np.concatenate([b, a])
    for _ in range(len(tri)):
        missing = np.isnan(thickness)
        give = ~missing[left] & missing[right]
        if not give.any():
            break
        total = np.bincount(right[give], thickness[left[give]], len(tri))
        count = np.bincount(right[give], minlength=len(tri))
        thickness = np.where(missing & (count > 0), total / np.maximum(count, 1), thickness)
    return thickness


def _to_mid_surface(nodes: np.ndarray, tri: np.ndarray, n: np.ndarray, t: np.ndarray) -> np.ndarray:
    """Move the kept skin half a wall inward.

    A node on a crease goes to where the half-wall offset planes of its triangles meet (least squares), so the corner of a box lands on the corner of
    the wall's mid-surface: without that a skin over-counts the volume by the wall's share of every bend (9.4 % on a tray). That moves a crease node
    sideways by half a wall; the nodes next to it would be overtaken and their triangles folded, so the sideways part of the move is spread over the
    nodes around (they slide within their own surface) and the strip beside a corner is squeezed evenly instead.
    """
    k = len(nodes)
    count = np.maximum(np.bincount(tri.ravel(), minlength=k), 1)
    outer = np.einsum("mi,mj->mij", n, n).reshape(-1, 9)
    a = np.stack([np.bincount(tri.ravel(), np.repeat(outer[:, c], 3), k) for c in range(9)], axis=1).reshape(k, 3, 3)
    b = np.stack([np.bincount(tri.ravel(), np.repeat(-n[:, c] * t / 2, 3), k) for c in range(3)], axis=1)
    half = np.bincount(tri.ravel(), np.repeat(t, 3), k) / count / 2
    mitre = np.einsum("kij,kj->ki", np.linalg.pinv(a, rcond=1e-2, hermitian=True), b)
    length = np.linalg.norm(mitre, axis=1)
    mitre *= np.minimum(1.0, 2 * half / np.maximum(length, 1e-12))[:, None]     # never further than one wall

    mean_normal = np.stack([np.bincount(tri.ravel(), np.repeat(n[:, c], 3), k) for c in range(3)], axis=1) / count[:, None]
    crease = np.linalg.norm(mean_normal, axis=1) < _SMOOTH                       # the triangles around the node do not share a normal
    unit = mean_normal / np.maximum(np.linalg.norm(mean_normal, axis=1, keepdims=True), 1e-12)
    straight = -half[:, None] * unit
    pair = np.unique(np.sort(np.stack([tri, tri[:, [1, 2, 0]]], axis=2), axis=2).reshape(-1, 2), axis=0)
    i, j = np.concatenate([pair[:, 0], pair[:, 1]]), np.concatenate([pair[:, 1], pair[:, 0]])
    degree = np.maximum(np.bincount(i, minlength=k), 1)[:, None]
    shift = np.where(crease[:, None], mitre, straight)
    for _ in range(_SLIDE_PASSES):
        around = np.stack([np.bincount(i, shift[j, c], k) for c in range(3)], axis=1) / degree
        sideways = around - (around * unit).sum(axis=1, keepdims=True) * unit
        shift = np.where(crease[:, None], mitre, straight + sideways)
    return nodes + shift


def _surface(shape: Any, deflection: float):
    """The tessellated surface as corner coordinates and face ids; a part too detailed for the triangle limit is tessellated more coarsely, up to twice."""
    from OCC.Core.BRepTools import breptools  # type: ignore

    for _ in range(3):
        faces = tessellate_faces(shape, linear_deflection=deflection)
        count = sum(len(f.triangles) for f in faces)
        if count <= SURFACE_LIMIT:
            corners = np.array([t.vertices for f in faces for t in f.triangles], float).reshape(-1, 3, 3)
            return corners, np.array([f.index for f in faces for _ in f.triangles], int), deflection, faces
        breptools.Clean(shape)                                              # the mesher keeps a finer mesh it already has
        deflection *= 3
    raise ValueError(f"This part is too detailed to mesh for a fill simulation yet: {count} surface triangles even at a deflection of {deflection / 3:g} mm.")


def extract_fill_mesh(shape: Any, deflection_mm: Optional[float] = None, target_edge_mm: Optional[float] = None,
                      deadline: Optional[float] = None) -> Tuple[FillMesh, Dict[str, Any]]:
    """The FillMesh of `shape` and a report: counts, the CAD volume against the mesh volume, what was left out, and the mesh's quality issues.
    Past `deadline` (a time.monotonic() value) it stops with TookTooLong."""
    solid = measure_solid(shape)
    diagonal = solid["bounding_box"]["diagonal"]
    corners, face_of, deflection, faces = _surface(shape, deflection_mm or max(0.1, diagonal * 0.001))
    empty = FillMesh(np.zeros((0, 3)), np.zeros((0, 3), int), np.zeros(0), np.zeros(0, int))
    report: Dict[str, Any] = {
        "deflection_mm": round(deflection, 4), "triangles_total": len(corners), "triangles_surface": 0, "triangles_measured": 0, "triangles_kept": 0,
        "triangles_in_mesh": 0,
        "triangles_unmeasured": 0, "detached_pieces": 0, "detached_volume_pct": 0.0, "longest_edge_mm": 0.0, "target_edge_mm": 0.0,
        "resolution_limited": False, "cad_volume_mm3": round(solid["volume"], 2), "mesh_volume_mm3": 0.0, "volume_ratio": None,
        "pull_direction": None,
    }
    if 0 < len(corners) <= PULL_MAX_TRIANGLES:   # the direction the mold opens, chosen as the part analysis chooses it: for the clamp force
        report["pull_direction"] = [round(float(c), 5) for c in choose_pull_direction(faces, UNDRAFTED_DEG).vector]
    if not len(corners):
        return empty, {**report, "issues": [i.as_dict() for i in check(empty)]}

    centre = (corners.reshape(-1, 3).min(axis=0) + corners.reshape(-1, 3).max(axis=0)) / 2
    surface = _welded(corners, face_of, max(deflection * 1e-3, 1e-6), centre)
    surface = surface.refined(diagonal / MEASURE_PER_DIAGONAL, max(MEASURE_ALL, len(surface.triangles) + REFINE_EXTRA))
    v = surface.corners()
    cross = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])
    area = np.linalg.norm(cross, axis=1) / 2
    normal = cross / np.maximum(2 * area, 1e-300)[:, None]
    check_time(deadline, "reading the part")
    measured = _rays_for(surface.face_id, area)
    thickness = _triangle_thickness(v, normal, area, deflection, measured)
    partner, gap = _partners(v, normal, thickness, _PARTNER_TOL * np.nan_to_num(thickness) + deflection, deadline)
    paired = partner >= 0
    if paired.any():   # a near-zero gap is where two faces meet at a knife edge: it reads as a wall 0.01 mm thick, which nothing flows through
        order = np.argsort(gap[paired])
        share = np.cumsum(area[paired][order])
        usual = float(gap[paired][order][np.searchsorted(share, share[-1] / 2)])        # the part's usual wall: the area-weighted median gap
        partner = np.where(paired & (gap < max(2 * deflection, MIN_WALL_SHARE * usual)), -1, partner)
    keep = _wall_faces(surface.face_id, area, ((v.mean(axis=1) - centre) * normal).sum(axis=1), partner, measured & np.isfinite(thickness))
    report.update(triangles_surface=len(v), triangles_measured=int(measured.sum()), triangles_unmeasured=int((measured & np.isnan(thickness)).sum()))
    if not keep.any():
        return empty, {**report, "issues": [i.as_dict() for i in check(empty)]}

    tri = surface.triangles[keep]
    wall = _spread_thickness(tri, gap[keep], partner[keep] >= 0)
    piece = components(tri)
    volume = np.bincount(piece, np.nan_to_num(area[keep] * wall), len(tri))
    body = piece == volume.argmax()
    used, tri = np.unique(tri[body], return_inverse=True)
    tri = tri.reshape(-1, 3)
    nodes = _to_mid_surface(surface.nodes_mm[used], tri, normal[keep][body], np.nan_to_num(wall[body]))
    mesh = FillMesh(nodes, tri, wall[body], surface.face_id[keep][body], centre)
    target = target_edge_mm or EDGE_PER_WALL * float(np.nanmedian(mesh.thickness_mm))
    # Merge away the edges far shorter than the target, cut the ones longer than it, and merge again: bisecting a nearly flat triangle
    # leaves a new edge as short as its height. Twice round settles it; the last word is a clean-up, so no needle is left for the solver.
    for _ in range(2):
        mesh = mesh.cleaned(MIN_EDGE_SHARE * target).refined(target, MAX_FILL_TRIANGLES)
    mesh = mesh.cleaned(MIN_EDGE_SHARE * target)
    # Merging nodes can pinch a neck down to a point. What then hangs by a point is left out like the other detached pieces.
    piece = components(mesh.triangles)
    piece_volume = np.bincount(piece, mesh.areas_mm2() * mesh.thickness_mm, len(piece))
    pinched = int((piece_volume > 0).sum()) - 1
    if pinched > 0:
        main = piece == piece_volume.argmax()
        used, tri = np.unique(mesh.triangles[main], return_inverse=True)
        mesh = FillMesh(mesh.nodes_mm[used], tri.reshape(-1, 3), mesh.thickness_mm[main], mesh.face_id[main], centre)
    ok = solid["volume"] > 0
    report.update(
        triangles_kept=int(body.sum()), triangles_in_mesh=len(mesh.triangles),
        detached_pieces=int((volume > 0).sum()) - 1 + pinched,
        detached_volume_pct=round(100.0 * float(1 - (volume.max() / volume.sum()) * (piece_volume.max() / piece_volume.sum())), 2),
        longest_edge_mm=round(mesh.longest_edge_mm(), 3), target_edge_mm=round(target, 3), resolution_limited=bool(mesh.longest_edge_mm() > target),
        mesh_volume_mm3=round(mesh.volume_mm3(), 2), volume_ratio=round(mesh.volume_mm3() / solid["volume"], 4) if ok else None,
    )
    issues = [i.as_dict() for i in check(mesh)]
    ratio = report["volume_ratio"]
    if ratio is not None and ratio < THIN_WALL_SHARE:
        issues.append({"code": "not_thin_walled", "triangles": [], "message":
                       f"The wall mid-surface holds only {100 * ratio:.0f}% of the part's volume: most of this part is not a thin wall, so a fill of it would not describe the part."})
    elif ratio is not None and not COVERED_SHARE <= ratio <= 2 - COVERED_SHARE:
        issues.append({"code": "volume_mismatch", "triangles": [], "message":
                       f"The mesh holds {100 * ratio:.0f}% of the part's volume. What is missing (ribs, bosses, thick sections) is not in the fill; pressure and fill pattern near it are approximate."})
    return mesh, {**report, "issues": issues}
