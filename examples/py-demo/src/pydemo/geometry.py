"""3-D vector geometry built on top of numpy.

This module is the foundation of the package: :class:`Vec3` and the free
functions :func:`distance` and :func:`centroid` are imported and used by
:mod:`pydemo.mesh` and :mod:`pydemo.pipeline`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

import numpy as np
from numpy.typing import NDArray

# A concrete alias for the float arrays used throughout the package.
FloatArray = NDArray[np.float64]


@dataclass(frozen=True)
class Vec3:
    """An immutable 3-D vector backed by three floats.

    The class deliberately keeps its state as plain floats (rather than a numpy
    array) so instances are hashable and cheap to construct, while every
    numeric operation drops down to numpy via :meth:`to_array`.
    """

    x: float
    y: float
    z: float

    def to_array(self) -> FloatArray:
        """Return the vector as a length-3 numpy array."""
        return np.array([self.x, self.y, self.z], dtype=np.float64)

    @classmethod
    def from_array(cls, arr: Iterable[float]) -> "Vec3":
        """Build a :class:`Vec3` from any length-3 iterable of numbers."""
        a = np.asarray(list(arr), dtype=np.float64)
        if a.shape != (3,):
            raise ValueError(f"expected 3 components, got shape {a.shape}")
        return cls(float(a[0]), float(a[1]), float(a[2]))

    def dot(self, other: "Vec3") -> float:
        """Scalar (dot) product with ``other``."""
        return float(np.dot(self.to_array(), other.to_array()))

    def cross(self, other: "Vec3") -> "Vec3":
        """Vector (cross) product with ``other``."""
        return Vec3.from_array(np.cross(self.to_array(), other.to_array()))

    def norm(self) -> float:
        """Euclidean length of the vector."""
        return float(np.linalg.norm(self.to_array()))

    def normalized(self) -> "Vec3":
        """Return a unit vector pointing in the same direction."""
        length = self.norm()
        if length == 0.0:
            raise ValueError("cannot normalize a zero-length vector")
        return Vec3.from_array(self.to_array() / length)

    def __add__(self, other: "Vec3") -> "Vec3":
        return Vec3(self.x + other.x, self.y + other.y, self.z + other.z)

    def __sub__(self, other: "Vec3") -> "Vec3":
        return Vec3(self.x - other.x, self.y - other.y, self.z - other.z)

    def __mul__(self, scalar: float) -> "Vec3":
        return Vec3(self.x * scalar, self.y * scalar, self.z * scalar)


def distance(a: Vec3, b: Vec3) -> float:
    """Euclidean distance between two points.

    Used by :meth:`pydemo.mesh.Mesh.edge_lengths`.
    """
    return (a - b).norm()


def centroid(points: Sequence[Vec3]) -> Vec3:
    """Arithmetic mean of a sequence of points.

    Used by :meth:`pydemo.mesh.Mesh.centroid`.
    """
    if not points:
        raise ValueError("centroid of an empty point set is undefined")
    stacked: FloatArray = np.stack([p.to_array() for p in points])
    return Vec3.from_array(stacked.mean(axis=0))
