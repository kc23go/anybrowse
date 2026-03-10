import { getSubscribersDueEmail, markEmailSent } from './db.js';

const RESEND_KEY = process.env.RESEND_KEY || '';
const FROM = process.env.DRIP_FROM || 'hello@anybrowse.dev';

interface Email {
  subject: string;
  html: string;
  text: string;
}

const EMAILS: Record<1 | 2 | 3, Email> = {
  1: {
    subject: 'You now have 50 free scrapes per day',
    text: `You just unlocked 50 free scrapes per day on anybrowse.

The free tier gives you 10 per day by default. You are now on the higher limit.

Here is how to use it:

POST https://anybrowse.dev/scrape
Content-Type: application/json
{"url": "https://example.com"}

That converts any URL to clean Markdown. No API key needed.

The limit resets at midnight UTC every day.

If you need more than 50, credit packs start at $5 for 3,000 scrapes that never expire:
https://anybrowse.dev/credits

If you run into anything that does not work, reply to this email.`,
    html: `<p>You just unlocked 50 free scrapes per day on anybrowse.</p><p>The free tier gives you 10 per day by default. You are now on the higher limit.</p><pre>POST https://anybrowse.dev/scrape\nContent-Type: application/json\n{"url": "https://example.com"}</pre><p>That converts any URL to clean Markdown. No API key needed. Resets at midnight UTC.</p><p>If you need more than 50: <a href="https://anybrowse.dev/credits">credit packs start at $5 for 3,000 scrapes</a>.</p><p>If you run into anything that does not work, reply to this email.</p>`
  },
  2: {
    subject: 'What are you building with anybrowse?',
    text: `Two days ago you signed up for 50 free scrapes per day.

Curious what you are using it for. Reply and let us know.

A few things people are doing with it right now:
- Feeding web content into LLM pipelines
- Building research agents that pull live data
- Monitoring competitor sites
- Scraping job boards and aggregating listings

If you are hitting limits or specific sites that fail, reply with the URL.

When you are ready to go further, $5 gets you 3,000 scrapes with no expiry:
https://anybrowse.dev/credits`,
    html: `<p>Two days ago you signed up for 50 free scrapes per day.</p><p>Curious what you are using it for. Reply and let us know.</p><ul><li>Feeding web content into LLM pipelines</li><li>Building research agents that pull live data</li><li>Monitoring competitor sites</li><li>Scraping job boards and aggregating listings</li></ul><p>If you are hitting limits or specific sites that fail, reply with the URL.</p><p>When ready for more: <a href="https://anybrowse.dev/credits">$5 for 3,000 scrapes, no expiry</a>.</p>`
  },
  3: {
    subject: '3,000 scrapes for $5, no expiry',
    text: `Quick note.

If you have been using the free tier and hitting the daily limit, credits are the next step.

$5 gets you 3,000 scrapes. They do not expire. Use them over a week or a year.

No subscription. No monthly charge. Buy once, use whenever.

https://anybrowse.dev/credits

If neither the free tier nor credit packs fit what you are building, reply and tell us what you need.`,
    html: `<p>Quick note.</p><p>If you have been using the free tier and hitting the daily limit, credits are the next step.</p><p>$5 gets you 3,000 scrapes. They do not expire.</p><p>No subscription. No monthly charge. Buy once, use whenever.</p><p><a href="https://anybrowse.dev/credits">Get credits — $5 for 3,000 scrapes</a></p><p>If this does not fit what you are building, reply and tell us what you need.</p>`
  }
};

async function sendEmail(to: string, email: Email): Promise<boolean> {
  if (!RESEND_KEY) {
    console.warn('[drip] RESEND_KEY not set — skipping send');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to, subject: email.subject, html: email.html, text: email.text })
    });
    const data = await res.json() as any;
    if (!res.ok) {
      console.error('[drip] send failed:', data);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[drip] send error:', e);
    return false;
  }
}

export async function runDrip(): Promise<void> {
  for (const n of [1, 2, 3] as const) {
    const due = getSubscribersDueEmail(n);
    for (const sub of due) {
      const ok = await sendEmail(sub.email, EMAILS[n]);
      if (ok) {
        markEmailSent(sub.id, n);
        console.log(`[drip] sent email ${n} to ${sub.email}`);
      }
    }
  }
}
