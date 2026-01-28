# What are Apify Actors?

- Actors are serverless cloud programs that can perform anything from a simple action, like filling out a web form, to a complex operation, like crawling an entire website or removing duplicates from a large dataset.
- Actors are programs packaged as Docker images, which accept a well-defined JSON input, perform an action, and optionally produce a well-defined JSON output.

---

SEC Filing Alert Scraper — Overview
- Purpose: monitor SEC EDGAR Atom/RSS feeds (company-level) and alert on new filings that match configured filing types (e.g., 10-K, 10-Q, 8-K).
- Approach: fetch Atom/RSS feeds, parse entries, deduplicate using the Key-Value store (persist lastSeenId per feed), push new filings to Dataset and optionally POST a webhook for each new filing.

Important notes
- The SEC asks crawlers to use a descriptive User-Agent string that includes contact information. Set `userAgent` input accordingly.
- For production-grade monitoring consider:
  - obeying SEC rate guidance and robots.txt,
  - distributing requests over time (scheduling actor runs),
  - using the SEC Bulk Data or other official ingestion endpoints where appropriate.

Inputs
- `startUrls` — list of feed URLs to poll (company Atom feeds)
- `cikOrTickerList` — convenience list to build company feed URLs
- `filingTypes` — tokens used to filter filings to alert on
- `includeFullFiling` — if true, attempts to fetch the linked filing page (may be large)
- `webhookUrl` — optional HTTP endpoint to POST new filing notifications

Outputs
- Dataset rows include feedUrl, company, filingId, filingType, title, summary, link, publishedAt, optional full filing text, and scrapedAt.

How to run locally
- Create a directory named `sec-filing-alert-scraper` and place the files there (do NOT create `storage/`).
- Install deps: `npm install`
- Run: `apify run` (or `node src/main.js`)

Recommendations & Enhancements
- (A) Add scheduled runs and KV time-series storage to accumulate historical alerts and provide daily digests.
- (B) Add email/Slack integration and richer webhook signing (HMAC) for secure notifications.
- (C) Add support for SEC bulk data or the EDGAR API where available for more reliable coverage.
- (D) Add robust XML parsing using an XML parser library for feeds that contain namespaces or non-standard structures.

Respectful scraping & legal
- Always respect Terms of Use and robots.txt for the target site.
- Do not overwhelm SEC infrastructure — schedule and rate-limit crawls.
- Include a proper User-Agent as requested by the SEC.
