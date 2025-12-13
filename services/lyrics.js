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
 * Parse YouTube video title to extract song and artist
 * Handles common Bollywood title formats:
 * - "Tum Hi Ho" Full Video Song | Arijit Singh | Aashiqui 2
 * - Arijit Singh - Tum Hi Ho (Official Video)
 * - Tu Mane Ya Na Mane Dildara – Live | Lakhwinder Wadali | Sufi Mehfil
 * - Woh Lamhe Woh Baatein | Atif Aslam | Zeher
 * @param {string} videoTitle
 * @returns {{title: string, artist: string}}
 */
function parseVideoTitle(videoTitle) {
  // Remove common suffixes first
  let cleaned = videoTitle
    .replace(/\(official\s*(music\s*)?video\)/gi, '')
    .replace(/\(official\s*audio\)/gi, '')
    .replace(/\(lyric[s]?\s*video\)/gi, '')
    .replace(/\(full\s*(video\s*)?(song)?(\s*video)?\)/gi, '')
    .replace(/\|\s*full\s*video(\s*song)?/gi, '')
    .replace(/\[.*?\]/g, '') // Remove [anything]
    .replace(/–\s*live/gi, '') // Remove "– Live"
    .replace(/-\s*live/gi, '')
    .replace(/\|\s*lyric[s]?/gi, '')
    .replace(/\|\s*audio/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Try to extract quoted song title first: "Song Name" ... Artist
  const quotedMatch = cleaned.match(/[""]([^""]+)[""].*?\|\s*([^|]+)/i);
  if (quotedMatch) {
    return {
      title: quotedMatch[1].trim(),
      artist: quotedMatch[2].trim().split('|')[0].trim()
    };
  }

  // Split by | and analyze parts
  const pipeParts = cleaned.split('|').map(p => p.trim()).filter(p => p.length > 0);

  if (pipeParts.length >= 2) {
    // First part is usually song, second is usually artist
    // But filter out noise words from artist
    const noiseWords = ['full video', 'video song', 'audio', 'lyrics', 'hd', '4k', 'sufi mehfil', 'my fm', 'unplugged'];

    let songPart = pipeParts[0];
    let artistPart = null;

    // Find the first part that looks like an artist name (not noise)
    for (let i = 1; i < pipeParts.length; i++) {
      const part = pipeParts[i].toLowerCase();
      const isNoise = noiseWords.some(noise => part.includes(noise));
      if (!isNoise && pipeParts[i].length > 2) {
        artistPart = pipeParts[i];
        break;
      }
    }

    // Clean up song part - remove artist if duplicated
    if (artistPart && songPart.toLowerCase().includes(artistPart.toLowerCase())) {
      songPart = songPart.replace(new RegExp(artistPart, 'gi'), '').trim();
    }

    // Remove trailing separators from song
    songPart = songPart.replace(/[-–|:]\s*$/, '').trim();

    return {
      title: songPart || pipeParts[0],
      artist: artistPart || ''
    };
  }

  // Try "Artist - Song" or "Song - Artist" format
  const dashParts = cleaned.split(/\s*[-–]\s*/);
  if (dashParts.length >= 2) {
    // Heuristic: Bollywood artists are usually shorter names
    // If first part has more words, it's probably the song
    const firstWords = dashParts[0].split(' ').length;
    const secondWords = dashParts[1].split(' ').length;

    if (firstWords > secondWords) {
      return { title: dashParts[0], artist: dashParts[1] };
    } else {
      return { title: dashParts[1], artist: dashParts[0] };
    }
  }

  // Fallback: whole thing is the title
  return { title: cleaned, artist: '' };
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
  console.log(`[LYRICS] Parsed: song="${title}", artist="${artist}"`);

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
