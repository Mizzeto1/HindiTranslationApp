/**
 * Lyrics Service
 *
 * Fetches song lyrics from various sources:
 * 1. Local cache (JSON file)
 * 2. Musixmatch API (if API key provided)
 * 3. Web scraping from lyrics sites (if enabled)
 *
 * Falls back to Groq transcription if lyrics not found.
 */

const fs = require('fs').promises;
const path = require('path');
const cheerio = require('cheerio');

// Path to lyrics cache file
const CACHE_FILE = path.join(__dirname, '..', 'data', 'lyrics-cache.json');

// Musixmatch API base URL
const MUSIXMATCH_API_BASE = 'https://api.musixmatch.com/ws/1.1';

/**
 * Ensure the cache file exists
 */
async function ensureCacheFile() {
  const dataDir = path.dirname(CACHE_FILE);

  try {
    await fs.access(dataDir);
  } catch {
    await fs.mkdir(dataDir, { recursive: true });
    console.log('[LYRICS] Created data directory');
  }

  try {
    await fs.access(CACHE_FILE);
  } catch {
    await fs.writeFile(CACHE_FILE, JSON.stringify({}, null, 2));
    console.log('[LYRICS] Created lyrics cache file');
  }
}

/**
 * Load lyrics cache
 * @returns {Promise<Object>}
 */
async function loadCache() {
  await ensureCacheFile();
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('[LYRICS] Error loading cache:', error.message);
    return {};
  }
}

/**
 * Save lyrics to cache
 * @param {Object} cache - The cache object
 */
async function saveCache(cache) {
  await ensureCacheFile();
  try {
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (error) {
    console.error('[LYRICS] Error saving cache:', error.message);
  }
}

/**
 * Generate cache key from title and artist
 * @param {string} title
 * @param {string} artist
 * @returns {string}
 */
function getCacheKey(title, artist) {
  const normalize = (str) => str.toLowerCase().trim().replace(/[^a-z0-9\s]/gi, '').replace(/\s+/g, '_');
  return `${normalize(artist)}|${normalize(title)}`;
}

/**
 * Check local cache for lyrics
 * @param {string} title
 * @param {string} artist
 * @returns {Promise<Object|null>}
 */
async function checkCache(title, artist) {
  const cache = await loadCache();
  const key = getCacheKey(title, artist);

  if (cache[key]) {
    console.log(`[LYRICS] Cache hit for: ${artist} - ${title}`);
    return cache[key];
  }

  console.log(`[LYRICS] Cache miss for: ${artist} - ${title}`);
  return null;
}

/**
 * Save lyrics to local cache
 * @param {string} title
 * @param {string} artist
 * @param {string} lyrics
 * @param {string} source
 */
async function saveToCache(title, artist, lyrics, source) {
  const cache = await loadCache();
  const key = getCacheKey(title, artist);

  cache[key] = {
    title,
    artist,
    lyrics,
    source,
    fetched_at: new Date().toISOString()
  };

  await saveCache(cache);
  console.log(`[LYRICS] Saved to cache: ${artist} - ${title} (source: ${source})`);
}

/**
 * Fetch lyrics from Musixmatch API
 * @param {string} title
 * @param {string} artist
 * @returns {Promise<string|null>}
 */
async function fetchFromMusixmatch(title, artist) {
  const apiKey = process.env.MUSIXMATCH_API_KEY;

  if (!apiKey) {
    console.log('[LYRICS] Musixmatch API key not configured, skipping');
    return null;
  }

  try {
    console.log(`[LYRICS] Searching Musixmatch for: ${artist} - ${title}`);

    // Search for the track
    const searchUrl = `${MUSIXMATCH_API_BASE}/track.search?q_track=${encodeURIComponent(title)}&q_artist=${encodeURIComponent(artist)}&page_size=1&s_track_rating=desc&apikey=${apiKey}`;

    const searchResponse = await fetch(searchUrl);
    const searchData = await searchResponse.json();

    if (searchData.message.header.status_code !== 200) {
      console.log('[LYRICS] Musixmatch search failed:', searchData.message.header.status_code);
      return null;
    }

    const trackList = searchData.message.body.track_list;
    if (!trackList || trackList.length === 0) {
      console.log('[LYRICS] No tracks found on Musixmatch');
      return null;
    }

    const trackId = trackList[0].track.track_id;
    console.log(`[LYRICS] Found track ID: ${trackId}`);

    // Get lyrics for the track
    const lyricsUrl = `${MUSIXMATCH_API_BASE}/track.lyrics.get?track_id=${trackId}&apikey=${apiKey}`;

    const lyricsResponse = await fetch(lyricsUrl);
    const lyricsData = await lyricsResponse.json();

    if (lyricsData.message.header.status_code !== 200) {
      console.log('[LYRICS] Musixmatch lyrics fetch failed:', lyricsData.message.header.status_code);
      return null;
    }

    const lyrics = lyricsData.message.body.lyrics?.lyrics_body;
    if (!lyrics) {
      console.log('[LYRICS] No lyrics body in Musixmatch response');
      return null;
    }

    // Remove the Musixmatch watermark if present
    const cleanLyrics = lyrics.replace(/\*{7}.*$/s, '').trim();

    console.log(`[LYRICS] Found lyrics on Musixmatch (${cleanLyrics.length} chars)`);
    return cleanLyrics;

  } catch (error) {
    console.error('[LYRICS] Musixmatch error:', error.message);
    return null;
  }
}

/**
 * Scrape lyrics from LyricsMint (Hindi lyrics site)
 * Only runs if ENABLE_LYRICS_SCRAPING=true
 * @param {string} title
 * @param {string} artist
 * @returns {Promise<string|null>}
 */
async function scrapeFromLyricsMint(title, artist) {
  if (process.env.ENABLE_LYRICS_SCRAPING !== 'true') {
    console.log('[LYRICS] Web scraping disabled, skipping LyricsMint');
    return null;
  }

  try {
    console.log(`[LYRICS] Scraping LyricsMint for: ${artist} - ${title}`);

    // Format search query
    const query = `${title} ${artist} lyrics site:lyricsmint.com`;
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

    // Note: In production, you'd want to use a proper search or direct URL construction
    // For now, we'll try to construct a likely URL pattern
    const slug = title.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, '-');

    const lyricsUrl = `https://www.lyricsmint.com/${slug}-lyrics/`;

    console.log(`[LYRICS] Trying LyricsMint URL: ${lyricsUrl}`);

    const response = await fetch(lyricsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      console.log(`[LYRICS] LyricsMint returned ${response.status}`);
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // LyricsMint typically has lyrics in a div with class 'lyrics' or similar
    let lyrics = '';

    // Try different selectors
    const selectors = ['.lyrics', '.entry-content p', '.song-lyrics', '#lyrics'];

    for (const selector of selectors) {
      const element = $(selector);
      if (element.length > 0) {
        lyrics = element.text().trim();
        if (lyrics.length > 100) {
          break;
        }
      }
    }

    if (lyrics.length < 100) {
      console.log('[LYRICS] Could not extract meaningful lyrics from LyricsMint');
      return null;
    }

    console.log(`[LYRICS] Found lyrics on LyricsMint (${lyrics.length} chars)`);
    return lyrics;

  } catch (error) {
    console.error('[LYRICS] LyricsMint scraping error:', error.message);
    return null;
  }
}

/**
 * Parse YouTube video title to extract song info
 * Common formats:
 * - "Artist - Song Title"
 * - "Song Title | Artist"
 * - "Song Title (Official Video) - Artist"
 * - "Artist: Song Title"
 * @param {string} videoTitle
 * @returns {{title: string, artist: string}}
 */
function parseVideoTitle(videoTitle) {
  // Clean up common suffixes
  let cleaned = videoTitle
    .replace(/\(official\s*(music\s*)?video\)/gi, '')
    .replace(/\(official\s*audio\)/gi, '')
    .replace(/\(lyric\s*video\)/gi, '')
    .replace(/\(lyrics?\)/gi, '')
    .replace(/\[official\s*video\]/gi, '')
    .replace(/\|?\s*full\s*video/gi, '')
    .replace(/\|?\s*audio/gi, '')
    .replace(/ft\.?\s*[^-|]+/gi, '') // Remove featuring
    .replace(/feat\.?\s*[^-|]+/gi, '')
    .trim();

  // Try different separators
  const separators = [' - ', ' | ', ' : ', ' – ', ' — '];

  for (const sep of separators) {
    if (cleaned.includes(sep)) {
      const parts = cleaned.split(sep).map(p => p.trim());
      if (parts.length >= 2) {
        // First part is usually artist, second is song (or vice versa)
        return {
          artist: parts[0],
          title: parts.slice(1).join(' ')
        };
      }
    }
  }

  // If no separator found, use the whole thing as title with empty artist
  return {
    title: cleaned,
    artist: ''
  };
}

/**
 * Convert lyrics text to timestamped segments
 * Since we don't have actual timestamps, we estimate based on video duration
 * @param {string} lyrics
 * @param {number} durationSeconds - Video duration in seconds
 * @returns {Array}
 */
function lyricsToSegments(lyrics, durationSeconds) {
  // Split lyrics into lines, filter empty ones
  const lines = lyrics.split('\n').filter(line => line.trim().length > 0);

  if (lines.length === 0) {
    return [];
  }

  // Estimate time per line
  const timePerLine = durationSeconds / lines.length;

  return lines.map((line, index) => ({
    id: index,
    start: index * timePerLine,
    end: (index + 1) * timePerLine,
    text: line.trim()
  }));
}

/**
 * Main function to search for lyrics
 * @param {string} videoTitle - YouTube video title
 * @param {number} durationSeconds - Video duration
 * @returns {Promise<{found: boolean, segments: Array, source: string}>}
 */
async function searchLyrics(videoTitle, durationSeconds) {
  console.log(`[LYRICS] Searching lyrics for: "${videoTitle}"`);

  // Parse video title to get song info
  const { title, artist } = parseVideoTitle(videoTitle);
  console.log(`[LYRICS] Parsed: artist="${artist}", title="${title}"`);

  // 1. Check local cache
  const cached = await checkCache(title, artist);
  if (cached) {
    const segments = lyricsToSegments(cached.lyrics, durationSeconds);
    return {
      found: true,
      segments,
      source: 'cache',
      originalSource: cached.source
    };
  }

  // 2. Try Musixmatch API
  const musixmatchLyrics = await fetchFromMusixmatch(title, artist);
  if (musixmatchLyrics) {
    await saveToCache(title, artist, musixmatchLyrics, 'musixmatch');
    const segments = lyricsToSegments(musixmatchLyrics, durationSeconds);
    return {
      found: true,
      segments,
      source: 'musixmatch'
    };
  }

  // 3. Try web scraping (if enabled)
  const scrapedLyrics = await scrapeFromLyricsMint(title, artist);
  if (scrapedLyrics) {
    await saveToCache(title, artist, scrapedLyrics, 'lyricsmint');
    const segments = lyricsToSegments(scrapedLyrics, durationSeconds);
    return {
      found: true,
      segments,
      source: 'lyricsmint'
    };
  }

  // 4. Not found - will need to use Groq fallback
  console.log('[LYRICS] No lyrics found, will use Groq fallback');
  return {
    found: false,
    segments: [],
    source: null
  };
}

/**
 * Get cache statistics
 * @returns {Promise<Object>}
 */
async function getCacheStats() {
  const cache = await loadCache();
  const entries = Object.values(cache);

  const sourceCount = {
    musixmatch: 0,
    lyricsmint: 0,
    manual: 0
  };

  entries.forEach(entry => {
    if (sourceCount[entry.source] !== undefined) {
      sourceCount[entry.source]++;
    }
  });

  return {
    totalCached: entries.length,
    bySource: sourceCount
  };
}

module.exports = {
  searchLyrics,
  parseVideoTitle,
  lyricsToSegments,
  saveToCache,
  getCacheStats
};
