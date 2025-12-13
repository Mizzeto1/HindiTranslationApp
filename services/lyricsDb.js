/**
 * Lyrics Database Service
 *
 * Postgres-based lyrics cache for fast lookups.
 * Replaces the old JSON file cache.
 */

const { Pool } = require('pg');

// Only use Postgres if DATABASE_URL is set
const USE_POSTGRES = !!process.env.DATABASE_URL;

let pool = null;
if (USE_POSTGRES) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

/**
 * Get lyrics by YouTube video ID (exact match)
 * @param {string} youtubeId
 * @returns {Promise<Object|null>}
 */
async function getByYoutubeId(youtubeId) {
  if (!USE_POSTGRES || !youtubeId) return null;

  try {
    const result = await pool.query(
      'SELECT * FROM song_lyrics WHERE youtube_id = $1 AND confidence > 0',
      [youtubeId]
    );

    if (result.rows.length > 0) {
      console.log(`[LYRICS_DB] Cache hit for youtube_id: ${youtubeId}`);
      return result.rows[0];
    }
    return null;
  } catch (error) {
    console.error('[LYRICS_DB] Error getting by youtube_id:', error.message);
    return null;
  }
}

/**
 * Search lyrics by song title and artist (fuzzy match using full-text search)
 * @param {string} title
 * @param {string} artist
 * @returns {Promise<Object|null>}
 */
async function searchByTitleArtist(title, artist) {
  if (!USE_POSTGRES || !title) return null;

  try {
    // Build search query - combine title and artist
    const searchTerms = `${title} ${artist || ''}`.trim()
      .replace(/[^a-zA-Z0-9\s]/g, ' ')  // Remove special chars
      .split(/\s+/)
      .filter(t => t.length > 1)
      .join(' & ');

    if (!searchTerms) return null;

    const result = await pool.query(`
      SELECT *,
        ts_rank(to_tsvector('simple', song_title || ' ' || COALESCE(artist_name, '')),
                plainto_tsquery('simple', $1)) as rank
      FROM song_lyrics
      WHERE to_tsvector('simple', song_title || ' ' || COALESCE(artist_name, ''))
            @@ plainto_tsquery('simple', $1)
        AND confidence > 0
      ORDER BY rank DESC
      LIMIT 1
    `, [searchTerms]);

    if (result.rows.length > 0) {
      console.log(`[LYRICS_DB] Found match for: "${title}" by "${artist}"`);
      return result.rows[0];
    }

    // Fallback: try ILIKE search if full-text didn't match
    const fallback = await pool.query(`
      SELECT * FROM song_lyrics
      WHERE (LOWER(song_title) LIKE $1 OR LOWER(artist_name) LIKE $1)
        AND confidence > 0
      LIMIT 1
    `, [`%${title.toLowerCase()}%`]);

    if (fallback.rows.length > 0) {
      console.log(`[LYRICS_DB] Fallback match for: "${title}"`);
      return fallback.rows[0];
    }

    console.log(`[LYRICS_DB] No match for: "${title}" by "${artist}"`);
    return null;
  } catch (error) {
    console.error('[LYRICS_DB] Search error:', error.message);
    return null;
  }
}

/**
 * Save lyrics to the database cache
 * @param {Object} params
 * @returns {Promise<boolean>}
 */
async function saveLyrics({ songTitle, artistName, youtubeId, hindiLyrics, englishTranslation, source }) {
  if (!USE_POSTGRES) return false;

  try {
    // Upsert - insert or update if youtube_id exists
    await pool.query(`
      INSERT INTO song_lyrics (song_title, artist_name, youtube_id, hindi_lyrics, english_translation, source, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      ON CONFLICT (youtube_id)
      DO UPDATE SET
        song_title = EXCLUDED.song_title,
        artist_name = EXCLUDED.artist_name,
        hindi_lyrics = EXCLUDED.hindi_lyrics,
        english_translation = EXCLUDED.english_translation,
        source = EXCLUDED.source,
        updated_at = CURRENT_TIMESTAMP
    `, [songTitle, artistName, youtubeId, hindiLyrics, englishTranslation, source]);

    console.log(`[LYRICS_DB] Saved: "${songTitle}" (source: ${source})`);
    return true;
  } catch (error) {
    console.error('[LYRICS_DB] Save error:', error.message);
    return false;
  }
}

/**
 * Flag lyrics as incorrect (sets confidence to 0)
 * Used when user reports bad lyrics
 * @param {string} youtubeId
 * @returns {Promise<boolean>}
 */
async function flagAsIncorrect(youtubeId) {
  if (!USE_POSTGRES || !youtubeId) return false;

  try {
    await pool.query(
      'UPDATE song_lyrics SET confidence = 0, updated_at = CURRENT_TIMESTAMP WHERE youtube_id = $1',
      [youtubeId]
    );
    console.log(`[LYRICS_DB] Flagged as incorrect: ${youtubeId}`);
    return true;
  } catch (error) {
    console.error('[LYRICS_DB] Flag error:', error.message);
    return false;
  }
}

/**
 * Get cache statistics
 * @returns {Promise<Object>}
 */
async function getStats() {
  if (!USE_POSTGRES) {
    return { total: 0, bySource: {} };
  }

  try {
    const total = await pool.query('SELECT COUNT(*) FROM song_lyrics WHERE confidence > 0');
    const bySource = await pool.query(`
      SELECT source, COUNT(*) as count
      FROM song_lyrics
      WHERE confidence > 0
      GROUP BY source
    `);

    return {
      total: parseInt(total.rows[0].count),
      bySource: bySource.rows.reduce((acc, row) => {
        acc[row.source] = parseInt(row.count);
        return acc;
      }, {})
    };
  } catch (error) {
    console.error('[LYRICS_DB] Stats error:', error.message);
    return { total: 0, bySource: {} };
  }
}

module.exports = {
  getByYoutubeId,
  searchByTitleArtist,
  saveLyrics,
  flagAsIncorrect,
  getStats
};
