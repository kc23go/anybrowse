const AGENT_CARD_URL = "https://anybrowse.dev/.well-known/agent-card.json";
const PROMOTER_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

// Known A2A registries to submit to
const REGISTRIES = [
  {
    name: "a2a-directory",
    checkUrl: "https://a2a.directory/api/agents/anybrowse.dev",
    submitUrl: "https://a2a.directory/api/agents",
  },
];

let promoterTimer: ReturnType<typeof setInterval> | null = null;
let lastPromotionResult: PromotionResult | null = null;

interface RegistryStatus {
  name: string;
  listed: boolean;
  lastChecked: string;
  error?: string;
}

interface PromotionResult {
  lastRun: string;
  registries: RegistryStatus[];
  agentCardAccessible: boolean;
}

async function checkAgentCard(): Promise<boolean> {
  try {
    const resp = await fetch(AGENT_CARD_URL, { signal: AbortSignal.timeout(10_000) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function checkRegistry(registry: typeof REGISTRIES[0]): Promise<RegistryStatus> {
  const status: RegistryStatus = {
    name: registry.name,
    listed: false,
    lastChecked: new Date().toISOString(),
  };

  try {
    const resp = await fetch(registry.checkUrl, { signal: AbortSignal.timeout(10_000) });
    if (resp.ok) {
      status.listed = true;
    } else if (resp.status === 404) {
      try {
        const submitResp = await fetch(registry.submitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentCardUrl: AGENT_CARD_URL }),
          signal: AbortSignal.timeout(10_000),
        });
        status.listed = submitResp.ok;
        if (!submitResp.ok) {
          status.error = `Submit failed: ${submitResp.status}`;
        }
      } catch (err) {
        status.error = `Submit error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  } catch (err) {
    status.error = `Check error: ${err instanceof Error ? err.message : String(err)}`;
  }

  return status;
}

async function runPromotion(): Promise<void> {
  console.log("[promoter] Running daily promotion check...");

  const agentCardAccessible = await checkAgentCard();
  if (!agentCardAccessible) {
    console.warn("[promoter] Agent card not accessible at", AGENT_CARD_URL);
  }

  const registries: RegistryStatus[] = [];
  for (const registry of REGISTRIES) {
    const status = await checkRegistry(registry);
    registries.push(status);
    console.log(`[promoter] ${registry.name}: listed=${status.listed}${status.error ? ` error=${status.error}` : ""}`);
  }

  lastPromotionResult = {
    lastRun: new Date().toISOString(),
    registries,
    agentCardAccessible,
  };
}

export function startPromoter(): void {
  if (promoterTimer) return;
  console.log("[promoter] Starting self-promoter (interval: daily)");
  setTimeout(runPromotion, 5 * 60_000);
  promoterTimer = setInterval(runPromotion, PROMOTER_INTERVAL_MS);
}

export function stopPromoter(): void {
  if (promoterTimer) {
    clearInterval(promoterTimer);
    promoterTimer = null;
  }
}

export function getPromotionStatus(): PromotionResult | null {
  return lastPromotionResult;
}
