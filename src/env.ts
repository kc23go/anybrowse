import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Try loading production-env from multiple locations (non-dotfile, synced via deploy)
const searchPaths = [
  resolve(process.cwd(), 'production-env'),
  resolve(process.cwd(), '../production-env'),
  '/agent/app/production-env',
  '/agent/app/src/production-env',
  resolve(dirname(fileURLToPath(import.meta.url)), '../production-env'),
  resolve(dirname(fileURLToPath(import.meta.url)), 'production-env'),
];
for (const p of searchPaths) {
  if (existsSync(p)) {
    dotenvConfig({ path: p, override: false });
    break;
  }
}

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

// Debug: log where we're looking for production-env
// console.log('CWD:', process.cwd(), '| prodEnvPath:', prodEnvPath);
