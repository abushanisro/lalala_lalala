// The grooves a lathe plunges: the part's Ring:groove features (cad-engine toroid_features.py: a concave torus on the turning line, all the
// way round, with a groove's profile), grouped by size for the Plunging calculator. Pure.
//
// Each occurrence states its round profile's depth (depth_mm) and chord width (width_mm) since geo_v89; its diameter is the feature's
// (diameter_mm, the major diameter of the torus, the circle the profile's centre runs round). A groove of a part analysed before then has no
// depth or width: it is kept with what it lacks, for the line to name.

export interface TurnedGroove {
  /** The groove's major diameter (the feature's diameter_mm); null when the CAD gives none. */
  diameterMm: number | null;
  depthMm: number | null;
  widthMm: number | null;
  grooves: number;
  /** The groove faces (each occurrence's face_ids), for the Process tree to light. */
  faceIds: number[];
  featureIds: string[];
  /** The CAD measurements a groove of this group lacks ("depth", "width", "diameter"): the line names them, it does not price them. */
  lacks: string[];
}

const positive = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function turnedGrooveGroups(features: readonly unknown[] | null | undefined): TurnedGroove[] {
  const groups = new Map<string, TurnedGroove>();
  for (const f of (features ?? []) as any[]) {
    if (f?.feature_type !== 'Ring' || f?.variant !== 'groove') continue;
    const diameterMm = positive(f.diameter_mm);
    const occurrences: any[] = Array.isArray(f.occurrences) && f.occurrences.length > 0 ? f.occurrences : [{}];
    for (const o of occurrences) {
      const depthMm = positive(o?.depth_mm);
      const widthMm = positive(o?.width_mm);
      const lacks = [
        ...(diameterMm == null ? ['diameter'] : []), ...(depthMm == null ? ['depth'] : []), ...(widthMm == null ? ['width'] : []),
      ];
      const key = `${diameterMm}|${depthMm}|${widthMm}`;
      const g = groups.get(key) ?? { diameterMm, depthMm, widthMm, grooves: 0, faceIds: [], featureIds: [], lacks };
      g.grooves += 1;
      for (const id of Array.isArray(o?.face_ids) ? o.face_ids : []) if (Number.isInteger(id) && !g.faceIds.includes(id)) g.faceIds.push(id);
      if (typeof f.id === 'string' && f.id && !g.featureIds.includes(f.id)) g.featureIds.push(f.id);
      groups.set(key, g);
    }
  }
  return [...groups.values()];
}
