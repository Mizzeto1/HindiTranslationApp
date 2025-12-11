/**
 * Translation Routes
 *
 * Handles the translation API endpoints for receiving YouTube URLs
 * and checking job status.
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const jobManager = require('../services/jobManager');
const youtubeService = require('../services/youtube');
const transcribeService = require('../services/transcribe');
const fs = require('fs').promises;

// YouTube URL validation regex
const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/)|youtu\.be\/)[a-zA-Z0-9_-]{11}/;

/**
 * POST /api/translate
 * Start a new translation job
 */
router.post('/translate', async (req, res) => {
  try {
    const { youtubeUrl } = req.body;

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

    // Check if yt-dlp is installed
    const ytdlpInstalled = await youtubeService.checkYtDlpInstalled();
    if (!ytdlpInstalled) {
      console.log('[TRANSLATE] Error: yt-dlp is not installed');
      return res.status(500).json({
        error: 'Server configuration error',
        message: 'yt-dlp is not installed on the server. Please install it first.'
      });
    }

    // Create a new job
    const jobId = uuidv4();
    jobManager.createJob(jobId, youtubeUrl);
    console.log(`[TRANSLATE] Created job: ${jobId}`);

    // Start processing in background (don't await)
    processTranslation(jobId, youtubeUrl);

    // Return job ID immediately
    res.status(202).json({
      jobId,
      status: 'pending',
      message: 'Translation job started'
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
 */
async function processTranslation(jobId, youtubeUrl) {
  let audioFilePath = null;

  try {
    // Step 1: Check video duration
    console.log(`[JOB ${jobId}] Checking video duration...`);
    jobManager.updateJob(jobId, 'downloading', 10);

    const duration = await youtubeService.getVideoDuration(youtubeUrl);
    console.log(`[JOB ${jobId}] Video duration: ${duration} seconds`);

    // Limit to 15 minutes (900 seconds)
    if (duration > 900) {
      throw new Error(`Video is too long (${Math.round(duration / 60)} minutes). Maximum allowed is 15 minutes.`);
    }

    // Step 2: Download audio
    console.log(`[JOB ${jobId}] Downloading audio...`);
    jobManager.updateJob(jobId, 'downloading', 30);

    audioFilePath = await youtubeService.downloadAudio(youtubeUrl, jobId);
    console.log(`[JOB ${jobId}] Audio downloaded to: ${audioFilePath}`);
    jobManager.updateJob(jobId, 'downloading', 50);

    // Step 3: Transcribe and translate
    console.log(`[JOB ${jobId}] Starting transcription...`);
    jobManager.updateJob(jobId, 'transcribing', 60);

    const transcript = await transcribeService.transcribeAndTranslate(audioFilePath);
    console.log(`[JOB ${jobId}] Transcription complete. Got ${transcript.length} segments.`);
    jobManager.updateJob(jobId, 'transcribing', 90);

    // Step 4: Mark as complete
    jobManager.completeJob(jobId, transcript, duration);
    console.log(`[JOB ${jobId}] Job completed successfully!`);

  } catch (error) {
    console.error(`[JOB ${jobId}] Error:`, error.message);
    jobManager.failJob(jobId, error.message);

  } finally {
    // Clean up audio file
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
