import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsObject, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import type { SourceRef } from './cost-breakdown.dto';

export class MachiningCalculatorInputsRequestDto {
  @ApiProperty({ description: 'The machining calculator (calculators.id) to resolve inputs for' })
  @IsUUID()
  calculatorId!: string;

  @ApiPropertyOptional({
    description: 'Key inputs the engineer entered (e.g. {"Hole Diameter": 6}); they replace the part CAD values when choosing lookup rows',
    type: 'object',
    additionalProperties: { type: 'number' },
  })
  @IsOptional()
  @IsObject()
  keys?: Record<string, number>;

  @ApiPropertyOptional({ description: 'Digital factory location — when given, the part is costed and the calculator gets the inputs the engine used' })
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional({ description: 'Batch size for that costing (the canonical resolver applies when absent)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  batchSize?: number;

  @ApiPropertyOptional({ description: 'The process of the line being edited ("Drilling"), when several lines run the same calculator (a mill\'s Drilling line and its mill line): its inputs are that line\'s' })
  @IsOptional()
  @IsString()
  process?: string;

  @ApiPropertyOptional({ description: 'The machine chosen in the dialog (mhr_records.id): the inputs the calculator reads from its machine (top spindle speed) are read from it' })
  @IsOptional()
  @IsUUID()
  machineId?: string;

  @ApiPropertyOptional({ description: 'The calculator runs on a lathe\'s live tool (milling on the lathe), as the cost engine ran it: its spindle cap is the live tool\'s' })
  @IsOptional()
  @IsBoolean()
  liveTool?: boolean;
}

export class CalculatorInputsRequestDto extends MachiningCalculatorInputsRequestDto {
  @ApiPropertyOptional({ description: 'Which run of the calculator, when the part has several ("Slide 2"); the first otherwise' })
  @IsOptional()
  @IsString()
  runKey?: string;
}

export interface MachiningCalculatorInputsDto {
  calculatorId: string;
  /** Catalog operation the calculator is mapped to ("Drilling", "Parting", ...). */
  operation: string;
  materialClass: string;
  /** Input field name → value (CAD measurement, entered key, or lookup-table value). */
  inputs: Record<string, number>;
  /** Input field name → where the value came from. */
  provenance: Record<string, string>;
  /** Input field name → the lookup-table row(s) the value came from. */
  lookupMatches: Record<string, { table: string; row: Record<string, string | number> }>;
  /** Input field name → where the value was read (SourceRef), for the eye beside it; an entered value has none. */
  refs: Record<string, SourceRef>;
  /** Inputs that could not be resolved, each with the reason. */
  missing: string[];
  /** The inputs read from the machine the calculator runs on (Max Spindle Speed): re-read whenever the dialog's machine changes. */
  machineFields: string[];
}
