/**
 * Lyrics Service
 *
 * Fetches song lyrics from:
 * 1. PostgreSQL cache (fast)
 * 2. LyricsMint scraper (if not cached)
 *
 * Falls back to Groq transcription if lyrics not found.
 *
 * Returns segments with both romanized Hindi and English translation.
 */

const Groq = require('groq-sdk');
const lyricsDb = require('./lyricsDb');
const lyricsMintScraper = require('./lyricsMintScraper');

// Initialize Groq client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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
 * Translate romanized Hindi lyrics to actual English
 * @param {string} romanizedLyrics - Hindi lyrics in English letters (e.g., "Tum hi ho")
 * @returns {Promise<string|null>} - Actual English translation
 */
async function translateToEnglish(romanizedLyrics) {
  if (!romanizedLyrics || romanizedLyrics.length < 10) {
    return null;
  }

  if (!process.env.GROQ_API_KEY) {
    console.error('[LYRICS] GROQ_API_KEY not set, cannot translate');
    return null;
  }

  try {
    console.log('[LYRICS] Translating romanized Hindi to English...');

    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `You are a Hindi to English translator specializing in Bollywood song lyrics.

Your task:
- Translate the romanized Hindi lyrics to natural English
- Keep the SAME number of lines as the input
- Each output line should be the translation of the corresponding input line
- Capture the poetic meaning, not just literal translation
- Output ONLY the English translation, no explanations or notes
- Do not include line numbers or any other formatting
- If a line is a repetition (like "Tum hi ho, tum hi ho"), translate it as repetition too`
        },
        {
          role: 'user',
          content: romanizedLyrics
        }
      ],
      temperature: 0.3,
      max_tokens: 4000
    });

    const translation = response.choices[0].message.content.trim();
    console.log(`[LYRICS] Translation complete: ${translation.length} chars`);

    return translation;

  } catch (error) {
    console.error('[LYRICS] Translation error:', error.message);
    return null;
  }
}

/**
 * Convert lyrics to timestamped segments with romanized Hindi and English
 * @param {string} romanizedLyrics - Hindi in English letters
 * @param {string} englishLyrics - Actual English translation
 * @param {number} durationSeconds - Video duration
 * @returns {Array} Segments with id, start, end, romanized, english
 */
function lyricsToSegments(romanizedLyrics, englishLyrics, durationSeconds) {
  if (!romanizedLyrics) return [];

  const romanizedLines = romanizedLyrics.split('\n').filter(line => line.trim().length > 0);
  const englishLines = englishLyrics ? englishLyrics.split('\n').filter(line => line.trim().length > 0) : [];

  const lineCount = romanizedLines.length;
  if (lineCount === 0) return [];

  const timePerLine = durationSeconds / lineCount;

  return romanizedLines.map((romanizedLine, index) => ({
    id: index,
    start: index * timePerLine,
    end: (index + 1) * timePerLine,
    romanized: romanizedLine.trim(),
    english: englishLines[index]?.trim() || '',
    // For backwards compatibility, also include 'text' field
    text: englishLines[index]?.trim() || romanizedLine.trim()
  }));
}

/**
 * Legacy function: Convert lyrics text to timestamped segments (old format)
 * Kept for backwards compatibility with Groq fallback
 * @param {string} lyrics
 * @param {number} durationSeconds
 * @returns {Array}
 */
function lyricsToSegmentsLegacy(lyrics, durationSeconds) {
  if (!lyrics) return [];

  const lines = lyrics.split('\n').filter(line => line.trim().length > 0);
  if (lines.length === 0) return [];

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
 * @returns {Promise<{found: boolean, segments: Array, source: string}>}
 */
async function searchLyrics(videoTitle, durationSeconds, youtubeUrl = null) {
  console.log(`[LYRICS] Searching lyrics for: "${videoTitle}"`);

  const { title, artist } = parseVideoTitle(videoTitle);
  console.log(`[LYRICS] Parsed: song="${title}", artist="${artist}"`);

  const youtubeId = extractVideoId(youtubeUrl);

  // 1. Check Postgres cache by YouTube ID first (exact match)
  if (youtubeId) {
    const cachedById = await lyricsDb.getByYoutubeId(youtubeId);
    if (cachedById && cachedById.romanized_lyrics && cachedById.english_translation) {
      console.log('[LYRICS] Cache hit by YouTube ID (with romanized + english)');
      const segments = lyricsToSegments(cachedById.romanized_lyrics, cachedById.english_translation, durationSeconds);
      return {
        found: true,
        segments,
        source: 'cache',
        originalSource: cachedById.source
      };
    }
  }

  // 2. Check Postgres cache by title/artist (fuzzy match)
  const cachedByTitle = await lyricsDb.searchByTitleArtist(title, artist);
  if (cachedByTitle && cachedByTitle.romanized_lyrics && cachedByTitle.english_translation) {
    console.log('[LYRICS] Cache hit by title/artist (with romanized + english)');
    const segments = lyricsToSegments(cachedByTitle.romanized_lyrics, cachedByTitle.english_translation, durationSeconds);
    return {
      found: true,
      segments,
      source: 'cache',
      originalSource: cachedByTitle.source
    };
  }

  // 3. Try LyricsMint scraper
  const scraped = await lyricsMintScraper.fetchLyrics(title, artist);

  if (scraped && scraped.romanizedLyrics) {
    console.log(`[LYRICS] Found romanized lyrics on LyricsMint (${scraped.romanizedLyrics.length} chars)`);

    // Translate romanized Hindi to actual English
    const englishTranslation = await translateToEnglish(scraped.romanizedLyrics);

    if (!englishTranslation) {
      console.log('[LYRICS] Translation failed, falling back to Groq audio transcription');
      return {
        found: false,
        segments: [],
        source: null
      };
    }

    // Save to cache for next time
    if (youtubeId) {
      await lyricsDb.saveLyrics({
        songTitle: title,
        artistName: artist,
        youtubeId,
        romanizedLyrics: scraped.romanizedLyrics,
        hindiLyrics: scraped.hindiLyrics,
        englishTranslation: englishTranslation,
        source: 'lyricsmint'
      });
    }

    const segments = lyricsToSegments(scraped.romanizedLyrics, englishTranslation, durationSeconds);
    return {
      found: true,
      segments,
      source: 'lyricsmint'
    };
  }

  // 4. If scraper found only Devanagari (needs transliteration), skip for now
  if (scraped && scraped.needsTransliteration) {
    console.log('[LYRICS] Only Devanagari found, needs transliteration - falling back to Groq');
  }

  // 5. Not found - will use Groq fallback
  console.log('[LYRICS] No lyrics found, will use Groq fallback');
  return {
    found: false,
    segments: [],
    source: null
  };
}

/**
 * Save transcription to cache (called after Groq fallback succeeds)
 * For Groq fallback, we only have English translation, not romanized Hindi
 * @param {string} youtubeUrl
 * @param {string} videoTitle
 * @param {string} transcript - The transcribed/translated text (English from Groq)
 * @param {string} romanized - Optional romanized Hindi if available
 */
async function saveTranscriptionToCache(youtubeUrl, videoTitle, transcript, romanized = null) {
  const youtubeId = extractVideoId(youtubeUrl);
  if (!youtubeId) return;

  const { title, artist } = parseVideoTitle(videoTitle);

  await lyricsDb.saveLyrics({
    songTitle: title,
    artistName: artist,
    youtubeId,
    romanizedLyrics: romanized,
    hindiLyrics: null,
    englishTranslation: transcript,
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
  lyricsToSegmentsLegacy,
  translateToEnglish,
  saveTranscriptionToCache,
  getCacheStats,
  extractVideoId
};
