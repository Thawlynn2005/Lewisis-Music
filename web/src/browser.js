/* Lewisis' Music (web version) — starts the in-browser "server" and does the
 * AI separation work it queues.
 *
 * Loaded (only on the website) before app.js:
 *  1. registers sw.js, which answers the interface's /api/... requests from
 *     the visitor's own browser storage, and holds the interface back
 *     (window.LewisisReady) until it is in charge of this page;
 *  2. runs queued separation jobs in a worker (separate-worker.js): decoding
 *     the song here (the browser's own decoder, at 44.1 kHz), splitting it
 *     there, then saving both halves. Only one open tab works at a time.
 */
(() => {
     "use strict";
     const MODEL_URL = document.querySelector('meta[name="lewisis-model"]')?.content || "/models/htdemucs.onnx";
     const { get, put, remove, entries, channel, announce } = self.LewisisStore;

     // ───────────── 1. the in-browser server ─────────────
     async function start() {
          if (!("serviceWorker" in navigator) || !self.indexedDB)
               throw new Error("This browser can't keep a music library here (private windows often can't). Try a normal window, or another browser.");
          await navigator.serviceWorker.register("/sw.js", { scope: "/" });
          await navigator.serviceWorker.ready;
          if (!navigator.serviceWorker.controller) {
               // First visit: wait for it to take charge (or, after a hard reload, reload once).
               const claimed = new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
               const late = new Promise(resolve => setTimeout(resolve, 3000, "late"));
               if ((await Promise.race([claimed, late])) === "late") {
                    if (sessionStorage.getItem("lewisis-reloaded")) throw new Error("The music library could not start. Reload the page to try again.");
                    sessionStorage.setItem("lewisis-reloaded", "1");
                    location.reload();
                    return new Promise(() => {});
               }
          }
          sessionStorage.removeItem("lewisis-reloaded");
          // Ask the browser to keep the library even when it is short of space.
          navigator.storage?.persist?.().catch(() => {});
     }
     window.LewisisReady = start();
     document.documentElement.classList.add("web-app");

     // ───────────── 2. AI separation ─────────────
     let worker = null;
     const nextJob = async () => {
          const waiting = (await entries("jobs")).filter(([, job]) => job.state === "queued");
          waiting.sort(([, a], [, b]) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) || (a.queuedAt || 0) - (b.queuedAt || 0));
          return waiting[0]?.[0] || null;
     };

     // The song as two 44.1 kHz channels, decoded by the browser.
     async function decode(blob) {
          const context = new OfflineAudioContext(2, 1, 44100);
          const audio = await context.decodeAudioData(await blob.arrayBuffer());
          const left = new Float32Array(audio.getChannelData(0));
          const right = audio.numberOfChannels > 1 ? new Float32Array(audio.getChannelData(1)) : new Float32Array(left);
          return { left, right };
     }

     async function runJob(id) {
          const job = await get("jobs", id);
          const update = async fields => {
               const current = (await get("jobs", id)) || job;
               await put("jobs", id, { ...current, ...fields });
               announce({ type: "changed", id });
          };
          const blob = await get("files", id);
          if (!blob) {
               await remove("jobs", id);
               return;
          }
          await update({ state: "running", progress: 0, stage: "loading", error: undefined });
          try {
               const { left, right } = await decode(blob);
               worker ||= new Worker("/separate-worker.js");
               const result = await new Promise((resolve, reject) => {
                    let last = { stage: "", progress: -1 };
                    worker.onmessage = ({ data }) => {
                         if (data.job !== id) return;
                         if (data.type === "stage") {
                              // Saved when the stage changes or progress moves by a whole percent.
                              if (data.stage !== last.stage || data.progress - last.progress >= 0.01 || data.progress === 1) {
                                   last = data;
                                   update({ stage: data.stage, progress: Math.round(data.progress * 10000) / 10000 });
                              }
                         } else if (data.type === "done") resolve(data);
                         else if (data.type === "error") reject(new Error(data.message));
                    };
                    worker.onerror = event => reject(new Error(event.message || "The AI stopped unexpectedly."));
                    worker.postMessage({ type: "separate", job: id, left, right, modelUrl: MODEL_URL }, [left.buffer, right.buffer]);
               });
               if (!(await get("tracks", id))) return remove("jobs", id); // deleted meanwhile
               await put("stems", `${id}/vocals`, new Blob([result.vocals], { type: "audio/flac" }));
               await put("stems", `${id}/instrumental`, new Blob([result.instrumental], { type: "audio/flac" }));
               await update({ state: "done", progress: 1, stage: "done", urgent: false });
               console.info(`Lewisis' Music: separated ${id} on ${result.backend === "webgpu" ? "the graphics card (WebGPU)" : "the processor (WebAssembly)"}.`);
          } catch (error) {
               worker?.terminate();
               worker = null;
               await update({ state: "error", progress: 0, stage: undefined, error: `Separation failed: ${error.message}` });
          }
     }

     let pumping = false;
     async function pump() {
          if (pumping || !navigator.locks) return;
          pumping = true;
          try {
               await navigator.locks.request("lewisis-separation", { ifAvailable: true }, async lock => {
                    if (!lock) return; // another tab is doing it
                    // Jobs left "running" by a closed tab start again.
                    for (const [id, job] of await entries("jobs")) if (job.state === "running") await put("jobs", id, { ...job, state: "queued", progress: 0 });
                    for (let id = await nextJob(); id; id = await nextJob()) await runJob(id);
               });
          } finally {
               pumping = false;
          }
     }
     channel?.addEventListener("message", ({ data }) => {
          if (data?.type === "queue") pump();
     });
     window.LewisisReady.then(() => setTimeout(pump, 1500), () => {});
})();
