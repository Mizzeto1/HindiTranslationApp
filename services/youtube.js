/**
 * YouTube Service
 *
 * Handles downloading audio from YouTube videos using yt-dlp.
 */

const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const util = require('util');

const execPromise = util.promisify(exec);

// Temp directory for audio files
const TEMP_DIR = path.join(__dirname, '..', 'temp');

// Local bin directory for yt-dlp
const LOCAL_BIN = path.join(__dirname, '..', 'bin', 'yt-dlp');

/**
 * Get the yt-dlp command path - prefers local bin, falls back to system PATH
 */
function getYtDlpPath() {
  // Check if local binary exists
  if (fsSync.existsSync(LOCAL_BIN)) {
    console.log('[YOUTUBE] Using local yt-dlp:', LOCAL_BIN);
    return LOCAL_BIN;
  }
  // Fall back to system PATH
  console.log('[YOUTUBE] Using system yt-dlp');
  return 'yt-dlp';
}

/**
 * Check if yt-dlp is installed on the system
 * @returns {Promise<boolean>} True if yt-dlp is installed
 */
async function checkYtDlpInstalled() {
  const ytdlp = getYtDlpPath();
  try {
    const { stdout } = await execPromise(`"${ytdlp}" --version`);
    console.log(`[YOUTUBE] yt-dlp is installed, version: ${stdout.trim()}`);
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
  const ytdlp = getYtDlpPath();
  try {
    console.log('[YOUTUBE] Getting video duration...');

    const { stdout } = await execPromise(
      `"${ytdlp}" --get-duration "${youtubeUrl}"`,
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
    console.error('[YOUTUBE] Duration error details:', error.stderr || error.stack || '(no details)');

    // Try to provide a more specific error message
    const errorStr = String(error.message || error.stderr || '').toLowerCase();
    if (errorStr.includes('unavailable') || errorStr.includes('private')) {
      throw new Error('Video is unavailable or private');
    } else if (errorStr.includes('age') || errorStr.includes('sign in')) {
      throw new Error('Video is age-restricted');
    } else if (errorStr.includes('not found') || errorStr.includes('404')) {
      throw new Error('Video not found. Please check the URL.');
    }

    // If we can't get duration, assume it's acceptable (will fail later if too long)
    console.log('[YOUTUBE] Proceeding without duration check');
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
  const ytdlp = getYtDlpPath();

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

    console.log(`[YOUTUBE] Running: ${ytdlp} ${args.join(' ')}`);

    const ytProcess = spawn(ytdlp, args);

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
        console.error(`[YOUTUBE] stdout: ${stdout}`);

        // Parse common errors with more specific messages
        const stderrLower = stderr.toLowerCase();
        const stdoutLower = stdout.toLowerCase();
        const combined = stderrLower + stdoutLower;

        if (combined.includes('video unavailable') || combined.includes('private video')) {
          reject(new Error('Video is unavailable or private. Please check the URL.'));
        } else if (combined.includes('sign in to confirm your age') || combined.includes('age-restricted')) {
          reject(new Error('Video is age-restricted and cannot be downloaded.'));
        } else if (combined.includes('copyright') || combined.includes('blocked')) {
          reject(new Error('Video is blocked due to copyright restrictions.'));
        } else if (combined.includes('premiere') || combined.includes('upcoming')) {
          reject(new Error('Video is an upcoming premiere and not yet available.'));
        } else if (combined.includes('members only') || combined.includes('member-only')) {
          reject(new Error('Video is for channel members only.'));
        } else if (combined.includes('geo restriction') || combined.includes('not available in your country')) {
          reject(new Error('Video is not available in this region.'));
        } else if (combined.includes('removed') || combined.includes('deleted')) {
          reject(new Error('Video has been removed or deleted.'));
        } else if (combined.includes('network') || combined.includes('connection')) {
          reject(new Error('Network error while downloading video. Please try again.'));
        } else if (combined.includes('http error 403') || combined.includes('forbidden')) {
          reject(new Error('Access to video is forbidden. It may be private or region-locked.'));
        } else if (combined.includes('http error 404') || combined.includes('not found')) {
          reject(new Error('Video not found. Please check the URL.'));
        } else {
          // Include first 200 chars of error for debugging
          const errorSnippet = stderr.slice(0, 200) || 'Unknown error';
          reject(new Error(`Failed to download: ${errorSnippet}`));
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

/**
 * Get video metadata (title, channel, etc.)
 * @param {string} youtubeUrl - The YouTube URL
 * @returns {Promise<{title: string, channel: string, description: string}>}
 */
async function getVideoMetadata(youtubeUrl) {
  const ytdlp = getYtDlpPath();
  try {
    console.log('[YOUTUBE] Getting video metadata...');

    const { stdout } = await execPromise(
      `"${ytdlp}" --dump-json --no-download "${youtubeUrl}"`,
      { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    );

    const metadata = JSON.parse(stdout);

    const result = {
      title: metadata.title || '',
      channel: metadata.channel || metadata.uploader || '',
      description: metadata.description || '',
      tags: metadata.tags || []
    };

    console.log(`[YOUTUBE] Video title: ${result.title}`);
    console.log(`[YOUTUBE] Channel: ${result.channel}`);

    return result;

  } catch (error) {
    console.error('[YOUTUBE] Error getting metadata:', error.message);
    return {
      title: '',
      channel: '',
      description: '',
      tags: []
    };
  }
}

/**
 * Search YouTube using the Data API (if key provided) or yt-dlp fallback
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum results to return (default 5)
 * @returns {Promise<Array>} Array of video results
 */
async function searchYouTube(query, maxResults = 5) {
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (apiKey) {
    try {
      return await searchWithApi(query, maxResults, apiKey);
    } catch (error) {
      console.log('[YOUTUBE] API search failed, falling back to yt-dlp:', error.message);
    }
  }

  // Fallback to yt-dlp search
  return await searchWithYtDlp(query, maxResults);
}

/**
 * Search YouTube using the Data API v3
 */
async function searchWithApi(query, maxResults, apiKey) {
  console.log(`[YOUTUBE] Searching with API: "${query}"`);

  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('type', 'video');
  url.searchParams.set('videoCategoryId', '10'); // Music category
  url.searchParams.set('q', query);
  url.searchParams.set('maxResults', maxResults.toString());
  url.searchParams.set('key', apiKey);

  const response = await fetch(url.toString());

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`YouTube API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();

  if (!data.items || data.items.length === 0) {
    console.log('[YOUTUBE] No results from API');
    return [];
  }

  const results = data.items.map(item => ({
    youtubeId: item.id.videoId,
    title: item.snippet.title,
    channel: item.snippet.channelTitle,
    thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
    publishedAt: item.snippet.publishedAt
  }));

  console.log(`[YOUTUBE] API returned ${results.length} results`);
  return results;
}

/**
 * Search YouTube using yt-dlp (no API key needed, but slower)
 */
async function searchWithYtDlp(query, maxResults) {
  const ytdlp = getYtDlpPath();
  console.log(`[YOUTUBE] Searching with yt-dlp: "${query}"`);

  try {
    const { stdout } = await execPromise(
      `"${ytdlp}" "ytsearch${maxResults}:${query}" --dump-json --flat-playlist --no-warnings`,
      { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
    );

    // yt-dlp outputs one JSON object per line
    const lines = stdout.trim().split('\n').filter(line => line.trim());
    const results = [];

    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        results.push({
          youtubeId: item.id,
          title: item.title,
          channel: item.channel || item.uploader || '',
          thumbnail: item.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
          publishedAt: null
        });
      } catch (parseError) {
        // Skip malformed lines
      }
    }

    console.log(`[YOUTUBE] yt-dlp returned ${results.length} results`);
    return results;

  } catch (error) {
    console.error('[YOUTUBE] yt-dlp search error:', error.message);
    return [];
  }
}

/**
 * Try to get subtitles/captions from YouTube video
 * @param {string} videoUrl - YouTube URL
 * @returns {object|null} - { segments, isDevanagari, source } or null if no captions
 */
async function getYouTubeCaptions(videoUrl) {
  const videoId = extractVideoId(videoUrl);
  if (!videoId) {
    console.log('[CAPTIONS] Invalid video URL');
    return null;
  }

  console.log('[CAPTIONS] Checking for captions on video:', videoId);

  try {
    // Ensure temp directory exists
    try {
      await fs.mkdir(TEMP_DIR, { recursive: true });
    } catch (err) {
      // Directory might already exist
    }

    const outputBase = path.join(TEMP_DIR, `${videoId}_subs`);
    const ytdlp = getYtDlpPath();

    // Try to download Hindi and English subtitles
    await execPromise(
      `"${ytdlp}" --write-subs --write-auto-subs --sub-lang hi,en --skip-download -o "${outputBase}" "${videoUrl}"`,
      { timeout: 30000 }
    );

    // Check what subtitle files were created
    const files = fsSync.readdirSync(TEMP_DIR).filter(f =>
      f.startsWith(`${videoId}_subs`) && (f.endsWith('.vtt') || f.endsWith('.srt'))
    );

    if (files.length === 0) {
      console.log('[CAPTIONS] No caption files found');
      return null;
    }

    console.log('[CAPTIONS] Found caption files:', files);

    // Prefer Hindi, fallback to English
    let selectedFile = files.find(f => f.includes('.hi.')) || files[0];
    const filePath = path.join(TEMP_DIR, selectedFile);

    console.log('[CAPTIONS] Using:', selectedFile);

    const content = fsSync.readFileSync(filePath, 'utf-8');

    // Clean up all subtitle files
    files.forEach(f => {
      try { fsSync.unlinkSync(path.join(TEMP_DIR, f)); } catch (e) {}
    });

    // Parse the subtitle file
    const segments = parseSubtitleFile(content);

    if (segments.length < 5) {
      console.log('[CAPTIONS] Too few segments:', segments.length);
      return null;
    }

    // Detect if content is Devanagari or Romanized/English
    const sampleText = segments.slice(0, 5).map(s => s.text).join(' ');
    const isDevanagari = /[\u0900-\u097F]/.test(sampleText);

    console.log('[CAPTIONS] Extracted', segments.length, 'segments, Devanagari:', isDevanagari);

    return {
      segments,
      isDevanagari,
      source: 'youtube_captions'
    };

  } catch (error) {
    console.log('[CAPTIONS] Extraction failed:', error.message);
    return null;
  }
}

/**
 * Extract video ID from YouTube URL
 */
function extractVideoId(url) {
  if (!url) return null;

  // Handle various YouTube URL formats
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/  // Just the ID
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return null;
}

/**
 * Parse VTT or SRT subtitle content into segments
 */
function parseSubtitleFile(content) {
  const segments = [];
  const isVTT = content.includes('WEBVTT');

  if (isVTT) {
    // Parse VTT format
    const lines = content.split('\n');
    let current = null;

    for (const line of lines) {
      // Match timestamp: 00:00:01.000 --> 00:00:04.000
      const timeMatch = line.match(/(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/);

      if (timeMatch) {
        // Save previous segment
        if (current && current.text.trim()) {
          segments.push(current);
        }
        // Start new segment
        current = {
          id: segments.length,
          start: parseTimestamp(timeMatch[1]),
          end: parseTimestamp(timeMatch[2]),
          text: ''
        };
      } else if (current) {
        // Skip metadata lines
        if (line.includes('WEBVTT') || line.match(/^\d+$/) || line.includes('-->')) {
          continue;
        }
        // Clean and add text
        const cleanLine = line
          .replace(/<[^>]+>/g, '')  // Remove HTML/VTT tags
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .trim();

        if (cleanLine) {
          current.text += (current.text ? ' ' : '') + cleanLine;
        }
      }
    }

    // Don't forget last segment
    if (current && current.text.trim()) {
      segments.push(current);
    }

  } else {
    // Parse SRT format
    const blocks = content.split(/\n\n+/);

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 2) continue;

      // Find timestamp line
      const timeLine = lines.find(l => l.includes('-->'));
      if (!timeLine) continue;

      const timeMatch = timeLine.match(/(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})/);
      if (!timeMatch) continue;

      // Get text (everything after timestamp line)
      const timeIdx = lines.indexOf(timeLine);
      const textLines = lines.slice(timeIdx + 1);
      const text = textLines.join(' ').replace(/<[^>]+>/g, '').trim();

      if (text) {
        segments.push({
          id: segments.length,
          start: parseTimestamp(timeMatch[1].replace(',', '.')),
          end: parseTimestamp(timeMatch[2].replace(',', '.')),
          text
        });
      }
    }
  }

  // Deduplicate consecutive identical segments (common in auto-captions)
  const deduped = [];
  for (const seg of segments) {
    if (deduped.length === 0 || deduped[deduped.length - 1].text !== seg.text) {
      deduped.push(seg);
    } else {
      // Extend previous segment's end time
      deduped[deduped.length - 1].end = seg.end;
    }
  }

  return deduped;
}

/**
 * Parse timestamp string (HH:MM:SS.mmm) to seconds
 */
function parseTimestamp(ts) {
  const parts = ts.split(':');
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  const seconds = parseFloat(parts[2]);
  return hours * 3600 + minutes * 60 + seconds;
}

module.exports = {
  checkYtDlpInstalled,
  getVideoDuration,
  downloadAudio,
  cleanupAudioFile,
  getVideoMetadata,
  searchYouTube,
  getYouTubeCaptions,
  parseSubtitleFile,
  parseTimestamp,
  extractVideoId
};
