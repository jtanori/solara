import { scrypt } from "node:crypto";
import { promisify } from "node:util";
import { Semaphore, SemaphoreQueueFullError } from "@/lib/semaphore";

export type ScryptRunner = (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

const defaultRunner = promisify(scrypt) as ScryptRunner;

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

  async run(password: string, salt: string): Promise<Buffer> {
    try {
      await this.semaphore.acquire();
    } catch (error) {
      if (error instanceof SemaphoreQueueFullError) throw new ScryptBusyError();
      throw error;
    }

    try {
      return await this.runner(password, salt, 64);
    } finally {
      this.semaphore.release();
    }
  }
}

export const scryptPool = new ScryptPool();
