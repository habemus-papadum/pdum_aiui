# /// script
# requires-python = ">=3.10"
# dependencies = ["google-genai"]
# ///
"""Smoke-test the GEMINI_API_KEY in ../.env.dev with a trivial generate call."""

import sys
from pathlib import Path

from google import genai


def load_key() -> str:
    env_file = Path(__file__).resolve().parents[1] / ".env.dev"
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line.startswith("GEMINI_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit(f"GEMINI_API_KEY not found in {env_file}")


def main() -> None:
    client = genai.Client(api_key=load_key())
    resp = client.models.generate_content(
        model="gemini-2.5-flash",
        contents="What is the capital of France? Answer in one word.",
    )
    print(f"Gemini replied: {resp.text.strip()}")
    print("API key works.")


if __name__ == "__main__":
    main()
