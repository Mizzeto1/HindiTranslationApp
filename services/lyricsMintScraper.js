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
    $('script, style, noscript, nav, header, footer, .sidebar, .comments, .related-posts, .share-buttons, .ad, .advertisement, .social-share').remove();

    let romanizedLyrics = '';
    let hindiLyrics = '';

    // Method 1: Look for lyrics in pre-formatted blocks
    $('pre').each((i, el) => {
      const text = $(el).text().trim();
      if (text.length > 100) {
        const hasDevanagari = /[\u0900-\u097F]/.test(text);
        if (hasDevanagari && !hindiLyrics) {
          hindiLyrics = text;
          console.log('[LYRICSMINT] Found Hindi in <pre>:', text.length, 'chars');
        } else if (!hasDevanagari && !romanizedLyrics) {
          romanizedLyrics = text;
          console.log('[LYRICSMINT] Found romanized in <pre>:', text.length, 'chars');
        }
      }
    });

    // Method 2: Look for common lyrics container classes
    const lyricsSelectors = [
      '.lyrics', '.lyrics-body', '.lyrics-text', '.song-lyrics',
      '.entry-content .su-column', '.entry-content .wp-block-column',
      '[class*="lyrics"]', '[id*="lyrics"]'
    ];

    for (const selector of lyricsSelectors) {
      if (romanizedLyrics && hindiLyrics) break;

      $(selector).each((i, el) => {
        const elHtml = $(el).html();
        if (!elHtml) return;

        const text = cleanLyricsHtml(elHtml);
        if (text.length < 100) return;

        const hasDevanagari = /[\u0900-\u097F]/.test(text);
        if (hasDevanagari && !hindiLyrics) {
          hindiLyrics = text;
          console.log(`[LYRICSMINT] Found Hindi via ${selector}:`, text.length, 'chars');
        } else if (!hasDevanagari && !romanizedLyrics) {
          romanizedLyrics = text;
          console.log(`[LYRICSMINT] Found romanized via ${selector}:`, text.length, 'chars');
        }
      });
    }

    // Method 3: LyricsMint often uses columns - look for side-by-side Hindi/English
    $('.su-row .su-column, .wp-block-columns .wp-block-column, .row .col, .columns .column').each((i, el) => {
      const elHtml = $(el).html();
      if (!elHtml) return;

      const text = cleanLyricsHtml(elHtml);
      if (text.length < 100) return;

      const hasDevanagari = /[\u0900-\u097F]/.test(text);
      if (hasDevanagari && !hindiLyrics) {
        hindiLyrics = text;
        console.log('[LYRICSMINT] Found Hindi in column:', text.length, 'chars');
      } else if (!hasDevanagari && !romanizedLyrics) {
        romanizedLyrics = text;
        console.log('[LYRICSMINT] Found romanized in column:', text.length, 'chars');
      }
    });

    // Method 4: Get all paragraphs in entry-content and look for lyrics patterns
    if (!romanizedLyrics || !hindiLyrics) {
      const content = $('.entry-content, .post-content, article .content, main').first();

      if (content.length) {
        // Get all text blocks that contain line breaks (lyrics have many short lines)
        const blocks = [];

        content.find('p, div').each((i, el) => {
          const elHtml = $(el).html() || '';
          // Skip if it's a container with children we already processed
          if ($(el).children('p, div').length > 2) return;

          const text = cleanLyricsHtml(elHtml);
          // Lyrics typically have multiple lines
          const lineCount = text.split('\n').filter(l => l.trim()).length;

          if (text.length > 100 && lineCount >= 4) {
            blocks.push({ text, hasDevanagari: /[\u0900-\u097F]/.test(text) });
          }
        });

        // Sort by length (longer = more likely to be full lyrics)
        blocks.sort((a, b) => b.text.length - a.text.length);

        for (const block of blocks) {
          if (block.hasDevanagari && !hindiLyrics) {
            hindiLyrics = block.text;
            console.log('[LYRICSMINT] Found Hindi in content block:', block.text.length, 'chars');
          } else if (!block.hasDevanagari && !romanizedLyrics) {
            romanizedLyrics = block.text;
            console.log('[LYRICSMINT] Found romanized in content block:', block.text.length, 'chars');
          }

          if (romanizedLyrics && hindiLyrics) break;
        }
      }
    }

    // Method 5: Last resort - get ALL text from entry-content and split by script type
    if (!romanizedLyrics && !hindiLyrics) {
      const content = $('.entry-content').first();
      const fullHtml = content.html() || '';
      const fullText = cleanLyricsHtml(fullHtml);

      if (fullText.length > 200) {
        // Split lines by script
        const lines = fullText.split('\n');
        const hindiLines = [];
        const romanLines = [];

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.length < 3) continue;

          // Skip metadata
          if (/^(singer|music|lyrics|movie|album|label|composer|director|starring)[:\s]/i.test(trimmed)) continue;

          const hasDevanagari = /[\u0900-\u097F]/.test(trimmed);
          if (hasDevanagari) {
            hindiLines.push(trimmed);
          } else if (/^[a-zA-Z]/.test(trimmed)) {
            romanLines.push(trimmed);
          }
        }

        if (hindiLines.length > 5) {
          hindiLyrics = hindiLines.join('\n');
          console.log('[LYRICSMINT] Extracted Hindi lines:', hindiLyrics.length, 'chars');
        }
        if (romanLines.length > 5) {
          romanizedLyrics = romanLines.join('\n');
          console.log('[LYRICSMINT] Extracted romanized lines:', romanizedLyrics.length, 'chars');
        }
      }
    }

    // Debug: if still low chars, dump what we found
    if ((!romanizedLyrics || romanizedLyrics.length < 200) && (!hindiLyrics || hindiLyrics.length < 200)) {
      console.log('[LYRICSMINT] WARNING: Low lyrics extracted');
      console.log('[LYRICSMINT] DEBUG: Entry content classes:', $('.entry-content').attr('class'));
      console.log('[LYRICSMINT] DEBUG: First 500 chars of entry-content:');
      console.log($('.entry-content').text().substring(0, 500));
    }

    if (!romanizedLyrics && !hindiLyrics) {
      console.log('[LYRICSMINT] Could not extract lyrics');
      return null;
    }

    // Clean up the extracted lyrics
    romanizedLyrics = romanizedLyrics ? cleanLyrics(romanizedLyrics) : null;
    hindiLyrics = hindiLyrics ? cleanLyrics(hindiLyrics) : null;

    console.log('[LYRICSMINT] Final romanized:', romanizedLyrics ? romanizedLyrics.length + ' chars' : 'none');
    console.log('[LYRICSMINT] Final Hindi:', hindiLyrics ? hindiLyrics.length + ' chars' : 'none');

    return {
      romanizedLyrics,
      hindiLyrics
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
