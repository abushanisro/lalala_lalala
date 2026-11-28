import { BadRequestException, Body, Controller, HttpCode, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { memoryStorage } from 'multer';

import { MAX_DRAWING_BYTES } from './drawing-reading';
import { DrawingReadingsService, type DrawingReadingResult } from './drawing-readings.service';
import { DrawingSolidsService, type DrawingSolid } from './drawing-solids.service';
import { IntakeAnswersService, type IntakeAnswer } from './intake-answers.service';
import { IntakePicksService, type IntakePicks } from './intake-picks.service';
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

/**
 * "Ask" on the intake page: one question, about the attached drawing or picture when there is one, answered in words. An answer is
 * made, not stored, and nothing is created from it. It spends the caller's AI budget (429 when used up, 503 when AI is off).
 */
@ApiTags('Drawing readings')
@ApiBearerAuth()
@OrgRole('member')
@UseGuards(OrganizationContextGuard)
@Controller({ path: 'intake-answers', version: '1' })
export class IntakeAnswersController {
  constructor(private readonly answers: IntakeAnswersService) {}

  @Post()
  @HttpCode(200) // an answer, given in full: nothing is created
  @SpendsAi()
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Answer one question about a drawing or a picture of a part (optional file: PNG, JPEG, WebP, GIF or PDF). No cost figures; nothing is created.' })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_DRAWING_BYTES } }))
  ask(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { question?: unknown },
    @CurrentUser() user: { id: string },
    @AccessToken() token: string,
    @CurrentOrganization() organizationId: string,
  ): Promise<IntakeAnswer> {
    return this.answers.ask(body.question, file, { userId: user.id, organizationId, accessToken: token });
  }
}

/**
 * A pick from a list for the intake page's questions: the material grades a part is most likely made of, or the listed answer a
 * person's own words mean. Picks are made, not stored, and are always choices of the list given. It spends the caller's AI budget
 * (429 when used up, 503 when AI is off).
 */
@ApiTags('Drawing readings')
@ApiBearerAuth()
@OrgRole('member')
@UseGuards(OrganizationContextGuard)
@Controller({ path: 'intake-picks', version: '1' })
export class IntakePicksController {
  constructor(private readonly picks: IntakePicksService) {}

  @Post()
  @HttpCode(200) // picks, given in full: nothing is created
  @SpendsAi()
  @ApiOperation({ summary: 'Pick from a list of choices: up to three likely material grades for a part ("material"), or the one a typed answer means ("answer"). No cost figures; nothing is created.' })
  pick(
    @Body() body: unknown,
    @CurrentUser() user: { id: string },
    @AccessToken() token: string,
    @CurrentOrganization() organizationId: string,
  ): Promise<IntakePicks> {
    return this.picks.pick(body, { userId: user.id, organizationId, accessToken: token });
  }
}
