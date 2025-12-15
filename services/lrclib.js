/**
 * LRCLIB Service
 *
 * Free lyrics API - no API key needed!
 * https://lrclib.net/docs
 */

const USER_AGENT = 'BollyLearn/1.0';

/**
 * Search LRCLIB for lyrics using multiple strategies
 */
async function searchLyrics(trackName, artistName = null, duration = null) {
  console.log(`[LRCLIB] Searching: "${trackName}"${artistName ? ` by "${artistName}"` : ''}`);

  try {
    // Strategy 1: Try with full cleaned title using q parameter (most flexible)
    let result = await searchWithQuery(trackName);
    if (result) return result;

    // Strategy 2: Try with just the core song name (more aggressive cleaning)
    const coreName = extractCoreSongName(trackName);
    if (coreName && coreName !== trackName) {
      console.log(`[LRCLIB] Trying core name: "${coreName}"`);
      result = await searchWithQuery(coreName);
      if (result) return result;
    }

    // Strategy 3: If we have artist, try combining core name + artist
    if (artistName) {
      const queryWithArtist = `${coreName || trackName} ${artistName}`;
      console.log(`[LRCLIB] Trying with artist: "${queryWithArtist}"`);
      result = await searchWithQuery(queryWithArtist);
      if (result) return result;
    }

    console.log(`[LRCLIB] No results found`);
    return null;

  } catch (error) {
    console.error(`[LRCLIB] Error:`, error.message);
    return null;
  }
}

/**
 * Search using the q parameter (full-text search)
 */
async function searchWithQuery(query) {
  // Use 'q' parameter for flexible full-text search
  const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;

  const response = await fetch(searchUrl, {
    headers: { 'User-Agent': USER_AGENT }
  });

  if (!response.ok) {
    console.log(`[LRCLIB] Search failed: ${response.status}`);
    return null;
  }

  const results = await response.json();

  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }

  // Find best result (prefer one with synced lyrics)
  let best = results.find(r => r.syncedLyrics) || results[0];
  console.log(`[LRCLIB] ✓ Found: "${best.trackName}" by "${best.artistName}"`);

  // Fetch full lyrics if not included
  if (!best.plainLyrics && !best.syncedLyrics && best.id) {
    console.log(`[LRCLIB] Fetching full lyrics for id: ${best.id}`);
    const fullResponse = await fetch(`https://lrclib.net/api/get/${best.id}`, {
      headers: { 'User-Agent': USER_AGENT }
    });
    if (fullResponse.ok) {
      return await fullResponse.json();
    }
  }

  return best;
}

/**
 * Parse synced lyrics (LRC format) into segments
 * "[00:27.93] Line one\n[00:32.45] Line two" → [{ start, end, text }]
 */
function parseSyncedLyrics(syncedLyrics) {
  if (!syncedLyrics) return [];

  const segments = [];
  const regex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]\s*(.*)/g;
  let match;

  while ((match = regex.exec(syncedLyrics)) !== null) {
    const mins = parseInt(match[1]);
    const secs = parseInt(match[2]);
    const ms = parseInt(match[3].padEnd(3, '0'));
    const text = match[4].trim();

    if (text) {
      segments.push({
        id: segments.length,
        start: mins * 60 + secs + ms / 1000,
        text
      });
    }
  }

  // Set end times
  for (let i = 0; i < segments.length; i++) {
    segments[i].end = (i < segments.length - 1)
      ? segments[i + 1].start
      : segments[i].start + 5;
  }

  console.log(`[LRCLIB] Parsed ${segments.length} synced segments`);
  return segments;
}

/**
 * Parse plain lyrics into segments with estimated timestamps
 */
function parsePlainLyrics(plainLyrics, duration) {
  if (!plainLyrics) return [];

  const lines = plainLyrics.split('\n').filter(l => l.trim());
  const timePerLine = duration / Math.max(lines.length, 1);

  const segments = lines.map((text, i) => ({
    id: i,
    start: i * timePerLine,
    end: (i + 1) * timePerLine,
    text: text.trim()
  }));

  console.log(`[LRCLIB] Parsed ${segments.length} plain segments`);
  return segments;
}

/**
 * Clean song title - remove common YouTube noise
 */
function cleanTitle(title) {
  return title
    // Remove content in parentheses
    .replace(/\s*\(official.*?\)/gi, '')
    .replace(/\s*\(lyric.*?\)/gi, '')
    .replace(/\s*\(audio.*?\)/gi, '')
    .replace(/\s*\(full.*?\)/gi, '')
    .replace(/\s*\(hd.*?\)/gi, '')
    .replace(/\s*\(4k.*?\)/gi, '')
    .replace(/\s*\(from.*?\)/gi, '')
    // Remove content in brackets
    .replace(/\s*\[.*?\]/g, '')
    // Remove everything after pipe
    .replace(/\s*\|.*$/g, '')
    // Remove common suffixes
    .replace(/\s*-\s*(official|full|hd|4k|lyric|audio|video).*$/gi, '')
    // Remove "Full Video Song", "Video Song", etc.
    .replace(/\s*(full\s+)?(video\s+)?song(\s+video)?/gi, '')
    .replace(/\s+full\s+video$/gi, '')
    .replace(/\s+video$/gi, '')
    .replace(/\s+audio$/gi, '')
    .replace(/\s+hd$/gi, '')
    .replace(/\s+4k$/gi, '')
    // Clean up whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract just the core song name (most aggressive cleaning)
 * For "Tum Hi Ho Full Video Song Aashiqui 2" → "Tum Hi Ho"
 */
function extractCoreSongName(title) {
  let cleaned = title
    // Remove everything in parentheses and brackets
    .replace(/\s*\(.*?\)/g, '')
    .replace(/\s*\[.*?\]/g, '')
    // Remove everything after pipe or dash
    .replace(/\s*\|.*$/g, '')
    .replace(/\s*-.*$/g, '')
    // Remove common noise words and what follows
    .replace(/\s+(full|video|song|audio|lyric|official|hd|4k|from|feat|ft)(\s+.*)?$/gi, '')
    // Remove movie names that follow song titles (common Bollywood pattern)
    // These are usually 1-3 word proper nouns after the song
    .replace(/\s+[A-Z][a-z]+(\s+[A-Z][a-z]+){0,2}\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // If we cleaned too much, return original cleaned version
  if (cleaned.length < 3) {
    return cleanTitle(title);
  }

  return cleaned;
}

/**
 * Try to extract artist from YouTube title
 * Note: This is unreliable for Bollywood as titles often list actors, not singers
 */
function parseArtist(title) {
  // Look for common patterns where singer name appears
  const patterns = [
    // "Song | Singer | Movie" - singer between pipes
    /\|\s*([^|]+?)\s*\|/,
    // "Song | Singer" - singer after single pipe (if no movie)
    /\|\s*([^|]+?)\s*$/,
    // "Song - Singer" - singer after dash
    /-\s*([^-|(]+?)\s*(?:[-|(]|$)/,
  ];

  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) {
      let artist = match[1]
        .replace(/\s*(official|video|audio|lyrics|full|hd|4k).*$/i, '')
        .trim();

      // Skip if it looks like a movie name (contains numbers like "2" or common movie words)
      if (/\d/.test(artist) || /^(the|a|an)\s/i.test(artist)) {
        continue;
      }

      // Skip very short or very long matches
      if (artist.length > 2 && artist.length < 40) {
        return artist;
      }
    }
  }

  return null;
}

module.exports = {
  searchLyrics,
  searchWithQuery,
  parseSyncedLyrics,
  parsePlainLyrics,
  cleanTitle,
  extractCoreSongName,
  parseArtist
};
