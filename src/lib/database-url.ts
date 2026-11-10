const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

export function normalizeDatabaseUrl(raw: string): string {
  const url = new URL(raw);
  if (isLoopbackHost(url.hostname)) return url.toString();

  const sslmode = url.searchParams.get("sslmode")?.trim().toLowerCase();
  const sslFlag = url.searchParams.get("ssl")?.trim().toLowerCase();
  if (sslmode === "disable" || sslFlag === "false" || sslFlag === "0") {
    throw new Error("Hosted DATABASE_URL must not disable TLS.");
  }

  url.searchParams.delete("ssl");
  if (sslmode !== "verify-full") {
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
}

export function poolMax(env: Record<string, string | undefined>): number {
  const parsed = Number.parseInt(env.DB_POOL_MAX ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 5;
  return Math.min(parsed, 20);
}
