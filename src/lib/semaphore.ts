export class SemaphoreQueueFullError extends Error {
  constructor(message = "Semaphore queue is full.") {
    super(message);
    this.name = "SemaphoreQueueFullError";
  }
}

export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly max: number,
    private readonly maxQueue: number,
  ) {
    if (max < 1) throw new Error("Semaphore max must be at least 1.");
    if (maxQueue < 0) throw new Error("Semaphore maxQueue must be non-negative.");
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiters.length;
  }

  tryAcquire(): boolean {
    if (this.active >= this.max) return false;
    this.active++;
    return true;
  }

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    if (this.waiters.length >= this.maxQueue) {
      throw new SemaphoreQueueFullError();
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    // The permit is transferred by release(); active already counts this holder.
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    if (this.active > 0) this.active--;
  }
}
