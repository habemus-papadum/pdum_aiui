"""Triangle meshes built out of :mod:`pydemo.geometry` primitives.

Every geometric operation here is expressed in terms of :class:`~pydemo.geometry.Vec3`
and the free functions :func:`~pydemo.geometry.distance` and
:func:`~pydemo.geometry.centroid`, so this module is a dense set of
cross-file references back into ``geometry``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Tuple

from .geometry import Vec3, centroid, distance

# A face is a triangle referencing three vertex indices.
Face = Tuple[int, int, int]


@dataclass
class Mesh:
    """A simple indexed triangle mesh.

    Parameters
    ----------
    vertices:
        The mesh vertices as :class:`~pydemo.geometry.Vec3` points.
    faces:
        Triangles as index triples into ``vertices``.
    """

    vertices: List[Vec3]
    faces: List[Face] = field(default_factory=list)

    def bounding_box(self) -> Tuple[Vec3, Vec3]:
        """Return the axis-aligned bounding box as ``(min_corner, max_corner)``."""
        if not self.vertices:
            raise ValueError("cannot compute a bounding box of an empty mesh")
        xs = [v.x for v in self.vertices]
        ys = [v.y for v in self.vertices]
        zs = [v.z for v in self.vertices]
        lo = Vec3(min(xs), min(ys), min(zs))
        hi = Vec3(max(xs), max(ys), max(zs))
        return lo, hi

    def centroid(self) -> Vec3:
        """Centroid of all vertices (delegates to :func:`~pydemo.geometry.centroid`)."""
        return centroid(self.vertices)

    def translate(self, offset: Vec3) -> "Mesh":
        """Return a copy of the mesh shifted by ``offset`` (uses ``Vec3.__add__``)."""
        moved = [v + offset for v in self.vertices]
        return Mesh(vertices=moved, faces=list(self.faces))

    def edge_lengths(self) -> List[float]:
        """Length of every triangle edge (delegates to :func:`~pydemo.geometry.distance`)."""
        lengths: List[float] = []
        for i, j, k in self.faces:
            a, b, c = self.vertices[i], self.vertices[j], self.vertices[k]
            lengths.extend([distance(a, b), distance(b, c), distance(c, a)])
        return lengths

    def face_area(self, face: Face) -> float:
        """Area of a single triangular face via the cross-product rule."""
        i, j, k = face
        a, b, c = self.vertices[i], self.vertices[j], self.vertices[k]
        edge1 = b - a
        edge2 = c - a
        return 0.5 * edge1.cross(edge2).norm()

    def area(self) -> float:
        """Total surface area: sum of every face area."""
        return sum(self.face_area(f) for f in self.faces)


def unit_tetrahedron() -> Mesh:
    """Build a simple tetrahedron mesh, handy for demos and tests."""
    v = [
        Vec3(0.0, 0.0, 0.0),
        Vec3(1.0, 0.0, 0.0),
        Vec3(0.0, 1.0, 0.0),
        Vec3(0.0, 0.0, 1.0),
    ]
    faces: List[Face] = [(0, 1, 2), (0, 1, 3), (0, 2, 3), (1, 2, 3)]
    return Mesh(vertices=v, faces=faces)
