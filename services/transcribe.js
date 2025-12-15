/**
 * Transcribe Service - SIMPLIFIED
 *
 * Does ONE thing well:
 * YouTube audio → Romanized Hindi → English Translation
 */

const Groq = require('groq-sdk');
const fs = require('fs');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * Check if text contains Devanagari script
 */
function isDevanagari(text) {
  return /[\u0900-\u097F]/.test(text);
}

/**
 * Transliterate Devanagari to romanized Hindi
 */
async function transliterate(devanagariText, songTitle = '') {
  console.log('[TRANSCRIBE] Transliterating Devanagari to romanized...');

  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: `Convert Hindi Devanagari script to romanized Hindi (English letters).
Output ONLY the romanized text. Keep line breaks. No explanations.

Examples:
तुम ही हो → Tum hi ho
चमक छल्लो → Chammak challo
दिल तो पागल है → Dil to pagal hai`
      },
      {
        role: 'user',
        content: devanagariText
      }
    ],
    temperature: 0.1,
    max_tokens: 4000
  });

  let result = response.choices[0].message.content.trim();

  // Remove any remaining Devanagari
  result = result.replace(/[\u0900-\u097F]+/g, '').trim();

  console.log('[TRANSCRIBE] Transliteration done:', result.length, 'chars');
  return result;
}

/**
 * Translate romanized Hindi to English
 */
async function translate(romanizedText, songTitle = '') {
  console.log('[TRANSCRIBE] Translating to English...');

  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: `Translate Hindi song lyrics to natural, poetic English.
Keep the same number of lines. Output ONLY the translation.

Examples:
"Tum hi ho, bas tum hi ho" → "You're the only one, just you"
"Chammak challo" → "Sparkle and shine, girl"
"Dil to pagal hai" → "This heart is crazy in love"`
      },
      {
        role: 'user',
        content: `Translate this song${songTitle ? ` "${songTitle}"` : ''}:\n\n${romanizedText}`
      }
    ],
    temperature: 0.3,
    max_tokens: 4000
  });

  const result = response.choices[0].message.content.trim();
  console.log('[TRANSCRIBE] Translation done:', result.length, 'chars');
  return result;
}

/**
 * Main function: Transcribe and translate audio
 *
 * @param {string} audioFilePath - Path to audio file
 * @param {object} options - { videoTitle }
 * @returns {Array} Segments with { id, start, end, romanized, english }
 */
async function transcribeAndTranslate(audioFilePath, options = {}) {
  const { videoTitle = '' } = options;

  console.log('[TRANSCRIBE] Starting:', audioFilePath);
  console.log('[TRANSCRIBE] Title:', videoTitle || '(none)');

  // Validate
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured');
  }

  const stats = fs.statSync(audioFilePath);
  const sizeMB = stats.size / (1024 * 1024);
  console.log('[TRANSCRIBE] File size:', sizeMB.toFixed(2), 'MB');

  if (sizeMB > 25) {
    throw new Error('Audio file too large (max 25MB)');
  }

  // Step 1: Transcribe with Whisper - USE .segments for real timestamps!
  console.log('[TRANSCRIBE] Step 1: Calling Whisper...');

  const whisperResponse = await groq.audio.transcriptions.create({
    file: fs.createReadStream(audioFilePath),
    model: 'whisper-large-v3',
    language: 'hi',
    prompt: 'Hindi Bollywood song lyrics',
    response_format: 'verbose_json',
    temperature: 0.0
  });

  // USE .segments - has real timestamps!
  const whisperSegments = whisperResponse.segments || [];
  console.log(`[TRANSCRIBE] Whisper returned ${whisperSegments.length} segments`);

  if (whisperSegments.length < 3) {
    throw new Error('Could not transcribe audio - no clear vocals detected');
  }

  // Build result with real timestamps from Whisper
  let segments = whisperSegments.map((seg, i) => ({
    id: i,
    start: seg.start,
    end: seg.end,
    text: seg.text.trim()
  }));

  // Combine all text for batch processing
  const allText = segments.map(s => s.text).join('\n');
  console.log('[TRANSCRIBE] Total text:', allText.length, 'chars');

  // Step 2: Transliterate if Devanagari
  let romanized = allText;

  if (isDevanagari(allText)) {
    console.log('[TRANSCRIBE] Step 2: Text is Devanagari, transliterating...');
    romanized = await transliterate(allText, videoTitle);

    if (!romanized || romanized.length < 20) {
      throw new Error('Transliteration failed');
    }
  } else {
    console.log('[TRANSCRIBE] Step 2: Text already romanized, skipping transliteration');
  }

  // Step 3: Translate to English
  console.log('[TRANSCRIBE] Step 3: Translating to English...');
  const english = await translate(romanized, videoTitle);

  if (!english || english.length < 20) {
    throw new Error('Translation failed');
  }

  // Step 4: Map translations back to segments with real timestamps
  const romanizedLines = romanized.split('\n');
  const englishLines = english.split('\n');

  segments.forEach((seg, i) => {
    seg.romanized = romanizedLines[i]?.trim() || seg.text;
    seg.english = englishLines[i]?.trim() || '';
    seg.text = seg.english || seg.romanized;  // Backwards compatibility
  });

  console.log('[TRANSCRIBE] Success! Created', segments.length, 'segments with real timestamps');
  return segments;
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
  formatTime
};
