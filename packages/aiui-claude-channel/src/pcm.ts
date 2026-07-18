/**
 * PCM/WAV helpers shared by the realtime engines (transcription and the
 * linter's live sessions): the OpenAI realtime endpoint, the session PCM
 * rate, and the WAV wrapper reply clips ride to the browser in.
 */

/** The GA realtime endpoint for a conversational (speech-to-speech) session. */
export const OPENAI_REALTIME_VOICE_URL = "wss://api.openai.com/v1/realtime";

/** The realtime session's PCM rate (in and out). */
export const REALTIME_VOICE_RATE = 24000;

/**
 * Wrap raw little-endian PCM16 mono samples in a minimal 44-byte WAV header so a
 * browser `<audio>` element can play the clip (raw PCM has no container). The
 * model streams `audio/pcm`; the page needs `audio/wav`.
 */
export function pcm16ToWav(pcm: Uint8Array, rate = REALTIME_VOICE_RATE): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  const byteRate = rate * 2; // mono, 16-bit
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, rate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}
