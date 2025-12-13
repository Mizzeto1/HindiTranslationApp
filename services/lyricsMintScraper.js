/**
 * LyricsMint Scraper Service
 *
 * Scrapes Hindi song lyrics and English translations from LyricsMint.com
 * Includes rate limiting and proper error handling.
 */

const cheerio = require('cheerio');

// Rate limiting: max 1 request per second
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1000;

// Common browser headers to avoid blocks
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1'
};

/**
 * Rate-limited fetch with proper headers
 * @param {string} url
 * @returns {Promise<Response|null>}
 */
async function rateLimitedFetch(url) {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
  }

  lastRequestTime = Date.now();

  try {
    const response = await fetch(url, {
      headers: HEADERS,
      timeout: 10000
    });

    if (!response.ok) {
      console.log(`[LYRICSMINT] HTTP ${response.status} for: ${url}`);
      return null;
    }

    return response;
  } catch (error) {
    console.error('[LYRICSMINT] Fetch error:', error.message);
    return null;
  }
}

/**
 * Build possible LyricsMint URL slugs for a song
 * @param {string} title
 * @param {string} artist
 * @returns {string[]}
 */
function buildPossibleUrls(title, artist) {
  const urls = [];

  // Clean and slugify
  const slugify = (str) => str.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();

  const titleSlug = slugify(title);
  const artistSlug = slugify(artist);

  // Common URL patterns on LyricsMint
  if (artistSlug && titleSlug) {
    urls.push(`https://www.lyricsmint.com/${artistSlug}/${titleSlug}`);
    urls.push(`https://www.lyricsmint.com/${titleSlug}-lyrics`);
    urls.push(`https://www.lyricsmint.com/${titleSlug}-${artistSlug}`);
  }

  if (titleSlug) {
    urls.push(`https://www.lyricsmint.com/${titleSlug}`);
    urls.push(`https://www.lyricsmint.com/${titleSlug}-lyrics`);
  }

  return urls;
}

/**
 * Scrape lyrics from a LyricsMint page
 * @param {string} html
 * @returns {{hindiLyrics: string, englishTranslation: string|null}|null}
 */
function scrapeLyricsFromHtml(html) {
  try {
    const $ = cheerio.load(html);

    let hindiLyrics = '';
    let englishTranslation = '';

    // LyricsMint typically structures lyrics in entry-content
    // Hindi and English are often in separate sections or alternating paragraphs

    // Try to find lyrics container
    const contentSelectors = [
      '.entry-content',
      '.lyrics-content',
      '.song-lyrics',
      'article .content',
      '.post-content'
    ];

    let $content = null;
    for (const sel of contentSelectors) {
      if ($(sel).length > 0) {
        $content = $(sel);
        break;
      }
    }

    if (!$content) {
      console.log('[LYRICSMINT] Could not find content container');
      return null;
    }

    // Extract text - LyricsMint often has Hindi in one block and English in another
    // Or they alternate paragraphs
    const paragraphs = $content.find('p').toArray();

    const hindiLines = [];
    const englishLines = [];

    paragraphs.forEach((p) => {
      const text = $(p).text().trim();
      if (!text || text.length < 3) return;

      // Skip navigation/metadata
      if (text.includes('Lyrics:') || text.includes('Singer:') ||
        text.includes('Music:') || text.includes('Movie:')) return;

      // Detect if text is Hindi (contains Devanagari) or English (mostly Latin)
      const hasDevanagari = /[\u0900-\u097F]/.test(text);
      const hasArabic = /[\u0600-\u06FF]/.test(text);  // Urdu script
      const isLatin = /^[a-zA-Z\s,.'!?()-]+$/.test(text.replace(/\s+/g, ' '));

      if (hasDevanagari || hasArabic) {
        // This is Hindi/Urdu script - we want romanized, skip this
      } else if (isLatin && text.length > 20) {
        // Could be English translation or romanized Hindi
        // Heuristic: if it looks like a translation (complete sentences), add to English
        // Otherwise treat as romanized Hindi
        const looksLikeTranslation = /\b(the|is|are|you|me|my|your|love|heart|I)\b/i.test(text);
        if (looksLikeTranslation) {
          englishLines.push(text);
        } else {
          hindiLines.push(text);
        }
      } else {
        // Mixed or romanized Hindi
        hindiLines.push(text);
      }
    });

    // If we didn't get good separation, just get all text
    if (hindiLines.length === 0 && englishLines.length === 0) {
      const allText = $content.text().trim();
      if (allText.length > 100) {
        hindiLines.push(allText);
      }
    }

    hindiLyrics = hindiLines.join('\n\n');
    englishTranslation = englishLines.length > 0 ? englishLines.join('\n\n') : null;

    if (hindiLyrics.length < 50) {
      console.log('[LYRICSMINT] Extracted lyrics too short');
      return null;
    }

    console.log(`[LYRICSMINT] Extracted ${hindiLyrics.length} chars Hindi, ${englishTranslation?.length || 0} chars English`);

    return {
      hindiLyrics,
      englishTranslation
    };
  } catch (error) {
    console.error('[LYRICSMINT] Parse error:', error.message);
    return null;
  }
}

/**
 * Search LyricsMint for a song using their search page
 * @param {string} songTitle
 * @param {string} artistName
 * @returns {Promise<string|null>} URL of the lyrics page
 */
async function searchLyricsMint(songTitle, artistName) {
  const query = `${songTitle} ${artistName}`.trim();
  const searchUrl = `https://www.lyricsmint.com/?s=${encodeURIComponent(query)}`;

  console.log(`[LYRICSMINT] Searching: ${searchUrl}`);

  const response = await rateLimitedFetch(searchUrl);
  if (!response) return null;

  try {
    const html = await response.text();
    const $ = cheerio.load(html);

    // Find first search result link
    const resultLink = $('article a, .entry-title a, h2 a').first().attr('href');

    if (resultLink) {
      console.log(`[LYRICSMINT] Found search result: ${resultLink}`);
      return resultLink;
    }

    return null;
  } catch (error) {
    console.error('[LYRICSMINT] Search parse error:', error.message);
    return null;
  }
}

/**
 * Main function: fetch lyrics for a song
 * @param {string} songTitle
 * @param {string} artistName
 * @returns {Promise<{hindiLyrics: string, englishTranslation: string|null}|null>}
 */
async function fetchLyrics(songTitle, artistName) {
  console.log(`[LYRICSMINT] Fetching lyrics for: "${songTitle}" by "${artistName}"`);

  // Strategy 1: Try direct URL patterns
  const possibleUrls = buildPossibleUrls(songTitle, artistName);

  for (const url of possibleUrls) {
    console.log(`[LYRICSMINT] Trying: ${url}`);
    const response = await rateLimitedFetch(url);

    if (response) {
      const html = await response.text();
      const lyrics = scrapeLyricsFromHtml(html);
      if (lyrics) {
        return lyrics;
      }
    }
  }

  // Strategy 2: Use search
  const searchResultUrl = await searchLyricsMint(songTitle, artistName);
  if (searchResultUrl) {
    const response = await rateLimitedFetch(searchResultUrl);
    if (response) {
      const html = await response.text();
      const lyrics = scrapeLyricsFromHtml(html);
      if (lyrics) {
        return lyrics;
      }
    }
  }

  console.log('[LYRICSMINT] No lyrics found');
  return null;
}

module.exports = {
  fetchLyrics
};
