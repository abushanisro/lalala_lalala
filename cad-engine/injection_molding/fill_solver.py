"""Injection mold filling: generalized Hele-Shaw flow on a thin-wall surface mesh (Hieber & Shen 1980).

  flow per width   q = -S grad(p);  continuity: div(S grad p) = 0 behind the front, p = 0 at the front
  fluidity         exact for a generalized Newtonian melt between parallel walls. Shear stress is linear across the gap, tau(z) = |grad p| z, which gives
                   q = (h^2 / 2) Psi(tau_wall),  Psi(t) = (1 / t^2) * integral_0^t tau rate(tau) dtau.
                   Psi is tabulated once per run from the material's viscosity curve; then S = q h / (2 tau_wall). No single "representative" shear rate.
  melt front       control-volume advance: a node fills when the volume that has flowed in equals its own volume. One pressure solve per arrival (nodes
                   arriving together share one): filling more of the front per solve erases race-tracking (measured: front ratio 1.03 where 2.0 is exact).
                   The clock advances by the volume actually placed / flow rate, so the injected volume and the clock never disagree.

Isothermal: the melt stays at `temp_k`. No freezing, packing, compressibility or pressure-dependent viscosity (Cross-WLF D3).
Units in: mm, mm^3/s, K. Out: s, MPa, 1/s. numpy only (no scipy): the pressure solve is a conjugate gradient with a two-level preconditioner.
"""
from dataclasses import dataclass
from typing import Optional, Protocol

import numpy as np

from .fill_mesh import check_time

MM = 1e-3  # mesh and flow rate arrive in mm
SAME_STEP = 0.02  # front nodes due within 2 % of the next arrival fill in the same step: a symmetric front is not split by rounding
CLUSTER = 20      # nodes per cluster of the preconditioner's coarse space
REGROWN = 0.05    # the coarse solve is rebuilt once the melt has reached this share more nodes; until then the last one still preconditions
SETTLED = 0.02    # the shear-thinning iteration stops when no element's fluidity would move its flow by more than 2 % of the largest flow


class Rheology(Protocol):
    def viscosity(self, shear_rate: np.ndarray, temp_k: float) -> np.ndarray: ...


@dataclass(frozen=True)
class CrossWLF:
    """Cross-WLF viscosity (Pa s). n, tau (Pa), d1 (Pa s), d2 (K), a1, a2 (K); the pressure term D3 is not modelled."""
    n: float
    tau_pa: float
    d1: float
    d2_k: float
    a1: float
    a2_k: float

    def viscosity(self, shear_rate, temp_k):
        dt = temp_k - self.d2_k
        eta0 = self.d1 * np.exp(-self.a1 * dt / (self.a2_k + dt))
        return eta0 / (1.0 + (eta0 * shear_rate / self.tau_pa) ** (1.0 - self.n))


@dataclass(frozen=True)
class Newtonian:
    """One viscosity (Pa s) at every shear rate and temperature: what a single reference number, such as a flow length ratio, can support."""
    eta_pa_s: float

    def viscosity(self, shear_rate, temp_k):
        return np.full_like(np.asarray(shear_rate, float), self.eta_pa_s)


class GapFlow:
    """The flow law of the melt in a gap at one temperature: Psi(tau_wall), tabulated from the viscosity curve, and its inverse."""

    def __init__(self, rheology: Rheology, temp_k: float):
        rate = np.logspace(-4, 8, 721)                         # 1/s, 60 points per decade: far wider than any molding shear rate
        tau = rheology.viscosity(rate, temp_k) * rate          # Pa
        if not (np.all(np.isfinite(tau)) and np.all(np.diff(tau) > 0)):
            raise ValueError("the viscosity curve must give a shear stress that rises with shear rate")
        f = tau * rate                                         # the integrand of integral tau rate dtau
        power = np.diff(np.log(f)) / np.diff(np.log(tau))      # between points the integrand is a power of tau: exact on Newtonian and power-law ranges
        pieces = (f[1:] * tau[1:] - f[:-1] * tau[:-1]) / (power + 1)
        integral = tau[0] ** 2 * rate[0] / 3 + np.concatenate([[0.0], np.cumsum(pieces)])   # Newtonian below the first point
        self.log_psi, self.log_tau, self.log_rate = np.log(integral / tau ** 2), np.log(tau), np.log(rate)

    def fluidity(self, q, h):
        """S (m^3 / Pa s) and the wall shear stress (Pa) for a flow q (m^2/s per width) through a gap h (m)."""
        log_psi = np.log(np.maximum(2 * q / h ** 2, 1e-300))
        below = log_psi < self.log_psi[0]                      # slower than the table: the Newtonian plateau, where stress is proportional to flow
        log_tau = np.where(below, self.log_tau[0] + log_psi - self.log_psi[0], np.interp(log_psi, self.log_psi, self.log_tau))
        return h ** 3 / 4 * np.exp(log_psi - log_tau), np.exp(log_tau)

    def wall_rate(self, tau):
        """Shear rate at the wall (1/s) for a wall shear stress (Pa)."""
        log_tau = np.log(np.maximum(tau, 1e-300))
        below = log_tau < self.log_tau[0]
        return np.exp(np.where(below, self.log_rate[0] + log_tau - self.log_tau[0], np.interp(log_tau, self.log_tau, self.log_rate)))


@dataclass
class FillResult:
    fill_time_s: np.ndarray            # per node; NaN where the melt never arrived (a region with no path from the gate)
    front_velocity_mm_s: np.ndarray    # per triangle (M, 3): the gap-averaged melt velocity as the front closed the triangle; 0 where it never did
    pressure_mpa: np.ndarray           # per node, at the velocity/pressure switchover
    wall_shear_stress_mpa: np.ndarray  # per triangle, at the switchover
    wall_shear_rate_1_s: np.ndarray    # per triangle, at the switchover
    time_s: np.ndarray                 # per advance step
    inlet_pressure_mpa: np.ndarray     # gate pressure at each step: the pressure the machine must deliver
    filled_fraction: np.ndarray        # share of the part volume filled at each step

    def switchover_pressure_mpa(self, fraction: float = 0.99) -> float:
        """Gate pressure at `fraction` of the volume filled: the machine's velocity/pressure switchover point.

        The last node to fill takes the whole flow, so the final step overstates the pressure the machine sees.
        """
        return float(np.interp(fraction, self.filled_fraction, self.inlet_pressure_mpa))


def element_geometry(xyz: np.ndarray, tri: np.ndarray):
    """Triangle areas and shape-function gradients (M, 3, 3) in the element plane (works for a surface in 3-D)."""
    p = xyz[tri]
    n = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
    area = np.linalg.norm(n, axis=1) / 2
    n_hat = n / (2 * area)[:, None]
    opposite = np.stack([p[:, 2] - p[:, 1], p[:, 0] - p[:, 2], p[:, 1] - p[:, 0]], axis=1)
    grad = np.cross(n_hat[:, None, :], opposite) / (2 * area)[:, None, None]
    return area, grad


def _dot(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.einsum('i,i->', a, b))       # einsum keeps to numpy's own loops (see _inverse)


def _cg(matvec, b, x, precondition, tol=1e-5, max_iter=5000):
    """Preconditioned conjugate gradient for a symmetric positive definite operator; `x` is the warm start. The tolerance is on the residual
    against the source: at 1e-5 a real part's fill times and pressures are those of 1e-8 (to 0.0002 MPa) in two thirds of the time."""
    r = b - matvec(x)
    z = precondition(r)
    d = z.copy()
    rz, stop = _dot(r, z), (tol * tol) * _dot(b, b)
    for _ in range(max_iter):
        if _dot(r, r) <= stop:
            break
        ad = matvec(d)
        a = rz / _dot(d, ad)
        x, r = x + a * d, r - a * ad
        z = precondition(r)
        rz, rz_old = _dot(r, z), rz
        d = z + (rz / rz_old) * d
    return x


def _inverse(a: np.ndarray) -> np.ndarray:
    """Inverse of a small symmetric positive definite matrix by Gauss-Jordan sweeps (no pivoting is needed), in numpy's own loops.
    numpy.linalg hands a matrix of this size to the BLAS thread pool, whose idle threads spin between calls: on ten cores a fill
    took six times as long and forty times the processor time. Nothing in the fill loop goes through that pool."""
    a = a.copy()
    for k in range(len(a)):
        pivot = a[k, k]
        row, column = a[k] / pivot, a[:, k].copy()
        a -= column[:, None] * row
        a[k], a[:, k] = row, -column / pivot
        a[k, k] = 1.0 / pivot
    return a


def _clusters(xyz: np.ndarray) -> np.ndarray:
    """Nodes grouped into compact patches of at most CLUSTER, by halving the set along its longest extent until each part is small enough
    (the leaves of a k-d tree). The patches hold the same number of nodes whatever the local mesh density: a uniform grid of cells put
    hundreds of nodes of a finely meshed fillet into one patch, where the coarse solve then did nothing."""
    out = np.zeros(len(xyz), np.int64)
    parts, count = [np.arange(len(xyz))], 0
    while parts:
        ids = parts.pop()
        if len(ids) <= CLUSTER:
            out[ids] = count
            count += 1
            continue
        p = xyz[ids]
        order = np.argsort(p[:, int(np.ptp(p, axis=0).argmax())], kind="stable")
        parts += [ids[order[:len(ids) // 2]], ids[order[len(ids) // 2:]]]
    return out


def fill(nodes_mm, triangles, thickness_mm, gate_nodes, flow_mm3_s, rheology: Rheology, temp_k: float,
         switchover: float = 0.99, iterations: int = 30, deadline: Optional[float] = None) -> FillResult:
    """Fill the mesh from `gate_nodes` at a constant flow rate; `switchover` is the filled share at which the pressure field is recorded.
    Past `deadline` (a time.monotonic() value) the run stops with TookTooLong."""
    xyz = np.asarray(nodes_mm, float) * MM
    tri = np.asarray(triangles, int)
    h = np.asarray(thickness_mm, float) * MM
    gate = np.unique(np.asarray(gate_nodes, int))
    q_in = flow_mm3_s * MM ** 3
    n_nodes = len(xyz)

    area, grad = element_geometry(xyz, tri)
    ke_unit = area[:, None, None] * np.einsum('mik,mjk->mij', grad, grad)   # element stiffness for S = 1
    volume = np.bincount(tri.ravel(), np.repeat(area * h / 3, 3), n_nodes)  # node control volumes
    law = GapFlow(rheology, temp_k)
    # Coarse space of the two-level preconditioner. Pressure is long-range, and a diagonal preconditioner alone needs iterations in proportion to
    # the mesh width; one small dense solve over clusters of nodes carries the long-range part.
    cluster = _clusters(xyz)
    n_clusters = int(cluster.max()) + 1
    pair = (cluster[tri][:, :, None] * n_clusters + cluster[tri][:, None, :]).reshape(len(tri), 9)

    full = np.zeros(n_nodes, bool)
    full[gate] = True
    fraction = full.astype(float)
    t = volume[gate].sum() / q_in                                           # the gate's own control volume fills first
    fill_time = np.where(full, t, np.nan)
    source = np.zeros(n_nodes)
    source[gate] = q_in * volume[gate] / volume[gate].sum()
    flux, stress, p = np.zeros(len(tri)), np.zeros(len(tri)), np.zeros(n_nodes)
    wet = np.zeros(len(tri), bool)
    closed = full[tri].all(axis=1)                                          # triangles the front has fully passed
    velocity = np.zeros((len(tri), 3))
    times, inlet, at_switchover = [], [], None
    coarse_inverse, coarse_nodes = np.zeros((n_clusters, n_clusters)), 0

    while True:
        check_time(deadline, "filling the cavity")
        active = full[tri].any(axis=1)
        front = np.zeros(n_nodes, bool)
        front[tri[active].ravel()] = True
        front &= ~full
        if not front.any():
            break
        fresh = active & ~wet
        if wet.any() and fresh.any():      # a newly wetted element starts from the flow around it, not from rest (the stiff zero-shear plateau)
            around = np.bincount(tri[wet].ravel(), np.repeat(flux[wet], 3), n_nodes) / np.maximum(np.bincount(tri[wet].ravel(), minlength=n_nodes), 1)
            flux[fresh] = around[tri[fresh]].max(axis=1)
        wet = active
        idx = np.flatnonzero(active)
        et, g, he = tri[idx], grad[idx], h[idx]
        s, _ = law.fluidity(flux[idx], he)
        for _ in range(iterations):
            ke = ke_unit[idx] * s[:, None, None]
            apply = lambda x: np.bincount(et.ravel(), np.einsum('mij,mj->mi', ke, x[et]).ravel(), n_nodes)
            diag = np.where(full, np.bincount(et.ravel(), np.einsum('mii->mi', ke).ravel(), n_nodes), 1.0)
            if full.sum() > (1 + REGROWN) * coarse_nodes:                  # any fixed positive definite preconditioner serves conjugate gradients
                fe = full[et]
                coarse = np.bincount(pair[idx].ravel(), (ke * fe[:, :, None] * fe[:, None, :]).ravel(), n_clusters ** 2).reshape(n_clusters, n_clusters)
                reached = np.flatnonzero(coarse.diagonal() > 0)            # the clusters the melt is in
                coarse_inverse = np.zeros_like(coarse)
                coarse_inverse[np.ix_(reached, reached)] = _inverse(coarse[np.ix_(reached, reached)])
                coarse_nodes = int(full.sum())
            precondition = lambda r: np.where(full, r / diag + np.einsum('ij,j->i', coarse_inverse, np.bincount(cluster, r, n_clusters))[cluster], 0.0)
            p = _cg(lambda x: np.where(full, apply(np.where(full, x, 0.0)), 0.0), source * full, p * full, precondition)
            slope = np.einsum('mi,mik->mk', p[et], g)                       # grad p in each triangle
            steep = np.linalg.norm(slope, axis=1)
            flux[idx] = s * steep
            used, (s, tau) = s, law.fluidity(flux[idx], he)
            if (np.abs(s / used - 1) * flux[idx]).max() <= SETTLED * flux[idx].max():   # the fluidity the flow implies is the one it was solved with
                break
        stress[idx] = tau

        inflow = np.clip(-apply(p), 0, None) * front
        if inflow.sum() == 0:              # a front no flow reaches (numerically enclosed): it fills last
            fill_time[front] = t
            break
        inflow *= q_in / inflow.sum()
        nodes = np.flatnonzero(inflow > 0)
        room = (1 - fraction[nodes]) * volume[nodes]
        remaining = room / inflow[nodes]
        dt = remaining.min() * (1 + SAME_STEP)
        gain = np.minimum(inflow[nodes] * dt, room)
        pace = gain.sum() / (q_in * dt)    # the little that overflows nodes filling together shortens the step: the clock follows the volume placed
        arrived = remaining <= dt
        fill_time[nodes[arrived]] = t + np.minimum(remaining[arrived], dt * pace)   # no later than the step itself ends
        fraction[nodes] += gain / volume[nodes]
        fraction[nodes[arrived]], full[nodes[arrived]] = 1.0, True
        closing = full[et].all(axis=1) & ~closed[idx]                       # the pressure field is smooth, arrival times are not: direction comes from here
        velocity[idx[closing]] = -slope[closing] * (flux[idx[closing]] / (he[closing] * np.maximum(steep[closing], 1e-300)))[:, None]
        closed[idx[closing]] = True
        t += dt * pace
        times.append(t)
        inlet.append(np.average(p[gate], weights=volume[gate]) / 1e6)
        if at_switchover is None and q_in * t >= switchover * volume.sum():
            at_switchover = (p.copy(), stress.copy())
    p_field, tau_field = at_switchover or (p, stress)
    return FillResult(fill_time, velocity / MM, p_field / 1e6, tau_field / 1e6, law.wall_rate(tau_field) * (tau_field > 0), np.array(times),
                      np.array(inlet), q_in * np.array(times) / volume.sum())
