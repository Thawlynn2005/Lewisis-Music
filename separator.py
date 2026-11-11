"""Background vocal / instrumental separation.

Uses the Demucs "htdemucs" neural network to split a song into a vocals-only
stem (acapella) and an everything-else stem (instrumental / karaoke). Results
are cached on disk as FLAC, so each song only has to be separated once.

There are two queues, served by one worker thread:

* urgent      – the listener pressed Acapella / Karaoke and is waiting.
* background  – songs being prepared ahead of time so the buttons are instant.

An urgent request interrupts a background job (it is put back and restarted
afterwards), so pressing a button never waits behind background work.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import threading
import traceback
from collections import deque
from pathlib import Path

MODEL_NAME = "htdemucs"
STEMS = ("vocals", "instrumental")
# How much neighbouring chunks overlap. Demucs defaults to 0.25; 0.1 is
# noticeably faster and the result is practically identical.
OVERLAP = 0.1
_REQUIRED_MODULES = ("torch", "demucs", "soundfile", "julius")


class _Preempted(Exception):
    """Raised inside the model loop to abandon the current job."""


class _ProgressShim:
    """Stands in for the `tqdm` module inside demucs.apply so we can report
    chunk-by-chunk progress to the UI (and stop between chunks)."""

    def __init__(self):
        self.callback = None

    def tqdm(self, iterable, **_kwargs):
        items = list(iterable)
        total = max(len(items), 1)
        for index, item in enumerate(items):
            yield item
            if self.callback:
                self.callback((index + 1) / total)


class Separator:
    def __init__(self, stems_dir: Path):
        self.stems_dir = Path(stems_dir)
        self.stems_dir.mkdir(parents=True, exist_ok=True)
        self._jobs: dict[str, dict] = {}
        self._sources: dict[str, Path] = {}
        self._urgent: deque[str] = deque()
        self._background: deque[str] = deque()
        self._running: str | None = None
        self._running_in_background = False
        self._preempt: str | None = None  # None | "requeue" | "drop"
        self._cv = threading.Condition()
        self._thread: threading.Thread | None = None
        self._model = None
        self._shim = _ProgressShim()
        self._device = "cpu"

    # ---- public API -------------------------------------------------------

    def missing_modules(self) -> list[str]:
        return [m for m in _REQUIRED_MODULES if importlib.util.find_spec(m) is None]

    def available(self) -> bool:
        return not self.missing_modules()

    def stem_path(self, track_id: str, stem: str) -> Path:
        return self.stems_dir / track_id / f"{stem}.flac"

    def has_stems(self, track_id: str) -> bool:
        return all(self.stem_path(track_id, s).is_file() for s in STEMS)

    def status(self, track_id: str) -> dict:
        if self.has_stems(track_id):
            return {"state": "done", "progress": 1.0}
        with self._cv:
            job = self._jobs.get(track_id)
            return dict(job) if job else {"state": "none", "progress": 0.0}

    def request(self, track_id: str, source: Path, urgent: bool = True) -> dict:
        """Queue a song. `urgent` means someone is waiting for it right now."""
        if self.has_stems(track_id):
            return self.status(track_id)
        with self._cv:
            self._sources[track_id] = Path(source)
            if self._running == track_id:
                if urgent:
                    self._running_in_background = False  # now protected from preemption
                    if self._preempt == "requeue":
                        self._preempt = None
                return dict(self._jobs[track_id])
            if urgent:
                if track_id in self._background:
                    self._background.remove(track_id)
                if track_id not in self._urgent:
                    self._urgent.appendleft(track_id)
                if self._running and self._running_in_background and not self._preempt:
                    self._preempt = "requeue"
            elif track_id not in self._urgent and track_id not in self._background:
                self._background.append(track_id)
            job = self._jobs.get(track_id)
            if not job or job["state"] != "queued":
                self._jobs[track_id] = {"state": "queued", "progress": 0.0}
            self._ensure_worker()
            self._cv.notify()
            return dict(self._jobs[track_id])

    def cancel_background(self) -> None:
        """Stop preparing songs ahead of time (urgent requests are kept)."""
        with self._cv:
            for track_id in self._background:
                self._jobs.pop(track_id, None)
            self._background.clear()
            if self._running and self._running_in_background:
                self._preempt = "drop"

    def forget(self, track_id: str) -> None:
        """Drop a song's job and cached stems (used when a track is deleted)."""
        with self._cv:
            for queue in (self._urgent, self._background):
                if track_id in queue:
                    queue.remove(track_id)
            if self._running == track_id:
                self._preempt = "drop"
            else:
                self._jobs.pop(track_id, None)
            self._sources.pop(track_id, None)
        shutil.rmtree(self.stems_dir / track_id, ignore_errors=True)

    # ---- worker -----------------------------------------------------------

    def _ensure_worker(self) -> None:
        if self._thread is None or not self._thread.is_alive():
            self._thread = threading.Thread(target=self._run, name="separator", daemon=True)
            self._thread.start()

    def _update(self, track_id: str, **fields) -> None:
        with self._cv:
            job = self._jobs.get(track_id)
            if job is not None:
                job.update(fields)

    def _on_progress(self, track_id: str, fraction: float) -> None:
        if self._preempt:
            raise _Preempted()
        self._update(track_id, progress=round(fraction, 4))

    def _run(self) -> None:
        while True:
            with self._cv:
                while not self._urgent and not self._background:
                    self._cv.wait()
                in_background = not self._urgent
                track_id = (self._background if in_background else self._urgent).popleft()
                source = self._sources.get(track_id)
                if source is None or track_id not in self._jobs:
                    continue
                self._jobs[track_id] = {"state": "running", "progress": 0.0, "stage": "loading"}
                self._running = track_id
                self._running_in_background = in_background
                self._preempt = None
            try:
                self._separate(track_id, source)
                self._update(track_id, state="done", progress=1.0, stage="done")
            except _Preempted:
                shutil.rmtree(self.stems_dir / track_id, ignore_errors=True)
                with self._cv:
                    if self._preempt == "requeue" and track_id in self._sources:
                        self._jobs[track_id] = {"state": "queued", "progress": 0.0}
                        self._background.appendleft(track_id)
                    else:
                        self._jobs.pop(track_id, None)
            except Exception as exc:  # report to the UI rather than kill the worker
                traceback.print_exc()
                shutil.rmtree(self.stems_dir / track_id, ignore_errors=True)
                self._update(track_id, state="error", error=str(exc) or type(exc).__name__)
            finally:
                with self._cv:
                    if track_id not in self._sources:  # deleted while we worked
                        shutil.rmtree(self.stems_dir / track_id, ignore_errors=True)
                        self._jobs.pop(track_id, None)
                    self._running = None
                    self._preempt = None

    def _load_model(self):
        if self._model is None:
            import torch
            import demucs.apply
            from demucs.pretrained import get_model

            demucs.apply.tqdm = self._shim  # route progress to us
            model = get_model(MODEL_NAME)  # downloads ~80 MB the first time
            model.eval()
            self._device = "cuda" if torch.cuda.is_available() else "cpu"
            self._model = model
        return self._model

    def _separate(self, track_id: str, source: Path) -> None:
        import julius
        import numpy as np
        import soundfile as sf
        import torch
        from demucs.apply import apply_model

        model = self._load_model()

        audio, sample_rate = sf.read(str(source), dtype="float32", always_2d=True)
        if audio.shape[0] == 0:
            raise ValueError("The audio file is empty.")
        wav = torch.from_numpy(np.ascontiguousarray(audio.T))  # (channels, samples)
        if wav.shape[0] == 1:
            wav = wav.repeat(2, 1)
        elif wav.shape[0] > 2:
            wav = wav[:2]
        if sample_rate != model.samplerate:
            wav = julius.resample_frac(wav, sample_rate, model.samplerate)

        # Same normalisation the Demucs command-line tool applies.
        ref = wav.mean(0)
        mean, std = ref.mean(), ref.std() + 1e-8
        mix = (wav - mean) / std

        self._update(track_id, stage="separating", progress=0.0)
        self._shim.callback = lambda fraction: self._on_progress(track_id, fraction)
        try:
            with torch.inference_mode():
                sources = apply_model(
                    model,
                    mix[None],
                    device=self._device,
                    shifts=0,
                    split=True,
                    overlap=OVERLAP,
                    progress=True,
                )[0]
        finally:
            self._shim.callback = None
        sources = sources * std + mean

        vocal_index = model.sources.index("vocals")
        vocals = sources[vocal_index]
        instrumental = sum(
            sources[i] for i in range(len(model.sources)) if i != vocal_index
        )

        self._update(track_id, stage="saving", progress=1.0)
        out_dir = self.stems_dir / track_id
        out_dir.mkdir(parents=True, exist_ok=True)
        written = []
        for name, tensor in (("vocals", vocals), ("instrumental", instrumental)):
            data = tensor.clamp(-1.0, 1.0).T.cpu().numpy()
            part = out_dir / f"{name}.flac.part"
            sf.write(str(part), data, model.samplerate, format="FLAC", subtype="PCM_16")
            written.append((part, self.stem_path(track_id, name)))
        for part, final in written:  # publish both stems together
            os.replace(part, final)
