import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { OrgRole } from '../../common/authz/authz-policy';
import { AccessToken } from '../../common/decorators/access-token.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RunFillSimulationDto } from './dto/fill-simulation.dto';
import { FillSimulationService, type FillSimulationInputs } from './services/fill-simulation.service';

/**
 * Injection fill simulation of a part: how the melt fills the cavity from a gate the engineer places. A simulation is run, not
 * stored: the same call without a gate returns the fill mesh, to show where a gate can go.
 */
@ApiTags('Plastic molding')
@ApiBearerAuth()
@OrgRole('member')
@Controller({ path: 'bom-items/:id', version: '1' })
export class BomItemFillSimulationController {
  constructor(private readonly fillSimulations: FillSimulationService) {}

  @OrgRole('viewer')
  @Get('fill-simulation-inputs')
  @ApiOperation({ summary: "What the reference data recommends for a fill simulation of the part: its grade's melt temperature, pressure and flow length ratio." })
  async inputs(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }, @AccessToken() token: string): Promise<FillSimulationInputs> {
    return this.fillSimulations.recommendedInputs(id, user.id, token);
  }

  @Post('fill-simulations')
  @HttpCode(HttpStatus.OK) // a computation, answered in full: nothing is created
  @Throttle({ default: { limit: 20, ttl: 60_000 } }) // heavy: the CAD engine meshes and simulates
  @ApiOperation({ summary: "Run an injection fill simulation of the part's 3D model (or, without a gate, return its fill mesh)." })
  async run(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RunFillSimulationDto,
    @CurrentUser() user: { id: string },
    @AccessToken() token: string,
  ): Promise<unknown> {
    return this.fillSimulations.run(id, user.id, token, body);
  }
}
