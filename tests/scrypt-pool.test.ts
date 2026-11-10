import assert from "node:assert/strict";
import test from "node:test";
import { ScryptBusyError, ScryptPool } from "../src/lib/scrypt-pool";
import { Semaphore, SemaphoreQueueFullError } from "../src/lib/semaphore";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not reached");
}

test("semaphore keeps at most four scrypt operations active across handoff", async () => {
  const gates = Array.from({ length: 8 }, () => deferred());
  let index = 0;
  let active = 0;
  let maxActive = 0;

  const pool = new ScryptPool(async () => {
    const gate = gates[index++];
    active++;
    maxActive = Math.max(maxActive, active);
    await gate.promise;
    active--;
    return Buffer.alloc(64);
  }, 4, 8);

  const runs = gates.map(() => pool.run("password", "salt"));
  await waitFor(() => pool.activeCount === 4);
  for (const gate of gates) gate.resolve();
  await Promise.all(runs);
  assert.equal(maxActive, 4);
});

test("semaphore rejects overflow instead of growing without bound", async () => {
  const gates = [deferred(), deferred(), deferred()];
  let index = 0;
  const pool = new ScryptPool(async () => {
    const gate = gates[index++];
    await gate.promise;
    return Buffer.alloc(64);
  }, 2, 1);

  const first = pool.run("password", "salt");
  const second = pool.run("password", "salt");
  await waitFor(() => pool.activeCount === 2);
  const queued = pool.run("password", "salt");
  await waitFor(() => pool.queuedCount === 1);
  await assert.rejects(() => pool.run("password", "salt"), ScryptBusyError);

  for (const gate of gates) gate.resolve();
  await Promise.all([first, second, queued]);
});

test("semaphore transfers permits without a decrement/wakeover window", async () => {
  const semaphore = new Semaphore(1, 1);
  assert.equal(semaphore.tryAcquire(), true);
  const waiter = semaphore.acquire();
  semaphore.release();
  const newcomer = semaphore.acquire();
  await waiter;
  assert.equal(semaphore.activeCount, 1);
  assert.equal(semaphore.queuedCount, 1);
  await assert.rejects(() => semaphore.acquire(), SemaphoreQueueFullError);
  semaphore.release();
  await newcomer;
  assert.equal(semaphore.activeCount, 1);
  semaphore.release();
  assert.equal(semaphore.activeCount, 0);
});
