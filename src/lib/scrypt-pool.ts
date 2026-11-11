import { scrypt } from "node:crypto";
import { promisify } from "node:util";
import { Semaphore, SemaphoreQueueFullError } from "@/lib/semaphore";

/**
 * scrypt cost parameters.
 *
 * These are stored *with* each hash (see `passwords.ts`) rather than being an
 * implicit global: the whole point of recording them is that raising the cost
 * later leaves existing hashes verifiable at their original cost instead of
 * silently unverifiable. `N` is the CPU/memory cost, `r` the block size, `p`
 * the parallelisation factor.
 */
export type ScryptParams = {
  N: number;
  r: number;
  p: number;
};

/**
 * Node's defaults, made explicit (S8). Before this, `scrypt` was called with no
 * options at all, so the cost lived only in Node's implementation.
 */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };

/**
 * Bounds used when reading parameters back out of a stored hash. A hash is our
 * own data, but a corrupted or hostile row must not be able to ask this process
 * to allocate gigabytes: scrypt's memory use is ~128 * N * r bytes.
 */
export const SCRYPT_PARAM_LIMITS = {
  maxN: 2 ** 20,
  maxR: 32,
  maxP: 16,
} as const;

export type ScryptRunner = (
  password: string,
  salt: string,
  keylen: number,
  params?: ScryptParams,
) => Promise<Buffer>;

const defaultRunner = (async (
  password: string,
  salt: string,
  keylen: number,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
) => {
  const scryptAsync = promisify(scrypt) as (
    password: string,
    salt: string,
    keylen: number,
    options: { N: number; r: number; p: number; maxmem: number },
  ) => Promise<Buffer>;
  // Default maxmem is 32 MiB, which N=16384/r=8 sits just under (16 MiB). Any
  // future cost bump would trip `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` without this.
  const maxmem = Math.max(32 * 1024 * 1024, 128 * params.N * params.r * 2);
  return scryptAsync(password, salt, keylen, { ...params, maxmem });
}) as ScryptRunner;

export class ScryptBusyError extends Error {
  constructor(message = "Password hashing capacity is exhausted.") {
    super(message);
    this.name = "ScryptBusyError";
  }
}

export class ScryptPool {
  private readonly semaphore: Semaphore;

  constructor(
    private readonly runner: ScryptRunner = defaultRunner,
    maxConcurrent = 4,
    maxQueue = 256,
  ) {
    this.semaphore = new Semaphore(maxConcurrent, maxQueue);
  }

  get activeCount(): number {
    return this.semaphore.activeCount;
  }

  get queuedCount(): number {
    return this.semaphore.queuedCount;
  }

  async run(
    password: string,
    salt: string,
    params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
  ): Promise<Buffer> {
    try {
      await this.semaphore.acquire();
    } catch (error) {
      if (error instanceof SemaphoreQueueFullError) throw new ScryptBusyError();
      throw error;
    }

    try {
      return await this.runner(password, salt, 64, params);
    } finally {
      this.semaphore.release();
    }
  }
}

export const scryptPool = new ScryptPool();
