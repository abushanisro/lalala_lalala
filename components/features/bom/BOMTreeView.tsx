'use client';

// The hover details are drawn on the page's top layer: inside the canvas they would be cut off at its edge and scaled with its zoom.
import { Portal as TooltipPortal } from '@radix-ui/react-tooltip';
import { motion, AnimatePresence } from 'framer-motion';
import dynamic from 'next/dynamic';
import { useState, useMemo, useEffect } from 'react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Plus, Edit2, ZoomIn, ZoomOut, Maximize2, AlertTriangle, CheckCircle, XCircle,
  Box, Layers, Layers3, Package, ChevronRight, ArrowRight, FolderOpen, X,
  type LucideIcon,
} from '@/components/ui/icons';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { BOMItem as BOMItemRecord } from '@/lib/api/hooks/useBOMItems';
import { familyToProcessGroupLabel } from '@/lib/features/process-group';
import { BOMItemType } from '@/lib/types/bom.types';
import { cn } from '@/lib/utils';

// The same lazily drawn picture of the part as the BOM list's rows (no SSR: it draws the model with WebGL).
const BOMItemThumbnail = dynamic(
  () => import('./BOMItemThumbnail').then((m) => m.BOMItemThumbnail),
  { ssr: false, loading: () => null },
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One item of the tree. The page passes the BOM items as the API returns them, so every other field of the item (its CAD files,
 * thumbnail, size, weight, material...) is there too and shown on the card and its hover details.
 */
export interface BOMItem extends Partial<Omit<BOMItemRecord, 'id' | 'name' | 'partNumber' | 'itemType' | 'quantity' | 'unit' | 'material'>> {
  id: string;
  name: string;
  partNumber?: string;
  itemType: BOMItemType;
  quantity: number;
  unit?: string;
  material?: string;
  children?: BOMItem[];
}

interface BOMTreeViewProps {
  items: BOMItem[];
  projectName?: string;
  projectId?: string;
  onAddItem: (parentId: string | null, type: BOMItemType) => void;
  onEditItem: (item: BOMItem) => void;
  /** Called after the user confirms the delete in the tree's own dialog. */
  onDeleteItem: (id: string) => void;
  /** A click on an item's card: the page opens the item's Manufacturing Intelligence page. */
  onOpenItem?: (item: BOMItem) => void;
}

type ValidationIssueType  = 'circular' | 'orphaned' | 'missing_quantity' | 'invalid_hierarchy' | 'duplicate_parts' | 'missing_data';
type ValidationSeverity   = 'low' | 'medium' | 'high' | 'critical';

interface ValidationIssue {
  type: ValidationIssueType;
  severity: ValidationSeverity;
  title: string;
  description: string;
  itemId?: string;
  suggestion: string;
  affectedItems?: string[];
}

interface BOMValidationResult {
  isValid: boolean;
  issues: ValidationIssue[];
  summary: {
    totalItems: number;
    assemblies: number;
    subAssemblies: number;
    childParts: number;
    orphanedItems: number;
    maxDepth: number;
    estimatedComplexity: 'low' | 'medium' | 'high';
  };
}

/** x: the card's left edge; y: its vertical middle. */
interface NodePosition {
  x: number;
  y: number;
  level: number;
}

interface TreeNode extends BOMItem {
  position: NodePosition;
  isExpanded: boolean;
  parentPos?: NodePosition;
}

// Fix TS18048 + TS2322: use a concrete typed object instead of Record<string, number>
interface ItemCounts {
  assemblies: number;
  subAssemblies: number;
  childParts: number;
}

interface CalcStatsResult {
  counts: ItemCounts;
  maxDepth: number;
}

// ---------------------------------------------------------------------------
// Card geometry and type colours
// ---------------------------------------------------------------------------

const CARD_W        = 288;
const CARD_H        = 76;
const COLUMN_GAP    = 72;   // room between a parent's card and its children's, for the connectors and the expand button
const ROW_H         = 96;   // one card and the gap below it
const PAD_X         = 24;
const PAD_Y         = 24;
const LEVEL_SPACING = CARD_W + COLUMN_GAP;

interface TypeStyle {
  label: string;
  Icon: LucideIcon;
  bar: string;    // the card's left bar
  text: string;   // the type label
  stroke: string; // the connector leading to the card
  ring: string;   // the card's hover ring
}

// The BOM list's type colours: assembly green, sub-assembly blue, child part yellow.
const TYPE_STYLE: Record<string, TypeStyle> = {
  [BOMItemType.ASSEMBLY]: {
    label: 'Assembly', Icon: Layers, bar: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-400',
    stroke: 'stroke-emerald-500', ring: 'hover:ring-emerald-500/40',
  },
  [BOMItemType.SUB_ASSEMBLY]: {
    label: 'Sub-Assembly', Icon: Layers3, bar: 'bg-blue-500', text: 'text-blue-700 dark:text-blue-400',
    stroke: 'stroke-blue-500', ring: 'hover:ring-blue-500/40',
  },
  [BOMItemType.CHILD_PART]: {
    label: 'Part', Icon: Box, bar: 'bg-yellow-400', text: 'text-yellow-700 dark:text-yellow-300',
    stroke: 'stroke-yellow-400', ring: 'hover:ring-yellow-400/50',
  },
};

function typeStyleOf(type: string): TypeStyle {
  return TYPE_STYLE[type] ?? {
    label: type, Icon: Package, bar: 'bg-border', text: 'text-muted-foreground', stroke: 'stroke-border', ring: 'hover:ring-border',
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function generateCurvedPath(x1: number, y1: number, x2: number, y2: number): string {
  const midX = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
}

function validateBOMStructure(items: BOMItem[]): BOMValidationResult {
  const issues: ValidationIssue[]           = [];
  const itemMap                             = new Map<string, BOMItem>();
  const visited                             = new Set<string>();
  const childToParent                       = new Map<string, string>();

  const buildMaps = (itemList: BOMItem[], parentId?: string) => {
    itemList.forEach(item => {
      itemMap.set(item.id, item);
      if (parentId) childToParent.set(item.id, parentId);
      if (item.children) buildMaps(item.children, item.id);
    });
  };
  buildMaps(items);

  // Circular dependency check
  const detectCircular = (itemId: string, path: Set<string>): void => {
    if (path.has(itemId)) {
      issues.push({
        type: 'circular',
        severity: 'critical',
        title: 'Circular Dependency Detected',
        description: 'Item creates a circular reference in the BOM structure',
        itemId,
        suggestion: 'Remove the circular reference by restructuring the hierarchy',
        affectedItems: Array.from(path),
      });
      return;
    }
    if (visited.has(itemId)) return;
    visited.add(itemId);
    path.add(itemId);
    const item = itemMap.get(itemId);
    item?.children?.forEach(child => detectCircular(child.id, new Set(path)));
    path.delete(itemId);
  };
  items.forEach(item => detectCircular(item.id, new Set()));

  // Orphaned items
  const orphanedItems: string[] = [];
  const findOrphaned = (itemList: BOMItem[], isTopLevel = true) => {
    itemList.forEach(item => {
      if (!isTopLevel && (item.itemType === 'sub_assembly' || item.itemType === 'child_part')) {
        if (!childToParent.has(item.id)) orphanedItems.push(item.id);
      }
      if (item.children) findOrphaned(item.children, false);
    });
  };
  findOrphaned(items);

  if (orphanedItems.length > 0) {
    issues.push({
      type: 'orphaned',
      severity: 'high',
      title: 'Orphaned BOM Items',
      description: `${orphanedItems.length} items are not properly connected to the BOM hierarchy`,
      suggestion: 'Ensure all sub-assemblies and parts have proper parent assemblies',
      affectedItems: orphanedItems,
    });
  }

  // Missing data / duplicate part numbers
  const missingDataItems: string[]                    = [];
  const duplicatePartNumbers                          = new Map<string, string[]>();

  const validateItemData = (itemList: BOMItem[]) => {
    itemList.forEach(item => {
      if (!item.quantity || item.quantity <= 0) missingDataItems.push(item.id);

      if (item.partNumber) {
        if (!duplicatePartNumbers.has(item.partNumber)) {
          duplicatePartNumbers.set(item.partNumber, []);
        }
        duplicatePartNumbers.get(item.partNumber)!.push(item.id);
      }

      if (item.children) validateItemData(item.children);
    });
  };
  validateItemData(items);

  if (missingDataItems.length > 0) {
    issues.push({
      type: 'missing_quantity',
      severity: 'medium',
      title: 'Missing or Invalid Quantities',
      description: `${missingDataItems.length} items have missing or invalid quantity values`,
      suggestion: 'Update all items to have valid quantities greater than 0',
      affectedItems: missingDataItems,
    });
  }

  Array.from(duplicatePartNumbers.entries())
    .filter(([, ids]) => ids.length > 1)
    .forEach(([partNumber, ids]) => {
      issues.push({
        type: 'duplicate_parts',
        severity: 'medium',
        title: 'Duplicate Part Numbers',
        description: `Part number "${partNumber}" is used by multiple items`,
        suggestion: 'Ensure each part has a unique part number or use revision numbers',
        affectedItems: ids,
      });
    });

  // ✅ Fix TS18048 + TS2322: return CalcStatsResult with typed ItemCounts (not Record<string,number>)
  const calculateStats = (itemList: BOMItem[], depth = 0): CalcStatsResult => {
    let assemblies = 0, subAssemblies = 0, childParts = 0, maxDepth = depth;

    itemList.forEach(item => {
      if (item.itemType === 'assembly')     assemblies++;
      else if (item.itemType === 'sub_assembly') subAssemblies++;
      else if (item.itemType === 'child_part')   childParts++;

      if (item.children && item.children.length > 0) {
        const childStats = calculateStats(item.children, depth + 1);
        // ✅ All fields are now typed as `number` — no more TS18048
        assemblies    += childStats.counts.assemblies;
        subAssemblies += childStats.counts.subAssemblies;
        childParts    += childStats.counts.childParts;
        maxDepth       = Math.max(maxDepth, childStats.maxDepth);
      }
    });

    return { counts: { assemblies, subAssemblies, childParts }, maxDepth };
  };

  const stats      = calculateStats(items);
  const totalItems = stats.counts.assemblies + stats.counts.subAssemblies + stats.counts.childParts;

  return {
    isValid: issues.length === 0,
    issues,
    summary: {
      totalItems,
      // fix TS2322: all fields are number (not number | undefined)
      assemblies:          stats.counts.assemblies,
      subAssemblies:       stats.counts.subAssemblies,
      childParts:          stats.counts.childParts,
      orphanedItems:       orphanedItems.length,
      maxDepth:            stats.maxDepth,
      estimatedComplexity: totalItems > 50 ? 'high' : totalItems > 20 ? 'medium' : 'low',
    },
  };
}


function countDescendants(item: BOMItem, expandedNodes: Set<string>): number {
  if (!item.children || item.children.length === 0 || !expandedNodes.has(item.id)) return 1;
  return item.children.reduce((sum, child) => sum + countDescendants(child, expandedNodes), 0);
}

function calculateHierarchicalPositions(
  items: BOMItem[],
  expandedNodes: Set<string>,
  startY = 0,
  level  = 1,
  parentPos?: NodePosition,
): { nodes: TreeNode[]; totalHeight: number } {
  const nodes: TreeNode[] = [];
  let currentY            = startY;

  items.forEach(item => {
    const isExpanded      = expandedNodes.has(item.id);
    const descendantCount = countDescendants(item, expandedNodes);
    const nodeHeight      = Math.max(descendantCount * ROW_H, ROW_H);
    const nodeY           = currentY + nodeHeight / 2;
    const nodeX           = PAD_X + level * LEVEL_SPACING;

    const position: NodePosition = { x: nodeX, y: nodeY, level };
    nodes.push({ ...item, position, isExpanded, ...(parentPos !== undefined ? { parentPos } : {}) });

    if (isExpanded && item.children && item.children.length > 0) {
      const childResult = calculateHierarchicalPositions(item.children, expandedNodes, currentY, level + 1, position);
      nodes.push(...childResult.nodes);
    }

    currentY += nodeHeight;
  });

  return { nodes, totalHeight: currentY - startY };
}

// ---------------------------------------------------------------------------
// Hover details: the item's CAD and part properties
// ---------------------------------------------------------------------------

const fileNameOf = (path: string | undefined): string => (path ? (path.split('?')[0] ?? '').split('/').pop() ?? '' : '');
const mm = (v: number | undefined): string => (v && v > 0 ? v.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '0');

function CadDetails({ node, onOpen }: { node: BOMItem; onOpen?: () => void }) {
  const style    = typeStyleOf(node.itemType);
  const hasModel = Boolean(node.file3dPath ?? node.file2dPath);
  const childCount = node.children?.length ?? 0;
  const size =
    (node.maxLength ?? 0) > 0 || (node.maxWidth ?? 0) > 0 || (node.maxHeight ?? 0) > 0
      ? `${mm(node.maxLength)} × ${mm(node.maxWidth)} × ${mm(node.maxHeight)} mm`
      : '';

  const sections: { title: string; rows: [string, string][] }[] = [
    {
      title: 'Details',
      rows: [
        ['Quantity', `${node.quantity} ${node.unit ?? 'pcs'}`],
        ['Contains', childCount > 0 ? `${childCount} ${childCount === 1 ? 'item' : 'items'}` : ''],
        ['Material', [node.material, node.materialGrade].filter(Boolean).join(' · ')],
        ['Process', familyToProcessGroupLabel(node.familyClassification) ?? ''],
        ['Make / Buy', node.makeBuy === 'buy' ? 'Buy' : node.makeBuy === 'make' ? 'Make' : ''],
        ['Unit cost', typeof node.unitCost === 'number' ? node.unitCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''],
        ['Revision', node.revision ?? ''],
      ],
    },
    {
      title: 'CAD',
      rows: [
        ['Size (L × W × H)', size],
        ['Weight', node.weight && node.weight > 0 ? `${node.weight.toFixed(3)} kg` : ''],
        ['Volume', node.volume && node.volume > 0 ? `${Math.round(node.volume).toLocaleString()} mm³` : ''],
        ['Surface area', node.surfaceArea && node.surfaceArea > 0 ? `${(node.surfaceArea / 1000).toFixed(1)}k mm²` : ''],
        ['Thickness', node.sheetThicknessMm && node.sheetThicknessMm > 0 ? `${mm(node.sheetThicknessMm)} mm` : ''],
        ['3D model', fileNameOf(node.file3dPath)],
        ['2D drawing', fileNameOf(node.file2dPath)],
      ],
    },
  ];
  // Only what is on file: an empty value leaves its row out.
  const groups = sections.map(g => ({ ...g, rows: g.rows.filter(([, v]) => v !== '') }));

  return (
    <div className="w-80 text-popover-foreground">
      {/* The part's picture, larger than on the card */}
      {hasModel && (
        <div className="flex justify-center border-b bg-muted/40 py-3">
          <BOMItemThumbnail item={node as unknown as BOMItemRecord} onClick={() => onOpen?.()} />
        </div>
      )}
      <div className="space-y-3 p-3">
        <div className="min-w-0">
          <div className={cn('flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider', style.text)}>
            <style.Icon className="h-3 w-3" />
            {style.label}
          </div>
          <div className="mt-0.5 break-words text-sm font-semibold leading-snug">{node.name}</div>
          {node.partNumber && <div className="break-all font-mono text-[11px] text-muted-foreground">{node.partNumber}</div>}
        </div>

        {groups.map(g => g.rows.length > 0 && (
          <div key={g.title}>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{g.title}</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {g.rows.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="truncate text-right font-medium tabular-nums" title={value}>{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}

        {!hasModel && (
          <p className="rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">No CAD model attached yet.</p>
        )}
      </div>
      {onOpen && (
        <div className="flex items-center gap-1.5 border-t px-3 py-2 text-[11px] font-medium text-primary">
          Click the card to open Manufacturing Intelligence
          <ArrowRight className="h-3 w-3" />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The expand / collapse button on a card's right edge, where its connectors start
// ---------------------------------------------------------------------------

function ExpandButton({ name, count, expanded, onToggle }: { name: string; count: number; expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="absolute -right-3 top-1/2 z-10 flex h-6 min-w-6 -translate-y-1/2 items-center justify-center gap-0.5 rounded-full border bg-background px-1.5 text-[10px] font-semibold tabular-nums text-muted-foreground shadow-xs transition-colors hover:border-primary/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={expanded ? 'Collapse' : `Expand (${count})`}
      aria-label={expanded ? `Collapse ${name}` : `Expand ${name}`}
      aria-expanded={expanded}
      onClick={e => { e.stopPropagation(); onToggle(); }}
    >
      {!expanded && <span>{count}</span>}
      <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.2 }} className="flex">
        <ChevronRight className="h-3 w-3" />
      </motion.span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// One item's card
// ---------------------------------------------------------------------------

function HierarchicalNode({
  node,
  onToggle,
  onEdit,
  onAdd,
  onRemove,
  onOpen,
}: {
  node: TreeNode;
  onToggle: (id: string) => void;
  onEdit:   (item: BOMItem) => void;
  onAdd:    (parentId: string | null, type: BOMItemType) => void;
  onRemove: (item: BOMItem) => void;
  onOpen?:  (item: BOMItem) => void;
}) {
  const childCount = node.children?.length ?? 0;
  const style      = typeStyleOf(node.itemType);
  const pos        = node.position;
  const hasModel   = Boolean(node.file3dPath ?? node.file2dPath);

  // The + adds a child part: into this card's item when it is an assembly or a sub-assembly, and beside it (same parent) when it is a
  // child part, since nothing goes under a child part (lib/bom/drop-intent.ts).
  const addParentId = node.itemType === BOMItemType.CHILD_PART ? (node.parentItemId ?? null) : node.id;

  const open = () => onOpen?.(node);
  const actionButton = 'h-6 w-6 rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground';

  return (
    <motion.div
      className="absolute"
      style={{ left: pos.x, top: pos.y - CARD_H / 2, width: CARD_W, height: CARD_H }}
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -16 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
    >
      <Tooltip delayDuration={350}>
        <TooltipTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            aria-label={`${node.name}: open Manufacturing Intelligence`}
            className={cn(
              'group relative flex h-full cursor-pointer items-center gap-3 overflow-hidden rounded-lg border bg-card py-2 pl-3.5 pr-3 shadow-xs',
              'transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md hover:ring-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              style.ring,
            )}
            onClick={open}
            // Only the card's own keys: Enter on one of its buttons is that button's.
            onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } }}
          >
            <span className={cn('absolute inset-y-0 left-0 w-1', style.bar)} aria-hidden="true" />

            {hasModel ? (
              <BOMItemThumbnail item={node as unknown as BOMItemRecord} size="sm" onClick={open} />
            ) : (
              <span className="flex h-12 w-16 shrink-0 items-center justify-center rounded bg-muted/50" aria-hidden="true">
                <style.Icon className={cn('h-5 w-5', style.text)} />
              </span>
            )}

            <div className="min-w-0 flex-1">
              <div className={cn('text-[10px] font-semibold uppercase leading-none tracking-wider', style.text)}>{style.label}</div>
              <div className="mt-1 truncate text-[13px] font-semibold leading-tight text-foreground">{node.name}</div>
              <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] leading-tight text-muted-foreground">
                {node.partNumber && <span className="truncate font-mono">{node.partNumber}</span>}
                {node.partNumber && <span aria-hidden="true">·</span>}
                <span className="shrink-0 tabular-nums">{node.quantity} {node.unit ?? 'pcs'}</span>
              </div>
            </div>

            {/* Actions on hover: add, edit, remove */}
            <div
              className="pointer-events-none absolute right-1.5 top-1.5 flex items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
              onClick={e => { e.stopPropagation(); }}
            >
              <Button variant="ghost" size="icon" className={actionButton} title="Add child part" aria-label="Add child part"
                onClick={e => { e.stopPropagation(); onAdd(addParentId, BOMItemType.CHILD_PART); }}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className={actionButton} title="Edit" aria-label={`Edit ${node.name}`}
                onClick={e => { e.stopPropagation(); onEdit(node); }}>
                <Edit2 className="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="icon" className={cn(actionButton, 'hover:bg-destructive/10 hover:text-destructive')} title="Remove" aria-label={`Remove ${node.name}`}
                onClick={e => { e.stopPropagation(); onRemove(node); }}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent side="right" align="start" sideOffset={childCount > 0 ? 20 : 10} collisionPadding={12} className="overflow-hidden p-0">
            <CadDetails node={node} {...(onOpen ? { onOpen: open } : {})} />
          </TooltipContent>
        </TooltipPortal>
      </Tooltip>

      {childCount > 0 && (
        <ExpandButton name={node.name} count={childCount} expanded={node.isExpanded} onToggle={() => { onToggle(node.id); }} />
      )}
    </motion.div>
  );
}

/** The curved line from a parent's right edge to a child's left edge, in the colour of the child it leads to. */
function connectorPath(from: NodePosition, to: NodePosition): string {
  return generateCurvedPath(from.x + CARD_W, from.y, to.x, to.y);
}

// ---------------------------------------------------------------------------
// BOMTreeView
// ---------------------------------------------------------------------------

export function BOMTreeView({ items, projectName, projectId, onAddItem, onEditItem, onDeleteItem, onOpenItem }: BOMTreeViewProps) {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => {
    const expanded = new Set(items.map(i => i.id));
    expanded.add('project-root');
    return expanded;
  });
  const [zoom,             setZoom]             = useState(0.9);
  const [showValidation,   setShowValidation]   = useState(true);
  const [validationResult, setValidationResult] = useState<BOMValidationResult | null>(null);
  // The item whose × was pressed, waiting for the user to confirm the delete.
  const [pendingDelete,    setPendingDelete]    = useState<BOMItem | null>(null);

  useEffect(() => {
    if (items.length === 0) { setValidationResult(null); return; }
    try {
      const result = validateBOMStructure(items);
      setValidationResult(result);

      const criticalCount = result.issues.filter(i => i.severity === 'critical').length;
      if (criticalCount > 0) {
        toast.error('BOM Structure Issues', {
          description: `${criticalCount} critical issues detected`,
          duration: 8_000,
          action: { label: 'View Details', onClick: () => setShowValidation(true) },
        });
      }
    } catch (error) {
      console.error('BOM validation error:', error);
      toast.error('Failed to validate BOM structure');
    }
  }, [items]);

  const toggleNode = (id: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const rootExpanded = expandedNodes.has('project-root');

  const { treeNodes, rootPos, canvas } = useMemo(() => {
    const rows   = rootExpanded ? items.reduce((sum, item) => sum + countDescendants(item, expandedNodes), 0) : 1;
    const height = Math.max(rows, 1) * ROW_H;
    // The project's card sits level with the middle of everything under it.
    const root: NodePosition = { x: PAD_X, y: PAD_Y + height / 2, level: 0 };

    if (items.length === 0 || !rootExpanded) {
      return { treeNodes: [] as TreeNode[], rootPos: root, canvas: { width: PAD_X * 2 + CARD_W + 24, height: height + PAD_Y * 2 } };
    }

    const result = calculateHierarchicalPositions(items, expandedNodes, PAD_Y, 1, root);
    const maxX   = Math.max(...result.nodes.map(n => n.position.x), root.x) + CARD_W + PAD_X + 24;

    return { treeNodes: result.nodes, rootPos: root, canvas: { width: maxX, height: result.totalHeight + PAD_Y * 2 } };
  }, [items, expandedNodes, rootExpanded]);

  const hasItems       = items.length > 0;
  const criticalIssues = validationResult?.issues.filter(i => i.severity === 'critical') ?? [];
  const highIssues     = validationResult?.issues.filter(i => i.severity === 'high')     ?? [];

  const summaryCounts = validationResult ? [
    { label: 'Assemblies',     value: validationResult.summary.assemblies,    dot: 'bg-emerald-500' },
    { label: 'Sub-Assemblies', value: validationResult.summary.subAssemblies, dot: 'bg-blue-500'    },
    { label: 'Child Parts',    value: validationResult.summary.childParts,    dot: 'bg-yellow-400'  },
    { label: 'Max Depth',      value: validationResult.summary.maxDepth,      dot: 'bg-muted-foreground/50' },
  ] : [];

  return (
    <div className="space-y-3">

      {/* ── Structure summary: one strip, with the issues under it when there are any ─────────── */}
      {validationResult && showValidation && (
        <div className="rounded-lg border bg-card">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
            {validationResult.isValid ? (
              <div className="flex items-center gap-2 text-green-700 dark:text-green-400">
                <CheckCircle className="h-4 w-4" />
                <span className="text-sm font-semibold">BOM Structure Valid</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-red-700 dark:text-red-400">
                <XCircle className="h-4 w-4" />
                <span className="text-sm font-semibold">{validationResult.issues.length} Issues Found</span>
              </div>
            )}
            <Badge
              variant={
                validationResult.summary.estimatedComplexity === 'high'   ? 'destructive' :
                validationResult.summary.estimatedComplexity === 'medium' ? 'default'     : 'secondary'
              }
              className="text-[10px]"
            >
              {validationResult.summary.estimatedComplexity.toUpperCase()} Complexity
            </Badge>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              {summaryCounts.map(({ label, value, dot }) => (
                <span key={label} className="flex items-center gap-1.5">
                  <span className={cn('h-2 w-2 rounded-full', dot)} aria-hidden="true" />
                  <span className="font-semibold tabular-nums">{value}</span>
                  <span className="text-muted-foreground">{label}</span>
                </span>
              ))}
            </div>

            <Button variant="ghost" size="icon" className="ml-auto h-7 w-7 rounded-full" title="Hide" aria-label="Hide structure analysis" onClick={() => { setShowValidation(false); }}>
              <XCircle className="h-4 w-4" />
            </Button>
          </div>

          {/* Issue list */}
          {validationResult.issues.length > 0 && (
            <div className="space-y-2 border-t px-4 py-3">
              <h4 className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="h-4 w-4" />
                Validation Issues
              </h4>
              <div className="space-y-2">
                {validationResult.issues.map((issue, index) => (
                  <Alert
                    key={index}
                    variant={issue.severity === 'critical' || issue.severity === 'high' ? 'destructive' : 'default'}
                    className="py-2"
                  >
                    <AlertTriangle className="h-4 w-4" />
                    <div className="space-y-1">
                      <AlertTitle className="flex items-center gap-2 text-sm">
                        {issue.title}
                        <Badge variant="outline" className="text-xs">{issue.severity.toUpperCase()}</Badge>
                      </AlertTitle>
                      <AlertDescription className="text-xs">{issue.description}</AlertDescription>
                      <p className="mt-1 text-xs text-muted-foreground">Suggestion: {issue.suggestion}</p>
                      {(issue.affectedItems?.length ?? 0) > 0 && (
                        <p className="text-xs text-muted-foreground">Affected items: {issue.affectedItems?.length ?? 0}</p>
                      )}
                    </div>
                  </Alert>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Collapsed summary bar ─────────────────────────────────────────── */}
      {validationResult && !showValidation && (
        <div className="flex items-center justify-between rounded-lg border bg-card px-4 py-2">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              {validationResult.isValid
                ? <CheckCircle  className="h-4 w-4 text-green-600" />
                : <AlertTriangle className="h-4 w-4 text-yellow-600" />}
              <span className="text-sm font-medium">
                {validationResult.summary.totalItems} items •{' '}
                {validationResult.isValid ? 'Valid Structure' : `${validationResult.issues.length} issues`}
              </span>
            </div>
            {(criticalIssues.length > 0 || highIssues.length > 0) && (
              <div className="flex items-center gap-1">
                {criticalIssues.length > 0 && <Badge variant="destructive" className="text-xs">{criticalIssues.length} Critical</Badge>}
                {highIssues.length     > 0 && <Badge variant="default"     className="text-xs">{highIssues.length} High</Badge>}
              </div>
            )}
          </div>
          <Button variant="outline" size="sm" className="h-7 rounded-full text-xs" onClick={() => { setShowValidation(true); }}>
            View Details
          </Button>
        </div>
      )}

      {/* ── Canvas ───────────────────────────────────────────────────────── */}
      <div className="relative h-[560px] w-full overflow-hidden rounded-lg border bg-muted/30 md:h-[640px] lg:h-[72vh]">

        {/* Legend and how to use it */}
        <div className="pointer-events-none absolute left-3 top-3 z-20 flex flex-wrap items-center gap-3 rounded-full border bg-background/90 px-3 py-1 text-[11px] text-muted-foreground shadow-xs backdrop-blur">
          {[BOMItemType.ASSEMBLY, BOMItemType.SUB_ASSEMBLY, BOMItemType.CHILD_PART].map(t => (
            <span key={t} className="flex items-center gap-1.5">
              <span className={cn('h-2 w-2 rounded-full', typeStyleOf(t).bar)} aria-hidden="true" />
              {typeStyleOf(t).label}
            </span>
          ))}
          <span className="hidden border-l pl-3 sm:inline">Hover for details · click to open</span>
        </div>

        {/* Zoom controls */}
        <div className="absolute right-3 top-3 z-20 flex items-center gap-0.5 rounded-full border bg-background/90 p-0.5 shadow-xs backdrop-blur">
          <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full" title="Zoom out" onClick={() => { setZoom(z => Math.max(z - 0.1, 0.4)); }}>
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <span className="w-10 text-center text-[11px] tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full" title="Zoom in" onClick={() => { setZoom(z => Math.min(z + 0.1, 1.5)); }}>
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full" title="Reset zoom" onClick={() => { setZoom(0.9); }}>
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div
          className="h-full w-full overflow-auto [background-image:radial-gradient(hsl(var(--border))_1px,transparent_1px)] [background-size:20px_20px]"
        >
          {/* Sized to the zoomed tree, so the scroll bars match what is on screen */}
          <div className="pt-10" style={{ width: canvas.width * zoom, height: canvas.height * zoom + 40 }}>
            <div className="relative origin-top-left" style={{ width: canvas.width, height: canvas.height, transform: `scale(${zoom})` }}>

              {/* Connectors, under the cards */}
              <svg className="pointer-events-none absolute inset-0" width={canvas.width} height={canvas.height} aria-hidden="true">
                <AnimatePresence>
                  {treeNodes.map(node => node.parentPos && (
                    <motion.path
                      key={`edge-${node.id}`}
                      d={connectorPath(node.parentPos, node.position)}
                      className={typeStyleOf(node.itemType).stroke}
                      strokeWidth={1.75}
                      strokeLinecap="round"
                      fill="none"
                      initial={{ pathLength: 0, opacity: 0 }}
                      animate={{ pathLength: 1, opacity: 0.7 }}
                      exit={{ pathLength: 0, opacity: 0 }}
                      transition={{ duration: 0.4, ease: 'easeOut' }}
                    />
                  ))}
                </AnimatePresence>
              </svg>

              {/* Project root: as tall as its text, so the full name and ID show; centred on its connectors */}
              <div
                className="absolute -translate-y-1/2"
                style={{ left: rootPos.x, top: rootPos.y, width: CARD_W, minHeight: CARD_H }}
              >
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={rootExpanded ? 'Collapse project' : 'Expand project'}
                  className="group relative cursor-pointer rounded-lg border border-primary/40 bg-primary/10 px-3.5 py-3 shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/60 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => { toggleNode('project-root'); }}
                  onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleNode('project-root'); } }}
                >
                  <div className="flex items-center gap-1.5 pr-7 text-[10px] font-semibold uppercase leading-none tracking-wider text-primary">
                    <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
                    Project Root
                  </div>
                  <div className="mt-1.5 break-words text-sm font-semibold leading-snug text-foreground">
                    {projectName ?? 'Project'}
                  </div>
                  {projectId && (
                    <div className="mt-1 break-all font-mono text-[10px] leading-snug text-muted-foreground">
                      ID: {projectId}
                    </div>
                  )}

                  <div className="pointer-events-none absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 rounded-full text-primary hover:bg-primary/15 hover:text-primary"
                      title="Add BOM Assembly"
                      onClick={e => { e.stopPropagation(); onAddItem(null, BOMItemType.ASSEMBLY); }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {hasItems && (
                  <ExpandButton name="project" count={items.length} expanded={rootExpanded} onToggle={() => { toggleNode('project-root'); }} />
                )}
              </div>

              {/* Item cards */}
              <AnimatePresence>
                {treeNodes.map(node => (
                  <HierarchicalNode
                    key={node.id}
                    node={node}
                    onToggle={toggleNode}
                    onEdit={onEditItem}
                    onAdd={onAddItem}
                    onRemove={setPendingDelete}
                    {...(onOpenItem ? { onOpen: onOpenItem } : {})}
                  />
                ))}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>

      {/* Asked before every delete from the tree */}
      <AlertDialog open={pendingDelete !== null} onOpenChange={o => { if (!o) setPendingDelete(null); }}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure you want to delete?</AlertDialogTitle>
            <AlertDialogDescription>
              “{pendingDelete?.name}” will be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (pendingDelete) onDeleteItem(pendingDelete.id); setPendingDelete(null); }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
