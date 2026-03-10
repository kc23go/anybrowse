import { PostHog } from 'posthog-node';

// PostHog cloud: https://app.posthog.com — free tier, no credit card
// KC: Sign up at https://app.posthog.com, create a project, copy the Project API Key, then set POSTHOG_KEY env var
const POSTHOG_KEY = process.env.POSTHOG_KEY || '';

let client: PostHog | null = null;

export function getAnalytics(): PostHog | null {
  if (!POSTHOG_KEY) return null;
  if (!client) {
    client = new PostHog(POSTHOG_KEY, { host: 'https://app.posthog.com' });
  }
  return client;
}

export function trackEvent(event: string, properties: Record<string, any>, distinctId = 'anonymous'): void {
  const ph = getAnalytics();
  if (!ph) return;
  ph.capture({ distinctId, event, properties });
}

export async function shutdownAnalytics(): Promise<void> {
  await client?.shutdown();
}
