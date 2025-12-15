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
      model: 'llama-3.3-70b-versatile',
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
    $('script, style, noscript, nav, header, footer, .sidebar, .comments, .share-buttons, .ad').remove();

    let romanizedLyrics = '';
    let hindiLyrics = '';

    // PRIMARY METHOD: LyricsMint uses tabs.panel for lyrics content
    const lyricsPanel = $('div[data-target="tabs.panel"]').first();

    if (lyricsPanel.length) {
      console.log('[LYRICSMINT] Found tabs.panel container');

      // Get the text container inside
      const textContainer = lyricsPanel.find('div.text-base, div[class*="text-base"]').first();

      if (textContainer.length) {
        console.log('[LYRICSMINT] Found text-base container');

        // Get all paragraphs and extract text
        const paragraphs = textContainer.find('p');
        const lines = [];

        paragraphs.each((i, p) => {
          // Get HTML and convert <br> to newlines
          const pHtml = $(p).html() || '';
          const pText = pHtml
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/[""]|&ldquo;|&rdquo;/g, '"')
            .replace(/['']|&lsquo;|&rsquo;/g, "'")
            .trim();

          if (pText.length > 0) {
            lines.push(pText);
          }
        });

        const extractedText = lines.join('\n\n');
        console.log('[LYRICSMINT] Extracted from tabs.panel:', extractedText.length, 'chars');

        // Check if it's Devanagari or Romanized
        const hasDevanagari = /[\u0900-\u097F]/.test(extractedText);

        if (hasDevanagari) {
          hindiLyrics = extractedText;
        } else {
          romanizedLyrics = extractedText;
        }
      }
    }

    // If tabs.panel didn't work, try other methods
    if (!romanizedLyrics && !hindiLyrics) {
      console.log('[LYRICSMINT] tabs.panel method failed, trying alternatives...');

      // Method 2: Look for entry-content with multiple <p> tags containing <br>
      const entryContent = $('.entry-content').first();

      if (entryContent.length) {
        const paragraphs = entryContent.find('p');
        const lyricsLines = [];

        paragraphs.each((i, p) => {
          const pHtml = $(p).html() || '';

          // Lyrics paragraphs typically have <br> tags
          if (pHtml.includes('<br')) {
            const pText = pHtml
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<[^>]+>/g, '')
              .replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/[""]|&ldquo;|&rdquo;/g, '"')
              .replace(/['']|&lsquo;|&rsquo;/g, "'")
              .trim();

            // Skip metadata paragraphs
            if (pText.length > 20 && !/^(singer|music|lyrics|movie|album)[:\s]/i.test(pText)) {
              lyricsLines.push(pText);
            }
          }
        });

        if (lyricsLines.length > 0) {
          const extractedText = lyricsLines.join('\n\n');
          console.log('[LYRICSMINT] Extracted from entry-content:', extractedText.length, 'chars');

          const hasDevanagari = /[\u0900-\u097F]/.test(extractedText);
          if (hasDevanagari) {
            hindiLyrics = extractedText;
          } else {
            romanizedLyrics = extractedText;
          }
        }
      }
    }

    // Method 3: Check if there are multiple tabs (Hindi / English tabs)
    if (!hindiLyrics || !romanizedLyrics) {
      const allPanels = $('div[data-target="tabs.panel"]');

      if (allPanels.length > 1) {
        console.log('[LYRICSMINT] Found multiple tabs:', allPanels.length);

        allPanels.each((i, panel) => {
          const textContainer = $(panel).find('div.text-base, div[class*="text-base"]').first();
          if (!textContainer.length) return;

          const paragraphs = textContainer.find('p');
          const lines = [];

          paragraphs.each((j, p) => {
            const pHtml = $(p).html() || '';
            const pText = pHtml
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<[^>]+>/g, '')
              .replace(/[""]|&ldquo;|&rdquo;/g, '"')
              .replace(/['']|&lsquo;|&rsquo;/g, "'")
              .trim();

            if (pText.length > 0) lines.push(pText);
          });

          const text = lines.join('\n\n');
          if (text.length < 50) return;

          const hasDevanagari = /[\u0900-\u097F]/.test(text);

          if (hasDevanagari && !hindiLyrics) {
            hindiLyrics = text;
            console.log('[LYRICSMINT] Found Hindi in tab', i, ':', text.length, 'chars');
          } else if (!hasDevanagari && !romanizedLyrics) {
            romanizedLyrics = text;
            console.log('[LYRICSMINT] Found romanized in tab', i, ':', text.length, 'chars');
          }
        });
      }
    }

    // Clean up the extracted lyrics
    if (romanizedLyrics) {
      romanizedLyrics = cleanLyrics(romanizedLyrics);
    }
    if (hindiLyrics) {
      hindiLyrics = cleanLyrics(hindiLyrics);
    }

    console.log('[LYRICSMINT] Final romanized:', romanizedLyrics ? romanizedLyrics.length + ' chars' : 'none');
    console.log('[LYRICSMINT] Final Hindi:', hindiLyrics ? hindiLyrics.length + ' chars' : 'none');

    // Debug if extraction is still low
    if ((!romanizedLyrics || romanizedLyrics.length < 200) && (!hindiLyrics || hindiLyrics.length < 200)) {
      console.log('[LYRICSMINT] WARNING: Low lyrics count. Debug info:');
      console.log('[LYRICSMINT] tabs.panel count:', $('div[data-target="tabs.panel"]').length);
      console.log('[LYRICSMINT] text-base divs:', $('div.text-base').length);
      console.log('[LYRICSMINT] p tags in entry-content:', $('.entry-content p').length);
    }

    if (!romanizedLyrics && !hindiLyrics) {
      console.log('[LYRICSMINT] Could not extract lyrics');
      return null;
    }

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
 * Clean lyrics text
 */
function cleanLyrics(text) {
  if (!text) return '';

  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => {
      if (line.length < 2) return false;
      // Remove metadata lines
      if (/^(singer|music|lyrics|composer|movie|album|label|starring|director)[:\s]/i.test(line)) return false;
      if (/^(copyright|all rights|share this|click here)/i.test(line)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')  // Max 2 newlines
    .trim();
}

/**
 * Clean lyrics HTML to text (legacy helper)
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
