import 'dotenv/config';

export function loadEnvString(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing env: ${key}`);
  return v;
}

export function loadEnvNumber(key: string, fallback?: number): number {
  const raw = process.env[key];
  if (raw === undefined) {
    if (fallback === undefined) throw new Error(`Missing env: ${key}`);
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for env ${key}`);
  return n;
}


