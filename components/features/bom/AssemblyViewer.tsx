'use client';

import { OrbitControls } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

import { Button } from '@/components/ui/button';
import { Box, ChevronDown, ChevronRight, ExternalLink, Layers3, Loader2, RotateCcw } from '@/components/ui/icons';
import { apiClient } from '@/lib/api/client';
import { useBOMItems, type BOMItem } from '@/lib/api/hooks/useBOMItems';
import { explodeOffsets, type Vec3 } from '@/lib/bom/assembly-explode';
import { ancestorChain, buildTree, groupedParts, modelIdsUnder, selectionFor, type TreeNode } from '@/lib/bom/assembly-tree';

type Node = TreeNode<BOMItem>;

interface Models {
  status: 'loading' | 'ready';
  geometries: ReadonlyMap<string, THREE.BufferGeometry>;
  /** Parts whose model could not be loaded: they are left out of the view, and said so. */
  failed: number;
}

/** The STL of every part, by item id. A model that cannot be had (not converted, not stored) is counted, not fatal. */
function useModels(parts: readonly Node[]): Models {
  const key = parts.map((part) => `${part.id}=${part.file3dPath ?? ''}`).join(',');
  const [models, setModels] = useState<Models>({ status: 'loading', geometries: new Map(), failed: 0 });

  useEffect(() => {
    let cancelled = false;
    const loader = new STLLoader();
    setModels({ status: 'loading', geometries: new Map(), failed: 0 });
    void Promise.all(parts.map(async (part) => {
      try {
        if (!/\.stl$/i.test(part.file3dPath ?? '')) return null;
        const signed = await apiClient.get<{ url: string }>(`/bom-items/${part.id}/file-url/3d`, { silent: true });
        if (!signed) return null;
        const geometry = await loader.loadAsync(signed.url);
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        return [part.id, geometry] as const;
      } catch {
        return null;
      }
    })).then((loaded) => {
      const found = loaded.flatMap((entry) => (entry ? [entry] : []));
      if (cancelled) { found.forEach(([, geometry]) => { geometry.dispose(); }); return; }
      setModels({ status: 'ready', geometries: new Map(found), failed: parts.length - found.length });
    });
    return () => { cancelled = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { models.geometries.forEach((geometry) => { geometry.dispose(); }); }, [models]);
  return models;
}

const centreOf = (geometry: THREE.BufferGeometry): Vec3 => {
  const c = new THREE.Vector3();
  geometry.boundingBox?.getCenter(c);
  return [c.x, c.y, c.z];
};

/** One colour per group (a sub-assembly), a little lighter or darker per part in it, so both are told apart. */
const colourOf = (group: number, partInGroup: number): THREE.Color =>
  new THREE.Color().setHSL(((group * 67) % 360) / 360, 0.38, 0.6 + ((partInGroup % 3) - 1) * 0.07);

interface PartViewProps {
  geometry: THREE.BufferGeometry;
  colour: THREE.Color;
  offset: Vec3;
  state: 'normal' | 'selected' | 'dimmed';
  onPick: () => void;
}

function PartView({ geometry, colour, offset, state, onPick }: PartViewProps) {
  return (
    <mesh
      geometry={geometry}
      position={offset}
      onClick={(e) => { e.stopPropagation(); onPick(); }}
      onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { document.body.style.cursor = ''; }}
    >
      <meshStandardMaterial
        color={colour}
        metalness={0.2}
        roughness={0.45}
        side={THREE.DoubleSide}
        transparent={state === 'dimmed'}
        opacity={state === 'dimmed' ? 0.16 : 1}
        depthWrite={state !== 'dimmed'}
        emissive={state === 'selected' ? colour : '#000000'}
        emissiveIntensity={state === 'selected' ? 0.18 : 0}
      />
    </mesh>
  );
}

export interface AssemblyViewerProps {
  bomId: string;
  /** The assembly or sub-assembly whose parts are shown. */
  assemblyId: string;
  /**
   * The items (parts, or sub-assemblies for all their parts) to show selected, as the page's selected process row says. Each change of
   * them replaces the selection, so a click in the view stays in force until the page's selection next changes. Absent: not driven.
   */
  highlightedIds?: readonly string[] | undefined;
  /** Called when a part is clicked in the view, with it and the sub-assemblies above it (nearest first), so the page can select the row that stands for it. */
  onPickPart?: ((itemIds: readonly string[]) => void) | undefined;
}

/**
 * An assembly with no model of its own, shown from the models of the parts below it: together, each where its own coordinates put it
 * (the parts of one STEP assembly share them), with an explode control, and a click on a part, or a sub-assembly or part in the list,
 * to select it and dim the rest.
 */
export function AssemblyViewer({ bomId, assemblyId, highlightedIds, onPickPart }: AssemblyViewerProps) {
  const router = useRouter();
  const { id: projectId } = useParams<{ id: string }>();
  const { data } = useBOMItems(bomId);
  const tree = useMemo(() => buildTree(data?.items ?? [], assemblyId), [data, assemblyId]);
  const grouped = useMemo(() => (tree ? groupedParts(tree) : []), [tree]);
  const models = useModels(useMemo(() => grouped.map((g) => g.part), [grouped]));
  const [explode, setExplode] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // The sub-assemblies whose list is closed; all start open.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => { setClosed((now) => { const next = new Set(now); if (!next.delete(id)) next.add(id); return next; }); };

  // What is drawn: the parts whose model loaded, each with its model, centre and colour (one colour per group, a shade per part in it).
  const drawn = useMemo(() => {
    const groups = new Map<string, number>();
    const inGroup = new Map<string, number>();
    return grouped.flatMap((g) => {
      const geometry = models.geometries.get(g.part.id);
      if (!geometry) return [];
      const group = groups.get(g.groupId) ?? groups.size;
      groups.set(g.groupId, group);
      const n = inGroup.get(g.groupId) ?? 0;
      inGroup.set(g.groupId, n + 1);
      return [{ id: g.part.id, groupId: g.groupId, geometry, centre: centreOf(geometry), colour: colourOf(group, n) }];
    });
  }, [grouped, models]);
  const offsets = useMemo(() => explodeOffsets(drawn.map((d) => ({ id: d.id, groupId: d.groupId, center: d.centre })), explode), [drawn, explode]);

  // The assembled model's box fixes the centre the view orbits and how far the camera stands; exploded, the parts move within it.
  const frame = useMemo(() => {
    const box = new THREE.Box3();
    drawn.forEach((d) => { if (d.geometry.boundingBox) box.union(d.geometry.boundingBox); });
    return { centre: box.getCenter(new THREE.Vector3()), diagonal: box.isEmpty() ? 1 : box.getSize(new THREE.Vector3()).length() };
  }, [drawn]);

  const highlightKey = highlightedIds?.join(',');
  useEffect(() => {
    if (highlightedIds === undefined || !tree) return;
    setSelected(new Set(selectionFor(tree, highlightedIds)));
  }, [highlightKey, tree]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (ids: readonly string[]) => { setSelected(new Set(ids)); };
  const stateOf = (id: string): PartViewProps['state'] => (selected.size === 0 ? 'normal' : selected.has(id) ? 'selected' : 'dimmed');
  const [soleId] = selected.size === 1 ? [...selected] : [];
  const only = tree && soleId ? findNode(tree, soleId) : null;

  if (!tree) return <Message icon={<Loader2 className="h-5 w-5 animate-spin" />} text="Loading assembly…" />;
  if (grouped.length === 0) return <Message icon={<Box className="h-8 w-8 opacity-30" />} text="No part below this assembly has a 3D model." />;
  if (models.status === 'loading') return <Message icon={<Loader2 className="h-5 w-5 animate-spin" />} text={`Loading ${grouped.length} models…`} />;
  if (drawn.length === 0) return <Message icon={<Box className="h-8 w-8 opacity-30" />} text="The models below this assembly could not be loaded." />;

  return (
    <div className="relative h-full min-h-[360px] w-full overflow-hidden rounded-lg">
      <Canvas
        camera={{ position: [frame.diagonal * 1.1, frame.diagonal * 0.75, frame.diagonal * 1.35], fov: 35, near: frame.diagonal / 1000, far: frame.diagonal * 50 }}
        gl={{ antialias: true, alpha: true }}
        onPointerMissed={() => { choose([]); }}
      >
        <ambientLight intensity={0.6} />
        <directionalLight position={[frame.diagonal, frame.diagonal, frame.diagonal * 0.5]} intensity={1.2} />
        <directionalLight position={[-frame.diagonal, -frame.diagonal * 0.5, -frame.diagonal]} intensity={0.4} />
        <hemisphereLight args={['#ffffff', '#444444', 0.6]} />
        {/* CAD is Z-up; the scene is Y-up. The inner group centres the assembled model on the orbit point. */}
        <group rotation={[-Math.PI / 2, 0, 0]}>
          <group position={[-frame.centre.x, -frame.centre.y, -frame.centre.z]}>
            {drawn.map((d) => (
              <PartView
                key={d.id}
                geometry={d.geometry}
                colour={d.colour}
                offset={offsets.get(d.id) ?? [0, 0, 0]}
                state={stateOf(d.id)}
                onPick={() => { choose([d.id]); onPickPart?.(ancestorChain(tree, d.id)); }}
              />
            ))}
          </group>
        </group>
        <OrbitControls makeDefault enableDamping />
      </Canvas>

      {/* The assembly's structure: a click selects a sub-assembly (all its parts) or a part. */}
      <div className="absolute left-2 top-2 max-h-[calc(100%-4.5rem)] w-56 overflow-y-auto rounded-md border bg-background/90 p-1 text-xs shadow-sm backdrop-blur">
        <StructureRow node={tree} depth={0} selected={selected} closed={closed} drawn={models.geometries} onChoose={choose} onToggle={toggle} root />
      </div>

      <div className="absolute inset-x-2 bottom-2 flex flex-wrap items-center gap-3 rounded-md border bg-background/90 px-3 py-2 text-xs shadow-sm backdrop-blur">
        <label className="flex min-w-48 flex-1 items-center gap-2">
          <span className="shrink-0 font-medium">Explode</span>
          <input
            type="range" min={0} max={1.5} step={0.01} value={explode} aria-label="Explode"
            onChange={(e) => { setExplode(Number(e.target.value)); }}
            className="h-1 w-full cursor-pointer accent-primary"
          />
        </label>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={() => { setExplode(0); choose([]); }} title="Assemble and clear the selection">
          <RotateCcw className="h-3.5 w-3.5" /> Reset
        </Button>
        <span className="truncate text-muted-foreground" aria-live="polite">
          {selected.size === 0
            ? `${drawn.length} parts${models.failed > 0 ? ` · ${models.failed} without a loadable model` : ''}`
            : only ? only.name : `${selected.size} parts selected`}
        </span>
        {only?.itemType === 'child_part' && (
          <Button size="sm" variant="outline" className="h-7 gap-1 px-2" onClick={() => { router.push(`/projects/${projectId}/bom/${bomId}/items/${only.id}/manufacturing-intelligence`); }}>
            <ExternalLink className="h-3.5 w-3.5" /> Open part
          </Button>
        )}
      </div>
    </div>
  );
}

function findNode(node: Node, id: string): Node | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function Message({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex h-full min-h-[360px] flex-col items-center justify-center gap-2 text-muted-foreground">
      {icon}
      <span className="text-sm">{text}</span>
    </div>
  );
}

interface StructureRowProps {
  node: Node;
  depth: number;
  selected: ReadonlySet<string>;
  /** The sub-assemblies whose list is closed. */
  closed: ReadonlySet<string>;
  drawn: ReadonlyMap<string, unknown>;
  onChoose: (ids: readonly string[]) => void;
  onToggle: (id: string) => void;
  root?: boolean;
}

/**
 * One line of the structure. A group (an assembly or sub-assembly) is a dropdown: its arrow, or a click on the line, opens or closes
 * what is under it; a click on the line also selects its parts (the root shows all). A part is selected by its line alone.
 */
function StructureRow({ node, depth, selected, closed, drawn, onChoose, onToggle, root }: StructureRowProps) {
  const ids = modelIdsUnder(node).filter((id) => drawn.has(id));
  const active = !root && ids.length > 0 && ids.every((id) => selected.has(id)) && ids.length === selected.size;
  const isGroup = node.children.length > 0;
  const open = !closed.has(node.id);
  const Icon = isGroup ? Layers3 : Box;
  return (
    <>
      <div className={`flex items-center rounded hover:bg-accent ${active ? 'bg-accent font-medium' : ''}`} style={{ paddingLeft: 2 + depth * 12 }}>
        {isGroup ? (
          <button
            type="button"
            onClick={() => { onToggle(node.id); }}
            aria-expanded={open}
            aria-label={`${open ? 'Close' : 'Open'} ${node.name}`}
            className="flex h-6 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          >
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="w-5 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          disabled={ids.length === 0}
          onClick={() => { onChoose(root ? [] : ids); if (isGroup) onToggle(node.id); }}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1 text-left disabled:opacity-40"
          title={root ? 'Show all' : ids.length === 1 ? node.name : `${node.name} (${ids.length} parts)`}
        >
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{node.name}</span>
          {isGroup && <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{ids.length}</span>}
        </button>
      </div>
      {isGroup && open && node.children.map((child) => (
        <StructureRow key={child.id} node={child} depth={depth + 1} selected={selected} closed={closed} drawn={drawn} onChoose={onChoose} onToggle={onToggle} />
      ))}
    </>
  );
}
