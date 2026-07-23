/**
 * @habemus-papadum/aiui-optics/widgets — the Solid display islands shared by
 * the diffraction/holography notebooks. Split from the root barrel so workers
 * (which import the pure engine) never pull solid-js. Consumers import
 * `@habemus-papadum/aiui-optics/widgets.css` once for the layout chrome.
 */
export { FieldMap } from "./FieldMap";
export { FilmStrip, GrainStrip } from "./FilmStrip";
export { type PhasorArrow, PhasorDial } from "./PhasorDial";
