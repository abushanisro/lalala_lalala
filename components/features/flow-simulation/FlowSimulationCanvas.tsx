"use client";

import { Edges, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import type { FillMesh, FillRun, Vec3 } from "@/lib/api/fill-simulation";
import { countUpTo, nodeColours, type ArrowPlan, type Scale } from "@/lib/flow-simulation/display";
import { fitCameraToBox, type Box3Like } from "@/lib/geometry/camera-fit";


const ARROW_COLOUR = "#0f172a";
const GATE_COLOUR = "#d946ef";
const AIR_TRAP_COLOUR = "#dc2626";
const END_OF_FILL_COLOUR = "#0f172a";
/** A click, not the end of an orbit drag (pixels the pointer may move between press and release). */
const CLICK_MAX_DRAG_PX = 4;

export interface FlowSimulationCanvasProps {
  mesh: FillMesh;
  /** Node values of the result on show, and its colour scale. */
  values: readonly (number | null)[];
  scale: Scale | null;
  /** The run on show, or null while only the mesh exists. */
  run: FillRun | null;
  /** Animation time (s): the melt is drawn where it has arrived by then. */
  time: number;
  arrows: ArrowPlan | null;
  showArrows: boolean;
  showWeldLines: boolean;
  showEndOfFill: boolean;
  gate: Vec3 | null;
  /** A click on the part, in the mesh's own part-centred millimetres. */
  onPick: (point: Vec3) => void;
  /** Bump to frame the whole part again. */
  fitNonce: number;
}

/** The fill mesh with the chosen result painted on it, the melt front at `time`, direction arrows, weld lines, end-of-fill points and the gate. */
export function FlowSimulationCanvas(props: FlowSimulationCanvasProps) {
  const { mesh, run, time } = props;
  const bounds = useMemo(() => boundsOf(mesh.nodesMm), [mesh]);
  const size = Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
  const marker = Math.max(0.012 * size, 0.4);
  return (
    <Canvas dpr={[1, 2]} camera={{ fov: 45 }} gl={{ antialias: true, alpha: true }}>
      <Surface mesh={mesh} values={props.values} scale={props.scale} fillTime={run ? run.fillTimeS : null} time={time} onPick={props.onPick} />
      {run && props.arrows && props.showArrows && props.arrows.arrows.length > 0 && <Arrows plan={props.arrows} time={time} />}
      {run && props.showWeldLines && <WeldLines run={run} time={time} />}
      {run && props.showEndOfFill && run.endOfFill.filter((p) => p.timeS <= time + 1e-9).map((p, i) => (
        <Marker key={i} at={p.atMm} radius={marker} colour={p.ventedEdge ? END_OF_FILL_COLOUR : AIR_TRAP_COLOUR} />
      ))}
      {props.gate && <Marker at={props.gate} radius={1.4 * marker} colour={GATE_COLOUR} />}
      <CameraRig bounds={bounds} nonce={props.fitNonce} />
      <OrbitControls makeDefault enableDamping={false} />
    </Canvas>
  );
}

function boundsOf(nodes: readonly Vec3[]): Box3Like {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of nodes) {
    for (let k = 0; k < 3; k++) {
      const value = p[k] ?? 0;
      if (value < (min[k] ?? 0)) min[k] = value;
      if (value > (max[k] ?? 0)) max[k] = value;
    }
  }
  return { min, max };
}

/** The legend is drawn in sRGB; three.js reads vertex colours as linear light, so each channel is converted or the mid-tones would come out pale. */
function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function Surface({ mesh, values, scale, fillTime, time, onPick }: {
  mesh: FillMesh;
  values: readonly (number | null)[];
  scale: Scale | null;
  fillTime: readonly (number | null)[] | null;
  time: number;
  onPick: (point: Vec3) => void;
}) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(mesh.nodesMm.flat()), 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.triangles.flat()), 1));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(3 * mesh.nodesMm.length), 3));
    return g;
  }, [mesh]);
  useEffect(() => () => {
    geometry.dispose();
  }, [geometry]);
  // Unlit, so a colour on the part is exactly the legend's colour; the crease lines (Edges) carry the shape instead of shading.
  useLayoutEffect(() => {
    const colour = geometry.getAttribute("color") as THREE.BufferAttribute;
    const rgb = nodeColours(values, scale, fillTime, time, colour.array as Float32Array);
    for (let i = 0; i < rgb.length; i++) rgb[i] = toLinear(rgb[i] ?? 0);
    colour.needsUpdate = true;
  }, [geometry, values, scale, fillTime, time]);
  return (
    <mesh
      geometry={geometry}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        if (e.delta > CLICK_MAX_DRAG_PX) return;
        e.stopPropagation();
        onPick([e.point.x, e.point.y, e.point.z]);
      }}
    >
      <meshBasicMaterial vertexColors side={THREE.DoubleSide} toneMapped={false} polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
      <Edges threshold={25} color="#1f2937" />
    </mesh>
  );
}

/** One cone per arrow, pointing the way the melt moved. They are sorted by arrival, so the ones to show at `time` are simply the first few. */
function Arrows({ plan, time }: { plan: ArrowPlan; time: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const times = useMemo(() => plan.arrows.map((a) => a.time), [plan]);
  const cone = useMemo(() => new THREE.ConeGeometry(0.17, 1, 10), []);
  useEffect(() => () => {
    cone.dispose();
  }, [cone]);
  useLayoutEffect(() => {
    const instances = ref.current;
    if (!instances) return;
    const matrix = new THREE.Matrix4();
    const turn = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const scale = new THREE.Vector3(plan.length, plan.length, plan.length);
    plan.arrows.forEach((arrow, i) => {
      turn.setFromUnitVectors(up, new THREE.Vector3(...arrow.direction));
      instances.setMatrixAt(i, matrix.compose(new THREE.Vector3(...arrow.at), turn, scale));
    });
    instances.instanceMatrix.needsUpdate = true;
  }, [plan]);
  useLayoutEffect(() => {
    if (ref.current) ref.current.count = countUpTo(times, time);
  }, [times, time, plan]);
  return (
    <instancedMesh key={plan.arrows.length} ref={ref} args={[cone, undefined, plan.arrows.length]} frustumCulled={false}>
      <meshBasicMaterial color={ARROW_COLOUR} toneMapped={false} />
    </instancedMesh>
  );
}

/** Weld lines formed by `time`: white on a dark underlay, drawn over the part so one on a far wall is not hidden. */
function WeldLines({ run, time }: { run: FillRun; time: number }) {
  const formed = useMemo(() => run.weldLines.map((w) => w.timeS), [run]);
  const count = countUpTo(formed, time);
  const points = useMemo(() => run.weldLines.slice(0, count).flatMap((w) => [w.fromMm, w.toMm]), [run, count]);
  if (points.length === 0) return null;
  return (
    <>
      <Line points={points} segments color="#0f172a" lineWidth={6} depthTest={false} renderOrder={10} />
      <Line points={points} segments color="#ffffff" lineWidth={2.5} depthTest={false} renderOrder={11} />
    </>
  );
}

function Marker({ at, radius, colour }: { at: Vec3; radius: number; colour: string }) {
  return (
    <mesh position={at} renderOrder={12}>
      <sphereGeometry args={[radius, 20, 14]} />
      <meshBasicMaterial color={colour} toneMapped={false} depthTest={false} />
    </mesh>
  );
}

function CameraRig({ bounds, nonce }: { bounds: Box3Like; nonce: number }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target: THREE.Vector3; update: () => void } | null;
  useEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    const fit = fitCameraToBox(bounds, camera.fov);
    if (!fit) return;
    camera.position.set(...fit.position);
    camera.near = fit.near;
    camera.far = fit.far;
    camera.updateProjectionMatrix();
    controls?.target.set(...fit.center);
    controls?.update();
  }, [bounds, nonce, camera, controls]);
  return null;
}
