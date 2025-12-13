/**
 * YouTube Translation API - Main Server
 *
 * This server accepts YouTube URLs and returns English translations
 * of Hindi, Punjabi, and other languages using Groq's Whisper API.
 *
 * Now includes:
 * - Clerk authentication
 * - Freemium subscription model with Stripe
 * - Usage tracking and limits
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const translateRoutes = require('./routes/translate');
const subscriptionRoutes = require('./routes/subscription');

const app = express();
const PORT = process.env.PORT || 3001;

// Get frontend URL from env, default to localhost:3000
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Middleware
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, etc)
    if (!origin) return callback(null, true);

    // Allow configured frontend URL
    if (origin === FRONTEND_URL) return callback(null, true);

    // Allow localhost for development
    if (origin.startsWith('http://localhost:')) return callback(null, true);

    // For production, you might want to be stricter
    // For now, allow all origins for flexibility
    callback(null, true);
  },
  credentials: true, // Allow cookies and authorization headers
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'ngrok-skip-browser-warning',
    'bypass-tunnel-reminder',
    'X-Requested-With'
  ]
}));

// IMPORTANT: Stripe webhook needs raw body, must come BEFORE express.json()
// The subscription routes handle this internally with express.raw()
app.use('/api/webhook', express.raw({ type: 'application/json' }));

// Parse JSON for all other routes
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/api', translateRoutes);
app.use('/api', subscriptionRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'YouTube Translation API',
    version: '2.0.0',
    description: 'Translates Hindi, Punjabi, and 50+ languages to English',
    features: [
      'Clerk authentication',
      'Freemium model (30 min/month free, 15 hrs/month premium)',
      'Stripe subscription management'
    ],
    endpoints: {
      // Search (no auth required)
      search_songs: 'POST /api/search-songs',
      // Translation (requires auth)
      translate: 'POST /api/translate',
      status: 'GET /api/status/:jobId',
      // Subscription (requires auth except webhook)
      subscription_status: 'GET /api/subscription-status',
      create_checkout: 'POST /api/create-checkout-session',
      create_portal: 'POST /api/create-portal-session',
      stripe_webhook: 'POST /api/webhook',
      // Health
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
  console.log('   YouTube Translation API Server v2.0');
  console.log('   With Clerk Auth & Stripe Subscriptions');
  console.log('========================================');
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Frontend URL: ${FRONTEND_URL}`);
  console.log('');
  console.log('Translation endpoints (requires auth):');
  console.log(`  POST http://localhost:${PORT}/api/translate`);
  console.log(`  GET  http://localhost:${PORT}/api/status/:jobId`);
  console.log('');
  console.log('Subscription endpoints:');
  console.log(`  GET  http://localhost:${PORT}/api/subscription-status`);
  console.log(`  POST http://localhost:${PORT}/api/create-checkout-session`);
  console.log(`  POST http://localhost:${PORT}/api/create-portal-session`);
  console.log(`  POST http://localhost:${PORT}/api/webhook (Stripe)`);
  console.log('');
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log('========================================');

  // Environment check
  const envVars = ['CLERK_SECRET_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_ID'];
  const missingVars = envVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    console.log('');
    console.log('\x1b[33m%s\x1b[0m', '⚠️  Warning: Missing environment variables:');
    missingVars.forEach(v => console.log(`   - ${v}`));
    console.log('');
  }
});
