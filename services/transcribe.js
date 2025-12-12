/**
 * Transcribe Service
 *
 * Dual-track output:
 * - Romanized Hindi/Punjabi (for singing along)
 * - English translation (for understanding)
 */

const Groq = require('groq-sdk');
const fs = require('fs');

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

/**
 * Transcribe and translate audio - returns both romanized and English
 * @param {string} audioFilePath - Path to the audio file
 * @param {Object} options - Optional settings
 * @returns {Promise<Array>} Segments with romanized + english text
 */
async function transcribeAndTranslate(audioFilePath, options = {}) {
  console.log(`[TRANSCRIBE] Starting dual transcription: ${audioFilePath}`);

  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not configured');
  }

  const stats = fs.statSync(audioFilePath);
  const fileSizeMB = stats.size / (1024 * 1024);
  console.log(`[TRANSCRIBE] File size: ${fileSizeMB.toFixed(2)} MB`);

  if (fileSizeMB > 25) {
    throw new Error(`Audio file is too large (${fileSizeMB.toFixed(2)} MB). Maximum is 25 MB.`);
  }

  try {
    console.log('[TRANSCRIBE] Calling Whisper API (transcription + translation in parallel)...');

    // Run both API calls in parallel
    const [transcription, translation] = await Promise.all([
      // Transcription - gets romanized/original text
      groq.audio.transcriptions.create({
        file: fs.createReadStream(audioFilePath),
        model: 'whisper-large-v3',
        response_format: 'verbose_json'
      }),
      // Translation - gets English
      groq.audio.translations.create({
        file: fs.createReadStream(audioFilePath),
        model: 'whisper-large-v3',
        response_format: 'verbose_json'
      })
    ]);

    console.log('[TRANSCRIBE] Both API calls complete');

    // Parse segments from transcription (romanized)
    const romanizedSegments = parseSegments(transcription);
    console.log(`[TRANSCRIBE] Romanized: ${romanizedSegments.length} segments`);

    // Parse segments from translation (english)
    const englishSegments = parseSegments(translation);
    console.log(`[TRANSCRIBE] English: ${englishSegments.length} segments`);

    // Merge segments - use romanized timing, pair with english
    const merged = mergeSegments(romanizedSegments, englishSegments);
    console.log(`[TRANSCRIBE] Merged: ${merged.length} segments`);

    return merged;

  } catch (error) {
    console.error('[TRANSCRIBE] Groq API error:', error);

    if (error.status === 401) {
      throw new Error('Invalid Groq API key');
    } else if (error.status === 429) {
      throw new Error('Groq API rate limit exceeded. Please try again later.');
    } else if (error.status === 413) {
      throw new Error('Audio file is too large for Groq API');
    } else {
      throw new Error(`Transcription failed: ${error.message || 'Unknown error'}`);
    }
  }
}

/**
 * Parse segments from Whisper response
 */
function parseSegments(response) {
  if (response.segments && Array.isArray(response.segments)) {
    return response.segments
      .map((seg, idx) => ({
        id: idx,
        start: seg.start || 0,
        end: seg.end || 0,
        text: (seg.text || '').trim()
      }))
      .filter(seg => seg.text.length > 0);
  }

  if (response.text) {
    return [{
      id: 0,
      start: 0,
      end: response.duration || 0,
      text: response.text.trim()
    }];
  }

  return [];
}

/**
 * Merge romanized and english segments
 * Uses romanized timing, pairs with closest english segment
 */
function mergeSegments(romanized, english) {
  if (romanized.length === 0) return [];

  // If same count, pair directly by index
  if (romanized.length === english.length) {
    return romanized.map((seg, idx) => ({
      id: idx,
      start: seg.start,
      end: seg.end,
      romanized: seg.text,
      english: english[idx].text,
      // Keep 'text' for backward compatibility
      text: english[idx].text
    }));
  }

  // Different counts - match by closest timestamp
  return romanized.map((seg, idx) => {
    const englishMatch = findClosestSegment(seg.start, english);
    return {
      id: idx,
      start: seg.start,
      end: seg.end,
      romanized: seg.text,
      english: englishMatch ? englishMatch.text : seg.text,
      text: englishMatch ? englishMatch.text : seg.text
    };
  });
}

/**
 * Find segment with closest start time
 */
function findClosestSegment(targetTime, segments) {
  if (segments.length === 0) return null;

  let closest = segments[0];
  let minDiff = Math.abs(segments[0].start - targetTime);

  for (const seg of segments) {
    const diff = Math.abs(seg.start - targetTime);
    if (diff < minDiff) {
      minDiff = diff;
      closest = seg;
    }
  }

  return closest;
}

/**
 * Format seconds to MM:SS or HH:MM:SS
 */
function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

module.exports = {
  transcribeAndTranslate,
  formatTime
};
