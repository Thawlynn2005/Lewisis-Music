#!/usr/bin/env python3
"""Fetch the ONNX Runtime library that the desktop app loads at run time.

The app's AI separation runs the Demucs model through ONNX Runtime. Rather
than linking ONNX Runtime into the program (the prebuilt static library needs
glibc 2.38 and GCC 13, so it cannot be built or run on older Linux systems),
the app ships Microsoft's own shared library and loads it when needed.

This script downloads Microsoft's official `Microsoft.ML.OnnxRuntime` NuGet
package (pinned version, checked against a pinned SHA-256), takes the library
for one platform out of it, and puts it where the Tauri bundle picks it up:

    linux-x64  → libonnxruntime.so      (needs glibc 2.28+)
    win-x64    → onnxruntime.dll
    osx-arm64  → libonnxruntime.dylib   (Apple Silicon)

Usage:
    python desktop/tools/fetch_onnxruntime.py                  # this computer's platform
    python desktop/tools/fetch_onnxruntime.py --platform win-x64 --out some/folder

Only the Python standard library is used, so it runs on every CI runner.
"""

from __future__ import annotations

import argparse
import hashlib
import platform
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

# ort 2.0.0-rc.15 is made for ONNX Runtime 1.31.x (its "api-31" level).
VERSION = "1.31.1"
SHA256 = "6871ccbc97f3d5bdb4095a1dcec33aa78d56f6ed8de5980ef5fa1d9f2e7c679a"
URL = f"https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/{VERSION}/microsoft.ml.onnxruntime.{VERSION}.nupkg"

LIBRARIES = {
    "linux-x64": "libonnxruntime.so",
    "win-x64": "onnxruntime.dll",
    "osx-arm64": "libonnxruntime.dylib",
}

DEFAULT_OUT = Path(__file__).resolve().parent.parent / "app" / "resources"


def this_platform() -> str:
    system, machine = platform.system(), platform.machine().lower()
    if system == "Linux" and machine in ("x86_64", "amd64"):
        return "linux-x64"
    if system == "Windows" and machine in ("amd64", "x86_64"):
        return "win-x64"
    if system == "Darwin" and machine == "arm64":
        return "osx-arm64"
    sys.exit(f"No ONNX Runtime build is set up for {system} {machine}.")


def download(target: Path) -> None:
    print(f"Downloading ONNX Runtime {VERSION} from NuGet…", flush=True)
    request = urllib.request.Request(URL, headers={"User-Agent": "fetch-onnxruntime"})
    digest = hashlib.sha256()
    with urllib.request.urlopen(request, timeout=300) as response, open(target, "wb") as out:
        while chunk := response.read(1 << 20):
            digest.update(chunk)
            out.write(chunk)
    if digest.hexdigest() != SHA256:
        target.unlink(missing_ok=True)
        sys.exit(f"The download does not match the expected checksum ({digest.hexdigest()}); not using it.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--platform", choices=sorted(LIBRARIES), default=None)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="folder to put the library in")
    parser.add_argument("--package", type=Path, help="use an already-downloaded .nupkg instead (still checked)")
    args = parser.parse_args()

    target_platform = args.platform or this_platform()
    name = LIBRARIES[target_platform]
    args.out.mkdir(parents=True, exist_ok=True)
    destination = args.out / name

    with tempfile.TemporaryDirectory() as temp:
        package = args.package
        if package is None:
            package = Path(temp) / "onnxruntime.nupkg"
            download(package)
        elif hashlib.sha256(package.read_bytes()).hexdigest() != SHA256:
            sys.exit(f"{package} is not the expected ONNX Runtime {VERSION} package.")
        with zipfile.ZipFile(package) as archive:
            data = archive.read(f"runtimes/{target_platform}/native/{name}")
    part = destination.with_name(destination.name + ".part")
    part.write_bytes(data)
    part.replace(destination)
    print(f"ONNX Runtime {VERSION} ({target_platform}): {destination} ({len(data) / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
