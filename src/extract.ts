/**
 * extract.ts — POST /extract endpoint
 *
 * Takes a URL + JSON schema, returns structured JSON extracted from the page.
 * Uses LLM-based extraction (claude-3-haiku) as primary path.
 * Price: $0.01 per call (same as crawl). Goes through x402 payment gate.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Browser } from 'playwright-core';
import { acquireSession, releaseSession } from './pool.js';
import { scrapeUrlWithFallback } from './scraper.js';

export type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';
export type Schema = Record<string, FieldType>;

/**
 * Extract structured data using LLM.
 * Uses OpenClaw gateway (subscription-based) if env vars set, otherwise falls back to Anthropic API direct.
 */
async function extractWithLLM(markdown: string, schema: Schema): Promise<Record<string, any>> {
  // Truncate markdown to 8000 chars to control token costs
  const content = markdown.slice(0, 8000);

  const schemaDesc = Object.entries(schema)
    .map(([key, type]) => `- ${key} (${type})`)
    .join('\n');

  const prompt = `Extract the following fields from this webpage content. Return ONLY valid JSON, no explanation.\n\nFields:\n${schemaDesc}\n\nContent:\n${content}`;

  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;

  if (gatewayUrl && gatewayToken) {
    // Use OpenClaw gateway (subscription-based, no per-token charges)
    // 20s timeout — fall through to Anthropic direct if gateway unreachable
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${gatewayToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'openclaw:main',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1024
        }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`Gateway returned ${res.status}`);
      const data = await res.json() as any;
      const text = data.choices?.[0]?.message?.content || '';
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      return JSON.parse(cleaned);
    } catch (gwErr: any) {
      console.warn('[extract] Gateway failed, falling back to Anthropic:', gwErr.message);
      // Fall through to Anthropic direct below
    }
  }

  // Fallback: Anthropic API direct
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('No LLM configured (set OPENCLAW_GATEWAY_URL or ANTHROPIC_API_KEY)');

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: 'claude-3-haiku-20240307',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }]
  });
  const text = (message.content[0] as any).text;
  // Strip any markdown code blocks if model adds them
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned);
}

// ─── Legacy regex extraction (fallback only) ────────────────────────────────

function extractString(fieldName: string, markdown: string): string | null {
  const lines = markdown.split('\n');
  const pattern = new RegExp(fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (pattern.test(line)) {
      const colonMatch = line.match(new RegExp(fieldName + '\\s*[:\\-]\\s*(.+)', 'i'));
      if (colonMatch) return colonMatch[1].trim();
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const nextLine = lines[j].trim();
        if (nextLine && !nextLine.startsWith('#') && nextLine.length > 0) {
          return nextLine.replace(/^[\*\-•]\s*/, '').trim();
        }
      }
    }
  }

  const sentences = markdown.split(/[.!?]/);
  for (const sentence of sentences) {
    if (pattern.test(sentence)) {
      return sentence.trim().slice(0, 200);
    }
  }

  return null;
}

function extractNumber(fieldName: string, markdown: string): number | null {
  const pattern = new RegExp(fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\\n]{0,80}', 'i');
  const match = markdown.match(pattern);
  if (!match) return null;
  const numMatch = match[0].match(/[\$€£]?\s*([\d,]+(?:\.\d+)?)/);
  if (numMatch) {
    return parseFloat(numMatch[1].replace(/,/g, ''));
  }
  return null;
}

function extractBoolean(fieldName: string, markdown: string): boolean | null {
  const window = 200;
  const pattern = new RegExp(fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const idx = markdown.search(pattern);
  if (idx === -1) return null;
  const context = markdown.slice(Math.max(0, idx), idx + window).toLowerCase();
  if (/\b(yes|true|available|in[\s-]?stock|in stock|enabled|active|open)\b/.test(context)) return true;
  if (/\b(no|false|unavailable|out[\s-]?of[\s-]?stock|out of stock|disabled|inactive|closed|sold out)\b/.test(context)) return false;
  return null;
}

function extractArray(fieldName: string, markdown: string): string[] | null {
  const lines = markdown.split('\n');
  const pattern = new RegExp(fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  let inSection = false;
  const items: string[] = [];

  for (const line of lines) {
    if (pattern.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      const bullet = line.match(/^[\s]*[-*•]\s+(.+)/);
      const numbered = line.match(/^[\s]*\d+[.)]\s+(.+)/);
      if (bullet) {
        items.push(bullet[1].trim());
      } else if (numbered) {
        items.push(numbered[1].trim());
      } else if (line.trim() === '') {
        // allow blank lines
      } else if (items.length > 0 && !line.match(/^[-*•]|\d+[.)]/)) {
        break;
      }
    }
  }

  if (items.length > 0) return items;

  const allBullets = lines
    .filter((l) => /^[\s]*[-*•]\s+/.test(l))
    .map((l) => l.replace(/^[\s]*[-*•]\s+/, '').trim())
    .slice(0, 10);

  return allBullets.length > 0 ? allBullets : null;
}

/**
 * Legacy regex-based extraction (last resort fallback).
 */
export function extractFromMarkdown(markdown: string, schema: Schema): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  for (const [fieldName, fieldType] of Object.entries(schema)) {
    switch (fieldType) {
      case 'string':
        data[fieldName] = extractString(fieldName, markdown) ?? null;
        break;
      case 'number':
        data[fieldName] = extractNumber(fieldName, markdown) ?? null;
        break;
      case 'boolean':
        data[fieldName] = extractBoolean(fieldName, markdown) ?? null;
        break;
      case 'array':
        data[fieldName] = extractArray(fieldName, markdown) ?? null;
        break;
      case 'object':
        data[fieldName] = extractString(fieldName, markdown) ?? null;
        break;
      default:
        data[fieldName] = null;
    }
  }

  return data;
}

// ─── Route registration ──────────────────────────────────────────────────────

interface ExtractRequestBody {
  url?: unknown;
  schema?: unknown;
  context?: string;
}

export async function registerExtractRoutes(app: FastifyInstance): Promise<void> {
  app.post('/extract', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as ExtractRequestBody;
    const url = body?.url;
    const schema = body?.schema;

    if (!url || typeof url !== 'string') {
      return reply.status(400).send({ error: 'url is required' });
    }
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      return reply.status(400).send({ error: 'schema is required and must be an object mapping field names to types' });
    }

    // Validate schema values
    const validTypes = new Set(['string', 'number', 'boolean', 'array', 'object']);
    for (const [key, val] of Object.entries(schema as Record<string, unknown>)) {
      if (!validTypes.has(val as string)) {
        return reply.status(400).send({
          error: `Invalid type "${val}" for field "${key}". Use: string, number, boolean, array, object`,
        });
      }
    }

    const typedSchema = schema as Schema;

    let session: Awaited<ReturnType<typeof acquireSession>> | null = null;
    let hadError = false;

    try {
      session = await acquireSession();
      const browser = session.browser as Browser;

      const result = await scrapeUrlWithFallback(browser, url, true);

      if (result.status !== 'success') {
        hadError = true;
        return reply.status(422).send({
          error: 'Failed to scrape URL',
          reason: result.error || result.status,
          url,
        });
      }

      let data: Record<string, any>;
      let extractionMethod: string;

      // ── Pass 1: LLM extraction with claude-3-haiku (primary path) ────────
      try {
        data = await extractWithLLM(result.markdown, typedSchema);
        extractionMethod = 'llm';
      } catch (llmErr: any) {
        // ── Pass 2: Legacy regex fallback ────────────────────────────────
        console.warn('[extract] LLM failed, falling back to regex:', llmErr.message);
        data = extractFromMarkdown(result.markdown, typedSchema);
        extractionMethod = 'regex-fallback';
      }

      return reply.send({
        url,
        data,
        extractionMethod,
        markdown: result.markdown,
        title: result.title,
      });
    } catch (err: any) {
      hadError = true;
      return reply.status(500).send({ error: 'Extract failed', message: err.message });
    } finally {
      if (session) releaseSession(session, hadError);
    }
  });

  console.log('[extract] POST /extract registered ($0.01/call, LLM-based extraction with claude-3-haiku)');
}
