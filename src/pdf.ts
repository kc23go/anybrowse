import { loadEnvString } from './env.js';

const DEBUG_LOG = process.env.DEBUG_LOG === '1' || process.env.DEBUG_LOG === 'true';

const DATALAB_API_URL = 'https://www.datalab.to/api/v1/marker';
const MAX_POLLS = 300;
const POLL_INTERVAL_MS = 2000;

interface DatalabSubmitResponse {
  success: boolean;
  error: string | null;
  request_id: string;
  request_check_url: string;
}

interface DatalabPollResponse {
  output_format: 'markdown' | 'json' | 'html';
  markdown?: string;
  json?: string;
  html?: string;
  status: 'complete' | 'processing' | 'failed';
  success: boolean;
  images: Record<string, string>;
  metadata: Record<string, unknown>;
  error: string;
  page_count: number;
}

export interface PdfConversionResult {
  url: string;
  title: string;
  markdown: string;
  status: 'success' | 'empty' | 'error';
  error?: string;
  pageCount?: number;
}

/**
 * Check if a URL points to a PDF file
 */
export function isPdfUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();
    return pathname.endsWith('.pdf');
  } catch {
    return false;
  }
}

/**
 * Get the Datalab API key from environment
 */
function getApiKey(): string | null {
  try {
    return loadEnvString('DATALAB_API_KEY');
  } catch {
    return null;
  }
}

/**
 * Check if PDF support is enabled (API key is configured)
 */
export function isPdfSupportEnabled(): boolean {
  return getApiKey() !== null;
}

/**
 * Delay helper for polling
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Log PDF conversion performance
 */
function logPerf(step: string, url: string, startTime: number, details?: Record<string, unknown>): void {
  const duration = performance.now() - startTime;
  const color = duration < 1000 ? '\x1b[32m' : duration < 5000 ? '\x1b[33m' : '\x1b[31m';
  const urlShort = url.length > 50 ? url.slice(0, 50) + '...' : url;
  const detailsStr = details ? ` | ${JSON.stringify(details)}` : '';
  console.log(`\x1b[36m[PDF]\x1b[0m ${step.padEnd(20)} | ${color}${duration.toFixed(0).padStart(5)}ms\x1b[0m | ${urlShort}${detailsStr}`);
}

/**
 * Extract a title from the PDF URL (filename without extension)
 */
function extractTitleFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.split('/').pop() || '';
    // Remove .pdf extension and decode URI components
    const title = decodeURIComponent(filename.replace(/\.pdf$/i, ''));
    // Replace underscores and hyphens with spaces
    return title.replace(/[_-]/g, ' ').trim() || 'PDF Document';
  } catch {
    return 'PDF Document';
  }
}

/**
 * Convert a PDF URL to Markdown using Datalab Marker API
 */
export async function convertPdfToMarkdown(url: string): Promise<PdfConversionResult> {
  const startTime = performance.now();
  console.log(`\x1b[36m[PDF]\x1b[0m Starting PDF conversion: ${url}`);

  const apiKey = getApiKey();
  if (!apiKey) {
    logPerf('ERROR', url, startTime, { error: 'DATALAB_API_KEY not configured' });
    return {
      url,
      title: '',
      markdown: '',
      status: 'error',
      error: 'DATALAB_API_KEY environment variable not configured',
    };
  }

  const headers = { 'X-Api-Key': apiKey };
  const title = extractTitleFromUrl(url);

  try {
    // Submit PDF for conversion using file_url parameter
    const submitStart = performance.now();
    
    const formData = new FormData();
    formData.append('file_url', url);
    formData.append('output_format', 'markdown');
    formData.append('force_ocr', 'false');
    formData.append('paginate', 'false');
    formData.append('use_llm', 'false');
    formData.append('strip_existing_ocr', 'false');
    formData.append('disable_image_extraction', 'true');

    const submitResponse = await fetch(DATALAB_API_URL, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!submitResponse.ok) {
      const errorText = await submitResponse.text();
      throw new Error(`Datalab API submit failed: ${submitResponse.status} ${errorText}`);
    }

    const submitData = await submitResponse.json() as DatalabSubmitResponse;
    logPerf('Submit complete', url, submitStart, { requestId: submitData.request_id });

    if (!submitData.success) {
      throw new Error(`Datalab API submit error: ${submitData.error}`);
    }

    // Poll for completion
    const pollStart = performance.now();
    const checkUrl = submitData.request_check_url;

    for (let i = 0; i < MAX_POLLS; i++) {
      await delay(POLL_INTERVAL_MS);

      const pollResponse = await fetch(checkUrl, { headers });
      if (!pollResponse.ok) {
        throw new Error(`Datalab API poll failed: ${pollResponse.status}`);
      }

      const pollData = await pollResponse.json() as DatalabPollResponse;

      if (pollData.status === 'complete') {
        logPerf('Poll complete', url, pollStart, { polls: i + 1, pageCount: pollData.page_count });

        const markdown = pollData.markdown || '';
        if (!markdown.trim()) {
          logPerf('PDF EMPTY', url, startTime);
          return {
            url,
            title,
            markdown: '',
            status: 'empty',
            pageCount: pollData.page_count,
          };
        }

        logPerf('PDF SUCCESS', url, startTime, { mdLen: markdown.length, pageCount: pollData.page_count });
        return {
          url,
          title,
          markdown,
          status: 'success',
          pageCount: pollData.page_count,
        };
      }

      if (pollData.status === 'failed') {
        throw new Error(`Datalab conversion failed: ${pollData.error}`);
      }

      if (DEBUG_LOG && i > 0 && i % 10 === 0) {
        console.log(`\x1b[36m[PDF]\x1b[0m Still polling... (${i + 1}/${MAX_POLLS})`);
      }
    }

    throw new Error('Datalab API polling timeout');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logPerf('PDF ERROR', url, startTime, { error: message });

    if (DEBUG_LOG) {
      console.error(`[pdf] Failed ${url}:`, message);
    }

    return {
      url,
      title: '',
      markdown: '',
      status: 'error',
      error: message,
    };
  }
}
