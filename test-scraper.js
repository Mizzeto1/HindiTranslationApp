/**
 * Standalone test for LyricsMint scraper
 * Run with: node test-scraper.js
 */

require('dotenv').config();

// Try to load the scraper
let scraper;
try {
  scraper = require('./services/lyricsMintScraper');
  console.log('✓ lyricsMintScraper.js loaded successfully');
} catch (e) {
  console.log('✗ Failed to load lyricsMintScraper.js:', e.message);

  // Try alternate location
  try {
    scraper = require('./services/lyrics');
    console.log('✓ Using lyrics.js instead');
  } catch (e2) {
    console.log('✗ Failed to load lyrics.js:', e2.message);
    process.exit(1);
  }
}

// Test songs - these definitely exist on LyricsMint
const testCases = [
  { song: 'Tum Hi Ho', artist: 'Arijit Singh' },
  { song: 'Kal Ho Naa Ho', artist: 'Sonu Nigam' },
  { song: 'Chaiyya Chaiyya', artist: 'Sukhwinder Singh' }
];

async function testSearch(song, artist) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: "${song}" by "${artist}"`);
  console.log('='.repeat(60));

  try {
    // Test 1: Search function
    if (scraper.searchLyricsMint) {
      console.log('\n[TEST 1] Testing searchLyricsMint...');
      const pageUrl = await scraper.searchLyricsMint(song, artist);

      if (pageUrl) {
        console.log(`✓ Found page URL: ${pageUrl}`);
      } else {
        console.log('✗ searchLyricsMint returned null/undefined');
        return;
      }

      // Test 2: Scrape function
      if (scraper.scrapeLyricsPage) {
        console.log('\n[TEST 2] Testing scrapeLyricsPage...');
        const lyrics = await scraper.scrapeLyricsPage(pageUrl);

        if (lyrics) {
          console.log('✓ scrapeLyricsPage returned data:');
          console.log(`  - romanizedLyrics: ${lyrics.romanizedLyrics ? lyrics.romanizedLyrics.substring(0, 100) + '...' : 'NULL'}`);
          console.log(`  - hindiLyrics: ${lyrics.hindiLyrics ? lyrics.hindiLyrics.substring(0, 100) + '...' : 'NULL'}`);
          console.log(`  - needsTransliteration: ${lyrics.needsTransliteration}`);
        } else {
          console.log('✗ scrapeLyricsPage returned null/undefined');
        }
      }
    }

    // Test 3: Main fetchLyrics function
    if (scraper.fetchLyrics) {
      console.log('\n[TEST 3] Testing fetchLyrics (main function)...');
      const result = await scraper.fetchLyrics(song, artist);

      if (result) {
        console.log('✓ fetchLyrics returned data:');
        console.log(`  - romanizedLyrics: ${result.romanizedLyrics ? 'EXISTS (' + result.romanizedLyrics.length + ' chars)' : 'NULL'}`);
        console.log(`  - hindiLyrics: ${result.hindiLyrics ? 'EXISTS (' + result.hindiLyrics.length + ' chars)' : 'NULL'}`);

        if (result.romanizedLyrics) {
          console.log('\n  First 3 lines of romanized lyrics:');
          const lines = result.romanizedLyrics.split('\n').slice(0, 3);
          lines.forEach((line, i) => console.log(`    ${i + 1}. ${line}`));
        }
      } else {
        console.log('✗ fetchLyrics returned null/undefined');
      }
    }

  } catch (error) {
    console.log(`\n✗ ERROR: ${error.message}`);
    console.log('Stack:', error.stack);
  }
}

async function testDirectFetch() {
  console.log(`\n${'='.repeat(60)}`);
  console.log('Testing direct HTTP fetch to LyricsMint');
  console.log('='.repeat(60));

  const testUrl = 'https://www.lyricsmint.com/?s=tum+hi+ho';

  try {
    console.log(`\nFetching: ${testUrl}`);

    const response = await fetch(testUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    console.log(`Status: ${response.status}`);
    console.log(`Content-Type: ${response.headers.get('content-type')}`);

    if (response.ok) {
      const html = await response.text();
      console.log(`HTML length: ${html.length} chars`);
      console.log(`Contains 'lyrics': ${html.toLowerCase().includes('lyrics')}`);
      console.log(`Contains 'Tum Hi Ho': ${html.includes('Tum Hi Ho') || html.includes('tum hi ho')}`);

      // Check for common block indicators
      if (html.includes('blocked') || html.includes('captcha') || html.includes('cloudflare')) {
        console.log('⚠ WARNING: Page may be blocked or showing captcha');
      }

      // Save HTML for debugging
      require('fs').writeFileSync('lyricsmint-search-debug.html', html);
      console.log('Saved search page HTML to lyricsmint-search-debug.html');
    } else {
      console.log(`✗ HTTP Error: ${response.status}`);
    }
  } catch (error) {
    console.log(`✗ Fetch failed: ${error.message}`);
  }
}

async function runAllTests() {
  console.log('LyricsMint Scraper Diagnostic Test');
  console.log('==================================\n');

  // First test if we can even reach LyricsMint
  await testDirectFetch();

  // Then test the scraper functions
  for (const { song, artist } of testCases) {
    await testSearch(song, artist);
  }

  console.log('\n\n' + '='.repeat(60));
  console.log('TESTS COMPLETE');
  console.log('='.repeat(60));
}

runAllTests().catch(console.error);
