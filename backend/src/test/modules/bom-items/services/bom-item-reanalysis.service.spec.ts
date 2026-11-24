import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { BomItemReanalysisService } from '../../../../modules/bom-items/services/bom-item-reanalysis.service';

import type { BOMItemsService } from '../../../../modules/bom-items/bom-items.service';
import type { AutoFillService } from '../../../../modules/bom-items/services/auto-fill.service';
import type { FileStorageService } from '../../../../modules/bom-items/services/file-storage.service';
import type { PlasticPullDirectionService } from '../../../../modules/bom-items/services/plastic-pull-direction.service';
import type { PcbBoardAnalysisService } from '../../../../modules/bom-items/costing/pcb/board-graph/pcb-board-analysis.service';

// Refresh analysis reads the part's file from storage. A row can name a file the environment never received (an item carried over
// from another database): that is something the user can fix, so it is said plainly, with the name the file was uploaded with.
// A storage outage is not the user's to fix.
const ITEM = {
  id: 'item-1', partNumber: 'P-1', scenarioOverrides: {},
  fileStepPath: 'u/p/bom-items/item-1/3d/1793473277903_1793473277814_shaft.step',
  file3dPath: 'u/p/bom-items/item-1/3d/1793473277903_shaft.stl',
  file2dPath: 'u/p/bom-items/item-1/2d/1785955156597_shaft.pdf',
};

function serviceReading(download: (path: string) => Promise<Buffer | null>) {
  const asked: string[] = [];
  const items = { findOne: () => Promise.resolve(ITEM), update: () => Promise.resolve({}) } as unknown as BOMItemsService;
  const files = { download: (path: string) => { asked.push(path); return download(path); } } as unknown as FileStorageService;
  const autoFill = { familyHintForProcessGroup: () => undefined, analyzeDrawing: () => Promise.resolve({}) } as unknown as AutoFillService;
  const service = new BomItemReanalysisService(items, files, autoFill, {} as unknown as PlasticPullDirectionService, {} as unknown as PcbBoardAnalysisService);
  return { service, asked };
}
const nothingStored = () => Promise.resolve(null);

describe('BomItemReanalysisService: the stored file', () => {
  it('names the missing file and says to upload it again, instead of "failed to download"', async () => {
    const { service, asked } = serviceReading(nothingStored);
    await expect(service.reanalyze('item-1', 'user-1', 'token')).rejects.toThrow(new NotFoundException(
      "This part's 3D model (shaft.step) is not in file storage, so it cannot be analysed. Upload the file again on the part.",
    ));
    // the original STEP is read in preference to the viewable STL
    expect(asked).toEqual([ITEM.fileStepPath]);
  });

  it('says the same for a missing drawing', async () => {
    const { service } = serviceReading(nothingStored);
    await expect(service.analyzeDrawing('item-1', 'user-1', 'token')).rejects.toThrow("This part's 2D drawing (shaft.pdf) is not in file storage");
  });

  it('reports a storage outage as one, not as a missing file', async () => {
    const { service } = serviceReading(() => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:8333')));
    await expect(service.reanalyze('item-1', 'user-1', 'token')).rejects.toThrow(ServiceUnavailableException);
  });
});

// A board set (Gerber, drill, Pick Place) is measured by the CAD engine's board routes. With no 3D model the measurement is the part's analysis;
// with one, it is laid into the model's analysis summary.
describe('BomItemReanalysisService: the board files', () => {
  const BOARD = 'u/p/bom-items/item-2/board/1793473277903_fl285182.zip';
  const MEASURED = {
    extractionVersion: 'pcb_v1' as const, source: 'board_files' as const, sourceName: 'fl285182.zip',
    graph: { outline: { lengthMm: 273.7, widthMm: 170.7 }, layers: 2 }, filesReport: [],
  };

  function boardService(item: Record<string, unknown>) {
    const updates: Array<Record<string, unknown>> = [];
    const items = { findOne: () => Promise.resolve(item), update: (_id: string, data: Record<string, unknown>) => { updates.push(data); return Promise.resolve(data); } } as unknown as BOMItemsService;
    const files = { download: () => Promise.resolve(Buffer.from('zip')) } as unknown as FileStorageService;
    const analyzed: string[] = [];
    const autoFill = {
      familyHintForProcessGroup: () => undefined,
      analyzeAndSuggest: (_b: Buffer, name: string) => {
        analyzed.push(name);
        return Promise.resolve({ geometry: { boundingBox: { length: 0, width: 0, height: 0 }, weight: 0, volume: 0, surfaceArea: 0 }, suggestions: {}, featureGraph: { classification: { family: 'sheet_metal' }, summary: { holes: 3 } } });
      },
    } as unknown as AutoFillService;
    const pull = { get: () => Promise.resolve({ axis: null }) } as unknown as PlasticPullDirectionService;
    const boards = { measure: (path: string) => (path === BOARD ? Promise.resolve(MEASURED) : Promise.reject(new Error(`no ${path}`))) } as unknown as PcbBoardAnalysisService;
    return { service: new BomItemReanalysisService(items, files, autoFill, pull, boards), updates, analyzed };
  }

  it('stores the measurement as the analysis of a part with board files and no 3D model, with the outline as its length and width', async () => {
    const { service, updates, analyzed } = boardService({ id: 'item-2', partNumber: 'FL285182', scenarioOverrides: {}, fileBoardPath: BOARD });
    await service.reanalyze('item-2', 'user-1', 'token');
    expect(analyzed).toEqual([]);
    expect(updates).toEqual([{ featureGraph: { summary: { pcbGeometry: MEASURED } }, maxLength: 273.7, maxWidth: 170.7 }]);
  });

  it('lays the board measurement into the 3D model\'s analysis when the part has both', async () => {
    const { service, updates, analyzed } = boardService({ ...ITEM, id: 'item-2', fileBoardPath: BOARD });
    await service.reanalyze('item-2', 'user-1', 'token');
    expect(analyzed).toEqual(['1793473277903_1793473277814_shaft.step']);
    expect((updates[0]!.featureGraph as { summary: Record<string, unknown> }).summary).toEqual({ holes: 3, pcbGeometry: MEASURED });
  });

  it('asks for a 3D model or the board files when the part has neither', async () => {
    const { service } = boardService({ id: 'item-3', partNumber: 'P-3', scenarioOverrides: {} });
    await expect(service.reanalyze('item-3', 'user-1', 'token')).rejects.toThrow("No 3D file or board files found for this item — upload a STEP/STL file or the board's Gerber set first");
  });
});
