"""Command-line entry point: ``python -m pydemo``.

Builds the default :class:`~pydemo.pipeline.Pipeline`, runs it, and prints a
human-readable report of the aggregated results.
"""

from __future__ import annotations

from .pipeline import default_pipeline


def main() -> None:
    """Run the default pipeline and print its results."""
    pipeline = default_pipeline()
    result = pipeline.run()
    data = result.as_dict()

    print("pydemo pipeline result")
    print("=" * 32)
    print(f"mesh area          : {data['mesh_area']:.4f}")
    cx, cy, cz = data["mesh_centroid"]  # type: ignore[misc]
    print(f"mesh centroid      : ({cx:.3f}, {cy:.3f}, {cz:.3f})")
    print(f"longest edge       : {data['longest_edge']:.4f}")
    print(f"dominant fft bin   : {data['dominant_bin']}")
    print(f"spectrogram shape  : {data['spectrogram_shape']}")
    print()
    print("smoothed signal summary")
    print("-" * 32)
    for key, value in data["smoothed_summary"].items():  # type: ignore[union-attr]
        if isinstance(value, float):
            print(f"  {key:5s}: {value:+.4f}")
        else:
            print(f"  {key:5s}: {value}")


if __name__ == "__main__":
    main()
