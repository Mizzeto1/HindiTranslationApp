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

  // Must have artist/song pattern
  const pattern = /lyricsmint\.com\/[a-z0-9_-]+\/[a-z0-9_-]+/i;
  if (!pattern.test(href)) return false;

  // Reject utility pages
  const rejectPatterns = [
    '/category/', '/tag/', '/author/', '/page/',
    '/wp-content/', '/wp-admin/', '/feed/',
    '/contact', '/about', '/privacy', '/terms',
    '/search', '/?s='
  ];

  for (const reject of rejectPatterns) {
    if (href.includes(reject)) return false;
  }

  return true;
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
 * Uses multiple URL extraction methods to handle Google's encoding
 */
async function searchLyricsMint(songTitle, artistName) {
  console.log('[LYRICSMINT] ============ SEARCH START ============');
  console.log('[LYRICSMINT] Input songTitle:', songTitle);
  console.log('[LYRICSMINT] Input artistName:', artistName);

  try {
    // Clean song title
    const cleanTitle = songTitle
      .replace(/["'"]/g, '')
      .replace(/\s*\(From\s+["']?[^)]+["']?\)\s*/gi, '')  // Remove (From "Movie")
      .replace(/\s*\(.*?\)\s*/g, '')
      .replace(/\s*\|.*$/g, '')
      .replace(/\s*-\s*$/, '')
      .trim();

    console.log('[LYRICSMINT] Cleaned title:', cleanTitle);

    // Build Google search query
    const query = `${cleanTitle} lyrics site:lyricsmint.com`;
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

    console.log('[LYRICSMINT] Google URL:', googleUrl);

    const response = await fetch(googleUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    console.log('[LYRICSMINT] Google response status:', response.status);

    if (!response.ok) {
      console.log('[LYRICSMINT] Google request failed');
      return await tryDuckDuckGoSearch(cleanTitle);
    }

    const html = await response.text();
    console.log('[LYRICSMINT] Google HTML length:', html.length);

    // Check for blocking
    if (html.includes('unusual traffic') || html.includes('captcha') || html.includes('CAPTCHA')) {
      console.log('[LYRICSMINT] Google is blocking (captcha)');
      return await tryDuckDuckGoSearch(cleanTitle);
    }

    // Extract URLs using multiple methods
    const foundUrls = new Set();

    // Method 1: Look for /url?q= redirects (URL encoded)
    const redirectPattern = /\/url\?q=(https?[^&"]+lyricsmint\.com[^&"]*)/gi;
    let match;
    while ((match = redirectPattern.exec(html)) !== null) {
      try {
        const decoded = decodeURIComponent(match[1]);
        if (isValidLyricsUrl(decoded)) {
          console.log('[LYRICSMINT] Found via /url?q=:', decoded);
          foundUrls.add(decoded);
        }
      } catch (e) {}
    }

    // Method 2: Look for URL-encoded lyricsmint URLs
    const encodedPattern = /https?%3A%2F%2F(?:www\.)?lyricsmint\.com%2F[a-zA-Z0-9%_-]+%2F[a-zA-Z0-9%_-]+/gi;
    while ((match = encodedPattern.exec(html)) !== null) {
      try {
        const decoded = decodeURIComponent(match[0]);
        if (isValidLyricsUrl(decoded)) {
          console.log('[LYRICSMINT] Found URL-encoded:', decoded);
          foundUrls.add(decoded);
        }
      } catch (e) {}
    }

    // Method 3: Look for plain URLs (less likely but try anyway)
    const plainPattern = /https?:\/\/(?:www\.)?lyricsmint\.com\/[a-z0-9_-]+\/[a-z0-9_-]+/gi;
    while ((match = plainPattern.exec(html)) !== null) {
      if (isValidLyricsUrl(match[0])) {
        console.log('[LYRICSMINT] Found plain URL:', match[0]);
        foundUrls.add(match[0]);
      }
    }

    // Method 4: Look for lyricsmint.com anywhere and extract path
    const domainPattern = /lyricsmint\.com\/([a-zA-Z0-9%_-]+)\/([a-zA-Z0-9%_-]+)/gi;
    while ((match = domainPattern.exec(html)) !== null) {
      try {
        const artist = decodeURIComponent(match[1]);
        const song = decodeURIComponent(match[2]);
        const url = `https://www.lyricsmint.com/${artist}/${song}`;
        if (isValidLyricsUrl(url)) {
          console.log('[LYRICSMINT] Found via domain pattern:', url);
          foundUrls.add(url);
        }
      } catch (e) {}
    }

    // Method 5: Parse with Cheerio and look for href attributes
    const $ = cheerio.load(html);

    $('a[href*="lyricsmint"]').each((i, el) => {
      let href = $(el).attr('href');
      if (href) {
        // Handle Google redirect URLs
        if (href.startsWith('/url?')) {
          const urlParams = new URLSearchParams(href.substring(5));
          href = urlParams.get('q') || href;
        }
        try {
          href = decodeURIComponent(href);
        } catch (e) {}

        if (isValidLyricsUrl(href)) {
          console.log('[LYRICSMINT] Found via Cheerio href:', href);
          foundUrls.add(href);
        }
      }
    });

    // Also check cite/span elements (Google shows URLs in these)
    $('cite, span').each((i, el) => {
      const text = $(el).text();
      if (text.includes('lyricsmint.com/')) {
        const urlMatch = text.match(/lyricsmint\.com\/([a-z0-9-]+)\/([a-z0-9-]+)/i);
        if (urlMatch) {
          const url = `https://www.lyricsmint.com/${urlMatch[1]}/${urlMatch[2]}`;
          console.log('[LYRICSMINT] Found in cite/span text:', url);
          foundUrls.add(url);
        }
      }
    });

    console.log('[LYRICSMINT] Total unique URLs found:', foundUrls.size);

    if (foundUrls.size > 0) {
      const urlArray = Array.from(foundUrls);
      urlArray.forEach((url, i) => console.log(`[LYRICSMINT]   ${i + 1}. ${url}`));

      // Return the first valid URL
      for (const url of urlArray) {
        // Verify URL actually exists with HEAD request
        try {
          const checkResponse = await fetch(url, {
            method: 'HEAD',
            headers: { 'User-Agent': 'Mozilla/5.0' }
          });
          if (checkResponse.ok) {
            console.log('[LYRICSMINT] Verified URL exists:', url);
            console.log('[LYRICSMINT] ============ SEARCH END ============');
            return url;
          } else {
            console.log('[LYRICSMINT] URL returned', checkResponse.status, ':', url);
          }
        } catch (e) {
          console.log('[LYRICSMINT] Could not verify URL:', url);
        }
      }

      // If verification failed, return first URL anyway
      console.log('[LYRICSMINT] Returning first URL without verification:', urlArray[0]);
      console.log('[LYRICSMINT] ============ SEARCH END ============');
      return urlArray[0];
    }

    // Debug: dump a sample of the HTML to see what we're getting
    console.log('[LYRICSMINT] DEBUG - Sample of Google HTML (first 2000 chars):');
    console.log(html.substring(0, 2000));

    // Fallback to DuckDuckGo
    console.log('[LYRICSMINT] No URLs found in Google, trying DuckDuckGo...');
    return await tryDuckDuckGoSearch(cleanTitle);

  } catch (error) {
    console.error('[LYRICSMINT] Search error:', error.message);
    console.log('[LYRICSMINT] ============ SEARCH END ============');
    return null;
  }
}

/**
 * DuckDuckGo search fallback
 */
async function tryDuckDuckGoSearch(searchTerm) {
  try {
    const query = `${searchTerm} lyrics site:lyricsmint.com`;
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    console.log('[LYRICSMINT] DuckDuckGo URL:', ddgUrl);

    const response = await fetch(ddgUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    console.log('[LYRICSMINT] DuckDuckGo status:', response.status);

    if (!response.ok) {
      console.log('[LYRICSMINT] ============ SEARCH END ============');
      return null;
    }

    const html = await response.text();
    console.log('[LYRICSMINT] DuckDuckGo HTML length:', html.length);

    const $ = cheerio.load(html);

    // DuckDuckGo shows URLs in result__url class or result links
    let foundUrl = null;

    // Check result links
    $('.result__a, .result__url, a[href*="lyricsmint"]').each((i, el) => {
      let href = $(el).attr('href');
      const text = $(el).text();

      // DuckDuckGo sometimes has the URL in text
      if (text.includes('lyricsmint.com/')) {
        const match = text.match(/lyricsmint\.com\/([a-z0-9-]+)\/([a-z0-9-]+)/i);
        if (match) {
          foundUrl = `https://www.lyricsmint.com/${match[1]}/${match[2]}`;
          console.log('[LYRICSMINT] DuckDuckGo found in text:', foundUrl);
          return false;
        }
      }

      // Check href
      if (href && href.includes('lyricsmint.com')) {
        // DuckDuckGo uses redirect URLs
        if (href.includes('uddg=')) {
          const uddgMatch = href.match(/uddg=([^&]+)/);
          if (uddgMatch) {
            href = decodeURIComponent(uddgMatch[1]);
          }
        }

        if (isValidLyricsUrl(href)) {
          foundUrl = href;
          console.log('[LYRICSMINT] DuckDuckGo found URL:', foundUrl);
          return false;
        }
      }
    });

    console.log('[LYRICSMINT] ============ SEARCH END ============');
    return foundUrl;

  } catch (error) {
    console.error('[LYRICSMINT] DuckDuckGo error:', error.message);
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
  tryDuckDuckGoSearch
};
