"""End-to-end pipeline that ties the whole package together.

:class:`Pipeline` imports from :mod:`pydemo.geometry`, :mod:`pydemo.mesh`,
:mod:`pydemo.signals`, and :mod:`pydemo.stats` — it is the densest hub of
cross-module references and the entry point exercised by :mod:`pydemo.__main__`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

import numpy as np

from .geometry import Vec3, distance
from .mesh import Mesh, unit_tetrahedron
from .signals import describe_signal, fft_magnitude, moving_average, sine_wave, spectrogram
from .stats import Summary, summary


@dataclass
class PipelineResult:
    """Aggregated outputs of a :class:`Pipeline` run."""

    mesh_area: float
    mesh_centroid: Vec3
    longest_edge: float
    smoothed_summary: Summary
    dominant_bin: int
    spectrogram_shape: tuple

    def as_dict(self) -> Dict[str, object]:
        """Flatten the result into a printable dict."""
        return {
            "mesh_area": self.mesh_area,
            "mesh_centroid": (
                self.mesh_centroid.x,
                self.mesh_centroid.y,
                self.mesh_centroid.z,
            ),
            "longest_edge": self.longest_edge,
            "smoothed_summary": self.smoothed_summary.as_dict(),
            "dominant_bin": self.dominant_bin,
            "spectrogram_shape": self.spectrogram_shape,
        }


class Pipeline:
    """Run a geometry + signal-processing workflow and collect the results.

    A single object bundles a :class:`~pydemo.mesh.Mesh` and DSP parameters;
    :meth:`run` walks the whole package to produce a :class:`PipelineResult`.
    """

    def __init__(
        self,
        mesh: Mesh,
        freq: float = 8.0,
        sample_rate: int = 256,
        smoothing_window: int = 5,
    ) -> None:
        self.mesh = mesh
        self.freq = freq
        self.sample_rate = sample_rate
        self.smoothing_window = smoothing_window

    def _geometry_stats(self) -> tuple:
        """Compute mesh area, centroid, and the longest edge."""
        area = self.mesh.area()
        center = self.mesh.centroid()
        edges: List[float] = self.mesh.edge_lengths()
        longest = max(edges) if edges else 0.0
        return area, center, longest

    def run(self) -> PipelineResult:
        """Execute the full pipeline and return the aggregated result."""
        area, center, longest = self._geometry_stats()

        # Signal branch: synthesize -> smooth -> summarize -> spectrum.
        raw = sine_wave(
            self.freq,
            duration=1.0,
            sample_rate=self.sample_rate,
            noise=0.3,
            seed=1,
        )
        smoothed = moving_average(raw, self.smoothing_window)
        smooth_summary = describe_signal(smoothed)

        spectrum = fft_magnitude(smoothed)
        dominant_bin = int(np.argmax(spectrum))

        spec = spectrogram(raw, window=64, hop=32)

        return PipelineResult(
            mesh_area=area,
            mesh_centroid=center,
            longest_edge=longest,
            smoothed_summary=smooth_summary,
            dominant_bin=dominant_bin,
            spectrogram_shape=tuple(spec.shape),
        )


def default_pipeline() -> Pipeline:
    """Construct a ready-to-run pipeline over a translated unit tetrahedron."""
    base = unit_tetrahedron()
    # Shift the mesh so the centroid is non-trivial (uses Vec3.__add__).
    mesh = base.translate(Vec3(1.0, 2.0, 3.0))
    # A tiny sanity computation that also exercises geometry.distance.
    _ = distance(mesh.vertices[0], mesh.vertices[1])
    return Pipeline(mesh=mesh)


def summarize_edges(mesh: Mesh) -> Summary:
    """Summary statistics of a mesh's edge-length distribution."""
    return summary(mesh.edge_lengths())
