/**
 * Transcribe Service
 *
 * Handles transcription and translation using Groq's Whisper API.
 * The translations endpoint automatically outputs English.
 *
 * Two-step translation process:
 * 1. Whisper transcribes/translates audio
 * 2. LLM translates any remaining romanized Hindi/Punjabi to English
 *
 * Optimized for Hindi/Punjabi Bollywood song lyrics with:
 * - Context prompt for better accuracy
 * - Low temperature for consistent output
 * - whisper-large-v3 model (turbo doesn't support translation)
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

// Common romanized Hindi/Punjabi words that indicate text needs translation
const ROMANIZED_INDICATORS = [
  'meri', 'teri', 'tere', 'mere', 'mera', 'tera', 'pyar', 'pyaar', 'ishq', 'dil',
  'tujhe', 'mujhe', 'tumhe', 'hum', 'tum', 'aap', 'main', 'tu', 'hai', 'hain',
  'kya', 'kyu', 'kyun', 'kaun', 'kaise', 'kahan', 'jab', 'tab', 'ab', 'phir',
  'aaja', 'jaana', 'rehna', 'milna', 'kehna', 'sunna', 'dekhna', 'samajh',
  'zindagi', 'duniya', 'raat', 'din', 'subah', 'shaam', 'waqt', 'lamha',
  'naina', 'aankhein', 'dard', 'gham', 'khushi', 'aashiq', 'deewana', 'pagal',
  'sanam', 'jaana', 'soniye', 'kudiye', 'yaara', 'yaar', 'dost', 'bhai',
  'nachle', 'gaana', 'dhol', 'bhangra', 'punjabi', 'hindi', 'bollywood',
  'ho gaya', 'ho gayi', 'kar de', 'kar do', 'de de', 'le le', 'aa ja',
  'nahi', 'nahin', 'koi', 'sab', 'bahut', 'bohot', 'accha', 'acha', 'theek'
];

/**
 * Check if text appears to be romanized Hindi/Punjabi rather than English
 * @param {string} text - Text to check
 * @returns {boolean} True if text appears to need translation
 */
function needsLLMTranslation(text) {
  if (!text || text.length < 10) return false;

  const lowerText = text.toLowerCase();
  const words = lowerText.split(/\s+/);

  // Count how many romanized indicators are present
  let indicatorCount = 0;
  for (const indicator of ROMANIZED_INDICATORS) {
    if (lowerText.includes(indicator)) {
      indicatorCount++;
    }
  }

  // If more than 3 indicators found, likely needs translation
  if (indicatorCount >= 3) {
    console.log(`[TRANSCRIBE] Detected ${indicatorCount} romanized words - will use LLM translation`);
    return true;
  }

  // Check for patterns common in romanized text
  // Like repeated 'aa', 'ee', 'oo' which are common in Hindi romanization
  const romanizedPatterns = /\b\w*(aa|ee|oo|ii|uu)\w*\b/gi;
  const patternMatches = (text.match(romanizedPatterns) || []).length;

  if (patternMatches > words.length * 0.3) {
    console.log(`[TRANSCRIBE] High romanization pattern density - will use LLM translation`);
    return true;
  }

  return false;
}

/**
 * Translate romanized Hindi/Punjabi text to English using LLM
 * @param {Array} segments - Array of transcript segments
 * @returns {Promise<Array>} Translated segments
 */
async function translateWithLLM(segments) {
  if (!segments || segments.length === 0) return segments;

  // Combine all text for context
  const fullText = segments.map(s => s.text).join('\n');

  console.log('[TRANSCRIBE] Translating romanized text with LLM...');

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `You are a Hindi/Punjabi to English translator specializing in Bollywood and Punjabi song lyrics.

Your task: Translate the romanized Hindi/Punjabi lyrics to natural, poetic English.

Rules:
1. Translate the MEANING, not word-for-word
2. Keep the emotional tone and poetic feel
3. Output ONLY the English translation, nothing else
4. Preserve line breaks exactly as given
5. If a line is already in English, keep it as-is
6. Don't add explanations or notes`
        },
        {
          role: 'user',
          content: `Translate these song lyrics to English:\n\n${fullText}`
        }
      ],
      temperature: 0.3,
      max_tokens: 2000
    });

    const translatedText = response.choices[0]?.message?.content?.trim();

    if (!translatedText) {
      console.log('[TRANSCRIBE] LLM returned empty response, using original');
      return segments;
    }

    console.log('[TRANSCRIBE] LLM translation complete');

    // Split translated text back into segments, preserving timing
    const translatedLines = translatedText.split('\n').filter(line => line.trim());

    // Map translated lines back to segments
    // If counts don't match, distribute evenly
    if (translatedLines.length === segments.length) {
      return segments.map((segment, i) => ({
        ...segment,
        text: translatedLines[i].trim()
      }));
    } else {
      // Different line counts - try to merge intelligently
      console.log(`[TRANSCRIBE] Line count mismatch: ${segments.length} segments, ${translatedLines.length} translated lines`);

      // If we have fewer translated lines, combine adjacent segments
      if (translatedLines.length < segments.length) {
        const ratio = segments.length / translatedLines.length;
        return translatedLines.map((line, i) => {
          const startIdx = Math.floor(i * ratio);
          const endIdx = Math.min(Math.floor((i + 1) * ratio), segments.length - 1);
          return {
            id: i,
            start: segments[startIdx].start,
            end: segments[endIdx].end,
            text: line.trim()
          };
        });
      }

      // If we have more translated lines, use first N
      return segments.map((segment, i) => ({
        ...segment,
        text: i < translatedLines.length ? translatedLines[i].trim() : segment.text
      }));
    }

  } catch (error) {
    console.error('[TRANSCRIBE] LLM translation error:', error.message);
    // Fall back to original segments
    return segments;
  }
}

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
      model: 'whisper-large-v3',  // Full model required for translation (turbo doesn't support it)
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

    // Check if the output is romanized Hindi/Punjabi instead of English
    // If so, use LLM to translate it properly
    const fullText = cleanedSegments.map(s => s.text).join(' ');
    if (needsLLMTranslation(fullText)) {
      console.log('[TRANSCRIBE] Whisper output appears to be romanized - using LLM for translation');
      const translatedSegments = await translateWithLLM(cleanedSegments);
      return translatedSegments;
    }

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
