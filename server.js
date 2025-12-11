/**
 * YouTube Translation API - Main Server
 *
 * This server accepts YouTube URLs and returns English translations
 * of Hindi, Punjabi, and other languages using Groq's Whisper API.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const translateRoutes = require('./routes/translate');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: '*', // Allow all origins for frontend on different domain
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'ngrok-skip-browser-warning',
    'bypass-tunnel-reminder'
  ]
}));
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/api', translateRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'YouTube Translation API',
    version: '1.0.0',
    description: 'Translates Hindi, Punjabi, and 50+ languages to English',
    endpoints: {
      translate: 'POST /api/translate',
      status: 'GET /api/status/:jobId',
      health: 'GET /health'
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${err.message}`);
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// Start server
app.listen(PORT, () => {
  console.log('========================================');
  console.log('   YouTube Translation API Server');
  console.log('   (Hindi, Punjabi, and 50+ languages)');
  console.log('========================================');
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log('');
  console.log('Available endpoints:');
  console.log(`  POST http://localhost:${PORT}/api/translate`);
  console.log(`  GET  http://localhost:${PORT}/api/status/:jobId`);
  console.log('========================================');
});
