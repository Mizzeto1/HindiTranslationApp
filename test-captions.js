require('dotenv').config();
const { getYouTubeCaptions } = require('./services/youtube');

async function test() {
  // Test with popular Bollywood songs that likely have captions
  const testUrls = [
    'https://www.youtube.com/watch?v=Umqb9KENgmk', // Tum Hi Ho - official T-Series
    'https://www.youtube.com/watch?v=cYOB941gyXI', // Kal Ho Naa Ho
  ];

  for (const url of testUrls) {
    console.log('\n' + '='.repeat(60));
    console.log('Testing:', url);
    console.log('='.repeat(60));

    const result = await getYouTubeCaptions(url);

    if (result) {
      console.log('✓ Found captions!');
      console.log('  Segments:', result.segments.length);
      console.log('  Devanagari:', result.isDevanagari);
      console.log('  Source:', result.source);
      console.log('  First 3 segments:');
      result.segments.slice(0, 3).forEach((s, i) => {
        console.log(`    ${i + 1}. [${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s] ${s.text.substring(0, 60)}${s.text.length > 60 ? '...' : ''}`);
      });
    } else {
      console.log('✗ No captions found');
    }
  }
}

test().catch(console.error);
