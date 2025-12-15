/**
 * YouTube Service - SIMPLIFIED
 *
 * Does THREE things:
 * 1. Search YouTube (for /api/search-songs) - KEEP AS-IS
 * 2. Get video metadata (title, duration)
 * 3. Download audio
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Get video metadata
 */
async function getVideoMetadata(youtubeUrl) {
  console.log('[YOUTUBE] Getting metadata for:', youtubeUrl);

  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      youtubeUrl
    ];

    const proc = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error('[YOUTUBE] Metadata error:', stderr);
        return reject(new Error('Failed to get video info'));
      }

      try {
        const info = JSON.parse(stdout);
        const metadata = {
          title: info.title || 'Unknown',
          duration: info.duration || 0,
          channel: info.channel || info.uploader || 'Unknown'
        };
        console.log('[YOUTUBE] Metadata:', metadata.title, '(' + metadata.duration + 's)');
        resolve(metadata);
      } catch (e) {
        reject(new Error('Failed to parse video info'));
      }
    });
  });
}

/**
 * Download audio from YouTube
 */
async function downloadAudio(youtubeUrl, jobId) {
  console.log('[YOUTUBE] Downloading audio for job:', jobId);

  const tempDir = os.tmpdir();
  const outputPath = path.join(tempDir, `${jobId}.m4a`);

  return new Promise((resolve, reject) => {
    const args = [
      '-x',                              // Extract audio
      '-f', 'bestaudio[ext=m4a]/bestaudio',
      '-o', outputPath,
      '--no-playlist',
      '--no-warnings',
      '--max-filesize', '25M',           // Limit file size
      youtubeUrl
    ];

    console.log('[YOUTUBE] Running yt-dlp...');
    const proc = spawn('yt-dlp', args);
    let stderr = '';

    proc.stderr.on('data', (data) => { stderr += data; });

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error('[YOUTUBE] Download error:', stderr);
        return reject(new Error('Failed to download audio'));
      }

      // Find the actual output file (extension might vary)
      const possibleExtensions = ['.m4a', '.webm', '.mp3', '.opus'];
      let actualPath = outputPath;

      for (const ext of possibleExtensions) {
        const testPath = outputPath.replace('.m4a', ext);
        if (fs.existsSync(testPath)) {
          actualPath = testPath;
          break;
        }
      }

      if (!fs.existsSync(actualPath)) {
        // Check without extension replacement
        const basePath = outputPath.replace('.m4a', '');
        for (const ext of possibleExtensions) {
          if (fs.existsSync(basePath + ext)) {
            actualPath = basePath + ext;
            break;
          }
        }
      }

      if (!fs.existsSync(actualPath)) {
        return reject(new Error('Audio file not found after download'));
      }

      console.log('[YOUTUBE] Downloaded:', actualPath);
      resolve(actualPath);
    });
  });
}

/**
 * Search YouTube (for search feature)
 */
async function searchYouTube(query, maxResults = 10) {
  console.log('[YOUTUBE] Searching:', query);

  // Use YouTube API if available
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (apiKey) {
    try {
      return await searchWithApi(query, maxResults, apiKey);
    } catch (error) {
      console.log('[YOUTUBE] API search failed, falling back to yt-dlp:', error.message);
    }
  }

  return new Promise((resolve, reject) => {
    const args = [
      `ytsearch${maxResults}:${query} hindi song`,
      '--dump-json',
      '--flat-playlist',
      '--no-warnings'
    ];

    const proc = spawn('yt-dlp', args);
    let stdout = '';

    proc.stdout.on('data', (data) => { stdout += data; });

    proc.on('close', (code) => {
      if (code !== 0) {
        return resolve([]);  // Return empty on error
      }

      try {
        const results = stdout
          .trim()
          .split('\n')
          .filter(line => line.trim())
          .map(line => {
            const data = JSON.parse(line);
            return {
              id: data.id,
              title: data.title,
              url: `https://www.youtube.com/watch?v=${data.id}`,
              duration: data.duration,
              channel: data.channel || data.uploader
            };
          })
          .filter(r => r.id && r.title);

        console.log('[YOUTUBE] Found', results.length, 'results');
        resolve(results);
      } catch (e) {
        resolve([]);
      }
    });
  });
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
  url.searchParams.set('q', query + ' hindi song');
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
    id: item.id.videoId,
    title: item.snippet.title,
    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
    channel: item.snippet.channelTitle,
    thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url
  }));

  console.log(`[YOUTUBE] API returned ${results.length} results`);
  return results;
}

module.exports = {
  getVideoMetadata,
  downloadAudio,
  searchYouTube
};
