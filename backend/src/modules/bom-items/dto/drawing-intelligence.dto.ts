import { Type } from 'class-transformer';
import {
  IsString, IsNumber, IsArray, IsOptional, ValidateNested, Min, Max, Matches, IsBoolean, IsIn,
} from 'class-validator';

// Mirrors cad-engine/drawing_analyzer.py's real POST /drawing/analyze response
// (PyMuPDF text-block extraction — vector PDFs only, never OCR/image drawings).
// Stored as-is (validated, not reshaped) into bom_items.drawing_intelligence —
// the parser is treated as the authoritative source; this DTO's job is to
// reject a malformed/unexpected response before it's ever persisted, not to
// translate its field names or invent structure it doesn't produce.
//
// gdt_callouts/clearanceHoles are typed as unknown[] deliberately: the Python
// analyzer hardcodes both to [] today (no real GD&T/clearance-hole extraction
// exists yet, only the placeholder fields) — giving them a detailed nested
// shape now would describe data that doesn't exist.

export class ThreadCalloutDto {
  @IsString()
  size!: string;

  @IsOptional()
  @IsNumber()
  pitch?: number;

  @IsNumber()
  @Min(1)
  count!: number;

  // Whether the callout states its count ("4 X M6") or names the size alone ("M6", where 1 is the analyser's default). Optional: a
  // drawing analysed before the analyser reported it has no such field. Undecorated it was stripped by the whitelist and never stored.
  @IsOptional()
  @IsBoolean()
  countStated?: boolean;

  // Whether the callout writes its pitch ("M12x1.75") or the pitch above is the analyser's coarse-series default ("M12").
  @IsOptional()
  @IsBoolean()
  pitchStated?: boolean;

  // The tolerance class printed after the size (ISO 965-1 "6g" / "6H", UN "2A" / "2B"); null when none is printed.
  @IsOptional()
  @IsString()
  toleranceClass?: string | null;

  // What the callout states of the thread: 'external' (a small-letter class, 2A, EXTERNAL) or 'internal' (a capital class, 2B,
  // TAPPED); null when it states neither.
  @IsOptional()
  @IsIn(['internal', 'external'])
  threadKind?: 'internal' | 'external' | null;

  // The thread's length the callout states ("M12x1.75-6g x 15 LG"); null when it states none.
  @IsOptional()
  @IsNumber()
  @Min(0)
  lengthMm?: number | null;

  @IsString()
  standard!: string; // 'metric' | 'imperial'

  @IsNumber()
  @Min(0)
  @Max(1)
  extractionConfidence!: number;

  @IsString()
  extractionSource!: string;
}

/**
 * A knurl callout as printed (cad-engine drawing_analyzer._extract_knurls): "MEDIUM DIAMOND KNURL", "STRAIGHT KNURL 30 TPI",
 * "Ø20 DIAMOND KNURL 10 LG", "RGE 1.0 DIN 82". Each value is null when the callout does not state it.
 */
export class KnurlCalloutDto {
  @IsOptional()
  @IsIn(['diamond', 'straight', 'diagonal', 'crossed'])
  pattern?: string | null;

  @IsOptional()
  @IsIn(['fine', 'medium', 'coarse'])
  grade?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  pitchMm?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  tpi?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  diameterMm?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  lengthMm?: number | null;

  @IsString()
  text!: string;

  @IsString()
  extractionSource!: string;
}

/** The drawing's machining allowance callout, as printed (cad-engine drawing_analyzer._extract_machining_allowance). */
export class MachiningAllowanceCalloutDto {
  @IsString()
  text!: string;

  // mm per machined face; null when the drawing gives none, no millimetre unit, or two different values.
  @IsOptional()
  @IsNumber()
  @Min(0)
  allowance_mm!: number | null;

  // RMAG grade A-K and DCTG grade 1-16 of an ISO 8062-3 callout; null when not printed.
  @IsOptional()
  @Matches(/^[A-K]$/)
  rmag!: string | null;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(16)
  dctg!: number | null;
}

class DrawingDimensionsDto {
  @IsNumber()
  L!: number;

  @IsNumber()
  W!: number;

  @IsNumber()
  H!: number;
}

export class DrawingIntelligenceDto {
  @IsString()
  material!: string;

  @IsNumber()
  @Min(0)
  @Max(1)
  material_confidence!: number;

  @IsString()
  process!: string;

  @ValidateNested()
  @Type(() => DrawingDimensionsDto)
  dimensions_mm!: DrawingDimensionsDto;

  @IsNumber()
  tightest_tolerance_mm!: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  tolerance_confidence!: number;

  @IsNumber()
  surface_finish_ra!: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  surface_finish_confidence!: number;

  @IsNumber()
  sheet_thickness_mm!: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  sheet_thickness_confidence!: number;

  @IsNumber()
  bend_count!: number;

  @IsString()
  heat_treatment!: string;

  @IsString()
  coating!: string;

  // Chemical milling callout text ("CHEM MILL", ...) or "None". Optional:
  // drawings analyzed before the analyzer reported it have no such field.
  @IsOptional()
  @IsString()
  chemical_milling?: string;

  // Gear quality ("A8" / "Q10" / "DIN7" or "None"), gear shaving / shaping
  // callouts and a polygon callout — optional for the same reason.
  @IsOptional()
  @IsString()
  gear_quality?: string;

  @IsOptional()
  @IsString()
  gear_shaving?: string;

  @IsOptional()
  @IsString()
  gear_shaping?: string;

  @IsOptional()
  @IsString()
  polygon_callout?: string;

  // Optional for the same reason; null when the drawing has no allowance callout.
  @IsOptional()
  @ValidateNested()
  @Type(() => MachiningAllowanceCalloutDto)
  machining_allowance?: MachiningAllowanceCalloutDto | null;

  @IsString()
  complexity!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ThreadCalloutDto)
  threads!: ThreadCalloutDto[];

  // Knurl callouts. Optional: a drawing analysed before the analyser read knurls has no such field.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KnurlCalloutDto)
  knurls?: KnurlCalloutDto[];

  // Always [] today — see class-level comment.
  @IsArray()
  gdt_callouts!: unknown[];

  @IsArray()
  clearanceHoles!: unknown[];

  @IsString()
  general_tolerances!: string;

  @IsString()
  drawing_revision!: string;

  @IsString()
  drawing_number!: string;

  @IsString()
  drawing_notes!: string;

  @IsNumber()
  @Min(0)
  @Max(1)
  drawing_intelligence_confidence!: number;

  @IsString()
  analyzedAt!: string;

  // Added by the NestJS integration layer, not by the Python parser itself —
  // bumped whenever drawing-intelligence.dto.ts's shape changes, so a future
  // consumer can tell which parser-response shape a given stored row used.
  @IsString()
  parserVersion!: string;
}
