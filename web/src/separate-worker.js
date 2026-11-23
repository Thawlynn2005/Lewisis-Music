/* Lewisis' Music (web version) — AI separation in the visitor's browser.
 *
 * Runs the same htdemucs model as the desktop app (made by
 * desktop/tools/export_demucs_onnx.py) with ONNX Runtime Web: on the graphics
 * card (WebGPU) where the browser offers it, otherwise on the processor
 * (WebAssembly, several threads). The splitting is a line-by-line port of
 * desktop/core/src/separate.rs (itself a port of Demucs's own apply_model):
 * normalise, 7.8-second chunks overlapping by 10 %, triangular cross-fades.
 *
 * Messages in:  { type: "separate", job, left, right, modelUrl }  (44.1 kHz)
 * Messages out: { type: "stage", job, stage, progress } …
 *               { type: "done", job, vocals, instrumental, backend }  (FLAC bytes)
 *               { type: "error", job, message }
 */
"use strict";
importScripts("/ort/ort.min.js", "/wasm/lewisis_wasm.js");

const SAMPLE_RATE = 44100;
const SEGMENT = 343980; // fixed by the exported model
const OVERLAP = 0.1;
const SOURCES = ["drums", "bass", "other", "vocals"];
const VOCALS = SOURCES.indexOf("vocals");
const MODEL_CACHE = "lewisis-model-htdemucs-v1";

ort.env.wasm.wasmPaths = "/ort/";
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)) : 1;
const flac = wasm_bindgen({ module_or_path: "/wasm/lewisis_wasm_bg.wasm" }).then(() => wasm_bindgen);

let session = null;
let backend = "";

// The model, from the browser's cache or (the first time) downloaded.
async function modelBytes(url, report) {
     const cache = await caches.open(MODEL_CACHE);
     const cached = await cache.match(url);
     if (cached) return new Uint8Array(await cached.arrayBuffer());
     const response = await fetch(url, { mode: "cors" });
     if (!response.ok) throw new Error(`Could not download the AI model (${response.status}).`);
     const total = Number(response.headers.get("Content-Length")) || 0;
     const reader = response.body.getReader();
     const parts = [];
     let received = 0;
     for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          received += value.length;
          if (total) report(received / total);
     }
     const bytes = new Uint8Array(received);
     let at = 0;
     for (const part of parts) {
          bytes.set(part, at);
          at += part.length;
     }
     try {
          await cache.put(url, new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }));
     } catch {
          /* no room to keep it: it is downloaded again next time */
     }
     return bytes;
}

async function load(url, report) {
     if (session) return;
     const bytes = await modelBytes(url, report);
     report(1);
     const tries = "gpu" in navigator ? ["webgpu", "wasm"] : ["wasm"];
     let lastError;
     for (const provider of tries) {
          try {
               session = await ort.InferenceSession.create(bytes, { executionProviders: [provider], graphOptimizationLevel: "all" });
               backend = provider;
               return;
          } catch (error) {
               lastError = error;
          }
     }
     throw new Error(`The AI model could not start in this browser: ${lastError?.message || lastError}`);
}

async function separate(left, right, progress) {
     const length = left.length;
     // Same normalisation as Demucs: mean and (unbiased) deviation of the mono mix.
     let sum = 0;
     for (let i = 0; i < length; i++) sum += (left[i] + right[i]) / 2;
     const mean = sum / length;
     let variance = 0;
     for (let i = 0; i < length; i++) variance += ((left[i] + right[i]) / 2 - mean) ** 2;
     const std = Math.sqrt(variance / Math.max(1, length - 1)) + 1e-8;

     const half = Math.floor(SEGMENT / 2);
     const weight = new Float32Array(SEGMENT);
     for (let i = 0; i < SEGMENT; i++) weight[i] = (i < half ? i + 1 : SEGMENT - i) / half;
     const stride = Math.floor((1 - OVERLAP) * SEGMENT);
     const offsets = [];
     for (let at = 0; at < length; at += stride) offsets.push(at);

     // Only what is needed: the vocals and the sum of the other three sources.
     const out = [new Float32Array(length), new Float32Array(length), new Float32Array(length), new Float32Array(length)]; // vL vR iL iR
     const total = new Float32Array(length);
     const channels = [left, right];
     for (let n = 0; n < offsets.length; n++) {
          const offset = offsets[n];
          const chunk = Math.min(SEGMENT, length - offset);
          const delta = SEGMENT - chunk;
          const start = offset - Math.floor(delta / 2);
          const input = new Float32Array(2 * SEGMENT);
          for (let c = 0; c < 2; c++)
               for (let j = 0; j < SEGMENT; j++) {
                    const at = start + j;
                    if (at >= 0 && at < length) input[c * SEGMENT + j] = (channels[c][at] - mean) / std;
               }
          const result = await session.run({ mix: new ort.Tensor("float32", input, [1, 2, SEGMENT]) });
          const stems = (result.stems || Object.values(result)[0]).data; // [1, 4, 2, SEGMENT]
          const trim = Math.floor(delta / 2);
          for (let source = 0; source < SOURCES.length; source++)
               for (let c = 0; c < 2; c++) {
                    const target = out[(source === VOCALS ? 0 : 2) + c];
                    const base = (source * 2 + c) * SEGMENT + trim;
                    for (let j = 0; j < chunk; j++) target[offset + j] += weight[j] * stems[base + j];
               }
          for (let j = 0; j < chunk; j++) total[offset + j] += weight[j];
          progress((n + 1) / offsets.length);
     }
     // Undo the normalising (the instrumental is the sum of three sources).
     for (let i = 0; i < length; i++) {
          const w = total[i];
          out[0][i] = (out[0][i] / w) * std + mean;
          out[1][i] = (out[1][i] / w) * std + mean;
          out[2][i] = (out[2][i] / w) * std + 3 * mean;
          out[3][i] = (out[3][i] / w) * std + 3 * mean;
     }
     return out;
}

self.onmessage = async ({ data }) => {
     if (data.type !== "separate") return;
     const { job } = data;
     const say = (stage, progress) => self.postMessage({ type: "stage", job, stage, progress });
     try {
          say("downloading", 0);
          await load(data.modelUrl, fraction => say("downloading", fraction));
          say("separating", 0);
          const [vl, vr, il, ir] = await separate(data.left, data.right, fraction => say("separating", fraction));
          say("saving", 1);
          const { encodeFlac } = await flac;
          const vocals = encodeFlac(vl, vr, SAMPLE_RATE);
          const instrumental = encodeFlac(il, ir, SAMPLE_RATE);
          self.postMessage({ type: "done", job, vocals, instrumental, backend }, [vocals.buffer, instrumental.buffer]);
     } catch (error) {
          self.postMessage({ type: "error", job, message: String(error?.message || error) });
     }
};
