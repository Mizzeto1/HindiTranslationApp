/**
 * LyricsMint Scraper
 * Searches and scrapes lyrics from lyricsmint.com
 * Uses Google/DuckDuckGo search since LyricsMint's own search is broken
 * Extracts romanized Hindi lyrics (Hindi written in English letters)
 */

const cheerio = require('cheerio');

// Rate limiting
let lastRequestTime = 0;
const MIN_INTERVAL = 1200; // 1.2 seconds between requests

async function rateLimitedFetch(url, customHeaders = {}) {
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
      'Accept-Language': 'en-US,en;q=0.5',
      ...customHeaders
    },
    timeout: 15000
  });

  return response;
}

/**
 * Check if URL is a valid lyrics page
 */
function isValidLyricsUrl(href) {
  if (!href) return false;
  if (!href.includes('lyricsmint.com')) return false;

  // Reject homepage
  if (href.match(/^https?:\/\/(www\.)?lyricsmint\.com\/?$/)) {
    return false;
  }

  // Reject utility pages
  const rejectPatterns = [
    '/category/', '/tag/', '/author/', '/page/',
    '/wp-content/', '/wp-admin/', '/feed/',
    '/contact', '/about', '/privacy', '/terms',
    '/search', '/?s='
  ];

  for (const pattern of rejectPatterns) {
    if (href.includes(pattern)) return false;
  }

  // Must have artist/song structure (at least 2 path segments)
  const pathMatch = href.match(/lyricsmint\.com\/([^\/]+)\/([^\/]+)/);
  if (pathMatch) {
    return true;
  }

  return false;
}

/**
 * Try to construct LyricsMint URL directly
 * URL pattern: lyricsmint.com/artist-name/song-name
 */
async function tryDirectUrl(songTitle, artistName) {
  if (!artistName) {
    console.log('[LYRICSMINT] No artist name for direct URL');
    return null;
  }

  const artistSlug = artistName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 50);

  const songSlug = songTitle
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 50);

  const directUrl = `https://www.lyricsmint.com/${artistSlug}/${songSlug}`;
  console.log('[LYRICSMINT] Trying direct URL:', directUrl);

  try {
    const response = await fetch(directUrl, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (response.ok) {
      console.log('[LYRICSMINT] Direct URL exists!');
      return directUrl;
    } else {
      console.log('[LYRICSMINT] Direct URL returned:', response.status);
    }
  } catch (e) {
    console.log('[LYRICSMINT] Direct URL check failed:', e.message);
  }

  return null;
}

/**
 * Search using Google
 */
async function searchWithGoogle(songTitle, artistName) {
  try {
    const cleanTitle = songTitle
      .replace(/["'"]/g, '')
      .replace(/\s*\(.*?\)\s*/g, '')
      .replace(/\s*\|.*$/g, '')
      .trim();

    const query = `${cleanTitle} ${artistName || ''} lyrics site:lyricsmint.com`.trim();
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

    console.log('[LYRICSMINT] Google search:', query);

    const response = await fetch(googleUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    });

    if (!response.ok) {
      console.log('[LYRICSMINT] Google search failed:', response.status);
      return null;
    }

    const html = await response.text();
    console.log('[LYRICSMINT] Google response length:', html.length);

    // Check if Google is blocking us
    if (html.includes('detected unusual traffic') || html.includes('captcha') || html.includes('CAPTCHA')) {
      console.log('[LYRICSMINT] Google is blocking automated requests');
      return null;
    }

    // Extract LyricsMint URLs from Google results
    const lyricsMintUrls = [];

    // Pattern 1: Direct href links
    const hrefPattern = /href="(https?:\/\/(www\.)?lyricsmint\.com\/[^"]+)"/gi;
    let match;
    while ((match = hrefPattern.exec(html)) !== null) {
      const url = match[1];
      if (isValidLyricsUrl(url)) {
        lyricsMintUrls.push(url);
      }
    }

    // Pattern 2: URL in Google's redirect format /url?q=...
    const redirectPattern = /\/url\?q=(https?:\/\/(www\.)?lyricsmint\.com\/[^&"]+)/gi;
    while ((match = redirectPattern.exec(html)) !== null) {
      const url = decodeURIComponent(match[1]);
      if (isValidLyricsUrl(url)) {
        lyricsMintUrls.push(url);
      }
    }

    // Pattern 3: Plain text URLs in the page
    const plainPattern = /(https?:\/\/(www\.)?lyricsmint\.com\/[a-z0-9-]+\/[a-z0-9-]+)/gi;
    while ((match = plainPattern.exec(html)) !== null) {
      const url = match[1];
      if (isValidLyricsUrl(url)) {
        lyricsMintUrls.push(url);
      }
    }

    // Remove duplicates
    const uniqueUrls = [...new Set(lyricsMintUrls)];

    console.log('[LYRICSMINT] Found URLs from Google:', uniqueUrls.length);
    uniqueUrls.slice(0, 3).forEach((url, i) => {
      console.log(`[LYRICSMINT]   ${i + 1}. ${url}`);
    });

    if (uniqueUrls.length > 0) {
      return uniqueUrls[0];
    }

    return null;

  } catch (error) {
    console.error('[LYRICSMINT] Google search error:', error.message);
    return null;
  }
}

/**
 * Search using DuckDuckGo (fallback, less likely to block)
 */
async function searchWithDuckDuckGo(songTitle, artistName) {
  try {
    const cleanTitle = songTitle
      .replace(/["'"]/g, '')
      .replace(/\s*\(.*?\)\s*/g, '')
      .replace(/\s*\|.*$/g, '')
      .trim();

    const query = `${cleanTitle} ${artistName || ''} lyrics site:lyricsmint.com`.trim();
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    console.log('[LYRICSMINT] DuckDuckGo search:', query);

    const response = await fetch(ddgUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      console.log('[LYRICSMINT] DuckDuckGo search failed:', response.status);
      return null;
    }

    const html = await response.text();
    console.log('[LYRICSMINT] DuckDuckGo response length:', html.length);

    const $ = cheerio.load(html);
    let foundUrl = null;

    // DuckDuckGo HTML results have links in result__url class or result__a
    $('.result__url, .result__a, .result a').each((i, el) => {
      const href = $(el).attr('href');
      const text = $(el).text();

      // Check href first
      if (href && href.includes('lyricsmint.com') && isValidLyricsUrl(href)) {
        console.log('[LYRICSMINT] Found in DDG href:', href);
        foundUrl = href;
        return false;
      }

      // Check text content (DDG sometimes shows URL as text)
      if (text && text.includes('lyricsmint.com')) {
        const urlMatch = text.match(/(https?:\/\/)?(www\.)?lyricsmint\.com\/[a-z0-9-]+\/[a-z0-9-]+/i);
        if (urlMatch) {
          let url = urlMatch[0];
          if (!url.startsWith('http')) {
            url = 'https://' + url;
          }
          if (isValidLyricsUrl(url)) {
            console.log('[LYRICSMINT] Found in DDG text:', url);
            foundUrl = url;
            return false;
          }
        }
      }
    });

    // Also search in raw HTML for URLs
    if (!foundUrl) {
      const urlPattern = /(https?:\/\/(www\.)?lyricsmint\.com\/[a-z0-9-]+\/[a-z0-9-]+)/gi;
      let match;
      while ((match = urlPattern.exec(html)) !== null) {
        if (isValidLyricsUrl(match[1])) {
          console.log('[LYRICSMINT] Found in DDG raw HTML:', match[1]);
          foundUrl = match[1];
          break;
        }
      }
    }

    return foundUrl;

  } catch (error) {
    console.error('[LYRICSMINT] DuckDuckGo search error:', error.message);
    return null;
  }
}

/**
 * Main search function - tries multiple methods with verbose logging
 */
async function searchLyricsMint(songTitle, artistName) {
  console.log('[LYRICSMINT] ============ SEARCH START ============');
  console.log('[LYRICSMINT] Input songTitle:', songTitle);
  console.log('[LYRICSMINT] Input artistName:', artistName);

  try {
    // Clean song title
    const cleanTitle = songTitle
      .replace(/["'"]/g, '')
      .replace(/\s*\(.*?\)\s*/g, '')
      .replace(/\s*\|.*$/g, '')
      .trim();

    console.log('[LYRICSMINT] Cleaned title:', cleanTitle);

    // Try Google search
    console.log('[LYRICSMINT] Attempting Google search...');

    const query = `${cleanTitle} ${artistName || ''} lyrics site:lyricsmint.com`.trim();
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

    console.log('[LYRICSMINT] Google query:', query);
    console.log('[LYRICSMINT] Google URL:', googleUrl);

    let response;
    try {
      response = await fetch(googleUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html',
          'Accept-Language': 'en-US,en;q=0.5'
        }
      });
      console.log('[LYRICSMINT] Google response status:', response.status);
    } catch (fetchError) {
      console.log('[LYRICSMINT] Google fetch FAILED:', fetchError.message);
    }

    if (response && response.ok) {
      const html = await response.text();
      console.log('[LYRICSMINT] Google HTML length:', html.length);

      // Check for blocking
      if (html.includes('unusual traffic') || html.includes('captcha') || html.includes('CAPTCHA')) {
        console.log('[LYRICSMINT] Google is BLOCKING us (captcha/unusual traffic)');
      } else {
        // Look for lyricsmint URLs
        const urlPattern = /(https?:\/\/(www\.)?lyricsmint\.com\/[a-z0-9-]+\/[a-z0-9-]+)/gi;
        const matches = html.match(urlPattern) || [];
        const uniqueMatches = [...new Set(matches)].filter(url => isValidLyricsUrl(url));

        console.log('[LYRICSMINT] Found lyricsmint URLs:', uniqueMatches.length);
        uniqueMatches.slice(0, 5).forEach((url, i) => {
          console.log(`[LYRICSMINT]   ${i + 1}. ${url}`);
        });

        if (uniqueMatches.length > 0) {
          console.log('[LYRICSMINT] Using first match:', uniqueMatches[0]);
          console.log('[LYRICSMINT] ============ SEARCH END ============');
          return uniqueMatches[0];
        }
      }
    }

    // Fallback: Try DuckDuckGo
    console.log('[LYRICSMINT] Trying DuckDuckGo fallback...');

    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    console.log('[LYRICSMINT] DuckDuckGo URL:', ddgUrl);

    try {
      const ddgResponse = await fetch(ddgUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      console.log('[LYRICSMINT] DuckDuckGo response status:', ddgResponse.status);

      if (ddgResponse.ok) {
        const ddgHtml = await ddgResponse.text();
        console.log('[LYRICSMINT] DuckDuckGo HTML length:', ddgHtml.length);

        const ddgMatches = (ddgHtml.match(/(https?:\/\/(www\.)?lyricsmint\.com\/[a-z0-9-]+\/[a-z0-9-]+)/gi) || [])
          .filter(url => isValidLyricsUrl(url));
        console.log('[LYRICSMINT] DuckDuckGo found URLs:', ddgMatches.length);

        if (ddgMatches.length > 0) {
          console.log('[LYRICSMINT] Using DuckDuckGo result:', ddgMatches[0]);
          console.log('[LYRICSMINT] ============ SEARCH END ============');
          return ddgMatches[0];
        }
      }
    } catch (ddgError) {
      console.log('[LYRICSMINT] DuckDuckGo FAILED:', ddgError.message);
    }

    // Last fallback: Direct URL construction
    console.log('[LYRICSMINT] Trying direct URL construction...');

    const artistSlug = (artistName || 'unknown')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '');

    const songSlug = cleanTitle
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '');

    console.log('[LYRICSMINT] Artist slug:', artistSlug);
    console.log('[LYRICSMINT] Song slug:', songSlug);

    const directUrl = `https://www.lyricsmint.com/${artistSlug}/${songSlug}`;
    console.log('[LYRICSMINT] Direct URL:', directUrl);

    try {
      const directResponse = await fetch(directUrl, {
        method: 'HEAD',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      console.log('[LYRICSMINT] Direct URL status:', directResponse.status);

      if (directResponse.ok) {
        console.log('[LYRICSMINT] Direct URL EXISTS!');
        console.log('[LYRICSMINT] ============ SEARCH END ============');
        return directUrl;
      }
    } catch (directError) {
      console.log('[LYRICSMINT] Direct URL check FAILED:', directError.message);
    }

    console.log('[LYRICSMINT] All methods failed - no lyrics URL found');
    console.log('[LYRICSMINT] ============ SEARCH END ============');
    return null;

  } catch (error) {
    console.log('[LYRICSMINT] FATAL ERROR:', error.message);
    console.log('[LYRICSMINT] Stack:', error.stack);
    console.log('[LYRICSMINT] ============ SEARCH END ============');
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

module.exports = {
  fetchLyrics,
  searchLyricsMint,
  scrapeLyricsPage,
  tryDirectUrl,
  isValidLyricsUrl,
  searchWithGoogle,
  searchWithDuckDuckGo
};
