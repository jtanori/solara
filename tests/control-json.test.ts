import assert from "node:assert/strict";
import test from "node:test";
import { InvalidControlJson, readControlJson } from "../src/lib/control-json";
import { readingControlBody } from "../src/readings/http";
import { GenerationBlocked } from "../src/readings/execution";

function streamed(parts: Uint8Array[], headers: Record<string, string> = {}) {
  let reads = 0; let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { const next = parts[reads++]; if (next) controller.enqueue(next); else controller.close(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const request = new Request("http://localhost/control", { method: "POST", body, headers, duplex: "half" } as RequestInit);
  return { request, reads: () => reads, cancelled: () => cancelled };
}
const bytes = (text: string) => new TextEncoder().encode(text);
const invalid = (error: unknown) => error instanceof InvalidControlJson && error.message === "invalid_request";

test("control JSON: split UTF-8, exact byte limit and no content-length header are supported", async () => {
  const text = JSON.stringify({ disclosure: "¿Sí?" }); const encoded = bytes(text);
  const source = streamed(Array.from(encoded, item => Uint8Array.of(item)));
  assert.deepEqual(await readControlJson(source.request, encoded.length), { disclosure: "¿Sí?" });
  assert.equal(source.request.body?.locked, false);
  await assert.rejects(readControlJson(streamed([encoded]).request, encoded.length - 1), invalid);
});

test("control JSON: lying/absent length cannot bypass the streaming limit; oversize cancels without reading the tail", async () => {
  for (const headers of [{}, { "content-length": "1" }, { "content-length": "invalid" }] as Record<string, string>[]) {
    const source = streamed([bytes('{"text":"'), bytes("é".repeat(1024)), bytes('"}'), bytes("UNREAD_PRIVATE_TAIL")], headers);
    await assert.rejects(readControlJson(source.request), invalid);
    assert.equal(source.cancelled(), true); assert.equal(source.reads(), 2); assert.equal(source.request.body?.locked, false);
  }
});

test("control JSON: oversized declared length, malformed JSON, missing body and stream failure fail closed", async () => {
  const huge = streamed([bytes("{}")], { "content-length": "999999999" });
  await assert.rejects(readControlJson(huge.request), invalid); assert.equal(huge.reads(), 0);
  for (const value of ["", "{", "{} {}", "UNTRUSTED_TOKEN"]) await assert.rejects(readControlJson(streamed([bytes(value)]).request), invalid);
  await assert.rejects(readControlJson(new Request("http://localhost/control", { method: "POST" })), invalid);
  const failing = new Request("http://localhost/control", { method: "POST", body: new ReadableStream({ start(controller) { controller.error(new Error("PRIVATE_UPSTREAM_BODY")); } }), duplex: "half" } as RequestInit);
  await assert.rejects(readControlJson(failing), invalid); assert.equal(failing.body?.locked, false);
});

test("control JSON: reading routes preserve their public error code instead of leaking parse/body errors", async () => {
  await assert.rejects(readingControlBody(streamed([bytes('{"private":')]).request), error => error instanceof GenerationBlocked && error.code === "invalid_request");
  assert.deepEqual(await readingControlBody(streamed([bytes('{"locale":"es"}')]).request), { locale: "es" });
});
