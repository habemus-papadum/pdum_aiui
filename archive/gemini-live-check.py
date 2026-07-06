# /// script
# requires-python = ">=3.10"
# dependencies = ["google-genai"]
# ///
"""Minimal Gemini Live API smoke test: does the realtime model answer with audio bytes?

Run with: uv run archive/gemini-live-check.py
Sends one text turn over the Live API websocket and counts the PCM audio bytes
that come back (24kHz 16-bit LE mono). No playback, no mic — just "does it work".
"""

import asyncio
from pathlib import Path

from google import genai

MODEL = "gemini-3.1-flash-live-preview"


def load_key() -> str:
    env_file = Path(__file__).resolve().parents[1] / ".env.dev"
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line.startswith("GEMINI_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit(f"GEMINI_API_KEY not found in {env_file}")


async def main() -> None:
    client = genai.Client(api_key=load_key())
    config = {"response_modalities": ["AUDIO"]}
    audio = bytearray()

    async with client.aio.live.connect(model=MODEL, config=config) as session:
        print(f"Connected to {MODEL}")
        await session.send_client_content(
            turns={"role": "user", "parts": [{"text": "What is the capital of France?"}]},
            turn_complete=True,
        )
        async for response in session.receive():
            sc = response.server_content
            if sc and sc.model_turn:
                for part in sc.model_turn.parts:
                    if part.inline_data and part.inline_data.data:
                        audio.extend(part.inline_data.data)
            if sc and sc.turn_complete:
                break

    seconds = len(audio) / (24000 * 2)  # 24kHz, 16-bit mono
    print(f"Received {len(audio)} bytes of PCM audio (~{seconds:.1f}s)")
    print("Live API works." if audio else "Connected, but no audio came back.")


if __name__ == "__main__":
    asyncio.run(main())
