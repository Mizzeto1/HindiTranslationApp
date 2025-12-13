/**
 * Lyrics Service
 *
 * Fetches song lyrics from:
 * 1. PostgreSQL cache (fast)
 * 2. LyricsMint scraper (if not cached)
 *
 * Falls back to Groq transcription if lyrics not found.
 */

const lyricsDb = require('./lyricsDb');
const lyricsMintScraper = require('./lyricsMintScraper');

/**
 * Parse YouTube video title to extract song info
 * Common formats:
 * - "Artist - Song Title"
 * - "Song Title | Artist"
 * - "Song Title (Official Video) - Artist"
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
    .replace(/\|?\s*hd/gi, '')
    .replace(/\|?\s*4k/gi, '')
    .replace(/ft\.?\s*[^-|]+/gi, '')
    .replace(/feat\.?\s*[^-|]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Try different separators
  const separators = [' - ', ' | ', ' : ', ' – ', ' — '];

  for (const sep of separators) {
    if (cleaned.includes(sep)) {
      const parts = cleaned.split(sep).map(p => p.trim());
      if (parts.length >= 2) {
        return {
          artist: parts[0],
          title: parts.slice(1).join(' ')
        };
      }
    }
  }

  // If no separator found, use the whole thing as title
  return {
    title: cleaned,
    artist: ''
  };
}

/**
 * Convert lyrics text to timestamped segments
 * Since we don't have actual timestamps, we estimate based on video duration
 * @param {string} lyrics
 * @param {number} durationSeconds
 * @returns {Array}
 */
function lyricsToSegments(lyrics, durationSeconds) {
  if (!lyrics) return [];

  // Split lyrics into lines, filter empty ones
  const lines = lyrics.split('\n').filter(line => line.trim().length > 0);

  if (lines.length === 0) return [];

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
 * Extract YouTube video ID from URL
 * @param {string} url
 * @returns {string|null}
 */
function extractVideoId(url) {
  if (!url) return null;

  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&?/]+)/,
    /^([a-zA-Z0-9_-]{11})$/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return null;
}

/**
 * Main function to search for lyrics
 * @param {string} videoTitle - YouTube video title
 * @param {number} durationSeconds - Video duration
 * @param {string} youtubeUrl - YouTube URL (optional, for caching)
 * @returns {Promise<{found: boolean, segments: Array, source: string, hindiLyrics?: string, englishTranslation?: string}>}
 */
async function searchLyrics(videoTitle, durationSeconds, youtubeUrl = null) {
  console.log(`[LYRICS] Searching lyrics for: "${videoTitle}"`);

  const { title, artist } = parseVideoTitle(videoTitle);
  console.log(`[LYRICS] Parsed: artist="${artist}", title="${title}"`);

  const youtubeId = extractVideoId(youtubeUrl);

  // 1. Check Postgres cache by YouTube ID first (exact match)
  if (youtubeId) {
    const cachedById = await lyricsDb.getByYoutubeId(youtubeId);
    if (cachedById) {
      const segments = lyricsToSegments(cachedById.hindi_lyrics, durationSeconds);
      return {
        found: true,
        segments,
        source: 'cache',
        originalSource: cachedById.source,
        hindiLyrics: cachedById.hindi_lyrics,
        englishTranslation: cachedById.english_translation
      };
    }
  }

  // 2. Check Postgres cache by title/artist (fuzzy match)
  const cachedByTitle = await lyricsDb.searchByTitleArtist(title, artist);
  if (cachedByTitle) {
    const segments = lyricsToSegments(cachedByTitle.hindi_lyrics, durationSeconds);
    return {
      found: true,
      segments,
      source: 'cache',
      originalSource: cachedByTitle.source,
      hindiLyrics: cachedByTitle.hindi_lyrics,
      englishTranslation: cachedByTitle.english_translation
    };
  }

  // 3. Try LyricsMint scraper
  const scraped = await lyricsMintScraper.fetchLyrics(title, artist);
  if (scraped && scraped.hindiLyrics) {
    // Save to cache for next time
    if (youtubeId) {
      await lyricsDb.saveLyrics({
        songTitle: title,
        artistName: artist,
        youtubeId,
        hindiLyrics: scraped.hindiLyrics,
        englishTranslation: scraped.englishTranslation,
        source: 'lyricsmint'
      });
    }

    const segments = lyricsToSegments(scraped.hindiLyrics, durationSeconds);
    return {
      found: true,
      segments,
      source: 'lyricsmint',
      hindiLyrics: scraped.hindiLyrics,
      englishTranslation: scraped.englishTranslation
    };
  }

  // 4. Not found - will use Groq fallback
  console.log('[LYRICS] No lyrics found, will use Groq fallback');
  return {
    found: false,
    segments: [],
    source: null
  };
}

/**
 * Save transcription to cache (called after Groq fallback succeeds)
 * @param {string} youtubeUrl
 * @param {string} videoTitle
 * @param {string} transcript - The transcribed/translated text
 */
async function saveTranscriptionToCache(youtubeUrl, videoTitle, transcript) {
  const youtubeId = extractVideoId(youtubeUrl);
  if (!youtubeId) return;

  const { title, artist } = parseVideoTitle(videoTitle);

  await lyricsDb.saveLyrics({
    songTitle: title,
    artistName: artist,
    youtubeId,
    hindiLyrics: transcript,
    englishTranslation: null,
    source: 'groq'
  });
}

/**
 * Get cache statistics
 * @returns {Promise<Object>}
 */
async function getCacheStats() {
  return await lyricsDb.getStats();
}

module.exports = {
  searchLyrics,
  parseVideoTitle,
  lyricsToSegments,
  saveTranscriptionToCache,
  getCacheStats,
  extractVideoId
};
