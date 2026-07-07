"""pydemo — a small, cross-referenced numpy package.

The public API re-exports the key symbols from the submodules so consumers (and
the aiui code reader) can see the definition/reference graph at a glance.
"""

from __future__ import annotations

from .geometry import Vec3, centroid, distance
from .mesh import Mesh, unit_tetrahedron
from .pipeline import Pipeline, PipelineResult, default_pipeline, summarize_edges
from .signals import fft_magnitude, moving_average, sine_wave, spectrogram
from .stats import Summary, summary

__all__ = [
    "Vec3",
    "centroid",
    "distance",
    "Mesh",
    "unit_tetrahedron",
    "Pipeline",
    "PipelineResult",
    "default_pipeline",
    "summarize_edges",
    "fft_magnitude",
    "moving_average",
    "sine_wave",
    "spectrogram",
    "Summary",
    "summary",
]

__version__ = "0.1.0"
