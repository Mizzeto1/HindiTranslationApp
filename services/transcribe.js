/**
 * Transcribe Service
 *
 * Handles transcription and translation using Groq's Whisper API.
 * The translations endpoint automatically outputs English.
 *
 * Optimized for Hindi/Punjabi Bollywood song lyrics with:
 * - Context prompt for better accuracy
 * - Low temperature for consistent output
 * - Turbo model for speed + quality balance
 */

const Groq = require('groq-sdk');
const fs = require('fs');

// Initialize Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// Prompt to help Whisper understand the context (improves accuracy significantly)
const TRANSCRIPTION_PROMPT = `This is a Hindi or Punjabi song with lyrics.
Common themes: love, heartbreak, celebration, devotion, Bollywood music.
May include: Hindi words, Punjabi words, Urdu poetry, romantic expressions.
Translate naturally to English, preserving the emotional meaning.`;

/**
 * Transcribe and translate an audio file to English
 * @param {string} audioFilePath - Path to the audio file
 * @param {Object} options - Optional settings
 * @param {string} options.videoTitle - Video title for context
 * @returns {Promise<Array>} Array of transcript segments with timestamps
 */
async function transcribeAndTranslate(audioFilePath, options = {}) {
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

  // Build context prompt - include video title if available for better accuracy
  let prompt = TRANSCRIPTION_PROMPT;
  if (options.videoTitle) {
    prompt = `Song: "${options.videoTitle}"\n${TRANSCRIPTION_PROMPT}`;
  }

  try {
    console.log('[TRANSCRIBE] Calling Groq API with optimized settings...');

    // Use the translations endpoint for Hindi -> English
    // Key improvements:
    // - prompt: Provides context about the content (song lyrics)
    // - temperature: 0 for most accurate/consistent output
    // - response_format: verbose_json for timestamps
    const transcription = await groq.audio.translations.create({
      file: fs.createReadStream(audioFilePath),
      model: 'whisper-large-v3-turbo',  // Turbo is faster and great for songs
      response_format: 'verbose_json',
      prompt: prompt,
      temperature: 0  // More deterministic = more accurate
    });

    console.log('[TRANSCRIBE] Groq API response received');

    // Parse the response into segments
    const segments = parseTranscriptionResponse(transcription);
    console.log(`[TRANSCRIBE] Parsed ${segments.length} segments`);

    // Post-process segments for better quality
    const cleanedSegments = postProcessSegments(segments);
    console.log(`[TRANSCRIBE] Post-processed to ${cleanedSegments.length} segments`);

    return cleanedSegments;

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
 * Post-process segments to improve quality
 * - Remove empty segments
 * - Clean up repeated text
 * - Merge very short segments
 * @param {Array} segments - Raw segments from API
 * @returns {Array} Cleaned segments
 */
function postProcessSegments(segments) {
  if (!segments || segments.length === 0) return [];

  const cleaned = [];
  let lastText = '';

  for (const segment of segments) {
    // Skip empty segments
    if (!segment.text || segment.text.trim().length === 0) continue;

    const text = segment.text.trim();

    // Skip if it's just repeating the last segment exactly
    if (text === lastText) continue;

    // Clean up common transcription artifacts
    let cleanedText = text
      .replace(/\[.*?\]/g, '')  // Remove [Music], [Applause], etc.
      .replace(/\(.*?\)/g, '')  // Remove (inaudible), etc.
      .replace(/♪/g, '')        // Remove music notes
      .replace(/\s+/g, ' ')     // Normalize whitespace
      .trim();

    // Skip if cleaned text is too short (likely noise)
    if (cleanedText.length < 2) continue;

    cleaned.push({
      id: cleaned.length,
      start: segment.start,
      end: segment.end,
      text: cleanedText
    });

    lastText = text;
  }

  // Merge very short consecutive segments (< 1 second) for better readability
  const merged = [];
  let buffer = null;

  for (const segment of cleaned) {
    const duration = segment.end - segment.start;

    if (buffer === null) {
      buffer = { ...segment };
    } else if (duration < 1 && (segment.start - buffer.end) < 0.5) {
      // Merge short segment into buffer
      buffer.end = segment.end;
      buffer.text = `${buffer.text} ${segment.text}`;
    } else {
      // Push buffer and start new one
      merged.push(buffer);
      buffer = { ...segment };
    }
  }

  // Don't forget the last buffer
  if (buffer) {
    merged.push(buffer);
  }

  // Re-index
  return merged.map((seg, idx) => ({ ...seg, id: idx }));
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
