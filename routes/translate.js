/**
 * Translation Routes - SIMPLIFIED
 *
 * Handles the translation API endpoints:
 * - POST /api/search-songs - Search YouTube (unchanged, works great)
 * - POST /api/translate - Translate a YouTube video
 * - GET /api/status/:jobId - Check job status
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const jobManager = require('../services/jobManager');
const youtubeService = require('../services/youtube');
const transcribeService = require('../services/transcribe');
const userStorage = require('../services/userStorage');
const { requireAuth, getUserEmail } = require('../middleware/auth');
const fs = require('fs').promises;

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
    processTranslation(jobId, youtubeUrl, userId, duration, metadata.title);

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
 * Process translation - SIMPLIFIED
 * No lyrics database, no scraping, just: Download → Transcribe → Translate
 */
async function processTranslation(jobId, youtubeUrl, userId, duration, videoTitle) {
  let audioFilePath = null;

  try {
    // Step 1: Download audio
    console.log(`[JOB ${jobId}] Downloading audio...`);
    jobManager.updateJob(jobId, 'downloading', 30);

    audioFilePath = await youtubeService.downloadAudio(youtubeUrl, jobId);
    console.log(`[JOB ${jobId}] Audio downloaded: ${audioFilePath}`);

    jobManager.updateJob(jobId, 'transcribing', 50);

    // Step 2: Transcribe and translate
    console.log(`[JOB ${jobId}] Transcribing and translating...`);

    const transcript = await transcribeService.transcribeAndTranslate(audioFilePath, {
      videoTitle: videoTitle
    });

    console.log(`[JOB ${jobId}] Got ${transcript.length} segments`);
    jobManager.updateJob(jobId, 'transcribing', 90);

    // Step 3: Deduct usage
    let usageInfo = { minutes_used: 0, minutes_remaining: 0 };
    if (userId) {
      try {
        usageInfo = await userStorage.deductMinutes(userId, duration);
        console.log(`[JOB ${jobId}] Deducted ${Math.ceil(duration / 60)} minutes`);
      } catch (e) {
        console.error(`[JOB ${jobId}] Usage tracking error:`, e.message);
      }
    }

    // Step 4: Complete
    const job = jobManager.getJob(jobId);
    jobManager.completeJob(jobId, transcript, duration);
    job.minutes_used = usageInfo.minutes_used;
    job.minutes_remaining = usageInfo.minutes_remaining;

    console.log(`[JOB ${jobId}] Complete!`);

  } catch (error) {
    console.error(`[JOB ${jobId}] Error:`, error.message);
    jobManager.failJob(jobId, error.message);

  } finally {
    // Cleanup audio file
    if (audioFilePath) {
      try {
        await fs.unlink(audioFilePath);
        console.log(`[JOB ${jobId}] Cleaned up audio file`);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
}

module.exports = router;
