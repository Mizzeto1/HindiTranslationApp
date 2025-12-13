/**
 * LyricsMint Scraper
 * Searches and scrapes lyrics from lyricsmint.com
 * Extracts romanized Hindi lyrics (Hindi written in English letters)
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
 * Clean HTML to plain text lyrics
 */
function cleanLyricsHtml(html) {
  let text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#?[a-z0-9]+;/gi, '')
    .trim();

  // Clean up whitespace
  text = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');

  // Remove metadata lines
  const removePatterns = [
    /^lyrics\s*$/im,
    /^song\s*:?\s*$/im,
    /^singer\s*:/im,
    /^music\s*:/im,
    /^composer\s*:/im,
    /^lyricist\s*:/im,
    /^movie\s*:/im,
    /^album\s*:/im,
    /^label\s*:/im,
    /^starring\s*:/im,
    /^director\s*:/im,
    /^share this/im,
    /^copyright/im,
    /^all rights reserved/im,
    /^\[.*\]$/m
  ];

  let lines = text.split('\n');
  lines = lines.filter(line => {
    const trimmed = line.trim();
    return !removePatterns.some(pattern => pattern.test(trimmed));
  });

  return lines.join('\n').trim();
}

/**
 * Scrape lyrics from a LyricsMint lyrics page
 * Returns romanized Hindi (Hindi written in English letters)
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

    let hindiLyrics = '';      // Devanagari: तुम ही हो
    let romanizedLyrics = '';  // Romanized: Tum hi ho

    // Method 1: Look for explicit Hindi/English sections by headers
    const content = $('.entry-content').html() || '';

    // Try to find labeled sections
    const englishMatch = content.match(/english\s*lyrics[:\s]*([\s\S]*?)(?=hindi\s*lyrics|$)/i);
    const hindiMatch = content.match(/hindi\s*lyrics[:\s]*([\s\S]*?)(?=english\s*lyrics|$)/i);

    if (englishMatch) {
      romanizedLyrics = cleanLyricsHtml(englishMatch[1]);
    }
    if (hindiMatch) {
      hindiLyrics = cleanLyricsHtml(hindiMatch[1]);
    }

    // Method 2: If no labeled sections, analyze the content
    if (!romanizedLyrics && !hindiLyrics) {
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
          lyricsHtml = container.html();
          if (lyricsHtml && lyricsHtml.length > 200) {
            break;
          }
        }
      }

      if (lyricsHtml) {
        const cleanedText = cleanLyricsHtml(lyricsHtml);

        // Separate Devanagari and romanized lines
        const lines = cleanedText.split('\n');
        const devanagariLines = [];
        const romanLines = [];

        lines.forEach(line => {
          const trimmed = line.trim();
          if (!trimmed) return;

          // Check if line contains Devanagari characters
          const hasDevanagari = /[\u0900-\u097F]/.test(trimmed);

          if (hasDevanagari) {
            devanagariLines.push(trimmed);
          } else if (/[a-zA-Z]/.test(trimmed)) {
            // Line has Latin characters - likely romanized Hindi
            romanLines.push(trimmed);
          }
        });

        // If we found both types, use them
        if (devanagariLines.length > 0 && romanLines.length > 0) {
          hindiLyrics = devanagariLines.join('\n');
          romanizedLyrics = romanLines.join('\n');
        } else if (romanLines.length > 0) {
          // Only romanized found
          romanizedLyrics = romanLines.join('\n');
        } else if (devanagariLines.length > 0) {
          // Only Devanagari found
          hindiLyrics = devanagariLines.join('\n');
        } else {
          // Mixed or unclear - assume it's romanized if mostly Latin
          const hasLatin = /[a-zA-Z]/.test(cleanedText);
          if (hasLatin) {
            romanizedLyrics = cleanedText;
          } else {
            hindiLyrics = cleanedText;
          }
        }
      }
    }

    // We prefer romanized lyrics for display
    if (!romanizedLyrics && !hindiLyrics) {
      console.log('[LYRICSMINT] Could not extract lyrics');
      return null;
    }

    // If we only have Devanagari, we can't display romanized
    if (!romanizedLyrics && hindiLyrics) {
      console.log('[LYRICSMINT] Only found Devanagari, no romanized version');
      return {
        hindiLyrics: hindiLyrics,
        romanizedLyrics: null,
        needsTransliteration: true
      };
    }

    // Validate we have enough content
    if (romanizedLyrics && romanizedLyrics.length < 50) {
      console.log('[LYRICSMINT] Romanized lyrics too short');
      return null;
    }

    console.log(`[LYRICSMINT] Found romanized: ${romanizedLyrics?.length || 0} chars`);
    if (hindiLyrics) {
      console.log(`[LYRICSMINT] Found Devanagari: ${hindiLyrics.length} chars`);
    }

    return {
      hindiLyrics: hindiLyrics || null,
      romanizedLyrics: romanizedLyrics,
      needsTransliteration: false
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
  const result = await scrapeLyricsPage(pageUrl);

  if (!result) {
    return null;
  }

  return {
    romanizedLyrics: result.romanizedLyrics,
    hindiLyrics: result.hindiLyrics,
    needsTransliteration: result.needsTransliteration || false
  };
}

module.exports = { fetchLyrics, searchLyricsMint, scrapeLyricsPage };
