import 'dotenv/config';

/**
 * Load a required string from environment variables
 */
export function loadEnvString(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Load a required number from environment variables
 */
export function loadEnvNumber(key: string, fallback?: number): number {
  const raw = process.env[key];

  if (raw === undefined) {
    if (fallback === undefined) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid number for environment variable ${key}: ${raw}`);
  }

  return value;
}
