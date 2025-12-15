/**
 * Transcribe Service
 *
 * Handles audio transcription using Groq's Whisper API.
 * Ensures output is ROMANIZED Hindi (not Devanagari script).
 * Returns both romanized Hindi AND English translation.
 */

const Groq = require('groq-sdk');
const fs = require('fs');

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// Garbage patterns that indicate Whisper hallucinated or transcribed ads
const GARBAGE_PATTERNS = [
  /subscribe/i,
  /notification/i,
  /click.*(bell|allow)/i,
  /like.*(share|comment)/i,
  /thanks for watching/i,
  /check out/i,
  /link in description/i,
  /follow us/i,
  /hit the bell/i,
  /\btu z draws\b/i,           // Known hallucination
  /\bO beloved everything\b/i,  // Known hallucination
  /\bas liego\b/i,              // Known hallucination
  /\beverything is as\b/i,      // Known hallucination
];

/**
 * Check if text contains Devanagari (Hindi script)
 */
function hasDevanagari(text) {
  return /[\u0900-\u097F]/.test(text);
}

/**
 * Check if transcription is garbage (YouTube intros/ads or hallucinations)
 */
function isGarbageTranscription(text, duration = 0) {
  if (!text || text.length < 50) {
    console.log('[TRANSCRIBE] Text too short, likely garbage');
    return true;
  }

  // Check garbage patterns
  for (const pattern of GARBAGE_PATTERNS) {
    if (pattern.test(text)) {
      console.log('[TRANSCRIBE] Detected garbage pattern:', pattern);
      return true;
    }
  }

  // Check for too much random English (real Hindi songs have <30% English)
  const words = text.split(/\s+/);
  const englishWords = words.filter(w => /^[a-zA-Z]+$/.test(w) && w.length > 2);
  const englishRatio = englishWords.length / words.length;

  if (englishRatio > 0.5 && !hasDevanagari(text)) {
    console.log('[TRANSCRIBE] Too much English without Hindi:', (englishRatio * 100).toFixed(1) + '%');
    return true;
  }

  // Check for repetitive lines (Whisper loops when confused)
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length > 5) {
    const uniqueLines = new Set(lines.map(l => l.trim().toLowerCase()));
    if (uniqueLines.size < lines.length * 0.4) {
      console.log('[TRANSCRIBE] Too repetitive, Whisper may be hallucinating');
      return true;
    }
  }

  return false;
}

/**
 * Transliterate Devanagari (Hindi script) to romanized Hindi using LLM
 */
async function transliterateToRomanized(devanagariText, videoTitle = '') {
  if (!devanagariText || devanagariText.length < 10) {
    return null;
  }

  // Check if actually contains Devanagari
  if (!hasDevanagari(devanagariText)) {
    console.log('[TRANSCRIBE] Text has no Devanagari, assuming already romanized');
    return devanagariText;
  }

  const systemPrompt = `You are a Hindi transliteration expert. Convert Devanagari script to romanized Hindi (Hindi words written in English letters).

CRITICAL RULES:
1. Output ONLY the romanized text, nothing else
2. Keep the same line structure and breaks
3. Use standard romanization conventions
4. REMOVE any garbage/nonsense English text you see (like "tu z draws O beloved")
5. If a line is pure garbage, skip it entirely

TRANSLITERATION EXAMPLES:
तुम ही हो → Tum hi ho
दिल तो पागल है → Dil to pagal hai
तेरे नैना → Tere naina
मेरी आशिकी → Meri aashiqui
क्या छुपाऊं तुझसे → Kya chupaaun tujhse
तेरे पीछे चल दूं → Tere peeche chal doon

DO NOT include:
- Any explanations or notes
- The original Devanagari
- Any garbage English phrases`;

  try {
    console.log('[TRANSCRIBE] Transliterating Devanagari to romanized...');
    console.log('[TRANSCRIBE] Input has', devanagariText.length, 'chars');

    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Transliterate this Hindi song${videoTitle ? ` "${videoTitle}"` : ''}:\n\n${devanagariText}` }
      ],
      temperature: 0.1,
      max_tokens: 4000
    });

    const romanized = response.choices[0].message.content.trim();

    // Verify output doesn't still contain Devanagari
    if (hasDevanagari(romanized)) {
      console.log('[TRANSCRIBE] Warning: Output still contains Devanagari, cleaning...');
      // Remove any remaining Devanagari characters
      const cleaned = romanized.replace(/[\u0900-\u097F]+/g, '').replace(/\s+/g, ' ').trim();
      return cleaned;
    }

    console.log('[TRANSCRIBE] Transliteration complete:', romanized.length, 'chars');
    return romanized;

  } catch (error) {
    console.error('[TRANSCRIBE] Transliteration error:', error.message);
    return null;
  }
}

/**
 * Translate romanized Hindi to English using Groq LLM
 */
async function translateToEnglish(romanizedText, videoTitle = '') {
  const systemPrompt = `You are translating Hindi/Punjabi Bollywood song lyrics to English.

RULES:
- Make it sound natural and poetic in English
- Keep the same number of lines as input
- Preserve emotional meaning, not just literal words
- Output ONLY the English translation, nothing else

EXAMPLES:
"Tum hi ho, bas tum hi ho" → "You're the only one, just you"
"Dil to pagal hai" → "This heart is crazy in love"
"Tere naina aise ghafil" → "Your eyes are so careless"
"Kya chupaaun tujhse" → "What can I hide from you"`;

  try {
    console.log('[TRANSCRIBE] Translating to English...');

    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Translate these Hindi lyrics${videoTitle ? ` from "${videoTitle}"` : ''}:\n\n${romanizedText}` }
      ],
      temperature: 0.2,
      max_tokens: 4000
    });

    const translation = response.choices[0].message.content.trim();
    console.log('[TRANSCRIBE] Translation complete:', translation.length, 'chars');
    return translation;
  } catch (error) {
    console.error('[TRANSCRIBE] Translation error:', error.message);
    return null;
  }
}

/**
 * Main function: Transcribe audio to romanized Hindi, then translate to English
 * @param {string} audioFilePath - Path to the audio file
 * @param {Object} options - { videoTitle }
 * @returns {Promise<Array>} Array of segments with romanized + english
 */
async function transcribeAndTranslate(audioFilePath, options = {}) {
  const { videoTitle = '' } = options;

  console.log(`[TRANSCRIBE] Starting transcription: ${audioFilePath}`);
  console.log(`[TRANSCRIBE] Video title: ${videoTitle || '(none)'}`);

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
    // Step 1: Transcribe audio with Whisper
    console.log('[TRANSCRIBE] Step 1: Calling Whisper...');

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(audioFilePath),
      model: 'whisper-large-v3',
      language: 'hi',  // Tell Whisper it's Hindi
      prompt: videoTitle
        ? `Hindi Bollywood song "${videoTitle}". Transcribe the sung Hindi lyrics in romanized form (English letters).`
        : 'Hindi Bollywood song lyrics. Transcribe in romanized Hindi (English letters).',
      response_format: 'verbose_json',
      temperature: 0.0
    });

    let rawText = transcription.text || '';
    console.log('[TRANSCRIBE] Whisper returned:', rawText.length, 'chars');

    if (rawText.length > 0) {
      console.log('[TRANSCRIBE] First 300 chars:', rawText.substring(0, 300));
    }

    // Step 2: Check for garbage before processing further
    if (isGarbageTranscription(rawText, transcription.duration)) {
      console.log('[TRANSCRIBE] Initial transcription is garbage, rejecting');
      throw new Error('Could not extract meaningful lyrics from audio. The video may have a long intro or no clear vocals.');
    }

    // Step 3: Check if Whisper output Devanagari (it often does for Hindi)
    let romanizedText = rawText;

    if (hasDevanagari(rawText)) {
      console.log('[TRANSCRIBE] Step 2: Whisper output Devanagari, transliterating...');
      romanizedText = await transliterateToRomanized(rawText, videoTitle);

      if (!romanizedText || romanizedText.length < 50) {
        throw new Error('Failed to transliterate Hindi script to romanized text');
      }
    } else {
      console.log('[TRANSCRIBE] Whisper output is already romanized');
    }

    // Step 4: Clean up any remaining garbage after transliteration
    if (isGarbageTranscription(romanizedText)) {
      console.log('[TRANSCRIBE] Post-transliteration text is garbage, rejecting');
      throw new Error('Could not extract meaningful lyrics from audio.');
    }

    // Step 5: Translate romanized Hindi to English
    console.log('[TRANSCRIBE] Step 3: Translating to English...');
    const englishText = await translateToEnglish(romanizedText, videoTitle);

    if (!englishText) {
      throw new Error('Translation to English failed');
    }

    // Step 6: Build segments with both romanized and english
    const romanizedLines = romanizedText.split('\n').filter(l => l.trim());
    const englishLines = englishText.split('\n').filter(l => l.trim());

    // Use Whisper's duration if available
    const duration = transcription.duration || 300;
    const lineCount = Math.max(romanizedLines.length, 1);
    const timePerLine = duration / lineCount;

    const segments = romanizedLines.map((romanized, idx) => ({
      id: idx,
      start: idx * timePerLine,
      end: (idx + 1) * timePerLine,
      romanized: romanized.trim(),
      english: englishLines[idx]?.trim() || '',
      // For backwards compatibility with existing frontend
      text: englishLines[idx]?.trim() || romanized.trim()
    }));

    console.log(`[TRANSCRIBE] Success! Created ${segments.length} segments`);
    console.log(`[TRANSCRIBE] Sample segment:`, segments[0]);

    return segments;

  } catch (error) {
    console.error('[TRANSCRIBE] Error:', error);

    if (error.status === 401) {
      throw new Error('Invalid Groq API key');
    } else if (error.status === 429) {
      throw new Error('Rate limit exceeded. Please try again later.');
    } else if (error.message.includes('garbage') || error.message.includes('meaningful') || error.message.includes('transliterate')) {
      throw error;  // Re-throw our custom errors
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
  formatTime,
  isGarbageTranscription,
  hasDevanagari,
  transliterateToRomanized
};
