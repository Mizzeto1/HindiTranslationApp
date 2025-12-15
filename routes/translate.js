/**
 * Translation Routes
 *
 * Handles the translation API endpoints:
 * - POST /api/search-songs - Search YouTube (unchanged, works great)
 * - POST /api/translate - Translate a YouTube video
 * - GET /api/status/:jobId - Check job status
 *
 * Uses LRCLIB as primary lyrics source, Whisper as fallback.
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const Groq = require('groq-sdk');
const jobManager = require('../services/jobManager');
const youtubeService = require('../services/youtube');
const transcribeService = require('../services/transcribe');
const lrclib = require('../services/lrclib');
const userStorage = require('../services/userStorage');
const { requireAuth, getUserEmail } = require('../middleware/auth');
const fs = require('fs').promises;

// Initialize Groq for translation
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * Extract and clean YouTube URL to get just the video
 * @param {string} url - Raw YouTube URL from user
 * @returns {string} - Clean YouTube URL
 */
function cleanYouTubeUrl(url) {
  try {
    // Handle youtu.be short URLs
    if (url.includes('youtu.be/')) {
      const match = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
      if (match) {
        return `https://www.youtube.com/watch?v=${match[1]}`;
      }
    }

    // Handle youtube.com URLs
    const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);

    // Handle /shorts/ URLs
    if (urlObj.pathname.includes('/shorts/')) {
      const videoId = urlObj.pathname.split('/shorts/')[1]?.slice(0, 11);
      if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    }

    // Handle /embed/ and /v/ URLs
    if (urlObj.pathname.includes('/embed/') || urlObj.pathname.includes('/v/')) {
      const pathParts = urlObj.pathname.split('/');
      const videoId = pathParts[pathParts.length - 1]?.slice(0, 11);
      if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    }

    // Handle standard watch URLs
    const videoId = urlObj.searchParams.get('v');
    if (videoId) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }

    return url;
  } catch (error) {
    console.log('[TRANSLATE] Could not clean URL, using original:', url);
    return url;
  }
}

/**
 * Extract video ID from any YouTube URL format
 * @param {string} url - YouTube URL
 * @returns {string|null} - Video ID or null
 */
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/ // Just the video ID itself
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * POST /api/search-songs
 * Search for Hindi/Bollywood songs on YouTube
 * Public endpoint (no auth required for search)
 */
router.post('/search-songs', async (req, res) => {
  try {
    const { query } = req.body;

    if (!query || query.length < 2) {
      return res.status(400).json({
        error: 'Invalid query',
        message: 'Search query must be at least 2 characters'
      });
    }

    console.log(`[SEARCH] Searching for: "${query}"`);

    let results;
    try {
      results = await youtubeService.searchYouTube(query, 5);
    } catch (searchError) {
      console.error('[SEARCH] YouTube search error:', searchError.message);
      return res.status(500).json({
        error: 'YouTube search failed',
        message: 'Could not search YouTube. Please try pasting a URL directly.'
      });
    }

    if (!results || results.length === 0) {
      return res.json({
        selected: null,
        alternatives: [],
        message: 'No results found'
      });
    }

    // Format results
    const formattedResults = results.map(r => ({
      youtubeId: r.id,
      title: r.title,
      url: r.url,
      duration: r.duration,
      channel: r.channel,
      thumbnail: r.thumbnail || `https://i.ytimg.com/vi/${r.id}/mqdefault.jpg`
    }));

    const selected = formattedResults[0];
    console.log(`[SEARCH] Found ${results.length} results, selected: ${selected.title}`);

    res.json({
      selected,
      alternatives: formattedResults.slice(1)
    });

  } catch (error) {
    console.error('[SEARCH] Unexpected error:', error.message);
    res.status(500).json({
      error: 'Search failed',
      message: error.message
    });
  }
});

/**
 * POST /api/translate
 * Start a new translation job
 * Protected: Requires Clerk authentication
 */
router.post('/translate', requireAuth, async (req, res) => {
  try {
    let { youtubeUrl: rawUrl, youtubeId } = req.body;
    const userId = req.userId;

    console.log(`[TRANSLATE] Request from user: ${userId}`);

    // Accept either youtubeUrl or youtubeId
    if (!rawUrl && !youtubeId) {
      return res.status(400).json({
        error: 'Missing required field',
        message: 'Either youtubeUrl or youtubeId is required'
      });
    }

    // If youtubeId provided, construct URL
    if (youtubeId && !rawUrl) {
      rawUrl = `https://www.youtube.com/watch?v=${youtubeId}`;
      console.log(`[TRANSLATE] Constructed URL from ID: ${rawUrl}`);
    }

    // Validate YouTube URL
    const videoId = extractVideoId(rawUrl);
    if (!videoId) {
      return res.status(400).json({
        error: 'Invalid URL',
        message: 'Please provide a valid YouTube URL or ID'
      });
    }

    const youtubeUrl = cleanYouTubeUrl(rawUrl);
    console.log(`[TRANSLATE] Clean URL: ${youtubeUrl}`);

    // Get user email and ensure user exists
    const email = await getUserEmail(userId);
    await userStorage.getOrCreateUser(userId, email);

    // Get video metadata (includes duration)
    console.log(`[TRANSLATE] Getting video metadata...`);
    let metadata;
    try {
      metadata = await youtubeService.getVideoMetadata(youtubeUrl);
      console.log(`[TRANSLATE] Title: ${metadata.title}, Duration: ${metadata.duration}s`);
    } catch (metadataError) {
      return res.status(400).json({
        error: 'Video error',
        message: metadataError.message
      });
    }

    const duration = metadata.duration;

    // Limit to 15 minutes
    if (duration > 900) {
      return res.status(400).json({
        error: 'video_too_long',
        message: `Video is too long (${Math.round(duration / 60)} minutes). Maximum is 15 minutes.`
      });
    }

    // Check usage limits
    const usageCheck = await userStorage.checkUsageLimit(userId, duration);
    if (!usageCheck.canTranslate) {
      return res.status(403).json(usageCheck.error);
    }

    // Create job
    const jobId = uuidv4();
    jobManager.createJob(jobId, youtubeUrl);
    const job = jobManager.getJob(jobId);
    job.userId = userId;
    job.videoDuration = duration;
    job.videoTitle = metadata.title;
    console.log(`[TRANSLATE] Created job: ${jobId}`);

    // Get current usage
    const { remaining, used, limit } = await userStorage.getRemainingMinutes(userId);

    // Start processing in background
    processTranslation(jobId, youtubeUrl, userId, metadata);

    // Return immediately
    res.status(202).json({
      jobId,
      status: 'pending',
      message: 'Translation job started',
      video_duration_minutes: Math.ceil(duration / 60),
      minutes_remaining: remaining,
      minutes_used: used,
      minutes_limit: limit
    });

  } catch (error) {
    console.error('[TRANSLATE] Error:', error);
    res.status(500).json({
      error: 'Server error',
      message: error.message
    });
  }
});

/**
 * GET /api/status/:jobId
 * Check the status of a translation job
 */
router.get('/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobManager.getJob(jobId);

  if (!job) {
    return res.status(404).json({
      error: 'Job not found',
      message: `No job found with ID: ${jobId}`
    });
  }

  const response = {
    jobId: job.id,
    status: job.status,
    progress: job.progress
  };

  if (job.status === 'complete') {
    response.transcript = job.transcript;
    response.duration = job.duration;
    response.source = job.source;
    if (job.minutes_used !== undefined) {
      response.minutes_used = job.minutes_used;
      response.minutes_remaining = job.minutes_remaining;
    }
  }

  if (job.status === 'error') {
    response.error = job.error;
  }

  console.log(`[STATUS] Job ${jobId}: ${job.status} (${job.progress}%)`);
  res.json(response);
});

/**
 * Process translation
 * Tries LRCLIB first (fast), falls back to Whisper (slow)
 */
async function processTranslation(jobId, youtubeUrl, userId, metadata) {
  let audioFilePath = null;
  let source = 'unknown';

  try {
    // Step 1: Try LRCLIB first (free, fast)
    console.log(`[JOB ${jobId}] Trying LRCLIB...`);
    console.log(`[JOB ${jobId}] Original title: "${metadata.title}"`);
    jobManager.updateJob(jobId, 'processing', 20);

    // Clean the title for LRCLIB search
    const cleanedTitle = lrclib.cleanTitle(metadata.title);
    const artist = lrclib.parseArtist(metadata.title);

    // Search LRCLIB with validated results
    const lrcResult = await lrclib.searchLyrics(cleanedTitle, artist);

    let transcript = null;

    if (lrcResult && (lrcResult.syncedLyrics || lrcResult.plainLyrics)) {
      // LRCLIB found lyrics!
      console.log(`[JOB ${jobId}] ✓ LRCLIB found lyrics`);
      source = 'lrclib';
      jobManager.updateJob(jobId, 'processing', 40);

      // Parse into segments
      let segments;
      if (lrcResult.syncedLyrics) {
        segments = lrclib.parseSyncedLyrics(lrcResult.syncedLyrics);
      } else {
        segments = lrclib.parsePlainLyrics(lrcResult.plainLyrics, metadata.duration);
      }

      // Translate segments to English
      jobManager.updateJob(jobId, 'processing', 60);
      transcript = await translateSegments(segments, cleanedTitle);

    } else {
      // Fallback to Whisper
      console.log(`[JOB ${jobId}] LRCLIB: not found, using Whisper...`);
      source = 'whisper';
      jobManager.updateJob(jobId, 'downloading', 30);

      audioFilePath = await youtubeService.downloadAudio(youtubeUrl, jobId);
      console.log(`[JOB ${jobId}] Audio downloaded: ${audioFilePath}`);
      jobManager.updateJob(jobId, 'transcribing', 50);

      transcript = await transcribeService.transcribeAndTranslate(audioFilePath, {
        videoTitle: metadata.title
      });
    }

    console.log(`[JOB ${jobId}] Got ${transcript.length} segments (source: ${source})`);
    jobManager.updateJob(jobId, 'processing', 90);

    // Deduct usage
    let usageInfo = { minutes_used: 0, minutes_remaining: 0 };
    if (userId) {
      try {
        usageInfo = await userStorage.deductMinutes(userId, metadata.duration);
        console.log(`[JOB ${jobId}] Deducted ${Math.ceil(metadata.duration / 60)} minutes`);
      } catch (e) {
        console.error(`[JOB ${jobId}] Usage error:`, e.message);
      }
    }

    // Complete
    const job = jobManager.getJob(jobId);
    jobManager.completeJob(jobId, transcript, metadata.duration);
    job.minutes_used = usageInfo.minutes_used;
    job.minutes_remaining = usageInfo.minutes_remaining;
    job.source = source;

    console.log(`[JOB ${jobId}] ✓ Complete (${source})`);

  } catch (error) {
    console.error(`[JOB ${jobId}] Error:`, error.message);
    jobManager.failJob(jobId, error.message);
  } finally {
    if (audioFilePath) {
      try { await fs.unlink(audioFilePath); } catch (e) {}
    }
  }
}

/**
 * Translate LRCLIB segments to English
 */
async function translateSegments(segments, songTitle) {
  if (!segments.length) return [];

  const allText = segments.map(s => s.text).join('\n');

  // Check if Devanagari - transliterate first
  let romanized = allText;
  if (/[\u0900-\u097F]/.test(allText)) {
    console.log('[TRANSLATE] Transliterating Devanagari...');
    romanized = await transliterate(allText);
  }

  // Translate to English
  console.log('[TRANSLATE] Translating to English...');
  const english = await translateToEnglish(romanized, songTitle);

  const romanizedLines = romanized.split('\n').filter(l => l.trim());
  const englishLines = english.split('\n').filter(l => l.trim());

  return segments.map((seg, i) => ({
    id: i,
    start: seg.start,
    end: seg.end,
    romanized: romanizedLines[i]?.trim() || seg.text,
    english: englishLines[i]?.trim() || '',
    text: englishLines[i]?.trim() || romanizedLines[i]?.trim() || seg.text
  }));
}

/**
 * Transliterate Devanagari to romanized Hindi
 */
async function transliterate(text) {
  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: `Convert Devanagari to romanized Hindi. Output ONLY the romanized text.
Examples: तुम ही हो → Tum hi ho, दिल तो पागल है → Dil to pagal hai`
      },
      { role: 'user', content: text }
    ],
    temperature: 0.1,
    max_tokens: 4000
  });
  return response.choices[0].message.content.trim();
}

/**
 * Translate romanized Hindi to English
 */
async function translateToEnglish(text, songTitle) {
  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: `Translate Hindi lyrics to natural English. Keep same line count. Output ONLY translation.`
      },
      { role: 'user', content: `Translate "${songTitle}":\n\n${text}` }
    ],
    temperature: 0.3,
    max_tokens: 4000
  });
  return response.choices[0].message.content.trim();
}

module.exports = router;
