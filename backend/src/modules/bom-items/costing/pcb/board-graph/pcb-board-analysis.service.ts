import { BadRequestException, Injectable, Logger, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';

import { BOARD_ARCHIVE_LIMITS, boardSetFiles, entriesOf, MAX_BOARD_FILES } from './board-files';
import { PCB_GEOMETRY_VERSION, type PcbGeometrySummary } from './pcb-geometry';
import { expandArchiveInWorker, withHeavyWorkSlot } from '../../../../../common/heavy-work/heavy-work';
import { BoardExtractionClient, ExtractionRejected, ExtractionUnavailable } from './board-extraction.client';

export { PCB_GEOMETRY_VERSION, type PcbGeometrySummary } from './pcb-geometry';

/** The name the set was uploaded with: the stored name carries an upload timestamp in front of it. */
const uploadedName = (path: string): string => (path.split('/').pop() ?? path).replace(/^(\d{10,}_)+/, '');

/** Measures a part's stored board set (bom_items.file_board_path) with the CAD engine's board routes. */
@Injectable()
export class PcbBoardAnalysisService {
  private readonly logger = new Logger(PcbBoardAnalysisService.name);

  constructor(private readonly engine: BoardExtractionClient) {}

  /**
   * The board set's measurement. A set the engine refuses (no outline layer, an unreadable layer) is the user's to fix and says why;
   * an engine that cannot be reached is reported as unavailable. Nothing is estimated.
   */
  async measure(storagePath: string, zipBytes: Buffer): Promise<PcbGeometrySummary> {
    const sourceName = uploadedName(storagePath);
    const archive = await withHeavyWorkSlot(() => expandArchiveInWorker(sourceName, zipBytes, BOARD_ARCHIVE_LIMITS));
    if (!archive.ok) throw new BadRequestException(`The board files (${sourceName}) could not be unpacked: ${archive.message}`);
    const { files, skipped } = boardSetFiles(entriesOf(archive.entries));
    if (!files.some((f) => f.role === 'board_outline')) {
      throw new UnprocessableEntityException(`The board files (${sourceName}) hold no outline layer (.gko), so the board's size cannot be measured. Add it and upload the set again.`);
    }
    if (files.length > MAX_BOARD_FILES) {
      throw new UnprocessableEntityException(`The board set holds ${files.length} board files and tables; at most ${MAX_BOARD_FILES} are read. Remove the ones that are not this board's.`);
    }
    try {
      const out = await this.engine.extractBoard(files, {}, 'B');
      const report = [...out.filesReport, ...skipped.map((s) => ({ name: s.name, role: 'none', status: 'skipped', note: s.reason }))];
      return { extractionVersion: PCB_GEOMETRY_VERSION, source: 'board_files', sourceName, graph: out.graph as Record<string, unknown>, filesReport: report };
    } catch (error) {
      if (error instanceof ExtractionRejected) throw new UnprocessableEntityException(`The CAD engine could not read the board files (${sourceName}): ${error.message}`);
      if (error instanceof ExtractionUnavailable) {
        this.logger.warn(`board set ${sourceName}: ${error.message}`);
        throw new ServiceUnavailableException('The CAD engine is not available to read the board files. Try again in a moment.');
      }
      throw error;
    }
  }
}
