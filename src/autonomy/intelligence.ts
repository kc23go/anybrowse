import { readFileSync, writeFileSync, existsSync } from "fs";

const INTEL_FILE = "/agent/data/domain_intelligence.json";
const PERSIST_INTERVAL_MS = 5 * 60_000; // save every 5 minutes

interface DomainProfile {
  total: number;
  fastSuccess: number;
  slowSuccess: number;
  fastFail: number;
  slowFail: number;
  avgResponseMs: number;
  totalResponseMs: number;
  lastSeen: string;
  preferSlowScrape: boolean;
}

interface ContentQuality {
  totalScored: number;
  avgMarkdownLength: number;
  avgHeadings: number;
  avgLinks: number;
  avgLists: number;
}

export interface IntelSnapshot {
  domains: Record<string, DomainProfile>;
  quality: ContentQuality;
  capabilityGaps: string[];
}

class DomainIntelligence {
  private domains: Record<string, DomainProfile> = {};
  private quality: ContentQuality = {
    totalScored: 0,
    avgMarkdownLength: 0,
    avgHeadings: 0,
    avgLinks: 0,
    avgLists: 0,
  };
  private capabilityGaps: string[] = [];
  private persistTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.load();
    this.persistTimer = setInterval(() => this.save(), PERSIST_INTERVAL_MS);
  }

  private getOrCreateDomain(domain: string): DomainProfile {
    if (!this.domains[domain]) {
      this.domains[domain] = {
        total: 0,
        fastSuccess: 0,
        slowSuccess: 0,
        fastFail: 0,
        slowFail: 0,
        avgResponseMs: 0,
        totalResponseMs: 0,
        lastSeen: new Date().toISOString(),
        preferSlowScrape: false,
      };
    }
    return this.domains[domain];
  }

  recordScrape(url: string, method: "fast" | "slow", success: boolean, responseMs: number): void {
    try {
      const domain = new URL(url).hostname;
      const profile = this.getOrCreateDomain(domain);
      profile.total++;
      profile.totalResponseMs += responseMs;
      profile.avgResponseMs = profile.totalResponseMs / profile.total;
      profile.lastSeen = new Date().toISOString();

      if (method === "fast" && success) profile.fastSuccess++;
      if (method === "fast" && !success) profile.fastFail++;
      if (method === "slow" && success) profile.slowSuccess++;
      if (method === "slow" && !success) profile.slowFail++;

      // Auto-determine if domain should prefer slow scrape
      if (profile.total >= 3) {
        const fastRate = profile.fastSuccess / Math.max(1, profile.fastSuccess + profile.fastFail);
        const slowRate = profile.slowSuccess / Math.max(1, profile.slowSuccess + profile.slowFail);
        profile.preferSlowScrape = fastRate < 0.4 && slowRate > fastRate;
      }
    } catch {
      // Invalid URL, skip
    }
  }

  scoreContent(markdown: string): void {
    if (!markdown) return;

    const headings = (markdown.match(/^#{1,6}\s/gm) || []).length;
    const links = (markdown.match(/\[.*?\]\(.*?\)/g) || []).length;
    const lists = (markdown.match(/^[\s]*[-*+]\s/gm) || []).length;
    const len = markdown.length;

    const n = this.quality.totalScored;
    this.quality.avgMarkdownLength = (this.quality.avgMarkdownLength * n + len) / (n + 1);
    this.quality.avgHeadings = (this.quality.avgHeadings * n + headings) / (n + 1);
    this.quality.avgLinks = (this.quality.avgLinks * n + links) / (n + 1);
    this.quality.avgLists = (this.quality.avgLists * n + lists) / (n + 1);
    this.quality.totalScored++;
  }

  recordCapabilityGap(gap: string): void {
    if (!this.capabilityGaps.includes(gap)) {
      this.capabilityGaps.push(gap);
      console.log("[intel] New capability gap:", gap);
    }
  }

  shouldSlowScrape(url: string): boolean {
    try {
      const domain = new URL(url).hostname;
      return this.domains[domain]?.preferSlowScrape ?? false;
    } catch {
      return false;
    }
  }

  getSnapshot(): IntelSnapshot {
    // Sort domains by total, keep top 100
    const sorted = Object.entries(this.domains)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 100);

    return {
      domains: Object.fromEntries(sorted),
      quality: { ...this.quality },
      capabilityGaps: [...this.capabilityGaps],
    };
  }

  private load(): void {
    try {
      if (existsSync(INTEL_FILE)) {
        const data = JSON.parse(readFileSync(INTEL_FILE, "utf-8"));
        this.domains = data.domains || {};
        this.quality = data.quality || this.quality;
        this.capabilityGaps = data.capabilityGaps || [];
        console.log("[intel] Loaded domain intelligence from", INTEL_FILE);
      }
    } catch (err) {
      console.warn("[intel] Failed to load intel:", err instanceof Error ? err.message : err);
    }
  }

  save(): void {
    try {
      writeFileSync(INTEL_FILE, JSON.stringify({
        domains: this.domains,
        quality: this.quality,
        capabilityGaps: this.capabilityGaps,
      }, null, 2));
    } catch (err) {
      console.warn("[intel] Failed to save intel:", err instanceof Error ? err.message : err);
    }
  }

  shutdown(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    this.save();
  }
}

export const intelligence = new DomainIntelligence();
