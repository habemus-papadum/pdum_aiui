// GENERATED COPY of aiui-dev-overlay's PCM_WORKLET_SOURCE — MV3 CSP blocks
// blob: worklet modules, so the panel loads this real file instead
// (chrome.runtime.getURL). worklet-file.test.ts pins it to the constant.
class AiuiPcmForwarder extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) { this.port.postMessage(ch.slice(0)); }
    return true;
  }
}
registerProcessor('aiui-pcm-forwarder', AiuiPcmForwarder);
