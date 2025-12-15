/**
 * LRCLIB Service
 *
 * Free lyrics API - no API key needed!
 * https://lrclib.net/docs
 */

const USER_AGENT = 'BollyLearn/1.0';

/**
 * Clean song title - remove YouTube junk but KEEP the song name
 */
function cleanTitle(title) {
  let cleaned = title
    // Remove common VIDEO TYPE prefixes
    .replace(/^(Lyrical|Official|Full)\s*[:|-]\s*/gi, '')
    .replace(/^(Official\s+)?(Music\s+)?(Video|Audio|Lyric[s]?)\s*[:|-]\s*/gi, '')
    .replace(/^(Full\s+)?(Video\s+)?(Song|Audio)\s*[:|-]\s*/gi, '')

    // Remove everything after |
    .replace(/\s*\|.*$/g, '')

    // Remove parenthetical junk
    .replace(/\s*\((Official|Full|Lyric|Audio|Video|HD|4K|HQ|From).*?\)/gi, '')

    // Remove bracketed junk
    .replace(/\s*\[.*?\]/g, '')

    // Remove trailing indicators
    .replace(/\s*-\s*(Official|Full|HD|4K|HQ|Audio|Video|Lyric[s]?).*$/gi, '')

    // Clean whitespace
    .replace(/\s+/g, ' ')
    .trim();

  // Safety: if too short, try simpler approach
  if (cleaned.length < 3) {
    cleaned = title.replace(/\s*\|.*$/, '').replace(/\s*\(.*?\)/g, '').replace(/\s*\[.*?\]/g, '').trim();
  }
  if (cleaned.length < 3) {
    cleaned = title.split('|')[0].trim();
  }

  console.log(`[LRCLIB] cleanTitle: "${title.substring(0, 60)}${title.length > 60 ? '...' : ''}" → "${cleaned}"`);
  return cleaned;
}

/**
 * Extract artist - returns null if not confident
 */
function parseArtist(title) {
  // For Bollywood: "Song | Movie | Actors" - singer NOT in title
  // Only extract if very clear pattern

  const patterns = [
    /\bby\s+([A-Za-z\s]{3,40})(?:\s*[-|(\[]|$)/i,
    /\b(?:ft\.?|feat\.?)\s+([A-Za-z\s]{3,40})(?:\s*[-|(\[]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) {
      const artist = match[1].trim();
      if (artist.length > 2) {
        console.log(`[LRCLIB] Extracted artist: "${artist}"`);
        return artist;
      }
    }
  }

  console.log(`[LRCLIB] No artist extracted (searching by title only)`);
  return null;
}

/**
 * Validate that LRCLIB result matches our search
 */
function isRelevantResult(searchQuery, result) {
  if (!result || !result.trackName) return false;

  const queryLower = searchQuery.toLowerCase();
  const resultLower = result.trackName.toLowerCase();

  const stopWords = ['the', 'and', 'for', 'with', 'from', 'song', 'full', 'video', 'audio', 'lyric', 'lyrics', 'official'];

  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2 && !stopWords.includes(w));
  const resultWords = resultLower.split(/\s+/).filter(w => w.length > 2 && !stopWords.includes(w));

  if (queryWords.length === 0) return true;

  const hasMatch = queryWords.some(qw => resultWords.some(rw => rw.includes(qw) || qw.includes(rw)));

  if (!hasMatch) {
    console.log(`[LRCLIB] ✗ Rejecting: searched "${searchQuery}", got "${result.trackName}"`);
    return false;
  }

  return true;
}

/**
 * Search LRCLIB with validation
 */
async function searchLyrics(trackName, artistName, duration = null) {
  console.log(`[LRCLIB] Searching: "${trackName}"${artistName ? ` by "${artistName}"` : ''}`);

  try {
    const params = new URLSearchParams({ track_name: trackName });
    if (artistName) params.append('artist_name', artistName);
    if (duration) params.append('duration', Math.round(duration));

    // Try exact match
    let response = await fetch(`https://lrclib.net/api/get?${params}`, {
      headers: { 'User-Agent': USER_AGENT }
    });

    if (response.ok) {
      const data = await response.json();
      if (data && (data.plainLyrics || data.syncedLyrics) && isRelevantResult(trackName, data)) {
        console.log(`[LRCLIB] ✓ Exact match: "${data.trackName}" by "${data.artistName}"`);
        return data;
      }
    }

    // Try search
    response = await fetch(`https://lrclib.net/api/search?${params}`, {
      headers: { 'User-Agent': USER_AGENT }
    });

    if (response.ok) {
      const results = await response.json();
      if (Array.isArray(results)) {
        for (const result of results) {
          if (isRelevantResult(trackName, result)) {
            console.log(`[LRCLIB] ✓ Search match: "${result.trackName}" by "${result.artistName}"`);

            if (!result.plainLyrics && !result.syncedLyrics && result.id) {
              const full = await fetch(`https://lrclib.net/api/get/${result.id}`, {
                headers: { 'User-Agent': USER_AGENT }
              });
              if (full.ok) return await full.json();
            }
            return result;
          }
        }
        if (results.length > 0) {
          console.log(`[LRCLIB] All ${results.length} results were irrelevant`);
        }
      }
    }

    console.log(`[LRCLIB] No relevant results found`);
    return null;

  } catch (error) {
    console.error(`[LRCLIB] Error:`, error.message);
    return null;
  }
}

/**
 * Parse synced lyrics (LRC format) into segments
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
    segments[i].end = (i < segments.length - 1) ? segments[i + 1].start : segments[i].start + 5;
  }

  console.log(`[LRCLIB] Parsed ${segments.length} synced segments`);
  return segments;
}

/**
 * Parse plain lyrics with estimated timestamps
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

module.exports = {
  searchLyrics,
  parseSyncedLyrics,
  parsePlainLyrics,
  cleanTitle,
  parseArtist
};
