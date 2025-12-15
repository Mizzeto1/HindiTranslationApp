/**
 * Transcribe Service
 *
 * Handles audio transcription using Groq's Whisper API.
 * Now returns romanized Hindi AND English translation.
 */

const Groq = require('groq-sdk');
const fs = require('fs');

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// Garbage patterns that indicate Whisper transcribed ads/intros
const GARBAGE_PATTERNS = [
  /subscribe/i,
  /notification/i,
  /click.*(bell|allow)/i,
  /like.*(share|comment)/i,
  /thanks for watching/i,
  /check out/i,
  /link in description/i,
  /follow us/i,
  /hit the bell/i
];

/**
 * Check if transcription is garbage (YouTube intros/ads)
 */
function isGarbageTranscription(text) {
  if (!text || text.length < 50) {
    console.log('[TRANSCRIBE] Text too short, likely garbage');
    return true;
  }

  for (const pattern of GARBAGE_PATTERNS) {
    if (pattern.test(text)) {
      console.log('[TRANSCRIBE] Detected garbage pattern:', pattern);
      return true;
    }
  }

  return false;
}

/**
 * Translate romanized Hindi to English using Groq LLM
 */
async function translateToEnglish(romanizedText, videoTitle = '') {
  const systemPrompt = `You are translating Hindi/Punjabi Bollywood song lyrics to English.

RULES:
- Make it sound natural and poetic in English
- Keep the same number of lines
- Preserve emotional meaning, not just literal words
- Output ONLY the English translation, nothing else

EXAMPLES:
"Tum hi ho, bas tum hi ho" → "You're the only one, just you"
"Dil to pagal hai" → "This heart is crazy in love"`;

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Translate these Hindi lyrics from "${videoTitle}":\n\n${romanizedText}` }
      ],
      temperature: 0.2,
      max_tokens: 4000
    });

    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error('[TRANSCRIBE] Translation error:', error.message);
    return null;
  }
}

/**
 * Transcribe audio to romanized Hindi, then translate to English
 * @param {string} audioFilePath - Path to the audio file
 * @param {Object} options - { videoTitle }
 * @returns {Promise<Array>} Array of segments with romanized + english
 */
async function transcribeAndTranslate(audioFilePath, options = {}) {
  const { videoTitle = '' } = options;

  console.log(`[TRANSCRIBE] Starting transcription: ${audioFilePath}`);

  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not configured');
  }

  const stats = fs.statSync(audioFilePath);
  const fileSizeMB = stats.size / (1024 * 1024);
  console.log(`[TRANSCRIBE] File size: ${fileSizeMB.toFixed(2)} MB`);

  if (fileSizeMB > 25) {
    throw new Error(`Audio file too large (${fileSizeMB.toFixed(2)} MB). Max 25 MB.`);
  }

  try {
    // Step 1: Transcribe to romanized Hindi (NOT translate)
    console.log('[TRANSCRIBE] Step 1: Getting romanized Hindi from Whisper...');

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(audioFilePath),
      model: 'whisper-large-v3',
      language: 'hi',  // Tell Whisper it's Hindi
      prompt: videoTitle
        ? `Hindi Bollywood song "${videoTitle}". Transcribe the sung lyrics.`
        : 'Hindi Bollywood song lyrics. Transcribe the sung portions.',
      response_format: 'verbose_json',
      temperature: 0.0
    });

    console.log('[TRANSCRIBE] Whisper response received');

    // Extract text
    const romanizedText = transcription.text || '';
    console.log(`[TRANSCRIBE] Romanized text: ${romanizedText.length} chars`);

    // Step 2: Check for garbage
    if (isGarbageTranscription(romanizedText)) {
      console.log('[TRANSCRIBE] Garbage detected, rejecting transcription');
      throw new Error('Could not extract meaningful lyrics from audio. Try a different video.');
    }

    // Step 3: Translate to English
    console.log('[TRANSCRIBE] Step 2: Translating to English...');
    const englishText = await translateToEnglish(romanizedText, videoTitle);

    if (!englishText) {
      throw new Error('Translation failed');
    }

    console.log(`[TRANSCRIBE] English translation: ${englishText.length} chars`);

    // Step 4: Build segments with both romanized and english
    const romanizedLines = romanizedText.split('\n').filter(l => l.trim());
    const englishLines = englishText.split('\n').filter(l => l.trim());

    // Estimate duration if available
    const duration = transcription.duration || 300;
    const timePerLine = duration / romanizedLines.length;

    const segments = romanizedLines.map((romanized, idx) => ({
      id: idx,
      start: idx * timePerLine,
      end: (idx + 1) * timePerLine,
      romanized: romanized.trim(),
      english: englishLines[idx]?.trim() || '',
      text: englishLines[idx]?.trim() || romanized.trim()  // Backwards compatibility
    }));

    console.log(`[TRANSCRIBE] Created ${segments.length} segments with romanized + english`);
    return segments;

  } catch (error) {
    console.error('[TRANSCRIBE] Error:', error);

    if (error.status === 401) {
      throw new Error('Invalid Groq API key');
    } else if (error.status === 429) {
      throw new Error('Rate limit exceeded. Please try again later.');
    } else if (error.message.includes('garbage') || error.message.includes('meaningful')) {
      throw error;  // Re-throw our custom error
    } else {
      throw new Error(`Transcription failed: ${error.message || 'Unknown error'}`);
    }
  }
}

/**
 * Format seconds to MM:SS
 */
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

module.exports = {
  transcribeAndTranslate,
  formatTime,
  isGarbageTranscription
};
