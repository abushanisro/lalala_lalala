import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsNumber, IsOptional, IsPositive, Max, Min, ValidateNested } from 'class-validator';

/** The grade's own Cross-WLF viscosity constants, from its datasheet or a rheometer fit. There is no default: a guessed melt is a guessed result. */
export class CrossWlfDto {
  @ApiProperty({ description: 'Power-law index n (0 to 1).' })
  @IsNumber() @IsPositive() @Max(1)
  n!: number;

  @ApiProperty({ description: 'Critical shear stress tau* (Pa).' })
  @IsNumber() @IsPositive()
  tauPa!: number;

  @ApiProperty({ description: 'D1 (Pa s).' })
  @IsNumber() @IsPositive()
  d1PaS!: number;

  @ApiProperty({ description: 'D2, the reference temperature (K).' })
  @IsNumber() @IsPositive()
  d2K!: number;

  @ApiProperty({ description: 'A1.' })
  @IsNumber() @IsPositive()
  a1!: number;

  @ApiProperty({ description: 'A2 (K).' })
  @IsNumber() @IsPositive()
  a2K!: number;
}

/**
 * One injection fill simulation of the part's 3D model. Without a gate the answer is the fill mesh alone (where a gate can go);
 * with a gate, a fill time, a melt temperature and the Cross-WLF constants it is the mesh and the fill.
 */
export class RunFillSimulationDto {
  @ApiPropertyOptional({ type: [Number], description: 'Gate position [x, y, z] in part-centred mm (the 3D viewer frame). The nearest mesh node becomes the gate.' })
  @IsOptional() @IsArray() @ArrayMinSize(3) @ArrayMaxSize(3) @IsNumber({}, { each: true })
  gateMm?: number[];

  @ApiPropertyOptional({ description: 'Gate radius (mm): every mesh node within it is part of the gate. 0 is a pin gate.' })
  @IsOptional() @IsNumber() @Min(0) @Max(50)
  gateRadiusMm?: number;

  @ApiPropertyOptional({ description: 'Fill time (s). The flow rate is the mesh volume over it.' })
  @IsOptional() @IsNumber() @IsPositive() @Max(600)
  fillTimeS?: number;

  @ApiPropertyOptional({ description: 'Melt temperature at the gate (deg C).' })
  @IsOptional() @IsNumber() @Min(1) @Max(499)
  meltTempC?: number;

  @ApiPropertyOptional({ type: CrossWlfDto, description: "The grade's own viscosity constants. Without them, flowLengthRatio and maxInjectionPressureMpa give an estimate." })
  @IsOptional() @ValidateNested() @Type(() => CrossWlfDto)
  rheology?: CrossWlfDto;

  @ApiPropertyOptional({ description: "The grade's maximum flow length over wall thickness (reference data). With maxInjectionPressureMpa it sets one effective viscosity: an estimate." })
  @IsOptional() @IsNumber() @IsPositive() @Max(2000)
  flowLengthRatio?: number;

  @ApiPropertyOptional({ enum: ['x', 'y', 'z'], description: 'Mold opening axis, for the clamp force. Left out, the CAD engine chooses it from the part.' })
  @IsOptional() @IsIn(['x', 'y', 'z'])
  pullAxis?: 'x' | 'y' | 'z';

  @ApiPropertyOptional({ description: 'Injection pressure the machine or material allows (MPa): going over it is reported as an issue.' })
  @IsOptional() @IsNumber() @IsPositive()
  maxInjectionPressureMpa?: number;
}
