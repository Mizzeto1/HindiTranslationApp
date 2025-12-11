/**
 * YouTube Service
 *
 * Handles downloading audio from YouTube videos using yt-dlp.
 */

const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const util = require('util');

const execPromise = util.promisify(exec);

// Temp directory for audio files
const TEMP_DIR = path.join(__dirname, '..', 'temp');

/**
 * Check if yt-dlp is installed on the system
 * @returns {Promise<boolean>} True if yt-dlp is installed
 */
async function checkYtDlpInstalled() {
  try {
    await execPromise('yt-dlp --version');
    console.log('[YOUTUBE] yt-dlp is installed');
    return true;
  } catch (error) {
    console.error('[YOUTUBE] yt-dlp is not installed:', error.message);
    return false;
  }
}

/**
 * Get the duration of a YouTube video in seconds
 * @param {string} youtubeUrl - The YouTube URL
 * @returns {Promise<number>} Duration in seconds
 */
async function getVideoDuration(youtubeUrl) {
  try {
    console.log('[YOUTUBE] Getting video duration...');

    const { stdout } = await execPromise(
      `yt-dlp --get-duration "${youtubeUrl}"`,
      { timeout: 30000 }
    );

    const durationStr = stdout.trim();
    console.log(`[YOUTUBE] Raw duration: ${durationStr}`);

    // Parse duration string (formats: "MM:SS", "HH:MM:SS", or just seconds)
    const parts = durationStr.split(':').map(Number);
    let seconds = 0;

    if (parts.length === 3) {
      // HH:MM:SS
      seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      // MM:SS
      seconds = parts[0] * 60 + parts[1];
    } else {
      // Just seconds
      seconds = parts[0];
    }

    console.log(`[YOUTUBE] Parsed duration: ${seconds} seconds`);
    return seconds;

  } catch (error) {
    console.error('[YOUTUBE] Error getting duration:', error.message);
    // If we can't get duration, assume it's acceptable (will fail later if too long)
    return 0;
  }
}

/**
 * Download audio from a YouTube video
 * @param {string} youtubeUrl - The YouTube URL
 * @param {string} jobId - The job ID for naming the file
 * @returns {Promise<string>} Path to the downloaded audio file
 */
async function downloadAudio(youtubeUrl, jobId) {
  // Ensure temp directory exists
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  } catch (err) {
    // Directory might already exist, that's fine
  }

  // Use template for output, yt-dlp will add the correct extension
  const outputTemplate = path.join(TEMP_DIR, `${jobId}.%(ext)s`);
  const expectedPath = path.join(TEMP_DIR, jobId);

  console.log(`[YOUTUBE] Downloading audio from: ${youtubeUrl}`);
  console.log(`[YOUTUBE] Output template: ${outputTemplate}`);

  return new Promise((resolve, reject) => {
    // yt-dlp command to extract audio (keep original format, no conversion needed)
    const args = [
      '-x',                          // Extract audio
      '-f', 'bestaudio[ext=m4a]/bestaudio',  // Prefer m4a, fallback to best
      '-o', outputTemplate,          // Output path template
      '--no-playlist',               // Don't download playlists
      '--no-warnings',               // Suppress warnings
      youtubeUrl
    ];

    console.log(`[YOUTUBE] Running: yt-dlp ${args.join(' ')}`);

    const ytProcess = spawn('yt-dlp', args);

    let stdout = '';
    let stderr = '';

    ytProcess.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      // Log download progress
      if (output.includes('%')) {
        console.log(`[YOUTUBE] ${output.trim()}`);
      }
    });

    ytProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ytProcess.on('close', async (code) => {
      if (code === 0) {
        // Find the downloaded file (could be .m4a, .webm, .opus, etc.)
        try {
          const files = await fs.readdir(TEMP_DIR);
          const audioFile = files.find(f => f.startsWith(jobId));

          if (audioFile) {
            const finalPath = path.join(TEMP_DIR, audioFile);
            console.log(`[YOUTUBE] Download complete: ${finalPath}`);
            resolve(finalPath);
          } else {
            reject(new Error('Audio file not found after download'));
          }
        } catch (err) {
          reject(new Error('Audio file not found after download'));
        }
      } else {
        console.error(`[YOUTUBE] yt-dlp failed with code ${code}`);
        console.error(`[YOUTUBE] stderr: ${stderr}`);

        // Parse common errors
        if (stderr.includes('Video unavailable') || stderr.includes('Private video')) {
          reject(new Error('Video is unavailable or private'));
        } else if (stderr.includes('Sign in to confirm your age')) {
          reject(new Error('Video is age-restricted'));
        } else if (stderr.includes('copyright')) {
          reject(new Error('Video is not available due to copyright restrictions'));
        } else {
          reject(new Error(`Failed to download audio: ${stderr || 'Unknown error'}`));
        }
      }
    });

    ytProcess.on('error', (error) => {
      console.error('[YOUTUBE] Process error:', error);
      reject(new Error(`Failed to start yt-dlp: ${error.message}`));
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      ytProcess.kill();
      reject(new Error('Download timed out after 5 minutes'));
    }, 300000);
  });
}

/**
 * Clean up a downloaded audio file
 * @param {string} filePath - Path to the file to delete
 */
async function cleanupAudioFile(filePath) {
  try {
    await fs.unlink(filePath);
    console.log(`[YOUTUBE] Deleted: ${filePath}`);
  } catch (error) {
    console.error(`[YOUTUBE] Failed to delete ${filePath}:`, error.message);
  }
}

module.exports = {
  checkYtDlpInstalled,
  getVideoDuration,
  downloadAudio,
  cleanupAudioFile
};
