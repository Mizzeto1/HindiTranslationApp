/**
 * LRCLIB Service
 *
 * Free lyrics API - no API key needed!
 * https://lrclib.net/docs
 */

const USER_AGENT = 'BollyLearn/1.0';

/**
 * Search LRCLIB for lyrics
 */
async function searchLyrics(trackName, artistName, duration = null) {
  console.log(`[LRCLIB] Searching: "${trackName}" by "${artistName}"`);

  try {
    const params = new URLSearchParams({ track_name: trackName });
    if (artistName) params.append('artist_name', artistName);
    if (duration) params.append('duration', Math.round(duration));

    // Try exact match first
    const getUrl = `https://lrclib.net/api/get?${params}`;
    let response = await fetch(getUrl, {
      headers: { 'User-Agent': USER_AGENT }
    });

    if (response.ok) {
      const data = await response.json();
      if (data && (data.plainLyrics || data.syncedLyrics)) {
        console.log(`[LRCLIB] ✓ Found exact match`);
        return data;
      }
    }

    // Try search if exact match fails
    const searchUrl = `https://lrclib.net/api/search?${params}`;
    response = await fetch(searchUrl, {
      headers: { 'User-Agent': USER_AGENT }
    });

    if (response.ok) {
      const results = await response.json();
      if (Array.isArray(results) && results.length > 0) {
        const best = results[0];
        console.log(`[LRCLIB] ✓ Found via search: "${best.trackName}"`);

        // Fetch full lyrics if needed
        if (!best.plainLyrics && !best.syncedLyrics && best.id) {
          const fullResponse = await fetch(`https://lrclib.net/api/get/${best.id}`, {
            headers: { 'User-Agent': USER_AGENT }
          });
          if (fullResponse.ok) return await fullResponse.json();
        }
        return best;
      }
    }

    console.log(`[LRCLIB] No results`);
    return null;

  } catch (error) {
    console.error(`[LRCLIB] Error:`, error.message);
    return null;
  }
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
 * Clean song title for searching
 */
function cleanTitle(title) {
  return title
    .replace(/\s*\(official.*?\)/gi, '')
    .replace(/\s*\(lyric.*?\)/gi, '')
    .replace(/\s*\(audio.*?\)/gi, '')
    .replace(/\s*\(full.*?\)/gi, '')
    .replace(/\s*\|.*$/g, '')
    .replace(/\s*-\s*[^-]*$/, '')  // Remove last segment after dash
    .replace(/\s*\[.*?\]/g, '')
    .trim();
}

/**
 * Try to extract artist from YouTube title
 */
function parseArtist(title) {
  // "Song | Artist | Movie" or "Song - Artist"
  const patterns = [
    /\|\s*([^|]+?)\s*\|/,           // Between pipes
    /\|\s*([^|]+?)\s*$/,            // After last pipe
    /-\s*([^-|(]+?)\s*(?:[-|(]|$)/, // After dash
  ];

  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) {
      const artist = match[1]
        .replace(/\s*(official|video|audio|lyrics|full|hd).*$/i, '')
        .trim();
      if (artist.length > 2 && artist.length < 50) {
        return artist;
      }
    }
  }
  return null;
}

module.exports = {
  searchLyrics,
  parseSyncedLyrics,
  parsePlainLyrics,
  cleanTitle,
  parseArtist
};
