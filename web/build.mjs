// Builds the website version of Lewisis' Music into web/dist (deployed to Vercel
// as plain static files):
//   - the interface from static/ (unchanged), plus browser.js / store.js / sw.js /
//     separate-worker.js from web/src,
//   - the shared Rust code (desktop/wasm) compiled to WebAssembly,
//   - ONNX Runtime Web, for the AI separation.
// The separation model (~160 MB) is too big for a Vercel deployment; it is loaded
// from MODEL_URL (e.g. a Hugging Face file) the first time a visitor uses it.
//
//   MODEL_URL=https://huggingface.co/<user>/<repo>/resolve/main/htdemucs.onnx node build.mjs
//
// Needs Rust with the wasm32-unknown-unknown target and wasm-bindgen-cli 0.2.130.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const dist = join(here, "dist");
const desktop = join(repo, "desktop");
const modelUrl = process.env.MODEL_URL || "";

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit" });

console.log("• Compiling the shared Rust code to WebAssembly");
run("cargo", ["build", "-p", "lewisis-wasm", "--release", "--target", "wasm32-unknown-unknown", "--locked"], desktop);

// Keep the Vercel project link (dist/.vercel) across builds; everything else is rebuilt.
const link = join(here, ".vercel-link");
rmSync(link, { recursive: true, force: true });
try {
     cpSync(join(dist, ".vercel"), link, { recursive: true });
} catch {
     /* not linked yet */
}
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
try {
     cpSync(link, join(dist, ".vercel"), { recursive: true });
     rmSync(link, { recursive: true, force: true });
} catch {
     /* not linked yet */
}
// Never upload local environment files (`vercel link` writes a token to .env.local).
writeFileSync(join(dist, ".vercelignore"), ".env*\n.gitignore\n");
const built = join(desktop, "target/wasm32-unknown-unknown/release/lewisis_wasm.wasm");
// Folders named after their contents, so browsers can keep them for good and
// a new version always comes with new names (never old WebAssembly with new glue).
const wasmDir = `wasm-${createHash("sha256").update(readFileSync(built)).digest("hex").slice(0, 10)}`;
const ortVersion = JSON.parse(readFileSync(join(here, "node_modules/onnxruntime-web/package.json"), "utf8")).version;
const ortDir = `ort-${ortVersion}`;
run("wasm-bindgen", ["--target", "no-modules", "--no-typescript", "--out-dir", join(dist, wasmDir), built], repo);

console.log("• Copying the interface");
cpSync(join(repo, "static"), dist, { recursive: true });
for (const file of ["sw.js", "store.js", "browser.js", "separate-worker.js"]) {
     const text = readFileSync(join(here, "src", file), "utf8").replaceAll("/wasm/", `/${wasmDir}/`).replaceAll("/ort/", `/${ortDir}/`);
     writeFileSync(join(dist, file), text);
}

console.log("• Copying ONNX Runtime Web");
const ort = join(here, "node_modules/onnxruntime-web/dist");
mkdirSync(join(dist, ortDir));
for (const file of ["ort.min.js", "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"]) copyFileSync(join(ort, file), join(dist, ortDir, file));

// index.html: the web version's scripts, where the model lives, and a line
// telling visitors their music stays on their device.
let html = readFileSync(join(dist, "index.html"), "utf8");
const swap = (from, to) => {
     if (!html.includes(from)) throw new Error(`index.html no longer contains: ${from}`);
     html = html.replace(from, to);
};
swap('<script src="/desktop.js"></script>', '<script src="/store.js"></script>\n  <script src="/browser.js"></script>\n  <script src="/desktop.js"></script>');
swap('<meta name="viewport"', `<meta name="lewisis-model" content="${modelUrl}">\n  <meta name="viewport"`);
swap(
     "<p>Drop MP3, WAV or FLAC files anywhere in this window, or press <b>Add Music</b>.</p>",
     "<p>Drop MP3, WAV or FLAC files anywhere in this window, or press <b>Add Music</b>.</p>\n          <p class=\"web-note\">Your songs stay in this browser on this device; nothing is uploaded.</p>",
);
writeFileSync(join(dist, "index.html"), html);

// Security headers. Inline scripts are allowed only by their exact hash.
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
const csp = [
     "default-src 'self'",
     `script-src 'self' 'wasm-unsafe-eval' ${inline.join(" ")}`,
     "worker-src 'self' blob:",
     "style-src 'self' 'unsafe-inline'",
     "img-src 'self' data: blob:",
     "media-src 'self' blob:",
     "font-src 'self'",
     "connect-src 'self' https://lrclib.net https://huggingface.co https://*.huggingface.co https://*.hf.co",
     "object-src 'none'",
     "base-uri 'self'",
     "form-action 'none'",
     "frame-ancestors 'none'",
].join("; ");
const vercel = {
     $schema: "https://openapi.vercel.sh/vercel.json",
     headers: [
          {
               source: "/(.*)",
               headers: [
                    // Cross-origin isolation lets the AI use several processor threads.
                    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
                    { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
                    { key: "Content-Security-Policy", value: csp },
                    { key: "X-Content-Type-Options", value: "nosniff" },
                    { key: "Referrer-Policy", value: "no-referrer" },
               ],
          },
          { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
          { source: `/(${ortDir}|${wasmDir})/(.*)`, headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
          { source: "/fonts/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=604800" }] },
     ],
};
writeFileSync(join(dist, "vercel.json"), JSON.stringify(vercel, null, 2));

const size = Number(execFileSync("du", ["-sb", dist]).toString().split("\t")[0]);
console.log(`✓ web/dist is ready (${(size / 1e6).toFixed(1)} MB)${modelUrl ? `; model: ${modelUrl}` : "; model: /models/htdemucs.onnx (local testing only)"}`);
