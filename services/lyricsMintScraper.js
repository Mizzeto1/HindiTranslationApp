/**
 * LyricsMint Scraper
 * Uses LLM to identify artist, then constructs URL directly
 * Google/DuckDuckGo scraping doesn't work (they require JavaScript)
 */

const cheerio = require('cheerio');
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Rate limiting
let lastRequestTime = 0;
const MIN_INTERVAL = 1000;

async function rateLimitedFetch(url, options = {}) {
  const now = Date.now();
  const wait = MIN_INTERVAL - (now - lastRequestTime);
  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait));
  }
  lastRequestTime = Date.now();

  return fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      ...options.headers
    },
    ...options
  });
}

/**
 * Use LLM to identify the actual artist of a Bollywood song
 */
async function identifyArtist(songTitle) {
  try {
    console.log('[LYRICSMINT] Asking LLM to identify artist for:', songTitle);

    const response = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: `You are a Bollywood music expert. Given a song title, identify the main singer/artist.

Rules:
- Return ONLY the artist name, nothing else
- If multiple singers, return the most famous one
- Use the romanized name (English letters)
- If you don't know, return "unknown"
- Don't include "feat." or featured artists
- For movie songs, identify the actual singer, not actors

Examples:
- "Tum Hi Ho" → Arijit Singh
- "Kal Ho Naa Ho" → Sonu Nigam
- "Chaiyya Chaiyya" → Sukhwinder Singh
- "Teri Ni Kararan" → Diljit Dosanjh
- "Kesariya" → Arijit Singh
- "Naatu Naatu" → Rahul Sipligunj`
        },
        {
          role: 'user',
          content: `Song: "${songTitle}"\n\nWho is the singer?`
        }
      ],
      temperature: 0,
      max_tokens: 50
    });

    const artist = response.choices[0].message.content.trim();
    console.log('[LYRICSMINT] LLM identified artist:', artist);

    // Clean up the response
    const cleanArtist = artist
      .replace(/^(the\s+)?singer\s+(is\s+)?/i, '')
      .replace(/['"]/g, '')
      .trim();

    if (cleanArtist.toLowerCase() === 'unknown' || cleanArtist.length < 2) {
      return null;
    }

    return cleanArtist;

  } catch (error) {
    console.error('[LYRICSMINT] LLM artist identification failed:', error.message);
    return null;
  }
}

/**
 * Convert text to URL slug
 */
function toSlug(text) {
  return text
    .toLowerCase()
    .replace(/[''`]/g, '')           // Remove apostrophes
    .replace(/[^a-z0-9\s-]/g, '')    // Remove special chars
    .replace(/\s+/g, '-')            // Spaces to dashes
    .replace(/-+/g, '-')             // Multiple dashes to single
    .replace(/^-|-$/g, '')           // Trim dashes
    .substring(0, 50);               // Limit length
}

/**
 * Clean song title for searching
 */
function cleanSongTitle(title) {
  return title
    .replace(/["'"]/g, '')
    .replace(/\s*\(From\s+["']?[^)]+["']?\)\s*/gi, '')
    .replace(/\s*\(.*?\)\s*/g, '')
    .replace(/\s*\|.*$/g, '')
    .replace(/\s*-\s*(Official|Full|Audio|Video|Lyric|HD|4K).*$/gi, '')
    .replace(/\s*\[.*?\]\s*/g, '')
    .trim();
}

/**
 * Check if a LyricsMint URL exists
 */
async function checkUrlExists(url) {
  try {
    console.log('[LYRICSMINT] Checking URL:', url);
    const response = await rateLimitedFetch(url, { method: 'HEAD' });
    console.log('[LYRICSMINT] URL status:', response.status);
    return response.ok;
  } catch (error) {
    console.log('[LYRICSMINT] URL check failed:', error.message);
    return false;
  }
}

/**
 * Search for lyrics by trying multiple URL patterns
 */
async function searchLyricsMint(songTitle, artistName) {
  console.log('[LYRICSMINT] ============ SEARCH START ============');
  console.log('[LYRICSMINT] Input songTitle:', songTitle);
  console.log('[LYRICSMINT] Input artistName:', artistName);

  try {
    const cleanTitle = cleanSongTitle(songTitle);
    const songSlug = toSlug(cleanTitle);

    console.log('[LYRICSMINT] Cleaned title:', cleanTitle);
    console.log('[LYRICSMINT] Song slug:', songSlug);

    if (!songSlug || songSlug.length < 2) {
      console.log('[LYRICSMINT] Song slug too short');
      console.log('[LYRICSMINT] ============ SEARCH END ============');
      return null;
    }

    // Collect potential artists to try
    const artistsToTry = [];

    // 1. Use LLM to identify the actual artist
    const llmArtist = await identifyArtist(cleanTitle);
    if (llmArtist) {
      artistsToTry.push(llmArtist);
    }

    // 2. Use provided artist name if different
    if (artistName && artistName.length > 2) {
      const cleanArtist = artistName.split(',')[0].trim(); // Take first if multiple
      if (!artistsToTry.includes(cleanArtist)) {
        artistsToTry.push(cleanArtist);
      }
    }

    // 3. Try some common variations
    artistsToTry.push('arijit-singh');  // Most popular Hindi singer

    console.log('[LYRICSMINT] Artists to try:', artistsToTry);

    // Try each artist
    for (const artist of artistsToTry) {
      const artistSlug = toSlug(artist);
      if (!artistSlug || artistSlug.length < 2) continue;

      // Try standard URL pattern: /artist/song
      const url1 = `https://www.lyricsmint.com/${artistSlug}/${songSlug}`;
      if (await checkUrlExists(url1)) {
        console.log('[LYRICSMINT] Found URL:', url1);
        console.log('[LYRICSMINT] ============ SEARCH END ============');
        return url1;
      }

      // Try without www
      const url2 = `https://lyricsmint.com/${artistSlug}/${songSlug}`;
      if (await checkUrlExists(url2)) {
        console.log('[LYRICSMINT] Found URL:', url2);
        console.log('[LYRICSMINT] ============ SEARCH END ============');
        return url2;
      }
    }

    // Try song-only patterns (some pages might use this)
    const songOnlyUrls = [
      `https://www.lyricsmint.com/${songSlug}-lyrics`,
      `https://www.lyricsmint.com/lyrics/${songSlug}`,
      `https://lyricsmint.com/${songSlug}-lyrics`
    ];

    for (const url of songOnlyUrls) {
      if (await checkUrlExists(url)) {
        console.log('[LYRICSMINT] Found URL (song-only pattern):', url);
        console.log('[LYRICSMINT] ============ SEARCH END ============');
        return url;
      }
    }

    console.log('[LYRICSMINT] No valid URL found');
    console.log('[LYRICSMINT] ============ SEARCH END ============');
    return null;

  } catch (error) {
    console.error('[LYRICSMINT] Search error:', error.message);
    console.log('[LYRICSMINT] ============ SEARCH END ============');
    return null;
  }
}

/**
 * Scrape lyrics from a LyricsMint page
 */
async function scrapeLyricsPage(pageUrl) {
  try {
    console.log('[LYRICSMINT] Scraping page:', pageUrl);

    const response = await rateLimitedFetch(pageUrl);

    if (!response.ok) {
      console.log('[LYRICSMINT] Page returned:', response.status);
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    console.log('[LYRICSMINT] Page HTML length:', html.length);

    // Remove unwanted elements
    $('script, style, noscript, nav, header, footer, .sidebar, .comments, .related-posts, .share-buttons, .ad, .advertisement').remove();

    // Try to find lyrics content
    let romanizedLyrics = '';
    let hindiLyrics = '';

    // LyricsMint often has sections for Hindi and English/Romanized
    // Look for headers that indicate sections
    const content = $('.entry-content, .post-content, article').first();

    if (content.length === 0) {
      console.log('[LYRICSMINT] No content container found');
      return null;
    }

    // Get all text content
    const fullText = content.text();

    // Split by common section headers
    const hindiMatch = fullText.match(/hindi\s*lyrics[:\s]*([\s\S]*?)(?=english|romanized|translation|$)/i);
    const englishMatch = fullText.match(/(?:english|romanized)\s*lyrics[:\s]*([\s\S]*?)(?=hindi|translation|meaning|$)/i);

    if (englishMatch) {
      romanizedLyrics = cleanLyrics(englishMatch[1]);
      console.log('[LYRICSMINT] Found romanized section:', romanizedLyrics.substring(0, 100) + '...');
    }

    if (hindiMatch) {
      hindiLyrics = cleanLyrics(hindiMatch[1]);
      console.log('[LYRICSMINT] Found Hindi section:', hindiLyrics.substring(0, 100) + '...');
    }

    // If no clear sections, look for content patterns
    if (!romanizedLyrics) {
      // Find paragraphs that look like lyrics (multiple short lines)
      const paragraphs = content.find('p');
      const lyricsBlocks = [];

      paragraphs.each((i, p) => {
        const text = $(p).html() || '';
        // Lyrics often have <br> tags or are short lines
        if (text.includes('<br') || $(p).text().split('\n').length > 2) {
          const cleaned = cleanLyricsHtml(text);
          if (cleaned.length > 50 && isLikelyLyrics(cleaned)) {
            lyricsBlocks.push(cleaned);
          }
        }
      });

      if (lyricsBlocks.length > 0) {
        // Separate Devanagari and Romanized
        for (const block of lyricsBlocks) {
          const hasDevanagari = /[\u0900-\u097F]/.test(block);
          if (hasDevanagari && !hindiLyrics) {
            hindiLyrics = block;
          } else if (!hasDevanagari && !romanizedLyrics) {
            romanizedLyrics = block;
          }
        }
      }
    }

    // If we still don't have romanized, try to get any text that looks like lyrics
    if (!romanizedLyrics && !hindiLyrics) {
      const mainText = content.find('p, div').map((i, el) => $(el).text()).get().join('\n');
      const cleaned = cleanLyrics(mainText);

      if (cleaned.length > 100) {
        const hasDevanagari = /[\u0900-\u097F]/.test(cleaned);
        if (hasDevanagari) {
          hindiLyrics = cleaned;
        } else {
          romanizedLyrics = cleaned;
        }
      }
    }

    if (!romanizedLyrics && !hindiLyrics) {
      console.log('[LYRICSMINT] Could not extract lyrics');
      return null;
    }

    console.log('[LYRICSMINT] Extracted romanized:', romanizedLyrics ? romanizedLyrics.length + ' chars' : 'none');
    console.log('[LYRICSMINT] Extracted Hindi:', hindiLyrics ? hindiLyrics.length + ' chars' : 'none');

    return {
      romanizedLyrics: romanizedLyrics || null,
      hindiLyrics: hindiLyrics || null
    };

  } catch (error) {
    console.error('[LYRICSMINT] Scrape error:', error.message);
    return null;
  }
}

/**
 * Clean lyrics HTML to text
 */
function cleanLyricsHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#?[a-z0-9]+;/gi, '')
    .trim();
}

/**
 * Clean lyrics text
 */
function cleanLyrics(text) {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => {
      if (line.length < 2) return false;
      // Remove metadata lines
      if (/^(singer|music|lyrics|composer|movie|album|label|starring|director)[:\s]/i.test(line)) return false;
      if (/^(copyright|all rights|share this)/i.test(line)) return false;
      return true;
    });

  return lines.join('\n').trim();
}

/**
 * Check if text looks like song lyrics
 */
function isLikelyLyrics(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 4) return false;

  // Lyrics typically have short-medium length lines
  const avgLength = lines.reduce((sum, l) => sum + l.length, 0) / lines.length;
  if (avgLength > 100) return false; // Too long, probably prose

  return true;
}

/**
 * Main function: find and fetch lyrics
 */
async function fetchLyrics(songTitle, artistName) {
  console.log('[LYRICSMINT] Fetching lyrics for:', songTitle, 'by', artistName);

  const pageUrl = await searchLyricsMint(songTitle, artistName);

  if (!pageUrl) {
    console.log('[LYRICSMINT] No lyrics page found');
    return null;
  }

  const lyrics = await scrapeLyricsPage(pageUrl);
  return lyrics;
}

module.exports = {
  fetchLyrics,
  searchLyricsMint,
  scrapeLyricsPage,
  identifyArtist,
  toSlug
};
