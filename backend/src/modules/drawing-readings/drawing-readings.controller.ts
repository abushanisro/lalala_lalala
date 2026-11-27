import { BadRequestException, Body, Controller, HttpCode, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { memoryStorage } from 'multer';

import { MAX_DRAWING_BYTES } from './drawing-reading';
import { DrawingReadingsService, type DrawingReadingResult } from './drawing-readings.service';
import { DrawingSolidsService, type DrawingSolid } from './drawing-solids.service';
import { OrgRole } from '../../common/authz/authz-policy';
import { AccessToken } from '../../common/decorators/access-token.decorator';
import { CurrentOrganization } from '../../common/decorators/current-organization.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrganizationContextGuard } from '../../common/guards/organization-context.guard';
import { SpendsAi } from '../../common/throttling/throttlers';

/**
 * Reads an engineering drawing or a picture of a part with the vision model. A reading is made, not stored: the person checks it
 * before a project, a BOM or a part is created from it. It spends the caller's AI budget (429 when used up, 503 when AI is off).
 */
@ApiTags('Drawing readings')
@ApiBearerAuth()
@OrgRole('member')
@UseGuards(OrganizationContextGuard)
@Controller({ path: 'drawing-readings', version: '1' })
export class DrawingReadingsController {
  constructor(private readonly readings: DrawingReadingsService) {}

  @Post()
  @HttpCode(200) // a reading, answered in full: nothing is created
  @SpendsAi()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Read one drawing (PNG, JPEG, WebP, GIF or PDF): part, material, overall shape, holes, tolerances, and what could not be read.' })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_DRAWING_BYTES } }))
  read(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { note?: unknown },
    @CurrentUser() user: { id: string },
    @AccessToken() token: string,
    @CurrentOrganization() organizationId: string,
  ): Promise<DrawingReadingResult> {
    if (!file) throw new BadRequestException({ code: 'no_file', message: 'Attach the drawing as "file".' });
    return this.readings.read(file, { userId: user.id, organizationId, accessToken: token }, typeof body.note === 'string' ? body.note : undefined);
  }
}

/** The simple 3D model of a part that has a drawing and no model, built from a reading's form and holes. Made, not stored. */
@ApiTags('Drawing readings')
@ApiBearerAuth()
@OrgRole('member')
@Controller({ path: 'drawing-solids', version: '1' })
export class DrawingSolidsController {
  constructor(private readonly solids: DrawingSolidsService) {}

  @Post()
  @HttpCode(200) // a model, answered in full: nothing is created
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: "Build a simple solid (STEP) from a drawing reading's overall form and holes, to upload as the part's 3D model." })
  build(@Body() body: { shape?: unknown; holes?: unknown; name?: unknown }): Promise<DrawingSolid> {
    return this.solids.build(body);
  }
}
