/**
 * Translation Routes
 *
 * Handles the translation API endpoints for receiving YouTube URLs
 * and checking job status.
 * Now includes authentication and usage tracking.
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const jobManager = require('../services/jobManager');
const youtubeService = require('../services/youtube');
const transcribeService = require('../services/transcribe');
const lyricsService = require('../services/lyrics');
const userStorage = require('../services/userStorage');
const { requireAuth, getUserEmail } = require('../middleware/auth');
const fs = require('fs').promises;

// YouTube URL validation regex
const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/)|youtu\.be\/)[a-zA-Z0-9_-]{11}/;

/**
 * POST /api/translate
 * Start a new translation job
 * Protected: Requires Clerk authentication
 */
router.post('/translate', requireAuth, async (req, res) => {
  try {
    const { youtubeUrl } = req.body;
    const userId = req.userId;

    console.log(`[TRANSLATE] Request from user: ${userId}`);

    // Validate request body
    if (!youtubeUrl) {
      console.log('[TRANSLATE] Error: No YouTube URL provided');
      return res.status(400).json({
        error: 'Missing required field',
        message: 'youtubeUrl is required'
      });
    }

    // Validate YouTube URL format
    if (!YOUTUBE_URL_REGEX.test(youtubeUrl)) {
      console.log(`[TRANSLATE] Error: Invalid YouTube URL: ${youtubeUrl}`);
      return res.status(400).json({
        error: 'Invalid URL',
        message: 'Please provide a valid YouTube URL'
      });
    }

    console.log(`[TRANSLATE] Received request for: ${youtubeUrl}`);

    // Get user email and ensure user exists in storage
    const email = await getUserEmail(userId);
    await userStorage.getOrCreateUser(userId, email);

    // Check if yt-dlp is installed
    const ytdlpInstalled = await youtubeService.checkYtDlpInstalled();
    if (!ytdlpInstalled) {
      console.log('[TRANSLATE] Error: yt-dlp is not installed');
      return res.status(500).json({
        error: 'Server configuration error',
        message: 'yt-dlp is not installed on the server. Please install it first.'
      });
    }

    // Check video duration BEFORE processing to verify usage limits
    console.log(`[TRANSLATE] Checking video duration for usage limits...`);
    let duration;
    try {
      duration = await youtubeService.getVideoDuration(youtubeUrl);
      console.log(`[TRANSLATE] Video duration: ${duration} seconds`);
    } catch (durationError) {
      console.log(`[TRANSLATE] Error getting duration: ${durationError.message}`);
      return res.status(400).json({
        error: 'Video error',
        message: durationError.message
      });
    }

    // Limit to 15 minutes (900 seconds) per video
    if (duration > 900) {
      console.log(`[TRANSLATE] Video too long: ${duration} seconds`);
      return res.status(400).json({
        error: 'video_too_long',
        message: `Video is too long (${Math.round(duration / 60)} minutes). Maximum allowed is 15 minutes per video.`
      });
    }

    // Check user's remaining minutes BEFORE processing
    const usageCheck = await userStorage.checkUsageLimit(userId, duration);
    if (!usageCheck.canTranslate) {
      console.log(`[TRANSLATE] Usage limit check failed for user ${userId}`);
      return res.status(403).json(usageCheck.error);
    }

    // Create a new job with user ID
    const jobId = uuidv4();
    jobManager.createJob(jobId, youtubeUrl);
    // Store userId with the job for later deduction
    const job = jobManager.getJob(jobId);
    job.userId = userId;
    job.videoDuration = duration;
    console.log(`[TRANSLATE] Created job: ${jobId} for user: ${userId}`);

    // Get current usage for response
    const { remaining, used, limit } = await userStorage.getRemainingMinutes(userId);

    // Start processing in background (don't await)
    processTranslation(jobId, youtubeUrl, userId, duration);

    // Return job ID immediately with usage info
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
    console.error('[TRANSLATE] Unexpected error:', error);
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

  console.log(`[STATUS] Checking status for job: ${jobId}`);

  const job = jobManager.getJob(jobId);

  if (!job) {
    console.log(`[STATUS] Job not found: ${jobId}`);
    return res.status(404).json({
      error: 'Job not found',
      message: `No job found with ID: ${jobId}`
    });
  }

  // Build response based on job status
  const response = {
    jobId: job.id,
    status: job.status,
    progress: job.progress
  };

  // Include transcript if complete
  if (job.status === 'complete') {
    response.transcript = job.transcript;
    response.duration = job.duration;
    // Include transcription source (lyrics_db or groq_fallback)
    if (job.transcription_source) {
      response.transcription_source = job.transcription_source;
    }
    // Include usage info if available
    if (job.minutes_used !== undefined) {
      response.minutes_used = job.minutes_used;
      response.minutes_remaining = job.minutes_remaining;
    }
  }

  // Include error if failed
  if (job.status === 'error') {
    response.error = job.error;
  }

  console.log(`[STATUS] Job ${jobId}: ${job.status} (${job.progress}%)`);
  res.json(response);
});

/**
 * Process the translation job asynchronously
 * Uses lyrics database first, falls back to Groq transcription
 * @param {string} jobId - The job ID
 * @param {string} youtubeUrl - The YouTube URL
 * @param {string} userId - The Clerk user ID
 * @param {number} duration - Video duration in seconds (already validated)
 */
async function processTranslation(jobId, youtubeUrl, userId, duration) {
  let audioFilePath = null;
  let transcriptionSource = 'groq_fallback'; // Default to Groq

  try {
    // Step 1: Get video metadata for lyrics search
    console.log(`[JOB ${jobId}] Getting video metadata...`);
    jobManager.updateJob(jobId, 'downloading', 10);

    const metadata = await youtubeService.getVideoMetadata(youtubeUrl);
    console.log(`[JOB ${jobId}] Video title: ${metadata.title}`);

    // Step 2: Try to find lyrics first
    console.log(`[JOB ${jobId}] Searching for lyrics...`);
    jobManager.updateJob(jobId, 'downloading', 20);

    let transcript = null;
    const lyricsResult = await lyricsService.searchLyrics(metadata.title, duration);

    if (lyricsResult.found) {
      // Lyrics found! Use them instead of Groq
      console.log(`[JOB ${jobId}] ✓ LYRICS FOUND (source: ${lyricsResult.source})`);
      transcript = lyricsResult.segments;
      transcriptionSource = `lyrics_db:${lyricsResult.source}`;
      jobManager.updateJob(jobId, 'transcribing', 80);
    } else {
      // No lyrics found, fall back to Groq
      console.log(`[JOB ${jobId}] No lyrics found, using Groq fallback...`);

      // Step 3: Download audio (only if we need Groq)
      console.log(`[JOB ${jobId}] Downloading audio...`);
      jobManager.updateJob(jobId, 'downloading', 30);

      audioFilePath = await youtubeService.downloadAudio(youtubeUrl, jobId);
      console.log(`[JOB ${jobId}] Audio downloaded to: ${audioFilePath}`);
      jobManager.updateJob(jobId, 'downloading', 50);

      // Step 4: Transcribe and translate with Groq
      console.log(`[JOB ${jobId}] Starting Groq transcription...`);
      jobManager.updateJob(jobId, 'transcribing', 60);

      transcript = await transcribeService.transcribeAndTranslate(audioFilePath);
      transcriptionSource = 'groq_fallback';
    }

    console.log(`[JOB ${jobId}] Transcription complete. Got ${transcript.length} segments. Source: ${transcriptionSource}`);
    jobManager.updateJob(jobId, 'transcribing', 90);

    // Step 5: Deduct minutes from user's usage AFTER successful translation
    let usageInfo = { minutes_used: 0, minutes_remaining: 0 };
    if (userId) {
      try {
        usageInfo = await userStorage.deductMinutes(userId, duration);
        console.log(`[JOB ${jobId}] Deducted ${Math.ceil(duration / 60)} minutes from user ${userId}`);
      } catch (deductError) {
        console.error(`[JOB ${jobId}] Failed to deduct minutes:`, deductError.message);
        // Don't fail the job for usage tracking errors
      }
    }

    // Step 6: Mark as complete with usage info and source
    const job = jobManager.getJob(jobId);
    jobManager.completeJob(jobId, transcript, duration);
    // Add usage info and transcription source to the completed job
    job.minutes_used = usageInfo.minutes_used;
    job.minutes_remaining = usageInfo.minutes_remaining;
    job.transcription_source = transcriptionSource;
    console.log(`[JOB ${jobId}] Job completed successfully! (source: ${transcriptionSource})`);

  } catch (error) {
    console.error(`[JOB ${jobId}] Error:`, error.message);
    jobManager.failJob(jobId, error.message);

  } finally {
    // Clean up audio file (if it was downloaded)
    if (audioFilePath) {
      try {
        await fs.unlink(audioFilePath);
        console.log(`[JOB ${jobId}] Cleaned up audio file: ${audioFilePath}`);
      } catch (cleanupError) {
        console.error(`[JOB ${jobId}] Failed to clean up audio file:`, cleanupError.message);
      }
    }
  }
}

module.exports = router;
