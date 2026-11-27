# Injection fill simulation: design note

Status: filling simulation built end to end (engine route, backend endpoint, workspace on the Manufacturing Intelligence page) and tested
against closed-form solutions and known shapes. **Not validated against a molded part. No accuracy claim beyond the cases in this note.**

## What it is, and what it is not

A generalized Hele-Shaw (2.5D, thin-wall) filling solver built from the published method (Hieber & Shen 1980), not from any vendor's code.
It answers: how the cavity fills from one gate, at what pressure, which way the melt runs, where fronts meet and where the air ends up.

It is **isothermal** and **filling only**. It does not model cooling or freezing, packing, shrinkage, sink marks, warpage, fibre orientation,
runners or more than one gate location's balance. Those are listed at the end with what each needs.

## Layers (each knows only the one below)

```
STEP ─fill_mesh_extract─▶ FillMesh ─fill_solver.fill─▶ FillResult ─fill_results─▶ weld lines, end of fill, clamp force, issues
(OpenCASCADE)             (arrays)                     (arrays)                    (arrays)
                    fill_simulation.simulate() packs it as JSON  ◀── POST /simulate/fill (main.py)
```

| File | OpenCASCADE | Job |
|---|---|---|
| `fill_solver.py` | no | the physics: pressure solve, front advance, shear |
| `fill_mesh.py` | no | the mesh contract, refinement, gate lookup, quality checks |
| `fill_results.py` | no | what an engineer reads off a fill |
| `fill_mesh_extract.py` | yes | STEP shape to `FillMesh` |
| `fill_simulation.py` | via extract | the request model, the run, the JSON |

numpy only. scipy is not in the production image and is not needed.

## The solver

- **Flow law.** For a generalized Newtonian melt between parallel walls the shear stress is linear across the gap, so the flow per width is
  `q = (h²/2) Ψ(τ_wall)` with `Ψ(τ) = (1/τ²) ∫₀^τ τ' γ̇(τ') dτ'`. Ψ is tabulated once per run from the viscosity curve and inverted by
  interpolation; the fluidity is `S = q h / (2 τ_wall)`. This is exact for any viscosity function. The first version used one "representative"
  shear rate (6q/h²); for n = 0.3 that under-predicts pressure by about 16 %, so it was replaced.
- **Viscosity.** Either the grade's own Cross-WLF constants (the pressure term D3 is not modelled), or one number estimated from the
  reference data (next section).
- **Pressure.** `div(S grad p) = 0` on linear triangles, `p = 0` at the front, constant flow rate at the gate. Conjugate gradient with a
  two-level preconditioner (Jacobi plus a dense coarse solve over patches of at most 20 nodes, the leaves of a k-d tree), started from the
  last step's pressure: about 20 iterations a step on a plate, 26 on a real part. Residual tolerance 1e-5: on a real part its fill times
  and pressures are those of 1e-8 to 0.0002 MPa.
- **One system after another.** A fill is some 3 000 solves of systems that each differ from the last by one node. The coarse solve is
  therefore kept, and rebuilt only when the melt has reached 5 % more nodes: conjugate gradients accepts any fixed positive definite
  preconditioner, so an older one costs iterations (26 a step instead of 23.5), never accuracy (the switchover pressure moves in the
  sixth figure). Rebuilding it at every step took half of the run.
- **No BLAS thread pool.** numpy passes matrix products and `numpy.linalg` solves of this size to a pool of BLAS threads. The pool's idle
  threads spin between calls, and one call a step keeps them spinning: the same fill took 18 s on an idle ten-core machine and 137 s on a
  busy one, with all ten cores in use throughout (a plate: 69 s and 465 s of processor time, against 11 s single-threaded). The loop
  now uses numpy's own loops only (`einsum`, and a Gauss-Jordan inverse of the small coarse matrix), so a fill uses one core and takes
  the same time whatever else runs. Limiting the pool for the whole engine was not done: other modules' results could move in their
  last digits.
- **Front.** Control-volume advance, one pressure solve per arriving node (nodes arriving together share one). Filling more of the front per
  solve was tried and rejected: on the race-tracking test it gave a front ratio of 1.03 to 1.75 where 2.0 is exact.
- **Bookkeeping.** The clock advances by the volume actually placed over the flow rate, so the fill time equals volume / flow rate to rounding.
- **Direction.** The melt velocity of a triangle is taken from the pressure field at the moment the front closes it. Differentiating arrival
  times instead gives about 20 degrees of noise.

## Inputs: what is automatic, and what the estimate means

The setup fills itself; every value shows where it came from and can be replaced.

| Input | From |
|---|---|
| Fill time | the cost engine's own "Fill Time" for the part (the molding line's calculator) |
| Melt temperature | the grade's material record (`raw_materials.melting_temp_c`) |
| Injection pressure available | the grade's maximum injection pressure less the runner's loss: the cost engine's clamp model, read from that calculation itself |
| Flow length ratio | the grade's material record (`raw_materials.im_flow_length_ratio`): the longest flow path over the wall thickness |
| Mold opening direction | chosen from the part with the analysis's own `choose_pull_direction` (while that takes at most 1.5 million depth-buffer points, about 5 s; the 14 500-triangle back cover takes 0.4 s) |

A grade the reference does not cover gets no numbers: the backend says what is missing (`notes`) and the fields stay empty.

**The reference data holds no viscosity.** What it holds per grade is the flow length ratio R and the injection pressure. A strip R walls
long, filled at a constant rate in time t, needs `P = 12 η R² / t` whatever its thickness, so `η = P t / (12 R²)` is the one viscosity at
which a part at the grade's flow limit needs exactly the pressure available (`estimated_viscosity`; ABS at 127.5 MPa, R = 175, 1.2 s gives
416 Pa s). With it the solver is Newtonian. The fill pattern, weld lines and end of fill do not depend on the number at all; the pressure
says how near the part is to the grade's flow limit. It is an estimate and every run made with it says so (`pressure_estimated`). For a
pressure from the grade's real viscosity curve the engineer switches to its Cross-WLF constants and enters them.

## The mesh

One skin of the part moved to the wall's mid-surface, each triangle with its local wall thickness.

1. Tessellate (`tessellate_faces`), weld, and refine the whole surface so thickness is measured on small triangles.
2. Thickness per triangle with the existing shrinking-ball code (`measure_wall_thickness`, untouched: each measured triangle is handed to
   it as its own face). Thickness costs rays times triangles, so it is the **rays** that are limited, never the part: up to 8 000 surface
   triangles every one is measured; beyond that the largest triangle of every CAD face and then the largest of the rest, the small ones
   taking their wall from their neighbours. (A limit on triangles refused a real back cover outright: it has 10 000 however coarsely it is
   tessellated.)
3. A triangle faces a far wall if a surface facing back lies at `p - n t`. Its wall thickness is the gap to that surface (the ball itself reads
   low within half a wall of a free edge).
   A gap under a tenth of the part's usual wall is a knife edge where two faces meet, not a wall (a real part read 0.01 mm), and is not counted.
4. The skin is chosen **per CAD face**, by area: a face mostly facing a far wall is kept whole, so the strip of a floor under a wall stays with
   the floor. Of two faces facing each other the outer one is kept.
5. Only the largest piece is kept, a piece being triangles joined **edge to edge**. Rib sides and bosses stand on the dropped inner skin;
   they are **not flow channels**, and the report gives their share of the volume. Sharing a single node does not join two pieces: melt
   cannot pass through a point (see the back cover below).
6. Nodes move half a wall inward: a crease node to where its triangles' offset planes meet, its neighbours sliding within their own surface.
7. Clean and refine, twice, then clean: edges under a third of the target are merged away (an end on a crease or a free edge stays put, so
   corners are kept), and edges over the target (2 wall thicknesses, cap 6 000 triangles) are cut by longest-edge bisection with Delaunay
   flips between coplanar triangles of one CAD face.

Each of steps 1, 3, 4, 6 and 7 replaced a simpler version that failed on a real shape: a cup base lost 39 of 48 triangles; a flat face with a
hole stayed a fan of 2 degree needles; flips across a cylinder's facets read a 3 mm wall as 2.3 mm; a mitred corner folded its neighbours.

## Results

| Result | From |
|---|---|
| Fill time per node, melt front at any time | the front advance |
| Pressure per node at the V/P switchover (99 % filled) | the pressure solve at that step |
| Injection pressure against time | gate pressure per step |
| Melt-front velocity vectors | pressure gradient as each triangle closes |
| Wall shear stress and shear rate | exact from the flow law, at switchover |
| Weld lines | edges where the patch-averaged flows on either side run into each other at a meeting angle under 135 degrees, in chains of two or more |
| End of fill; air traps | nodes that fill after everything around them (2 % prominence); an air trap is one not on a free edge |
| Clamp force while filling | pressure times area projected on the parting plane, when a pull axis is given |

Issues reported with a run: `short_shot` (volume with no path from the gate), `pressure_over_limit`, `air_trap`, `weld_line`, `resolution_limited`,
and the mesh's own: `not_thin_walled` (no simulation), `volume_mismatch`, `degenerate_triangle`, `disconnected`, `invalid_thickness`.

## Route and switch

`POST /simulate/fill` (multipart: `file`, `params` JSON = `FillRequest`). Without `gate_mm` it returns the mesh; with a gate, fill time, melt
and the melt's viscosity (Cross-WLF constants with a melt temperature, or a flow length ratio with the pressure available) it returns the
mesh and the fill. Coordinates are part-centred mm, the 3D viewer's frame. The mesh of a file is kept in memory for the next call (the last
four files). One run stops itself after 150 s with a clear answer (422), long before the engine's watchdog would end the process. `FILL_SIMULATION_ENABLED` turns the route off (it answers 404, not 5xx: the
backend's circuit breaker reads a 5xx as an outage); `docker-compose.prod.yml` passes it as off unless the env file says otherwise.

Backend: `POST /api/v1/bom-items/:id/fill-simulations` sends the item's STEP file and relays the answer; `GET
/api/v1/bom-items/:id/fill-simulation-inputs` returns the recommended inputs. Nothing is stored.

## Validation (`test/test_fill_*.py`; all pass in the engine's test image)

| Case | Reference | Result |
|---|---|---|
| Strip and disc, total fill time | volume / flow rate | equal to 1e-9 |
| Strip, fill time along the flow | linear | within 3 % of total |
| Newtonian strip, gate pressure | `12 η q L / h³` | within 3 % at 50 % and 95 % filled (test bound; measured 0.4 % and 0.2 %) |
| Power-law strip, n = 0.25, 0.4, 0.7 | exact slit-flow solution | within 3 % |
| Gap-flow table for Cross-WLF | brute-force integration | within 0.5 % |
| Two channels, thickness 3 and 1.5 mm, one pressure | fronts stay in the ratio 2.0 (Newtonian and power law) | 1.96 to 1.98 |
| Disc, centre gate | expanding circle | within 6 % of total |
| Plate, tray, cup, plate with a hole from STEP | wall, CAD volume | wall within 5 %; volume within 2 % |
| Cup from STEP | mid-surface radius 23.5 mm, base at 1.5 mm | within 0.1 mm |
| Plate, one gate | no weld line, one vented end of fill | as expected |
| Plate, two gates | weld line half way, head on | as expected |
| Plate gated all round | one air trap at the centre | as expected |
| Plate with a hole | weld line directly behind the hole | as expected |
| Cup gated at the rim | weld line on the wall opposite the gate | 41 mm, as expected |
| Cup gated at the base centre | no weld line; rim fills within 3 % | as expected |

These check the mathematics and the mesh on shapes with known answers. None of them is a molded part.

### Real CAD files (robustness only)

15 real STEP parts (machined housings, brackets and shafts: the only real files at hand, none of them a molded part) were run through
extraction and a fill. 14 ran without an error; 1 did not finish meshing within 50 s. Meshing took 2 to 24 s (thickness is measured on up
to 12 000 surface triangles). Two sheet-like parts kept 94 % and 99 % of their volume; the solid ones kept 1 % to 72 %, which is why a mesh
holding under half the CAD volume is now refused (`not_thin_walled`) and one off by more than 10 % is reported (`volume_mismatch`).
Four parts kept some sliver triangles on curved faces (`degenerate_triangle`, reported, not blocking). Nothing here says the numbers are right
on a real part: only that real geometry goes through.

### The first real molded part (a back cover, 16 MB STEP, 14 530 surface triangles, wall 0.6 to 2.8 mm)

It found six faults that no constructed shape had:

| Fault | What it did | Fix |
|---|---|---|
| A limit on surface triangles | the part was refused | the rays are limited instead (step 2) |
| A knife edge read as a wall | "wall 0.01 mm" | gaps under a tenth of the usual wall are not walls |
| Edges of 0.01 mm from small faces and fillets | 175 solver iterations per step, a 113 s fill | short edges merged away (step 7) |
| Rib sides touching the skin at single nodes | the last 1 % forced through a point: 803 MPa at switchover, 115 MPa at 98 % | pieces are joined edge to edge (step 5) |
| The BLAS thread pool, woken once a step | a fill of 18 to 137 s by what else the machine was doing, on ten cores | no call in the fill loop goes through it; the coarse solve is kept between steps |
| A limit of 6 000 surface triangles on choosing the opening direction | no clamp force, though choosing takes 0.4 s | the limit is on the points the chooser samples |

Now: mesh in 15 s, fill in 8 s, 5 508 triangles with edges up to 3.4 mm, gate pressure rising smoothly from 27 MPa at half fill to
114 MPa at switchover (127.5 MPa available by the flow-length estimate). The mesh holds 68 % of the part's volume, 18 % being ribs and
bosses: that is the size of the rib limitation on a ribbed part. The fill pattern of the main wall is modelled; the ribs' own filling and
their share of the pressure are not.

## Performance (one core, numpy)

| Part | Triangles | Extract | Fill |
|---|---|---|---|
| Plate 120 x 60 x 2 with a hole | 2 236 | 1.6 s | 1.0 s |
| Tray 100 x 60 x 15 | 1 940 | 2.4 s | 0.7 s |
| Cup 50 dia x 30 | 1 702 | 5.4 s | 0.6 s |
| Plate, Cross-WLF, 6 480 triangles | 6 480 | | 11.5 s |
| Back cover (real, 14 530 surface triangles) | 5 508 | 15 s | 8 s |

Where the back cover's time goes. Meshing (once per file while the engine runs): thickness rays 6 s, the far-wall search 2 s, volume and
areas 2 s, tessellation 1 s, opening direction 0.4 s, and 2.5 s to read the STEP. Filling: 2 986 solves of 26 iterations at 75 microseconds
an iteration, half in the element product and half in the preconditioner.

What would make it faster, largest first: a compiled kernel for the solve (the loop is numpy calls on 3 000 numbers, so most of its time is
call overhead); advancing a layer of the front per solve with the overflow passed downstream (some 60 solves instead of 3 000, but the
simple version of it fails the race-tracking test, see "Front" above); a spatial index for the thickness rays; keeping the mesh with the
part, so it is made once and not once per engine start.

A second call on the same file skips extraction: 0.24 s end to end for a 1 024-triangle plate through the live route.

## Not built, and what each needs

- **Temperature, frozen layer, freeze time, hesitation, real short shots.** Needs the energy equation across the gap with convection along
  the flow, and mold-side heat transfer. Until then pressure is a lower bound on thin, long flow paths.
- **Packing, volumetric shrinkage, sink marks, warpage.** Needs a compressible stage with pvT (Tait) data per grade.
- **Ribs and bosses as flow channels.** Needs the rib mid-surface joined to the floor mid-surface (a T-junction mesh).
- **Runners, several gates as one system, valve gates.** The solver accepts several gate nodes at a fixed split; a runner network is not modelled.
- **Viscosity data.** None in the reference data. The automatic run uses the flow-length estimate; Cross-WLF constants are entered by hand
  per run and are not stored with the grade.
- **Validation on a molded part.** Needs a part with a measured short-shot sequence or a machine pressure trace.
- **Stored runs.** The gate and inputs are remembered in the browser only; nothing is saved with the part.
