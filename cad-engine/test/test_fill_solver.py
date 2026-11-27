"""The fill solver against closed-form Hele-Shaw solutions (plate, strip, disc) and an independent integration of the gap flow."""
import numpy as np
import pytest

from injection_molding.fill_solver import CrossWLF, GapFlow, fill


class Newtonian:
    def __init__(self, eta_pa_s):
        self.eta = eta_pa_s

    def viscosity(self, shear_rate, temp_k):
        return np.full_like(np.asarray(shear_rate, float), self.eta)


class PowerLaw:
    """eta = K rate^(n-1): the one shear-thinning melt with a closed-form slit flow."""

    def __init__(self, k, n):
        self.k, self.n = k, n

    def viscosity(self, shear_rate, temp_k):
        return self.k * np.asarray(shear_rate, float) ** (self.n - 1)


PP = CrossWLF(n=0.3, tau_pa=2.5e4, d1=1e12, d2_k=263.15, a1=25.0, a2_k=51.6)   # test constants, not a real grade


def plate(length, width, nx, ny):
    """Structured triangle mesh of a length x width plate; returns nodes, triangles, left-edge node ids."""
    x, y = np.meshgrid(np.linspace(0, length, nx + 1), np.linspace(0, width, ny + 1), indexing='ij')
    nodes = np.column_stack([x.ravel(), y.ravel(), np.zeros(x.size)])
    ids = np.arange(x.size).reshape(nx + 1, ny + 1)
    a, b, c, d = ids[:-1, :-1].ravel(), ids[1:, :-1].ravel(), ids[1:, 1:].ravel(), ids[:-1, 1:].ravel()
    return nodes, np.vstack([np.column_stack([a, b, c]), np.column_stack([a, c, d])]), ids[0]


def disc(radius, rings, sectors):
    """Polar triangle mesh with the centre node 0."""
    r = np.linspace(0, radius, rings + 1)[1:]
    ang = np.linspace(0, 2 * np.pi, sectors, endpoint=False)
    ring = lambda i: 1 + i * sectors + np.arange(sectors)
    nodes = np.vstack([[0, 0, 0]] + [np.column_stack([ri * np.cos(ang), ri * np.sin(ang), np.zeros(sectors)]) for ri in r])
    tri = [np.column_stack([np.zeros(sectors, int), ring(0), np.roll(ring(0), -1)])]
    for i in range(rings - 1):
        a, b, c, d = ring(i), ring(i + 1), np.roll(ring(i + 1), -1), np.roll(ring(i), -1)
        tri += [np.column_stack([a, b, c]), np.column_stack([a, c, d])]
    return nodes, np.vstack(tri)


STRIP = dict(length=100.0, width=20.0, h=2.0, q=5000.0)      # mm, mm, mm, mm3/s


def strip_fill(rheology, temp_k=503.15):
    nodes, tri, gate = plate(STRIP["length"], STRIP["width"], 40, 8)
    return nodes, fill(nodes, tri, np.full(len(tri), STRIP["h"]), gate, STRIP["q"], rheology, temp_k)


def strip_pressure_mpa(gradient_pa_per_m, filled=1.0):
    return gradient_pa_per_m * filled * STRIP["length"] * 1e-3 * 1e-6


FLUX = STRIP["q"] * 1e-9 / (STRIP["width"] * 1e-3)            # m2/s per width
GAP = STRIP["h"] * 1e-3


def test_the_clock_and_the_injected_volume_agree_exactly_and_a_strip_fills_linearly():
    nodes, r = strip_fill(Newtonian(500.0))
    total = STRIP["length"] * STRIP["width"] * STRIP["h"] / STRIP["q"]
    assert np.nanmax(r.fill_time_s) == pytest.approx(total, rel=1e-9)          # t = V / Q, to rounding
    assert np.nanmax(np.abs(r.fill_time_s - nodes[:, 0] / STRIP["length"] * total)) < 0.03 * total


def test_newtonian_strip_pressure_matches_hele_shaw():
    _, r = strip_fill(Newtonian(500.0))
    gradient = 12 * 500.0 * FLUX / GAP ** 3                                      # dp/dx = 12 eta q / h^3
    assert r.switchover_pressure_mpa(0.95) == pytest.approx(strip_pressure_mpa(gradient, 0.95), rel=0.03)
    assert r.switchover_pressure_mpa(0.5) == pytest.approx(strip_pressure_mpa(gradient, 0.5), rel=0.03)
    wet = r.wall_shear_stress_mpa > 0
    assert np.median(r.wall_shear_stress_mpa[wet]) == pytest.approx(gradient * GAP / 2 * 1e-6, rel=0.02)   # tau_wall = (h / 2) dp/dx
    assert np.median(r.wall_shear_rate_1_s[wet]) == pytest.approx(6 * FLUX / GAP ** 2, rel=0.02)            # Newtonian wall shear rate


@pytest.mark.parametrize("n", [0.25, 0.4, 0.7])
def test_power_law_strip_pressure_matches_the_exact_slit_flow_solution(n):
    k = 8000.0
    _, r = strip_fill(PowerLaw(k, n))
    gradient = (2 * k / GAP) * (2 * FLUX * (2 * n + 1) / (n * GAP ** 2)) ** n    # from q = n/(2n+1) (h^2/2) (dp/dx h / 2K)^(1/n)
    assert r.switchover_pressure_mpa(0.95) == pytest.approx(strip_pressure_mpa(gradient, 0.95), rel=0.03)


def test_the_gap_flow_table_matches_a_brute_force_integration_of_cross_wlf():
    temp = 503.15
    law = GapFlow(PP, temp)
    for wall_stress in (2e3, 2e4, 1.5e5, 6e5):                                   # Newtonian plateau through deep shear thinning
        tau = np.linspace(0, wall_stress, 4001)[1:]
        lo, hi = np.full_like(tau, 1e-9), np.full_like(tau, 1e12)
        for _ in range(200):                                                     # bisection for rate(tau): eta(rate) rate = tau
            mid = np.sqrt(lo * hi)
            low = PP.viscosity(mid, temp) * mid < tau
            lo, hi = np.where(low, mid, lo), np.where(low, hi, mid)
        integrand = tau * np.sqrt(lo * hi)
        psi = (integrand.sum() - integrand[-1] / 2) * (tau[1] - tau[0]) / wall_stress ** 2   # trapezoid from 0
        q = GAP ** 2 / 2 * psi
        s, stress = law.fluidity(np.array([q]), np.array([GAP]))
        assert stress[0] == pytest.approx(wall_stress, rel=5e-3)
        assert s[0] == pytest.approx(q * GAP / (2 * wall_stress), rel=5e-3)


def test_cross_wlf_strip_agrees_with_its_gap_flow_and_shear_thinning_lowers_the_pressure():
    _, r = strip_fill(PP)
    _, stress = GapFlow(PP, 503.15).fluidity(np.array([FLUX]), np.array([GAP]))
    assert r.switchover_pressure_mpa(0.95) == pytest.approx(strip_pressure_mpa(2 * stress[0] / GAP, 0.95), rel=0.03)
    _, zero_shear = strip_fill(Newtonian(float(PP.viscosity(np.array(1e-6), 503.15))))
    assert r.switchover_pressure_mpa() < 0.2 * zero_shear.switchover_pressure_mpa()


def test_disc_front_stays_circular_and_fills_in_v_over_q():
    radius, h, q = 50.0, 2.0, 4000.0
    nodes, tri = disc(radius, 25, 48)
    r = fill(nodes, tri, np.full(len(tri), h), [0], q, Newtonian(300.0), 500.0)
    mesh_volume = 0.5 * 48 * radius ** 2 * np.sin(2 * np.pi / 48) * h             # the 48-gon the mesh really is
    assert np.nanmax(r.fill_time_s) == pytest.approx(mesh_volume / q, rel=1e-9)
    rad = np.hypot(nodes[:, 0], nodes[:, 1])
    expected = np.pi * rad ** 2 * h / q                                           # an expanding circle
    assert np.nanmax(np.abs(r.fill_time_s - expected)) < 0.06 * expected.max()


def two_channels(thick, thin, header=8.0, length=120.0, width=40.0, lead=20.0, nx=70, ny=16):
    """A thick header feeding two side-by-side channels that do not touch each other: both start together, at the same pressure."""
    nodes, tri, gate = plate(length + lead, width, nx, ny)
    nodes = nodes.copy()
    nodes[:, 0] -= lead
    centre = nodes[tri].mean(axis=1)
    h = np.where(centre[:, 0] < 0, header, np.where(centre[:, 1] < width / 2, thick, thin))
    split = np.flatnonzero((np.abs(nodes[:, 1] - width / 2) < 1e-9) & (nodes[:, 0] > 1e-9))   # the wall between the channels: its nodes are doubled
    copy = dict(zip(split.tolist(), range(len(nodes), len(nodes) + len(split))))
    nodes = np.vstack([nodes, nodes[split]])
    tri = tri.copy()
    for e in np.flatnonzero((centre[:, 1] > width / 2) & (centre[:, 0] > 0)):
        tri[e] = [copy.get(int(v), int(v)) for v in tri[e]]
    return nodes, tri, h, gate, width


@pytest.mark.parametrize("melt", [Newtonian(400.0), PowerLaw(8000.0, 0.35)], ids=["newtonian", "power law n=0.35"])
def test_race_tracking_two_channels_at_one_pressure_advance_in_the_ratio_of_their_thicknesses(melt):
    # dx/dt = q / h and q ~ h^((2n+1)/n) (P/x)^(1/n) give x^((n+1)/n) ~ h^((n+1)/n) * integral(P^(1/n) dt): whatever the pressure does,
    # the two fronts stay in the ratio of the thicknesses. Filling a whole front per solve gives 1.03 here instead of 2.
    thick, thin = 3.0, 1.5
    nodes, tri, h, gate, width = two_channels(thick, thin)
    r = fill(nodes, tri, h, gate, 20000.0, melt, 500.0)
    along = lambda y: np.flatnonzero((np.abs(nodes[:, 1] - y) < 1e-9) & (nodes[:, 0] > 0))
    a, b = along(width / 4), along(3 * width / 4)
    a, b = a[np.argsort(nodes[a, 0])], b[np.argsort(nodes[b, 0])]
    for x_thin in (25.0, 35.0, 45.0, 55.0):                                      # while the thick channel is still filling
        t = np.interp(x_thin, nodes[b, 0], r.fill_time_s[b])
        assert np.interp(t, r.fill_time_s[a], nodes[a, 0]) / x_thin == pytest.approx(thick / thin, rel=0.04)


def test_a_region_the_melt_cannot_reach_is_reported_as_unfilled():
    nodes, tri, gate = plate(40.0, 10.0, 8, 2)
    assert not np.isnan(fill(nodes, tri, np.full(len(tri), 2.0), gate, 1000.0, Newtonian(300.0), 500.0).fill_time_s).any()
    far = np.vstack([nodes, nodes + [500, 0, 0]])
    tri2 = np.vstack([tri, tri + len(nodes)])
    r = fill(far, tri2, np.full(len(tri2), 2.0), gate, 1000.0, Newtonian(300.0), 500.0)
    assert np.isnan(r.fill_time_s[len(nodes):]).all()                            # the detached island never fills
    assert r.filled_fraction[-1] == pytest.approx(0.5, rel=1e-6)


def test_a_viscosity_curve_whose_stress_does_not_rise_is_refused():
    class Broken:
        def viscosity(self, shear_rate, temp_k):
            return 1e3 / np.asarray(shear_rate, float) ** 1.5                    # stress falls as rate rises

    with pytest.raises(ValueError, match="shear stress"):
        GapFlow(Broken(), 500.0)


def test_a_run_past_its_time_budget_stops_with_a_clear_reason_instead_of_running_on():
    import time

    from injection_molding.fill_mesh import TookTooLong

    nodes, tri, gate = plate(100.0, 20.0, 40, 8)
    with pytest.raises(TookTooLong, match="ran out of time while filling the cavity"):
        fill(nodes, tri, np.full(len(tri), 2.0), gate, 5000.0, Newtonian(500.0), 500.0, deadline=time.monotonic() - 1)
    assert isinstance(TookTooLong("x"), ValueError)                               # the route answers a ValueError with 422, never a 5xx
