/**
 * @habemus-papadum/aiui-optics — the scalar wave-optics engine shared by the
 * diffraction/holography notebooks (demos/gratings, demos/holograms).
 *
 * This barrel is PURE math (playbook layer 1): safe to import from workers and
 * tests. The Solid display islands live on the `./widgets` subpath.
 *
 * The model, in one breath: monochromatic light at a plane is an array of
 * complex amplitudes (field.ts); free space is a linear operator on it
 * (propagate.ts); every element is a pointwise multiply (elements.ts); film
 * records |E|² and becomes an element itself (film.ts); an eye is a pupil, a
 * lens, and a retina (eye.ts); and the designer's paraxial arithmetic that
 * predicts what the wave engine will do is holo.ts.
 */

export {
  type BraggCurve,
  type BraggParams,
  braggCurve,
  braggReflectance,
} from "./bragg";
export { type Rgb, spectralRgb, waveColor, waveColorCss } from "./color";
export {
  apertureWindow,
  chirpedGrating,
  composeTransmission,
  idealLens,
  slitArray,
  stripePattern,
  type Transmission,
  uniformGrating,
  unityTransmission,
  zonePlate,
} from "./elements";
export { type EyeSpec, type RetinaImage, retinaImage } from "./eye";
export { fft, fft2d, fftfreq, ifft, isPow2, nextPow2 } from "./fft";
export {
  addField,
  applyTransmission,
  cloneField,
  type Field,
  fieldX,
  intensity,
  power,
  type SourceSpec,
  sourceAt,
  sourcesOnGrid,
  taperEdges,
  zeroField,
} from "./field";
export {
  type FieldMapChunk,
  type FieldMapJob,
  fieldMapColumns,
  mapX,
  mapZ,
  writeChunk,
} from "./fieldmap";
export {
  type ArmSpec,
  type DevelopOpts,
  developFilm,
  type ExposureOpts,
  type ExposureResult,
  exposeFilm,
  grainDots,
  lowpassTransmission,
} from "./film";
export {
  type BeamAtFilm,
  type HoloImagePrediction,
  holoImages,
  planeBeam,
  pointBeam,
} from "./holo";
export {
  createMapAccumulator,
  type FieldMapData,
  type MapExtent,
  type MapReplyChunk,
  type MapRequest,
  type MapWorkerIo,
  runMapRequest,
} from "./mapwork";
export {
  type FarField,
  farField,
  type PropagationPlan,
  planPropagation,
  powerInBand,
  propagate,
  propagateTo,
} from "./propagate";
