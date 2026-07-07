"""Small DSP toolkit: smoothing, spectra, and spectrograms with numpy.

:func:`describe_signal` reaches into :mod:`pydemo.stats` (:func:`~pydemo.stats.summary`),
and the whole module is orchestrated by :mod:`pydemo.pipeline`.
"""

from __future__ import annotations

from typing import Sequence, Union

import numpy as np
from numpy.typing import NDArray

from .stats import Summary, summary

FloatArray = NDArray[np.float64]
ArrayLike = Union[Sequence[float], FloatArray]


def moving_average(signal: ArrayLike, window: int) -> FloatArray:
    """Smooth ``signal`` with a centered box filter of size ``window``."""
    arr = np.asarray(signal, dtype=np.float64).ravel()
    if window < 1:
        raise ValueError("window must be a positive integer")
    if window == 1:
        return arr.copy()
    kernel = np.ones(window, dtype=np.float64) / float(window)
    return np.convolve(arr, kernel, mode="same")


def fft_magnitude(signal: ArrayLike) -> FloatArray:
    """Return the magnitude spectrum (one-sided) of a real ``signal``."""
    arr = np.asarray(signal, dtype=np.float64).ravel()
    spectrum = np.fft.rfft(arr)
    return np.abs(spectrum)


def spectrogram(
    signal: ArrayLike,
    window: int = 64,
    hop: int = 32,
) -> FloatArray:
    """Compute a simple magnitude spectrogram.

    The signal is split into overlapping frames of length ``window`` advanced by
    ``hop`` samples; each frame is Hann-windowed and passed through
    :func:`fft_magnitude`. Returns a ``(n_frames, n_bins)`` array.
    """
    arr = np.asarray(signal, dtype=np.float64).ravel()
    if window < 2 or hop < 1:
        raise ValueError("window must be >= 2 and hop >= 1")
    taper = np.hanning(window)
    frames = []
    for start in range(0, max(len(arr) - window + 1, 0), hop):
        frame = arr[start : start + window] * taper
        frames.append(fft_magnitude(frame))
    if not frames:
        return np.empty((0, window // 2 + 1), dtype=np.float64)
    return np.stack(frames)


def describe_signal(signal: ArrayLike) -> Summary:
    """Summarize a signal's amplitude distribution (delegates to :func:`~pydemo.stats.summary`)."""
    arr = np.asarray(signal, dtype=np.float64).ravel()
    return summary(arr)


def sine_wave(
    freq: float,
    duration: float = 1.0,
    sample_rate: int = 256,
    noise: float = 0.0,
    seed: int = 0,
) -> FloatArray:
    """Generate a noisy sine wave, a convenient input for the DSP helpers."""
    n = int(duration * sample_rate)
    t = np.arange(n, dtype=np.float64) / float(sample_rate)
    clean = np.sin(2.0 * np.pi * freq * t)
    if noise > 0.0:
        rng = np.random.default_rng(seed)
        clean = clean + noise * rng.standard_normal(n)
    return clean
