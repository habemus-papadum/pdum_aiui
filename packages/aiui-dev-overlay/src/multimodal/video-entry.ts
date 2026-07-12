/**
 * The share/video sampler as a subpath entry
 * (`@habemus-papadum/aiui-dev-overlay/multimodal-video`) — framework-free;
 * the extension panel samples its warm tabCapture stream through the same
 * cadence + smart-gate machine the overlay's share uses.
 */
export {
  type SampledFrame,
  sampleDimensions,
  VIDEO_FRAME_MIME,
  VIDEO_JPEG_QUALITY,
  VIDEO_MAX_WIDTH,
  VIDEO_SAMPLE_INTERVAL_MS,
  VideoSampler,
  type VideoSamplerDeps,
} from "./video";
