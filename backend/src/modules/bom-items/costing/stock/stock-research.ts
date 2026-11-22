// What memory/Stock Maching does not hold for sizing and sawing stock, from published sources (2026-11-22). Each is the engine's own value,
// stated on the quote, and the Cost Guide can replace the first.

/**
 * The end of a bar that makes no part: what the saw's vises (or a lathe's bar feeder) still hold when the bar no longer reaches the stop.
 * Saw builders publish 35 to 190 mm for automatic band saws (a 120 mm butt end, a 180 or 190 mm remaining piece); bar feeders 2 to 6 in. No
 * standard exists. 6 in is taken, inside both ranges and the value Multi-Spindle Machining already uses for its bar feeder.
 */
export const BAR_END_REMNANT_MM = 152.4;
export const BAR_END_REMNANT_SOURCE = 'Bar end that makes no part: automatic band saws leave 35-190 mm, bar feeders 2-6 in; 6 in taken (saw builders\' published '
  + 'remnant lengths; Production Machining, "Bar feeder basics")';

/**
 * A band saw's cut time is the area cut over its cutting rate (Machinery's Handbook, band saw speed and feed rate: "the time required to
 * make a cut is equal to the area of the cut divided by the cutting rate"), and a bundle is cut as one section: its whole area at the rate
 * for its whole width (The Fabricator, "Cutting through the obstacles"). Bundling saves the handling and indexing of each bar, not the
 * cutting of it.
 */
export const BAND_SAW_CUT_SOURCE = 'Cut time = area cut / cutting rate; a bundle is cut as one section at the rate for its width '
  + '(Machinery\'s Handbook, band saw cutting rate; The Fabricator, "Cutting through the obstacles")';
