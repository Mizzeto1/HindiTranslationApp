/**
 * LyricsMint Scraper
 * Searches and scrapes lyrics from lyricsmint.com
 */

const cheerio = require('cheerio');

// Rate limiting
let lastRequestTime = 0;
const MIN_INTERVAL = 1200; // 1.2 seconds between requests

async function rateLimitedFetch(url) {
  const now = Date.now();
  const wait = MIN_INTERVAL - (now - lastRequestTime);
  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait));
  }
  lastRequestTime = Date.now();

  console.log(`[LYRICSMINT] Fetching: ${url}`);

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5'
    },
    timeout: 15000
  });

  return response;
}

/**
 * Search LyricsMint and get the first matching lyrics page URL
 */
async function searchLyricsMint(songTitle, artistName) {
  try {
    // Build search query - song title is most important
    let query = songTitle;
    if (artistName && artistName.length > 0) {
      query = `${songTitle} ${artistName}`;
    }

    const searchUrl = `https://www.lyricsmint.com/?s=${encodeURIComponent(query)}`;
    console.log(`[LYRICSMINT] Searching: ${searchUrl}`);

    const response = await rateLimitedFetch(searchUrl);

    if (!response.ok) {
      console.log(`[LYRICSMINT] Search returned ${response.status}`);
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // LyricsMint search results are usually in article tags or entry-title links
    // Look for the first lyrics link
    const selectors = [
      'article a[href*="lyricsmint.com"]',
      '.entry-title a',
      'h2.entry-title a',
      '.post-title a',
      'a[href*="/lyrics"]'
    ];

    let lyricsPageUrl = null;

    for (const selector of selectors) {
      const link = $(selector).first();
      if (link.length > 0) {
        const href = link.attr('href');
        // Make sure it's a lyrics page, not a category/tag page
        if (href && href.includes('lyricsmint.com') && !href.includes('/tag/') && !href.includes('/category/')) {
          lyricsPageUrl = href;
          break;
        }
      }
    }

    // Fallback: find any link that looks like a lyrics page
    if (!lyricsPageUrl) {
      $('a').each((i, el) => {
        const href = $(el).attr('href');
        if (href && href.includes('lyricsmint.com/') && href.split('/').length >= 5) {
          // URL like lyricsmint.com/artist/song has 5+ parts when split
          lyricsPageUrl = href;
          return false; // break
        }
      });
    }

    if (lyricsPageUrl) {
      console.log(`[LYRICSMINT] Found lyrics page: ${lyricsPageUrl}`);
      return lyricsPageUrl;
    }

    console.log('[LYRICSMINT] No lyrics page found in search results');
    return null;

  } catch (error) {
    console.error('[LYRICSMINT] Search error:', error.message);
    return null;
  }
}

/**
 * Scrape lyrics from a LyricsMint lyrics page
 */
async function scrapeLyricsPage(pageUrl) {
  try {
    const response = await rateLimitedFetch(pageUrl);

    if (!response.ok) {
      console.log(`[LYRICSMINT] Page returned ${response.status}`);
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove script and style tags
    $('script, style, noscript').remove();

    // LyricsMint puts lyrics in various containers
    // Try multiple selectors
    const lyricsSelectors = [
      '.entry-content',
      '.lyrics-content',
      '.song-lyrics',
      '.lyrics',
      'article .content',
      '.post-content'
    ];

    let lyricsHtml = '';

    for (const selector of lyricsSelectors) {
      const container = $(selector).first();
      if (container.length > 0) {
        // Get the HTML and process it
        lyricsHtml = container.html();
        if (lyricsHtml && lyricsHtml.length > 200) {
          break;
        }
      }
    }

    if (!lyricsHtml || lyricsHtml.length < 200) {
      console.log('[LYRICSMINT] Could not find lyrics container');
      return null;
    }

    // Convert HTML to text, preserving line breaks
    // Replace <br> and </p> with newlines
    let lyrics = lyricsHtml
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, '') // Remove remaining HTML tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#?[a-z0-9]+;/gi, '') // Remove other HTML entities
      .trim();

    // Clean up excessive whitespace
    lyrics = lyrics
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');

    // Remove common non-lyrics content
    const removePatterns = [
      /^lyrics\s*$/im,
      /^song\s*$/im,
      /^singer[:\s]/im,
      /^music[:\s]/im,
      /^composer[:\s]/im,
      /^lyricist[:\s]/im,
      /^movie[:\s]/im,
      /^album[:\s]/im,
      /^label[:\s]/im,
      /^share this/im,
      /^copyright/im,
      /^all rights reserved/im,
      /^\[.*\]$/m
    ];

    let lines = lyrics.split('\n');
    lines = lines.filter(line => {
      const trimmed = line.trim();
      return !removePatterns.some(pattern => pattern.test(trimmed));
    });

    lyrics = lines.join('\n').trim();

    if (lyrics.length < 100) {
      console.log('[LYRICSMINT] Extracted lyrics too short, probably not actual lyrics');
      return null;
    }

    console.log(`[LYRICSMINT] Extracted ${lyrics.length} chars of lyrics`);

    return {
      hindiLyrics: lyrics,
      englishTranslation: null // LyricsMint sometimes has translations, but parsing is complex
    };

  } catch (error) {
    console.error('[LYRICSMINT] Scrape error:', error.message);
    return null;
  }
}

/**
 * Main function: search for and fetch lyrics
 */
async function fetchLyrics(songTitle, artistName) {
  console.log(`[LYRICSMINT] Fetching lyrics for: "${songTitle}" by "${artistName}"`);

  if (!songTitle || songTitle.length < 2) {
    console.log('[LYRICSMINT] Song title too short');
    return null;
  }

  // Search for the song
  const pageUrl = await searchLyricsMint(songTitle, artistName);

  if (!pageUrl) {
    console.log('[LYRICSMINT] No lyrics page found');
    return null;
  }

  // Scrape the lyrics page
  const lyrics = await scrapeLyricsPage(pageUrl);

  return lyrics;
}

module.exports = { fetchLyrics, searchLyricsMint, scrapeLyricsPage };
