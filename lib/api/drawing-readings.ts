import { spendingAi } from "@/lib/ai/usage-events";
import { apiClient } from "@/lib/api/client";

export type ProcessFamily = "machining" | "sheet_metal" | "casting" | "forging" | "plastic_molding" | "other";

/** The overall form of the part, in millimetres. */
export type DrawingShape =
  | { kind: "block"; lengthMm: number; widthMm: number; heightMm: number }
  | { kind: "turned"; segments: { diameterMm: number; lengthMm: number }[]; boreDiameterMm: number | null }
  | { kind: "sheet"; lengthMm: number; widthMm: number; thicknessMm: number };

/** One hole specification and how many holes have it. depthMm null is a through hole. */
export interface DrawingHole { diameterMm: number; depthMm: number | null; count: number; thread: string | null }

/** What the vision model read off a drawing (backend drawing-reading.ts). A value the drawing does not state is null. */
export interface DrawingReading {
  isDrawing: boolean;
  partName: string | null;
  partNumber: string | null;
  revision: string | null;
  material: string | null;
  units: "mm" | "inch" | null;
  quantity: number | null;
  process: { family: ProcessFamily; reason: string } | null;
  shape: DrawingShape | null;
  holes: DrawingHole[];
  tightestToleranceMm: number | null;
  surfaceFinishRaUm: number | null;
  notes: string[];
  /** Every value the model could not read clearly or had to interpret. */
  unsure: string[];
}

export interface DrawingReadingResult { fileName: string; model: string; reading: DrawingReading }

/** The simple solid built from a reading's form and holes (backend drawing-solids.service.ts). */
export interface DrawingSolid {
  fileName: string;
  stepBase64: string;
  volumeMm3: number;
  surfaceAreaMm2: number;
  boundingBox: { length: number; width: number; height: number; diagonal: number };
  holesPlaced: number;
  holesLeftOut: number;
}

/** One answer to a question asked on the New page (backend intake-answers.service.ts). It holds no cost figure. */
export interface IntakeAnswer { answer: string; model: string; fileName: string | null }

export const drawingReadingsApi = {
  /** POST /drawing-readings: one drawing (image or PDF) read by the vision model. Spends the caller's AI budget. */
  read: (file: File, note?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (note?.trim()) form.append("note", note.trim());
    return spendingAi(apiClient.uploadFiles<DrawingReadingResult>("/drawing-readings", form, { timeout: 240_000 }));   // a dense drawing takes the reader up to three minutes
  },
  /** POST /intake-answers: one question, about the attached drawing or picture when there is one. Spends the caller's AI budget. */
  ask: (question: string, file?: File) => {
    const form = new FormData();
    form.append("question", question);
    if (file) form.append("file", file);
    return spendingAi(apiClient.uploadFiles<IntakeAnswer>("/intake-answers", form, { timeout: 150_000 }));
  },
  /** POST /drawing-solids: the STEP of the solid a reading describes. */
  solid: (body: { shape: DrawingShape; holes: DrawingHole[]; name: string }) =>
    apiClient.post<DrawingSolid>("/drawing-solids", body, { timeout: 90_000, retry: false }),
};
