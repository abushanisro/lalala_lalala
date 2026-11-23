import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { BomItemReanalysisService } from '../../../../modules/bom-items/services/bom-item-reanalysis.service';

import type { BOMItemsService } from '../../../../modules/bom-items/bom-items.service';
import type { AutoFillService } from '../../../../modules/bom-items/services/auto-fill.service';
import type { FileStorageService } from '../../../../modules/bom-items/services/file-storage.service';
import type { PlasticPullDirectionService } from '../../../../modules/bom-items/services/plastic-pull-direction.service';

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
  const service = new BomItemReanalysisService(items, files, autoFill, {} as unknown as PlasticPullDirectionService);
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
