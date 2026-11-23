// Serves web/dist locally with the same headers Vercel will send (from
// dist/vercel.json), to try the website before deploying:
//   node serve.mjs [port]          → http://localhost:5070
// For trying AI separation locally, /models/htdemucs.onnx is served from
// desktop/app/resources/ (it is never part of the deployment).
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const port = Number(process.argv[2]) || 5070;
const rules = JSON.parse(readFileSync(join(dist, "vercel.json"), "utf8")).headers;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".woff2": "font/woff2", ".onnx": "application/octet-stream", ".svg": "image/svg+xml", ".png": "image/png" };
// Vercel's path patterns, as used in vercel.json: "(.*)" is anything; other text is literal.
const matches = (source, path) =>
     new RegExp(`^${source.split("(.*)").map(part => part.replace(/[.+?^${}[\]\\]/g, "\\$&")).join(".*")}$`).test(path);

createServer((request, response) => {
     const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
     let file = path === "/" ? join(dist, "index.html") : join(dist, normalize(path));
     if (path.startsWith("/models/")) file = join(here, "../desktop/app/resources", normalize(path.slice(8)));
     // Local testing only: sample songs from desktop/target/test-audio.
     if (path.startsWith("/test-audio/")) file = join(here, "../desktop/target/test-audio", normalize(path.slice(12)));
     if (!file.startsWith(dist) && !/^\/(models|test-audio)\//.test(path)) return response.writeHead(403).end();
     for (const rule of rules) if (matches(rule.source, path)) for (const { key, value } of rule.headers) response.setHeader(key, value);
     if (!existsSync(file) || statSync(file).isDirectory()) return response.writeHead(404).end("Not found");
     response.setHeader("Content-Type", types[extname(file)] || "application/octet-stream");
     response.setHeader("Content-Length", statSync(file).size);
     createReadStream(file).pipe(response.writeHead(200));
}).listen(port, () => console.log(`Lewisis' Music (web) on http://localhost:${port}`));
