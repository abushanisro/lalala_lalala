'use client';

import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

import { Badge } from '@/components/ui/badge';
import { Box, Maximize2 } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { apiClient } from '@/lib/api/client';
import type { BOMItem } from '@/lib/api/hooks/useBOMItems';
import { isWebGLAvailable } from '@/lib/utils/webgl';


// ---------------------------------------------------------------------------
// Module-level thumbnail cache — persists across remounts for the page session
// ---------------------------------------------------------------------------

// Keyed by item and model path (an assembly: the models it is drawn from), so replacing a model never shows the old picture.
const thumbnailCache = new Map<string, string>(); // `${item.id}:${file3dPath}` → dataUrl
const cacheKeyOf = (item: BOMItem, parts: readonly BOMItem[] = []) =>
  `${item.id}:${item.file3dPath ?? item.file2dPath ?? parts.map((part) => `${part.id}=${part.file3dPath ?? ''}`).join(',')}`;

/**
 * Pictures are drawn on a transparent background (PNG), so the part blends with the page. Those stored before 2026-11-22 are JPEGs on a
 * dark background: such a picture counts as out of date, and the part is drawn again (once: the new picture replaces it on the item),
 * the old one staying on screen until then, or for good if the model cannot be drawn. PNG and not WebP: the Excel and PDF reports
 * embed the stored picture and take JPEG or PNG.
 */
const isDarkPicture = (url: string | undefined): boolean => url?.startsWith('data:image/jpeg') === true;
const knownPictureOf = (item: BOMItem, parts: readonly BOMItem[] = []): string | null =>
  (isDarkPicture(item.thumbnailUrl) ? undefined : item.thumbnailUrl) ?? thumbnailCache.get(cacheKeyOf(item, parts)) ?? null;
const darkPictureOf = (item: BOMItem): string | null => (isDarkPicture(item.thumbnailUrl) ? (item.thumbnailUrl ?? null) : null);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase = 'idle' | 'fetching' | 'rendering' | 'done' | 'error';
type FileCategory = 'stl' | 'obj' | 'step' | 'image' | 'pdf' | 'unknown';

export interface BOMItemThumbnailProps {
  item: BOMItem;
  onClick: () => void;
  /**
   * md: 120 x 90 (the default). sm: 64 x 48, for a table row; the 3D badge and the fit button are left out, and the capture is still drawn
   * at 120 x 90, so the picture stays sharp.
   */
  size?: 'sm' | 'md';
  /** The parts below an assembly that has no model of its own (modelPartsOf): its picture is drawn from their models, together. */
  parts?: readonly BOMItem[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyFile(path: string | undefined): FileCategory {
  if (!path) return 'unknown';
  const base = path.split('?')[0] ?? '';
  const ext = (base.split('.').pop() ?? '').toLowerCase();
  if (ext === 'stl') return 'stl';
  if (ext === 'obj') return 'obj';
  if (ext === 'step' || ext === 'stp' || ext === 'iges' || ext === 'igs') return 'step';
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp') return 'image';
  if (ext === 'pdf') return 'pdf';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Off-screen STL capture — private inner component
// ---------------------------------------------------------------------------

function disposeGroup(group: THREE.Group): void {
  group.children.forEach((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    (child.material as THREE.Material).dispose();
  });
}

interface STLCaptureProps {
  urls: string[];
  onCapture: (dataUrl: string) => void;
  onError: () => void;
}

/** One model is slate; the parts of an assembly take these in turn, so each can be told apart. */
const SINGLE_COLOR = 0x8899aa;
const PART_COLORS = [SINGLE_COLOR, 0x6f9fb8, 0x9bb08a, 0xc2a574, 0xa98fb5, 0xb98a8a];

/**
 * Draws the models together, each where its own coordinates put it (the parts of one assembly share them), centred, and the camera
 * far enough to hold them all.
 */
function STLScene({ urls, onCapture, onError }: STLCaptureProps) {
  const { camera, scene, invalidate } = useThree();
  const capturedRef = useRef(false);
  const readyRef = useRef(false);
  const groupRef = useRef<THREE.Group | null>(null);
  const onCaptureRef = useRef(onCapture);
  const onErrorRef = useRef(onError);
  onCaptureRef.current = onCapture;
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    const loader = new STLLoader();
    Promise.all(urls.map((url) => loader.loadAsync(url)))
      .then((geometries) => {
        if (cancelled) { geometries.forEach((geometry) => { geometry.dispose(); }); return; }

        const group = new THREE.Group();
        geometries.forEach((geometry, i) => {
          geometry.computeVertexNormals();
          group.add(new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({
              color: urls.length > 1 ? (PART_COLORS[i % PART_COLORS.length] ?? SINGLE_COLOR) : SINGLE_COLOR,
              metalness: 0.2,
              roughness: 0.4,
              side: THREE.DoubleSide,
            }),
          ));
        });

        const box = new THREE.Box3().setFromObject(group);
        const center = new THREE.Vector3();
        const size = new THREE.Vector3();
        box.getCenter(center);
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z);

        // Guard against empty or corrupt geometry (NaN positions)
        if (!isFinite(maxDim) || maxDim <= 0) {
          disposeGroup(group);
          onErrorRef.current();
          return;
        }

        group.position.sub(center);
        scene.add(group);
        groupRef.current = group;

        const cam = camera as THREE.PerspectiveCamera;
        const fovRad = cam.fov * (Math.PI / 180);
        const dist = (maxDim / 2) / Math.tan(fovRad / 2) * 1.3;
        cam.position.set(dist * 0.7, dist * 0.45, dist);
        cam.near = maxDim * 0.001;
        cam.far = maxDim * 100;
        cam.lookAt(0, 0, 0);
        cam.updateProjectionMatrix();

        // No background: the canvas is transparent (alpha), so the picture is the part alone.
        readyRef.current = true;
        invalidate();
      })
      .catch(() => { if (!cancelled) onErrorRef.current(); });
    return () => {
      cancelled = true;
      if (groupRef.current) {
        scene.remove(groupRef.current);
        disposeGroup(groupRef.current);
        groupRef.current = null;
      }
      readyRef.current = false;
      capturedRef.current = false;
    };
  }, [urls, scene, camera, invalidate]);

  useFrame(({ gl, scene, camera }) => {
    if (capturedRef.current || !readyRef.current) return;
    capturedRef.current = true;
    try {
      // useFrame runs before R3F's implicit render — call explicitly so the
      // canvas has the model on it when we screenshot it.
      gl.render(scene, camera);
      const dataUrl = gl.domElement.toDataURL('image/png');
      onCaptureRef.current(dataUrl);
    } catch {
      onErrorRef.current();
    }
  });

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[10, 10, 5]} intensity={1.2} />
      <directionalLight position={[-10, -10, -5]} intensity={0.4} />
      <hemisphereLight args={['#ffffff', '#444444', 0.6]} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const NO_PARTS: readonly BOMItem[] = [];

export function BOMItemThumbnail({ item, onClick, size = 'md', parts = NO_PARTS }: BOMItemThumbnailProps) {
  const compact = size === 'sm';
  const containerRef = useRef<HTMLDivElement>(null);
  // The thumbnail stored on the item comes first: drawing one means
  // downloading the whole 3D model, which is the costliest thing this list
  // could do on every visit. An old dark picture is shown until the part is drawn again.
  const cached = knownPictureOf(item, parts);
  const [phase, setPhase] = useState<Phase>(cached ? 'done' : 'idle');
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [partUrls, setPartUrls] = useState<string[]>([]);
  const [dataUrl, setDataUrl] = useState<string | null>(cached ?? darkPictureOf(item));

  const fileCategory = item.file3dPath
    ? classifyFile(item.file3dPath)
    : classifyFile(item.file2dPath ?? undefined);

  const is3d = !!item.file3dPath;
  // An item with no model of its own, with models below it, is drawn from those.
  const isAssembly = !item.file3dPath && parts.length > 0;
  // What the effects below depend on instead of the array itself, which a caller builds anew on every render.
  const partsKey = parts.map((part) => `${part.id}=${part.file3dPath ?? ''}`).join(',');
  const resolvedCategory = useRef<FileCategory>(fileCategory);

  // Start over whenever the model or its stored picture changes while mounted:
  // a replaced model clears the stored thumbnail and changes the path, and the
  // old part's picture must not stay on screen.
  const cacheKey = cacheKeyOf(item, parts);
  useEffect(() => {
    const known = knownPictureOf(item, parts);
    resolvedCategory.current = fileCategory;
    setFileUrl(null);
    setPartUrls([]);
    setDataUrl(known ?? darkPictureOf(item));
    setPhase(known ? 'done' : 'idle');
  }, [cacheKey, item.thumbnailUrl, fileCategory, partsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy trigger via IntersectionObserver — skip if already cached
  useEffect(() => {
    if (phase !== 'idle') return;
    if (!containerRef.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && phase === 'idle') {
          setPhase('fetching');
        }
      },
      { rootMargin: '100px', threshold: 0.1 }
    );
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [phase]);

  // Fetch signed URL when entering 'fetching'
  useEffect(() => {
    if (phase !== 'fetching') return;
    const controller = new AbortController();

    if (isAssembly) {
      // One signed URL per part model; a part whose URL cannot be had is left out of the picture rather than failing it.
      void Promise.all(parts.map((part) =>
        apiClient.get<{ url: string }>(`/bom-items/${part.id}/file-url/3d`, { signal: controller.signal, silent: true }).catch(() => null),
      )).then((results) => {
        if (controller.signal.aborted) return;
        const urls = results.flatMap((result) => (result && classifyFile(result.url.split('?')[0]) === 'stl' ? [result.url] : []));
        setPartUrls(urls);
        setPhase(urls.length > 0 && isWebGLAvailable() ? 'rendering' : 'error');
      });
      return () => controller.abort();
    }

    const endpoint = is3d
      ? `/bom-items/${item.id}/file-url/3d`
      : `/bom-items/${item.id}/file-url/2d`;

    apiClient
      .get<{ url: string }>(endpoint, { signal: controller.signal, silent: true })
      .then((result) => {
        if (!result) {
          setPhase('error');
          return;
        }
        const url = result.url;
        // Re-check actual extension — backend may convert STEP→STL
        const actualCategory = classifyFile(url.split('?')[0]);
        resolvedCategory.current = actualCategory === 'unknown' ? fileCategory : actualCategory;

        setFileUrl(url);
        const canRenderStl = resolvedCategory.current === 'stl' || resolvedCategory.current === 'obj';
        if (is3d && canRenderStl && isWebGLAvailable()) {
          setPhase('rendering');
        } else {
          setPhase('done');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setPhase('error');
      });

    return () => controller.abort();
  }, [phase, item.id, is3d, isAssembly, partsKey, fileCategory]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCapture = useCallback((url: string) => {
    thumbnailCache.set(cacheKeyOf(item, parts), url);
    setDataUrl(url);
    setPhase('done');
    // Stored on the item, so no later visit downloads the model for this
    // picture again. Best-effort: on failure it is simply drawn next time.
    void apiClient.patch(`/bom-items/${item.id}/thumbnail`, { thumbnailUrl: url }, { silent: true });
  }, [item, partsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCaptureError = useCallback(() => {
    setPhase('error');
  }, []);

  const sceneUrls = useMemo(() => (isAssembly ? partUrls : fileUrl ? [fileUrl] : []), [isAssembly, partUrls, fileUrl]);

  return (
    // The click stops here: the BOM card this sits in navigates to
    // Manufacturing Intelligence, and the thumbnail means "open the viewer".
    <div
      ref={containerRef}
      className={`relative shrink-0 overflow-hidden cursor-pointer group ${compact ? 'h-12 w-16 rounded' : 'w-[120px] h-[90px] rounded-md'}`}
      title={compact ? `${item.name}: open the viewer` : undefined}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      {/* Skeleton during load (not while an old picture is up) */}
      {(phase === 'idle' || phase === 'fetching' || phase === 'rendering') && !dataUrl && (
        <Skeleton className="w-full h-full rounded-md" />
      )}

      {/* Off-screen WebGL capture */}
      {phase === 'rendering' && sceneUrls.length > 0 && (
        <div className="absolute inset-0 opacity-0 pointer-events-none overflow-hidden">
          <Canvas
            gl={{ preserveDrawingBuffer: true, antialias: true, alpha: true, powerPreference: 'low-power' }}
            dpr={2}
            frameloop="demand"
            style={{ width: 120, height: 90 }}
          >
            <STLScene urls={sceneUrls} onCapture={handleCapture} onError={handleCaptureError} />
          </Canvas>
        </div>
      )}

      {/* Captured 3D image: the part alone on a transparent background, so it blends with the page (no box behind it) */}
      {dataUrl && (
        <img
          src={dataUrl}
          alt={item.name}
          className="w-full h-full object-contain rounded-md group-hover:ring-2 group-hover:ring-primary/50 transition-all"
        />
      )}

      {/* 2D image */}
      {phase === 'done' && !dataUrl && fileUrl && resolvedCategory.current === 'image' && (
        <img
          src={fileUrl}
          alt={item.name}
          className="w-full h-full object-cover rounded-md border border-border/40 group-hover:ring-2 group-hover:ring-primary/50 transition-all"
        />
      )}

      {/* Fallback for non-previewable files (STEP, IGES, PDF, etc.) */}
      {phase === 'done' && !dataUrl && resolvedCategory.current !== 'image' && (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-muted/60 rounded-md border border-border/40 group-hover:ring-2 group-hover:ring-primary/50 transition-all">
          <Box className={compact ? 'h-5 w-5 text-primary/50' : 'h-7 w-7 text-primary/50'} />
          <span className={compact ? 'sr-only' : 'text-[9px] font-mono uppercase text-muted-foreground'}>
            {resolvedCategory.current === 'step' ? 'STEP'
              : resolvedCategory.current === 'obj' ? 'OBJ'
              : resolvedCategory.current === 'pdf' ? 'PDF'
              : '3D'}
          </span>
        </div>
      )}

      {/* Error state */}
      {phase === 'error' && !dataUrl && (
        <div className="w-full h-full flex items-center justify-center bg-muted rounded-md border border-border/40">
          <Box className={compact ? 'h-5 w-5 text-muted-foreground' : 'h-8 w-8 text-muted-foreground'} />
        </div>
      )}

      {/* 3D badge */}
      {phase === 'done' && (is3d || isAssembly) && !compact && (
        <Badge className="absolute bottom-1 left-1 h-4 px-1 text-[9px] bg-primary/80 text-primary-foreground pointer-events-none">
          3D
        </Badge>
      )}

      {/* Fit / expand button — appears on hover */}
      {phase === 'done' && !compact && (
        <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={onClick}
            title="Fit to view"
            className="h-6 w-6 flex items-center justify-center rounded bg-black/60 hover:bg-black/80 text-white transition-colors"
          >
            <Maximize2 className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}
