// The intake's steps as calls to the app's existing endpoints (and the two drawing endpoints). Nothing here is intake-only on the
// server: a part made by the box is a part like any other.
import { bomApi } from "@/lib/api/bom";
import { cadUploadsApi } from "@/lib/api/cad-uploads";
import { apiClient } from "@/lib/api/client";
import { drawingReadingsApi } from "@/lib/api/drawing-readings";
import { createBOMItem } from "@/lib/api/hooks/useBOMItems";
import { projectsApi } from "@/lib/api/projects";

import type { IntakeApi } from "./run";

export const intakeApi: IntakeApi = {
  createProject: name => projectsApi.create({ name }),
  createBom: (projectId, name) => bomApi.create({ name, projectId }),
  createItem: item => createBOMItem({ ...item, itemType: "child_part", unit: "pcs" }),
  buildSolid: body => drawingReadingsApi.solid(body),
  uploadFiles: (itemId, files) => {
    const form = new FormData();
    if (files.file2d) form.append("file2d", files.file2d);
    if (files.file3d) form.append("file3d", files.file3d);
    return apiClient.uploadFiles(`/bom-items/${itemId}/files`, form);
  },
  setProcessGroup: (itemId, processGroup) => apiClient.patch(`/bom-items/${itemId}/scenario-overrides`, { processGroup }),
  analyse: itemId => apiClient.post(`/bom-items/${itemId}/analysis-runs`, {}, { timeout: 150_000, retry: false }),
  applyScenario: (itemId, request) => apiClient.post(`/bom-items/${itemId}/scenario-applications`, request, { timeout: 240_000, retry: false }),
  importCad: (bomId, file) => cadUploadsApi.start(bomId, file),
};
