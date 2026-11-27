"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { FlowSimulationWorkspace } from "./FlowSimulationWorkspace";

export interface FlowSimulationDialogProps {
  open: boolean;
  onClose: () => void;
  itemId: string;
  partName?: string | undefined;
  /** The fill time the cost engine calculated for the part, and its runner system: the setup starts from them. */
  costFillTimeS?: number | null | undefined;
  runner?: "hot" | "cold" | null | undefined;
}

/** The injection fill simulation of a part, full screen: the part and the melt on the left, setup and results on the right. */
export function FlowSimulationDialog({ open, onClose, itemId, partName, costFillTimeS, runner }: FlowSimulationDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex w-[96vw] max-w-[1500px] flex-col gap-0 overflow-hidden p-0" style={{ height: "min(94vh, 940px)" }}>
        <DialogHeader className="shrink-0 space-y-0.5 border-b px-4 py-2.5 text-left">
          <DialogTitle className="text-sm">{partName ? `Fill simulation: ${partName}` : "Fill simulation"}</DialogTitle>
          <DialogDescription className="text-[11px]">
            How the melt fills the cavity from one gate: fill pattern, pressure, flow direction, weld lines and air traps. Filling only, at one melt temperature.
          </DialogDescription>
        </DialogHeader>
        {open && <FlowSimulationWorkspace itemId={itemId} costFillTimeS={costFillTimeS} runner={runner} />}
      </DialogContent>
    </Dialog>
  );
}
