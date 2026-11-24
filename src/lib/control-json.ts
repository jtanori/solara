/** Small control messages only; enforce actual streamed bytes, not just a header. */
export class InvalidControlJson extends Error {
  constructor() { super("invalid_request"); this.name = "InvalidControlJson"; }
}
export async function readControlJson(request: Request, limit = 2048): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) throw new InvalidControlJson();
  const reader = request.body?.getReader();
  if (!reader) throw new InvalidControlJson();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new InvalidControlJson();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { throw new InvalidControlJson(); }
  finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
