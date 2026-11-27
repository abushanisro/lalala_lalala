import { apiClient } from "@/lib/api/client";

/** The cost elements of a part's own cost. */
export type CostElement = "rawMaterial" | "process" | "tooling" | "packagingLogistics" | "procuredParts";

/** What the money is spent on, finer than the elements: the things a cost reduction acts on. */
export type CostDriver =
  | "machineTime" | "labourTime" | "setup" | "processScrap" | "processOther"
  | "materialInPart" | "materialRemoved" | "materialScrap" | "materialOverhead" | "materialOther"
  | "tooling" | "packagingLogistics" | "procuredParts";

export interface PartCostRow {
  id: string;
  name: string;
  partNumber: string | null;
  bomId: string;
  bomName: string;
  projectId: string | null;
  unitCost: number;
  elements: Record<CostElement, number>;
  annualVolume: number | null;
  annualSpend: number | null;
  weightKg: number | null;
  cycleTimeS: number;
  /** The first cost record of the part: when it was costed. */
  costedAt: string | null;
  askPrice: number | null;
  /** Ask price less should-cost, per part. */
  gap: number | null;
  annualGap: number | null;
}

export interface GroupCost { name: string; parts: number; records: number; unitCost: number; annualSpend: number; annualHours: number }
export interface MaterialCost { name: string; parts: number; unitCost: number; annualSpend: number; grossKg: number; netKg: number }
export interface BomCost {
  id: string;
  name: string;
  projectId: string | null;
  projectName: string | null;
  parts: number;
  costed: number;
  unitCost: number;
  annualSpend: number;
  elements: Record<CostElement, number>;
  askAnnual: number;
  askShouldCostAnnual: number;
}

/** GET /cost-analytics: the organization's should-cost, totalled from its saved cost records. Every amount is in `currency`. */
export interface CostAnalytics {
  currency: string;
  /** The exchange rates applied: 1 unit of the key in `currency`. */
  fxRates: Record<string, number>;
  coverage: {
    parts: number;
    costed: number;
    notCosted: number;
    unresolved: number;
    withAnnualVolume: number;
    withAskPrice: number;
    askPriceUnconverted: number;
  };
  totals: {
    unitCost: number;
    annualSpend: number;
    annualHours: number;
    grossKg: number;
    netKg: number;
    elements: Record<CostElement, { unitCost: number; annualSpend: number }>;
  };
  savings: {
    parts: number;
    askAnnual: number;
    shouldCostAnnual: number;
    opportunityAnnual: number;
    partsAboveShouldCost: number;
    partsBelowShouldCost: number;
    shortfallAnnual: number;
  };
  /** The drivers that carry money, the largest first. They add up to the should-cost. */
  drivers: { key: CostDriver; unitCost: number; annualSpend: number }[];
  parts: PartCostRow[];
  partsOmitted: number;
  processGroups: GroupCost[];
  machines: GroupCost[];
  materials: MaterialCost[];
  boms: BomCost[];
}

export const costAnalyticsApi = {
  get: () => apiClient.get<CostAnalytics>("/cost-analytics"),
};
