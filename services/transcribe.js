/**
 * Transcribe Service
 *
 * Handles audio translation using Groq's Whisper API.
 * Uses the translations endpoint to output English directly.
 */

const Groq = require('groq-sdk');
const fs = require('fs');

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

/**
 * Transcribe and translate audio to English
 * @param {string} audioFilePath - Path to the audio file
 * @param {Object} options - Optional settings
 * @returns {Promise<Array>} Array of transcript segments with timestamps
 */
async function transcribeAndTranslate(audioFilePath, options = {}) {
  console.log(`[TRANSCRIBE] Starting transcription: ${audioFilePath}`);

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
    console.log('[TRANSCRIBE] Calling Groq Whisper API...');

    const transcription = await groq.audio.translations.create({
      file: fs.createReadStream(audioFilePath),
      model: 'whisper-large-v3',
      response_format: 'verbose_json'
    });

    console.log('[TRANSCRIBE] API response received');

    // Parse segments
    let segments = [];

    if (transcription.segments && Array.isArray(transcription.segments)) {
      segments = transcription.segments.map((seg, idx) => ({
        id: idx,
        start: seg.start || 0,
        end: seg.end || 0,
        text: (seg.text || '').trim()
      }));
    } else if (transcription.text) {
      segments = [{
        id: 0,
        start: 0,
        end: transcription.duration || 0,
        text: transcription.text.trim()
      }];
    }

    segments = segments.filter(seg => seg.text.length > 0);
    console.log(`[TRANSCRIBE] Got ${segments.length} segments`);

    return segments;

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
