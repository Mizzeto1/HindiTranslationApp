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
 * Check if text is Latin script (romanized)
 * Returns false for Devanagari, Arabic/Urdu, etc.
 */
function isLatinScript(text) {
  if (!text) return true;
  // Allow Latin letters, numbers, punctuation, spaces
  // Block non-Latin scripts (Devanagari, Arabic, etc.)
  const nonLatinPattern = /[\u0900-\u097F\u0600-\u06FF\u0980-\u09FF\u0A00-\u0A7F]/;
  return !nonLatinPattern.test(text);
}

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
      // Transcription - force Hindi to get romanized/Devanagari output
      groq.audio.transcriptions.create({
        file: fs.createReadStream(audioFilePath),
        model: 'whisper-large-v3',
        language: 'hi',  // Force Hindi detection to avoid auto-translating
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

    // Parse segments from both responses
    const transcribedSegments = parseSegments(transcription);
    const translatedSegments = parseSegments(translation);

    // Check if transcription is Latin script
    const sampleText = transcribedSegments[0]?.text || '';
    const isLatin = isLatinScript(sampleText);
    console.log(`[TRANSCRIBE] Transcription: ${transcribedSegments.length} segments, Latin script: ${isLatin}`);
    console.log(`[TRANSCRIBE] Translation: ${translatedSegments.length} segments`);

    // Merge segments
    const merged = mergeSegments(transcribedSegments, translatedSegments);
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
 * - If transcription is non-Latin (Devanagari/Urdu), use translation for romanized
 * - If romanized equals english, set romanized to null (avoid duplicates)
 */
function mergeSegments(transcribed, translated) {
  const base = translated.length > 0 ? translated : transcribed;
  if (base.length === 0) return [];

  return base.map((seg, idx) => {
    const transcribedSeg = transcribed.length === base.length
      ? transcribed[idx]
      : findClosestSegment(seg.start, transcribed);

    const transcribedText = transcribedSeg ? transcribedSeg.text : '';
    const translatedText = seg.text;

    // Get romanized text (use translation if transcription is non-Latin)
    let romanized = isLatinScript(transcribedText) ? transcribedText : translatedText;

    // If romanized is same as english, set to null (no point showing twice)
    if (romanized.toLowerCase().trim() === translatedText.toLowerCase().trim()) {
      romanized = null;
    }

    return {
      id: idx,
      start: seg.start,
      end: seg.end,
      romanized: romanized,
      english: translatedText,
      text: translatedText
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
