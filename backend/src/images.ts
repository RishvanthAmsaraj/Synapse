// ---------------------------------------------------------------------------
// Image search — Wikipedia REST + Wikimedia Commons, cached, no API key.
//
// Extracted into its own module so the query-normalization + search ladder is
// unit-testable without booting the HTTP/WebSocket server. See images.test.ts.
//
// Returns MULTIPLE candidate URLs per query so the frontend can fall back to
// the next image if one fails to load (the "pull up a different one" behavior).
// ---------------------------------------------------------------------------

// Successful lookups are cached so repeat queries are instant and
// rate-limiter-friendly. Failed lookups are NOT cached (a retry with a
// slightly different query may succeed). Maps query → candidate URLs.
const imageCache = new Map<string, string[]>();

// Cap on how many distinct candidate URLs we hand back per query. Enough to
// survive a dead link or two without flooding the canvas or the network.
const MAX_CANDIDATES = 5;

// Wikipedia asks for a descriptive User-Agent; a generic one gets throttled
// after a handful of requests (the "stuck on one picture" symptom). A proper
// UA keeps successive lookups working.
const UA_HEADERS = {
  'User-Agent': 'SynapseEdu/1.0 (voice-first educational canvas; personal project)',
  'Accept': 'application/json',
};

/** Fetch a URL with a timeout (AbortController). Returns null on any failure. */
async function fetchJsonWithTimeout(url: string, timeoutMs = 8000): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { headers: UA_HEADERS, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Strip filler words so the query can hit a real article/title. This is the
 * normalization layer: determiners, pronouns, polite/imperative verbs, media
 * nouns, and conversational qualifiers ("different", "another", "other")
 * carry no content meaning in an image query. Word-boundary aware, so
 * "Finding Nemo" and "New York" are left intact.
 */
export function cleanQuery(query: string): string {
  const cleaned = query
    .replace(
      /\b(diagram|visualization|algorithm|chart|image|picture|photo|example|illustration|concept|overview|drawing|painting|screenshot|different|another|other|some|any|various|a|an|the|of|my|your|our|me|you|it|this|that|please|show|find|get|display|want|need|see|look|can|could|would)\b/gi,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || query;
}

/**
 * Qualifiers that only make sense at the FRONT of a query and only after the
 * fuller query has already failed to resolve. Kept out of cleanQuery so real
 * titles ("New York", "One Piece", "More") survive the first pass; stripped
 * here as a last-ditch simplification.
 */
const LEADING_QUALIFIERS = new Set([
  'different', 'another', 'other', 'some', 'any', 'various', 'new', 'one', 'more', 'extra', 'additional',
]);

/**
 * Build a ladder of candidate queries, most-specific first. If the full query
 * misses we retry with progressively simpler forms, so a conversational
 * request degrades to its content noun instead of failing outright.
 */
export function buildQueryLadder(query: string): string[] {
  const ladder: string[] = [];
  const cleaned = cleanQuery(query);
  if (cleaned) ladder.push(cleaned);

  const words = cleaned.split(' ').filter(Boolean);
  while (words.length > 1 && LEADING_QUALIFIERS.has(words[0].toLowerCase())) {
    words.shift();
    ladder.push(words.join(' '));
  }
  if (words.length > 2) ladder.push(words.slice(-2).join(' '));
  if (words.length > 1) ladder.push(words[words.length - 1]);

  return [...new Set(ladder)];
}

/** Search one candidate query; returns every usable image URL found. */
async function searchImages(candidate: string): Promise<string[]> {
  const key = candidate.toLowerCase();

  // Cache hit — instant, never re-hits the network.
  const cached = imageCache.get(key);
  if (cached) {
    console.log(`[wikipedia] cache hit: "${candidate}" (${cached.length})`);
    return cached;
  }

  const urls: string[] = [];
  const seen = new Set<string>();
  const push = (u?: string) => {
    if (u && !seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  };

  // Fast path: REST summary — prefer the full-resolution original image.
  const summary = await fetchJsonWithTimeout(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(candidate)}`
  );
  push(summary?.originalimage?.source ?? summary?.thumbnail?.source);

  // Wikimedia Commons — collect ALL matching images, not just the first.
  const commons = await fetchJsonWithTimeout(
    `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(candidate)}&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url&iiurlwidth=1600&format=json`
  );
  if (commons?.query?.pages) {
    const pages = Object.values(commons.query.pages) as any[];
    for (const page of pages) {
      const info = page?.imageinfo?.[0];
      const url = (info?.thumburl || info?.url) as string | undefined;
      if (url && /\.(jpe?g|png|svg|gif|webp)$/i.test(url)) push(url);
    }
  }

  // Fallback: opensearch for the best matching article titles.
  const searchData = (await fetchJsonWithTimeout(
    `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(candidate)}&limit=3&format=json`
  )) as [string, string[]] | null;
  const titles = searchData?.[1] ?? [];
  for (const title of titles) {
    const fallback = await fetchJsonWithTimeout(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
    );
    push(fallback?.thumbnail?.source);
  }

  if (urls.length > 0) {
    imageCache.set(key, urls);
    console.log(`[wikipedia] "${candidate}" → ${urls.length} candidate(s)`);
  }
  return urls;
}

/**
 * Fetch candidate images for a conversational query, walking the query ladder
 * from most- to least-specific until we collect enough URLs (or exhaust the
 * ladder). Returns [] only when every rung misses.
 */
export async function fetchWikipediaImages(query: string): Promise<string[]> {
  const ladder = buildQueryLadder(query);
  const collected: string[] = [];
  const seen = new Set<string>();

  for (const candidate of ladder) {
    for (const url of await searchImages(candidate)) {
      if (!seen.has(url)) {
        seen.add(url);
        collected.push(url);
      }
    }
    if (collected.length >= MAX_CANDIDATES) break;
  }

  if (collected.length === 0) {
    console.warn(`[wikipedia] no image found for "${query}" (ladder: ${ladder.join(' → ') || 'empty'})`);
  }
  return collected.slice(0, MAX_CANDIDATES);
}
