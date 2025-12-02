/**
 * Performance logging utilities for request tracing
 */

export interface PerfMetrics {
  step: string;
  durationMs: number;
  timestamp: number;
  details?: Record<string, unknown>;
}

/**
 * Performance logger for tracking request timing
 */
export class PerfLogger {
  private readonly requestId: string;
  private readonly startTime: number;
  private currentStepStart: number;
  private readonly metrics: PerfMetrics[] = [];

  constructor(requestId?: string) {
    this.requestId = requestId ?? this.generateId();
    this.startTime = performance.now();
    this.currentStepStart = this.startTime;
  }

  private generateId(): string {
    return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Mark the start of a timed step
   */
  beginStep(step: string, details?: Record<string, unknown>): void {
    this.currentStepStart = performance.now();
    const elapsed = this.currentStepStart - this.startTime;
    const detailsStr = details ? ` | ${JSON.stringify(details)}` : '';
    console.log(
      `\x1b[36m[PERF]\x1b[0m \x1b[33m${this.requestId}\x1b[0m | ▶ START: ${step} (total: ${elapsed.toFixed(0)}ms)${detailsStr}`
    );
  }

  /**
   * Mark the end of a timed step and record duration
   */
  endStep(step: string, details?: Record<string, unknown>): number {
    const now = performance.now();
    const duration = now - this.currentStepStart;
    const totalElapsed = now - this.startTime;

    this.metrics.push({
      step,
      durationMs: duration,
      timestamp: Date.now(),
      details,
    });

    const color = duration < 1000 ? '\x1b[32m' : duration < 5000 ? '\x1b[33m' : '\x1b[31m';
    const detailsStr = details ? ` | ${JSON.stringify(details)}` : '';
    console.log(
      `\x1b[36m[PERF]\x1b[0m \x1b[33m${this.requestId}\x1b[0m | ✓ END: ${step} | ${color}${duration.toFixed(0)}ms\x1b[0m (total: ${totalElapsed.toFixed(0)}ms)${detailsStr}`
    );

    return duration;
  }

  /**
   * Log an event without timing
   */
  event(message: string, details?: Record<string, unknown>): void {
    const elapsed = performance.now() - this.startTime;
    const detailsStr = details ? ` | ${JSON.stringify(details)}` : '';
    console.log(
      `\x1b[36m[PERF]\x1b[0m \x1b[33m${this.requestId}\x1b[0m | ℹ ${message} (total: ${elapsed.toFixed(0)}ms)${detailsStr}`
    );
  }

  /**
   * Log an error
   */
  error(step: string, error: Error | string): void {
    const elapsed = performance.now() - this.startTime;
    const message = error instanceof Error ? error.message : error;
    console.log(
      `\x1b[36m[PERF]\x1b[0m \x1b[33m${this.requestId}\x1b[0m | \x1b[31m✗ ERROR: ${step}\x1b[0m | ${message} (total: ${elapsed.toFixed(0)}ms)`
    );
  }

  /**
   * Print final performance summary
   */
  summary(): void {
    const totalDuration = performance.now() - this.startTime;

    console.log('\n' + '='.repeat(80));
    console.log(`\x1b[36m[PERF SUMMARY]\x1b[0m \x1b[33m${this.requestId}\x1b[0m`);
    console.log('='.repeat(80));

    if (this.metrics.length > 0) {
      console.log('\nStep Breakdown:');
      console.log('-'.repeat(60));

      for (const metric of this.metrics) {
        const pct = ((metric.durationMs / totalDuration) * 100).toFixed(1);
        const bar = '█'.repeat(Math.ceil(Number(pct) / 5));
        console.log(
          `  ${metric.step.padEnd(30)} ${metric.durationMs.toFixed(0).padStart(6)}ms (${pct.padStart(5)}%) ${bar}`
        );
      }

      console.log('-'.repeat(60));
    }

    const color = totalDuration < 5000 ? '\x1b[32m' : totalDuration < 15000 ? '\x1b[33m' : '\x1b[31m';
    console.log(`\n  TOTAL: ${color}${totalDuration.toFixed(0)}ms\x1b[0m`);
    console.log('='.repeat(80) + '\n');
  }

  /**
   * Get all collected metrics
   */
  getMetrics(): PerfMetrics[] {
    return [...this.metrics];
  }

  /**
   * Get the request ID
   */
  getId(): string {
    return this.requestId;
  }

  /**
   * Get total elapsed time in ms
   */
  getElapsed(): number {
    return performance.now() - this.startTime;
  }
}

/**
 * Create a new performance logger
 */
export function createPerfLogger(requestId?: string): PerfLogger {
  return new PerfLogger(requestId);
}
