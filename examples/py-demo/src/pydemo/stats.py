"""Lightweight descriptive statistics over numpy arrays.

:func:`summary` is consumed by :mod:`pydemo.signals` (``describe_signal``) and by
:mod:`pydemo.pipeline`, so this module is a shared leaf that several files
reference.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence, Union

import numpy as np
from numpy.typing import NDArray

# Anything that numpy can turn into a 1-D float array.
ArrayLike = Union[Sequence[float], NDArray[np.float64]]


@dataclass(frozen=True)
class Summary:
    """A compact statistical description of a 1-D dataset."""

    count: int
    mean: float
    std: float
    minimum: float
    maximum: float
    p25: float
    p50: float
    p75: float

    def as_dict(self) -> dict:
        """Return the summary as a plain dict (useful for printing/JSON)."""
        return {
            "count": self.count,
            "mean": self.mean,
            "std": self.std,
            "min": self.minimum,
            "max": self.maximum,
            "p25": self.p25,
            "p50": self.p50,
            "p75": self.p75,
        }


def summary(data: ArrayLike) -> Summary:
    """Compute mean/std/percentiles for ``data`` and return a :class:`Summary`."""
    arr = np.asarray(data, dtype=np.float64).ravel()
    if arr.size == 0:
        raise ValueError("cannot summarize an empty dataset")
    p25, p50, p75 = np.percentile(arr, [25.0, 50.0, 75.0])
    return Summary(
        count=int(arr.size),
        mean=float(arr.mean()),
        std=float(arr.std()),
        minimum=float(arr.min()),
        maximum=float(arr.max()),
        p25=float(p25),
        p50=float(p50),
        p75=float(p75),
    )


def normalize(data: ArrayLike) -> NDArray[np.float64]:
    """Rescale ``data`` to zero mean and unit variance (uses :func:`summary`)."""
    arr = np.asarray(data, dtype=np.float64).ravel()
    s = summary(arr)
    if s.std == 0.0:
        return arr - s.mean
    return (arr - s.mean) / s.std
