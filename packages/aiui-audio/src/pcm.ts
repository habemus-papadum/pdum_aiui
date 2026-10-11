/** Linear PCM conversion, shared by the microphone and recorded-input paths. */
export function resampleLinear(
  block: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || block.length === 0) return block;
  const ratio = toRate / fromRate;
  const out = new Float32Array(Math.floor(block.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const source = i / ratio;
    const left = Math.floor(source);
    out[i] =
      block[left] + (block[Math.min(left + 1, block.length - 1)] - block[left]) * (source - left);
  }
  return out;
}
export function floatToPcm16(block: Float32Array): Uint8Array {
  const bytes = new Uint8Array(block.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < block.length; i++) {
    const value = Math.max(-1, Math.min(1, block[i]));
    view.setInt16(i * 2, value * (value < 0 ? 0x8000 : 0x7fff), true);
  }
  return bytes;
}
