import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import { launchReadingTestBrowser } from "./browser";

/** Runs actual production React controls; only Next routing and HTTP are seams. */
export async function startControlBrowser(entryPoint: string) {
  const built = await build({ entryPoints: [entryPoint], write: false, bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "test-next-boundary", setup(b) {
      b.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: "test-next" }));
      b.onLoad({ filter: /.*/, namespace: "test-next" }, args => ({ loader: "js", contents: args.path.endsWith("navigation")
        ? "globalThis.readingRefreshes=0;const router={refresh(){globalThis.readingRefreshes++}};export function useRouter(){return router}"
        : "import React from 'react';export default function Link({href,children,...props}){return React.createElement('a',{href,...props},children)}", resolveDir: process.cwd() }));
    } }] });
  const server = createServer((request, response) => {
    if (request.url === "/controls.js") { response.setHeader("Content-Type", "application/javascript"); response.end(built.outputFiles[0].contents); }
    else { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><html lang="en"><head><meta charset="UTF-8"></head><body><main id="root"></main><script src="/controls.js"></script></body></html>'); }
  });
  await new Promise<void>(resolve => server.listen(0, "0.0.0.0", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const browser = await launchReadingTestBrowser().catch(async error => { await new Promise<void>(resolve => server.close(() => resolve())); throw error; });
  return { browser, origin: `http://127.0.0.1:${address.port}`, close: async () => { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
