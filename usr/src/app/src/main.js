// SEC Filing Alert Scraper
// - Polls EDGAR Atom/RSS feeds (company feed output=atom) and emits new filings.
// - Uses a Key-Value store to remember last seen entry per feed (dedup across runs).
//
// Notes:
// - The SEC requires requests to include a descriptive User-Agent string (see SEC rules).
// - For production use: respect crawl-rate guidance and SEC Terms of Use; consider using SEC bulk endpoints or RSS subscriptions.

import { Actor } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import crypto from 'crypto';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
  startUrls = ['https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&output=atom'],
  cikOrTickerList = [],
  filingTypes = ['10-K', '10-Q', '8-K'],
  maxRequestsPerCrawl = 100,
  maxEntriesPerFeed = 50,
  includeFullFiling = false,
  webhookUrl = '',
  userAgent = 'sec-filing-alert-scraper (+https://example.com)'
} = input;

// Build feeds from cikOrTickerList if provided (simple template)
const builtFeeds = Array.isArray(cikOrTickerList) && cikOrTickerList.length
  ? cikOrTickerList.map((id) => `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(id)}&output=atom`)
  : [];

const feeds = Array.from(new Set([...(Array.isArray(startUrls) ? startUrls : []), ...builtFeeds]));

// Validate
if (!feeds.length) {
  Actor.log.fatal('No feed URLs provided in startUrls or cikOrTickerList');
  await Actor.exit({ exitCode: 1 });
}

const kvStore = await Actor.openKeyValueStore(); // default KV store for last seen tracking
const proxyConfiguration = await Actor.createProxyConfiguration(); // recommended for scale

// Utility: make a KV key from feed url
function feedKey(feedUrl) {
  const hash = crypto.createHash('sha1').update(feedUrl).digest('hex');
  return `sec_feed_last_${hash}`;
}

// Helper: basic XML/Atom parsing using Cheerio (we use CheerioCrawler to reuse fetch/proxy settings)
function parseAtom(xml, $) {
  // returns array of entry objects { id, title, link, updated, summary, content }
  const entries = [];
  $('entry').each((i, el) => {
    const $el = $(el);
    const id = $el.find('id').first().text().trim() || $el.find('guid').first().text().trim();
    // link may be in <link href="..."/>
    let link = $el.find('link').first().attr('href') || $el.find('link').first().text() || null;
    if (!link) {
      const linkEl = $el.find('link[rel="alternate"]').first();
      link = linkEl && linkEl.attr ? linkEl.attr('href') : null;
    }
    const title = $el.find('title').first().text().trim() || null;
    const updated = $el.find('updated').first().text().trim() || $el.find('pubDate').first().text().trim() || null;
    // summary or content
    const summary = $el.find('summary').first().text().trim() || $el.find('content').first().text().trim() || null;
    const content = $el.find('content').first().text().trim() || null;
    entries.push({ id, title, link, updated, summary, content });
  });
  // Fallback: if no <entry>, try RSS <item>
  if (!entries.length) {
    $('item').each((i, el) => {
      const $el = $(el);
      const id = $el.find('guid').first().text().trim() || $el.find('link').first().text().trim();
      const title = $el.find('title').first().text().trim() || null;
      const link = $el.find('link').first().text().trim() || null;
      const updated = $el.find('pubDate').first().text().trim() || null;
      const summary = $el.find('description').first().text().trim() || null;
      entries.push({ id, title, link, updated, summary, content: null });
    });
  }
  return entries;
}

// Helper: detect filing type from title or summary
function detectFilingType(title, summary) {
  const candidate = (title || '') + ' ' + (summary || '');
  const tokens = ['10-K', '10Q', '10-Q', '8-K', '8K', 'SC 13D', '13F', '20-F', 'S-1', '424B', '4', '3'];
  for (const t of tokens) {
    const re = new RegExp(`\\b${t.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
    if (re.test(candidate)) {
      // normalize common variants
      if (/10-?q/i.test(t)) return '10-Q';
      if (/10-?k/i.test(t)) return '10-K';
      if (/8-?k/i.test(t)) return '8-K';
      return t;
    }
  }
  // If no token found, try to infer from title e.g., "Form 4" etc.
  const m = candidate.match(/Form\s*(\d+[A-Z]?)/i);
  if (m) return m[0];
  // fallback: unknown
  return null;
}

// Helper: post webhook (fire-and-forget with error log)
async function postWebhook(url, payload) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      Actor.log.warning('Webhook responded with non-OK', { status: res.status, url });
    }
  } catch (err) {
    Actor.log.warning('Failed to POST webhook', { error: err.message, url });
  }
}

// Use a lightweight CheerioCrawler to perform feed fetches (it sets reasonable defaults & integrates proxies)
const crawler = new CheerioCrawler({
  proxyConfiguration,
  maxRequestsPerCrawl,
  requestHandlerTimeoutSecs: 120,
  async requestHandler({ request, $, log, enqueueLinks, response }) {
    log.info('Fetching feed', { url: request.url });

    // Parse as XML/Atom/RSS
    const entries = parseAtom(response && response.text ? response.text() : null, $);

    if (!entries || entries.length === 0) {
      log.warning('No feed entries parsed', { url: request.url });
      return;
    }

    // Load last seen id from KV store
    const key = feedKey(request.url);
    let lastSeenId = null;
    try {
      const stored = await kvStore.getValue(key);
      if (stored && typeof stored === 'string') lastSeenId = stored;
      else if (stored && stored.lastSeenId) lastSeenId = stored.lastSeenId;
    } catch (err) {
      log.debug('KV read failed', { key, error: err.message });
    }

    // We'll process entries newest-first and emit those that are newer than lastSeenId
    // Atom entries are already newest-first in most feeds; to be safe we sort by updated date if available
    const normalized = entries.map((e) => {
      return {
        id: e.id || e.link || crypto.createHash('sha1').update(e.title || e.summary || '').digest('hex'),
        title: e.title,
        link: e.link,
        updated: e.updated ? new Date(e.updated).toISOString() : null,
        summary: e.summary || null,
        content: e.content || null
      };
    }).filter(Boolean);

    // Sort by updated ascending to process oldest-first among the new ones so we can update lastSeenId progressively
    normalized.sort((a, b) => {
      const ta = a.updated ? new Date(a.updated).getTime() : 0;
      const tb = b.updated ? new Date(b.updated).getTime() : 0;
      return ta - tb;
    });

    // Limit entries per feed
    const toConsider = normalized.slice(-Math.abs(maxEntriesPerFeed));

    let newLastSeen = lastSeenId;

    for (const entry of toConsider) {
      // skip already seen (we compare id equality)
      if (lastSeenId && entry.id === lastSeenId) {
        // Not new; continue
        continue;
      }

      // If lastSeenId exists and we haven't yet passed it (because we're processing oldest-first), we should skip until we reach items after it.
      // But since we sliced newest N and sorted oldest-first, if lastSeenId exists somewhere in the list we should skip entries up to that id.
      // Simpler approach: detect if lastSeenId occurs in toConsider; if so, ignore those <= that index.
    }

    // Find index of lastSeenId in toConsider (if present)
    const idx = lastSeenId ? toConsider.findIndex((e) => e.id === lastSeenId) : -1;
    const newItems = idx >= 0 ? toConsider.slice(idx + 1) : (lastSeenId ? toConsider : toConsider); // if no lastSeenId, all are new (within limit)

    // If lastSeenId not present but we had a lastSeenId, assume feed rotated or feed older than stored; in that case treat latest item(s) as new up to limit
    // newItems now contains candidate new entries (could be empty)
    for (const entry of newItems) {
      try {
        const detectedType = detectFilingType(entry.title, entry.summary);
        // If filingTypes filter is provided and non-empty, apply case-insensitive matching
        if (Array.isArray(filingTypes) && filingTypes.length > 0) {
          const lowered = (detectedType || '').toLowerCase();
          const matches = filingTypes.some((t) => (t || '').toLowerCase() === lowered || (detectedType || '').toLowerCase().includes((t || '').toLowerCase()));
          if (!matches) {
            // skip this entry
            Actor.log.debug('Skipping entry - type not in filter', { entryId: entry.id, detectedType });
            // still update newLastSeen to this entry so we don't keep reprocessing older entries next run
            newLastSeen = entry.id;
            continue;
          }
        }

        // Optionally fetch full filing if includeFullFiling true and link available
        let fullText = null;
        if (includeFullFiling && entry.link) {
          try {
            // Many SEC atom links point to filing page with links to docs; we attempt to fetch the link and extract text fallback
            const res = await fetch(entry.link, { headers: { 'User-Agent': userAgent } });
            if (res.ok) {
              fullText = await res.text();
            }
          } catch (err) {
            log.debug('Failed to fetch full filing', { link: entry.link, error: err.message });
          }
        }

        const item = {
          feedUrl: request.url,
          company: request.userData && request.userData.company ? request.userData.company : null,
          filingId: entry.id,
          filingType: detectedType,
          title: entry.title,
          summary: entry.summary,
          link: entry.link,
          publishedAt: entry.updated,
          fullFilingText: fullText,
          scrapedAt: new Date().toISOString()
        };

        // Save to Dataset
        await Dataset.pushData(item);
        log.info('New filing saved', { filingId: entry.id, title: entry.title });

        // Send webhook if configured
        if (webhookUrl) {
          // Minimal payload
          const payload = {
            filingId: entry.id,
            filingType: detectedType,
            title: entry.title,
            link: entry.link,
            publishedAt: entry.updated,
            feedUrl: request.url
          };
          postWebhook(webhookUrl, payload); // fire-and-forget
        }

        // update newLastSeen to this entry
        newLastSeen = entry.id;
      } catch (err) {
        log.error('Failed to process entry', { entryId: entry.id, error: err.message });
      }
    }

    // If there were any entries processed, update KV with newest id (use last element of toConsider as latest)
    try {
      const latest = toConsider.length ? toConsider[toConsider.length - 1].id : newLastSeen;
      if (latest) {
        await kvStore.setValue(key, { lastSeenId: latest, updatedAt: new Date().toISOString(), feed: request.url }, { contentType: 'application/json' });
        log.info('Updated last seen id in KV store', { key });
      }
    } catch (err) {
      log.warning('Failed to update KV store with last seen id', { error: err.message });
    }

    // Optionally follow links found on feed page (not necessary, but kept to match template)
    await enqueueLinks();
  },

  handleFailedRequestFunction: async ({ request, error, log }) => {
    log.error('Feed request failed', { url: request.url, error: error?.message ?? error });
  }
});

// Start requests - tag userData.company for convenience
const startRequests = feeds.map((u) => {
  let company = null;
  try {
    const m = u.match(/CIK=([^&]+)/i);
    if (m) company = decodeURIComponent(m[1]);
  } catch {}
  return { url: u, userData: { company } };
});

await crawler.run(startRequests);

await Actor.exit();
