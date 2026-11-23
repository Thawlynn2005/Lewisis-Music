"""Convert the htdemucs separation model to ONNX for the desktop app.

ONNX has no complex numbers and no inverse STFT, which htdemucs uses at its
edges. This script swaps exactly those parts for equivalent real-valued
convolutions (the same maths torch.stft / torch.istft do), checks that the
result still matches the original model, exports it, and checks the exported
file with ONNX Runtime.

The exported model takes one fixed 7.8-second stereo chunk at 44.1 kHz:

    input  "mix"    float32 [1, 2, 343980]
    output "stems"  float32 [1, 4, 2, 343980]   (drums, bass, other, vocals)

Splitting a whole song into chunks (with overlap and cross-fades) and the
mean / std normalisation are done by the app, as demucs.apply does.

Run with the Python player's environment:
    ../.venv/bin/python tools/export_demucs_onnx.py OUT.onnx [--fp16]
"""

from __future__ import annotations

import argparse
import math
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from demucs.pretrained import get_model


def dft_kernels(n_fft: int, bins: int) -> tuple[torch.Tensor, torch.Tensor]:
    """cos / sin rows for frequencies 0..bins-1 over n_fft samples (float64)."""
    n = torch.arange(n_fft, dtype=torch.float64)
    k = torch.arange(bins, dtype=torch.float64)[:, None]
    angle = 2 * math.pi * k * n / n_fft
    return torch.cos(angle), torch.sin(angle)


class RealSpectrogram(torch.nn.Module):
    """htdemucs's `_spec` (padding + torch.stft, normalized, centred) as a strided
    convolution. Returns real/imag as a last dimension of size 2."""

    def __init__(self, n_fft: int, hop: int):
        super().__init__()
        self.n_fft, self.hop = n_fft, hop
        bins = n_fft // 2  # htdemucs drops the Nyquist bin
        cos, sin = dft_kernels(n_fft, bins)
        window = torch.hann_window(n_fft, dtype=torch.float64)
        scale = 1 / math.sqrt(n_fft)  # normalized=True
        real = cos * window * scale
        imag = -sin * window * scale
        self.register_buffer("kernel", torch.cat([real, imag])[:, None, :].float())

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b, c, length = x.shape
        hl, n_fft = self.hop, self.n_fft
        le = int(math.ceil(length / hl))
        pad = hl // 2 * 3
        x = F.pad(x, (pad, pad + le * hl - length), mode="reflect")
        x = F.pad(x, (n_fft // 2, n_fft // 2), mode="reflect")  # center=True
        frames = F.conv1d(x.reshape(b * c, 1, -1), self.kernel, stride=hl)
        bins = n_fft // 2
        z = torch.stack([frames[:, :bins], frames[:, bins:]], dim=-1)  # (b*c, F, T, 2)
        z = z[:, :, 2: 2 + le]
        return z.reshape(b, c, bins, le, 2)


class RealInverseSpectrogram(torch.nn.Module):
    """htdemucs's `_ispec` (padding + torch.istft, normalized, centred) as a
    transposed convolution plus the usual window-envelope division."""

    def __init__(self, n_fft: int, hop: int, length: int):
        super().__init__()
        self.n_fft, self.hop, self.length = n_fft, hop, length
        bins = n_fft // 2 + 1
        cos, sin = dft_kernels(n_fft, bins)
        window = torch.hann_window(n_fft, dtype=torch.float64)
        weight = torch.full((bins, 1), 2.0, dtype=torch.float64)
        weight[0] = weight[-1] = 1.0  # DC and Nyquist appear once
        scale = math.sqrt(n_fft) / n_fft  # irfft's 1/N, undoing normalized=True
        real = cos * weight * window * scale
        imag = -sin * weight * window * scale
        imag[0] = imag[-1] = 0.0  # irfft ignores their imaginary parts
        self.register_buffer("kernel", torch.cat([real, imag])[:, None, :].float())

        le = int(math.ceil(length / hop))
        frames = le + 4  # htdemucs pads two frames on each side
        out_len = n_fft + hop * (frames - 1)
        envelope = torch.zeros(out_len, dtype=torch.float64)
        for t in range(frames):
            envelope[t * hop: t * hop + n_fft] += window ** 2
        self.register_buffer("envelope", envelope.float())

    def forward(self, z: torch.Tensor) -> torch.Tensor:
        # z: (B, S, C, F=n_fft/2, T, 2)
        b, s, c, fr, t, _ = z.shape
        hl, n_fft = self.hop, self.n_fft
        z = F.pad(z, (0, 0, 0, 0, 0, 1))  # add the Nyquist bin back
        z = F.pad(z, (0, 0, 2, 2))  # and the two frames each side
        bins = fr + 1
        z = z.reshape(b * s * c, bins, t + 4, 2)
        stacked = torch.cat([z[..., 0], z[..., 1]], dim=1)  # (N, 2*bins, T)
        x = F.conv_transpose1d(stacked, self.kernel, stride=hl)[:, 0]
        x = x / self.envelope.clamp_min(1e-11)
        pad = hl // 2 * 3
        le = hl * int(math.ceil(self.length / hl)) + 2 * pad
        x = x[:, n_fft // 2: n_fft // 2 + le]  # undo center=True, trim to `le`
        x = x[:, pad: pad + self.length]
        return x.reshape(b, s, c, self.length)


def patch_for_onnx(model, length: int) -> None:
    """Replace htdemucs's complex-number parts with the real-valued versions."""
    spec = RealSpectrogram(model.nfft, model.hop_length)
    ispec = RealInverseSpectrogram(model.nfft, model.hop_length, length)
    model.add_module("onnx_spec", spec)
    model.add_module("onnx_ispec", ispec)

    def _spec(x):
        return model.onnx_spec(x)

    def _magnitude(z):  # cac: real / imag become extra channels
        b, c, fr, t, _ = z.shape
        return z.permute(0, 1, 4, 2, 3).reshape(b, c * 2, fr, t)

    def _mask(z, m):  # cac: the network outputs the spectrogram itself
        b, s, _, fr, t = m.shape
        return m.view(b, s, -1, 2, fr, t).permute(0, 1, 2, 4, 5, 3)

    def _ispec(z, length=None, scale=0):
        return model.onnx_ispec(z)

    model._spec, model._magnitude, model._mask, model._ispec = _spec, _magnitude, _mask, _ispec


class Exportable(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, mix):
        return self.model(mix)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("out", type=Path)
    parser.add_argument("--fp16", action="store_true", help="store weights as float16 (half the size)")
    args = parser.parse_args()
    torch.manual_seed(0)

    reference = get_model("htdemucs").models[0].eval()
    patched = get_model("htdemucs").models[0].eval()
    length = int(reference.segment * reference.samplerate)
    patch_for_onnx(patched, length)
    print(f"segment: {length} samples ({length / reference.samplerate:.2f} s), sources: {reference.sources}")

    # 1. The patched model must still give the same answer in PyTorch.
    mix = torch.randn(1, 2, length) * 0.2
    t = np.arange(length) / reference.samplerate
    mix[0, 0] += torch.from_numpy(0.3 * np.sin(2 * np.pi * 440 * t)).float()
    mix[0, 1] += torch.from_numpy(0.3 * np.sin(2 * np.pi * 110 * t)).float()
    with torch.inference_mode():
        want = reference(mix)
        got = patched(mix)
    diff = (want - got).abs().max().item()
    print(f"patched vs original (PyTorch): max difference {diff:.2e}")
    if diff > 1e-3:
        sys.exit("The patched model does not match the original; not exporting.")

    # 2. Export.
    args.out.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()
    torch.onnx.export(
        Exportable(patched), (mix,), str(args.out),
        input_names=["mix"], output_names=["stems"], opset_version=17,
        dynamo=False, do_constant_folding=True,
    )
    print(f"exported in {time.time() - started:.0f} s: {args.out} ({args.out.stat().st_size / 1e6:.0f} MB)")

    if args.fp16:
        import onnx
        from onnx import numpy_helper

        graph = onnx.load(str(args.out))
        # Weights only: computation stays float32, so no accuracy surprises.
        for init in graph.graph.initializer:
            if init.data_type == onnx.TensorProto.FLOAT and init.dims and np.prod(init.dims) > 16:
                array = numpy_helper.to_array(init).astype(np.float16)
                name = init.name
                init.CopyFrom(numpy_helper.from_array(array, name + "__f16"))
                cast = onnx.helper.make_node("Cast", [name + "__f16"], [name], to=onnx.TensorProto.FLOAT)
                graph.graph.node.insert(0, cast)
        onnx.save(graph, str(args.out))
        print(f"weights stored as float16: {args.out.stat().st_size / 1e6:.0f} MB")

    # 3. The exported file must match too, run by ONNX Runtime.
    import onnxruntime as ort

    session = ort.InferenceSession(str(args.out), providers=["CPUExecutionProvider"])
    started = time.time()
    (onnx_out,) = session.run(["stems"], {"mix": mix.numpy()})
    elapsed = time.time() - started
    diff = np.abs(onnx_out - want.numpy()).max()
    rms = np.sqrt(np.mean((onnx_out - want.numpy()) ** 2))
    print(f"ONNX Runtime vs original: max difference {diff:.2e}, rms {rms:.2e}, "
          f"one chunk in {elapsed:.1f} s on CPU")
    if diff > 5e-3:
        sys.exit("The ONNX model does not match the original closely enough.")
    print("OK")


if __name__ == "__main__":
    main()
