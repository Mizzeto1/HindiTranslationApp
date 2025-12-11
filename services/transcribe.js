/**
 * Transcribe Service
 *
 * Handles transcription and translation using Groq's Whisper API.
 * The translations endpoint automatically outputs English.
 */

const Groq = require('groq-sdk');
const fs = require('fs');

// Initialize Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

/**
 * Transcribe and translate an audio file to English
 * @param {string} audioFilePath - Path to the audio file
 * @returns {Promise<Array>} Array of transcript segments with timestamps
 */
async function transcribeAndTranslate(audioFilePath) {
  console.log(`[TRANSCRIBE] Starting transcription of: ${audioFilePath}`);

  // Check if API key is configured
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not configured');
  }

  // Check if file exists and get file size
  const stats = fs.statSync(audioFilePath);
  const fileSizeMB = stats.size / (1024 * 1024);
  console.log(`[TRANSCRIBE] File size: ${fileSizeMB.toFixed(2)} MB`);

  // Groq has a 25MB limit
  if (fileSizeMB > 25) {
    throw new Error(`Audio file is too large (${fileSizeMB.toFixed(2)} MB). Maximum is 25 MB.`);
  }

  try {
    console.log('[TRANSCRIBE] Calling Groq API...');

    // Use the translations endpoint for Hindi -> English
    const transcription = await groq.audio.translations.create({
      file: fs.createReadStream(audioFilePath),
      model: 'whisper-large-v3',
      response_format: 'verbose_json'
    });

    console.log('[TRANSCRIBE] Groq API response received');

    // Parse the response into segments
    const segments = parseTranscriptionResponse(transcription);
    console.log(`[TRANSCRIBE] Parsed ${segments.length} segments`);

    return segments;

  } catch (error) {
    console.error('[TRANSCRIBE] Groq API error:', error);

    // Handle specific Groq errors
    if (error.status === 401) {
      throw new Error('Invalid Groq API key');
    } else if (error.status === 429) {
      throw new Error('Groq API rate limit exceeded. Please try again later.');
    } else if (error.status === 413) {
      throw new Error('Audio file is too large for Groq API');
    } else if (error.message) {
      throw new Error(`Transcription failed: ${error.message}`);
    } else {
      throw new Error('Transcription failed: Unknown error');
    }
  }
}

/**
 * Parse Groq API response into standardized segments
 * @param {Object} response - The Groq API response
 * @returns {Array} Array of segment objects
 */
function parseTranscriptionResponse(response) {
  console.log('[TRANSCRIBE] Parsing response...');

  // If we have segments in the response, use them
  if (response.segments && Array.isArray(response.segments)) {
    return response.segments.map((segment, index) => ({
      id: index,
      start: segment.start || 0,
      end: segment.end || 0,
      text: segment.text ? segment.text.trim() : ''
    }));
  }

  // If we only have the full text, create a single segment
  if (response.text) {
    console.log('[TRANSCRIBE] No segments found, using full text');
    return [{
      id: 0,
      start: 0,
      end: response.duration || 0,
      text: response.text.trim()
    }];
  }

  // Empty response
  console.log('[TRANSCRIBE] Empty response from API');
  return [];
}

/**
 * Format seconds to MM:SS or HH:MM:SS
 * @param {number} seconds - Time in seconds
 * @returns {string} Formatted time string
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
