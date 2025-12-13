/**
 * User Storage Service
 *
 * Handles user data persistence using PostgreSQL.
 * Falls back to in-memory storage if DATABASE_URL is not set.
 */

const { Pool } = require('pg');

// Usage limits
const FREE_LIMIT_MINUTES = 30;
const PREMIUM_LIMIT_MINUTES = 900; // 15 hours

// Check if PostgreSQL is configured
const USE_POSTGRES = !!process.env.DATABASE_URL;

// PostgreSQL connection pool (only if configured)
let pool = null;
if (USE_POSTGRES) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }  // Required for Railway PostgreSQL
  });
  console.log('[USER_STORAGE] PostgreSQL configured');
}

// In-memory fallback storage (data lost on restart)
const memoryStorage = {};

/**
 * Initialize the database table (PostgreSQL only)
 */
async function initDatabase() {
  if (!USE_POSTGRES) {
    console.log('[USER_STORAGE] No DATABASE_URL - using in-memory storage (data will reset on restart)');
    return;
  }

  try {
    // Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id VARCHAR(255) PRIMARY KEY,
        email VARCHAR(255),
        minutes_used INTEGER DEFAULT 0,
        subscription_status VARCHAR(50) DEFAULT 'free',
        stripe_customer_id VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        reset_date DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Song lyrics cache table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS song_lyrics (
        id SERIAL PRIMARY KEY,
        song_title VARCHAR(255),
        artist_name VARCHAR(255),
        youtube_id VARCHAR(50),
        romanized_lyrics TEXT,
        hindi_lyrics TEXT,
        english_translation TEXT,
        source VARCHAR(50) DEFAULT 'lyricsmint',
        confidence INTEGER DEFAULT 100,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(youtube_id)
      )
    `);

    // Add romanized_lyrics column if it doesn't exist (for existing deployments)
    await pool.query(`
      ALTER TABLE song_lyrics ADD COLUMN IF NOT EXISTS romanized_lyrics TEXT
    `);

    // Full-text search index for song lookup
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_lyrics_search
      ON song_lyrics USING GIN (to_tsvector('simple', song_title || ' ' || COALESCE(artist_name, '')))
    `);

    console.log('[USER_STORAGE] PostgreSQL database initialized');
  } catch (error) {
    console.error('[USER_STORAGE] Database init error:', error.message);
  }
}

// Initialize on startup
initDatabase();

/**
 * Get the reset date for the current month (1st of next month)
 */
function getNextResetDate() {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return nextMonth.toISOString().split('T')[0];
}

/**
 * Check if reset is needed
 */
function checkAndResetIfNeeded(user) {
  const now = new Date();
  const resetDate = new Date(user.reset_date);

  if (now >= resetDate) {
    return { needsReset: true, newResetDate: getNextResetDate() };
  }
  return { needsReset: false };
}

/**
 * Get or create a user record
 */
async function getOrCreateUser(userId, email = null) {
  if (USE_POSTGRES) {
    return getOrCreateUserPostgres(userId, email);
  }
  return getOrCreateUserMemory(userId, email);
}

async function getOrCreateUserPostgres(userId, email) {
  try {
    const result = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);

    if (result.rows.length > 0) {
      const user = result.rows[0];
      const resetCheck = checkAndResetIfNeeded(user);

      if (resetCheck.needsReset) {
        await pool.query(
          'UPDATE users SET minutes_used = 0, reset_date = $1 WHERE user_id = $2',
          [resetCheck.newResetDate, userId]
        );
        user.minutes_used = 0;
        user.reset_date = resetCheck.newResetDate;
      }

      if (email && user.email !== email) {
        await pool.query('UPDATE users SET email = $1 WHERE user_id = $2', [email, userId]);
        user.email = email;
      }

      return user;
    }

    // Create new user
    const newUser = {
      user_id: userId,
      email: email,
      minutes_used: 0,
      subscription_status: 'free',
      stripe_customer_id: null,
      stripe_subscription_id: null,
      reset_date: getNextResetDate()
    };

    await pool.query(
      `INSERT INTO users (user_id, email, minutes_used, subscription_status, reset_date)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, email, 0, 'free', newUser.reset_date]
    );

    console.log(`[USER_STORAGE] Created new user: ${userId}`);
    return newUser;
  } catch (error) {
    console.error('[USER_STORAGE] PostgreSQL error:', error.message);
    throw error;
  }
}

function getOrCreateUserMemory(userId, email) {
  if (!memoryStorage[userId]) {
    memoryStorage[userId] = {
      user_id: userId,
      email: email,
      minutes_used: 0,
      subscription_status: 'free',
      stripe_customer_id: null,
      stripe_subscription_id: null,
      reset_date: getNextResetDate()
    };
    console.log(`[USER_STORAGE] Created new user (memory): ${userId}`);
  } else {
    const user = memoryStorage[userId];
    const resetCheck = checkAndResetIfNeeded(user);
    if (resetCheck.needsReset) {
      user.minutes_used = 0;
      user.reset_date = resetCheck.newResetDate;
    }
    if (email) user.email = email;
  }
  return memoryStorage[userId];
}

/**
 * Get user data by ID
 */
async function getUser(userId) {
  if (USE_POSTGRES) {
    try {
      const result = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
      if (result.rows.length > 0) {
        const user = result.rows[0];
        const resetCheck = checkAndResetIfNeeded(user);
        if (resetCheck.needsReset) {
          await pool.query(
            'UPDATE users SET minutes_used = 0, reset_date = $1 WHERE user_id = $2',
            [resetCheck.newResetDate, userId]
          );
          user.minutes_used = 0;
          user.reset_date = resetCheck.newResetDate;
        }
        return user;
      }
      return null;
    } catch (error) {
      console.error('[USER_STORAGE] Error:', error.message);
      return null;
    }
  }
  return memoryStorage[userId] || null;
}

/**
 * Update user data
 */
async function updateUser(userId, updates) {
  if (USE_POSTGRES) {
    const fields = [];
    const values = [];
    let i = 1;
    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = $${i}`);
      values.push(value);
      i++;
    }
    values.push(userId);
    await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE user_id = $${i}`, values);
    return await getUser(userId);
  }

  if (memoryStorage[userId]) {
    Object.assign(memoryStorage[userId], updates);
  }
  return memoryStorage[userId];
}

/**
 * Get user by Stripe customer ID
 */
async function getUserByStripeCustomerId(stripeCustomerId) {
  if (USE_POSTGRES) {
    try {
      const result = await pool.query(
        'SELECT * FROM users WHERE stripe_customer_id = $1',
        [stripeCustomerId]
      );
      if (result.rows.length > 0) {
        return { userId: result.rows[0].user_id, userData: result.rows[0] };
      }
      return null;
    } catch (error) {
      console.error('[USER_STORAGE] Error:', error.message);
      return null;
    }
  }

  for (const [id, user] of Object.entries(memoryStorage)) {
    if (user.stripe_customer_id === stripeCustomerId) {
      return { userId: id, userData: user };
    }
  }
  return null;
}

/**
 * Get remaining minutes for a user
 */
async function getRemainingMinutes(userId) {
  const user = await getOrCreateUser(userId);
  const limit = user.subscription_status === 'premium' ? PREMIUM_LIMIT_MINUTES : FREE_LIMIT_MINUTES;

  return {
    remaining: Math.max(0, limit - user.minutes_used),
    used: user.minutes_used,
    limit: limit
  };
}

/**
 * Check if user can translate a video
 */
async function checkUsageLimit(userId, durationSeconds) {
  const user = await getOrCreateUser(userId);
  const durationMinutes = Math.ceil(durationSeconds / 60);
  const limit = user.subscription_status === 'premium' ? PREMIUM_LIMIT_MINUTES : FREE_LIMIT_MINUTES;
  const remaining = limit - user.minutes_used;

  if (remaining <= 0) {
    return {
      canTranslate: false,
      error: {
        error: 'limit_reached',
        message: 'You have reached your monthly limit',
        minutes_used: user.minutes_used,
        limit,
        subscription_status: user.subscription_status,
        reset_date: user.reset_date
      }
    };
  }

  if (durationMinutes > remaining) {
    return {
      canTranslate: false,
      error: {
        error: 'video_too_long',
        message: `Video is ${durationMinutes} minutes but you only have ${remaining} minutes remaining`,
        minutes_used: user.minutes_used,
        minutes_remaining: remaining,
        limit,
        video_duration_minutes: durationMinutes,
        subscription_status: user.subscription_status
      }
    };
  }

  return { canTranslate: true };
}

/**
 * Deduct minutes from user's usage
 */
async function deductMinutes(userId, durationSeconds) {
  const durationMinutes = Math.ceil(durationSeconds / 60);

  if (USE_POSTGRES) {
    await pool.query(
      'UPDATE users SET minutes_used = minutes_used + $1 WHERE user_id = $2',
      [durationMinutes, userId]
    );
  } else if (memoryStorage[userId]) {
    memoryStorage[userId].minutes_used += durationMinutes;
  }

  const user = await getUser(userId);
  const limit = user.subscription_status === 'premium' ? PREMIUM_LIMIT_MINUTES : FREE_LIMIT_MINUTES;

  console.log(`[USER_STORAGE] Deducted ${durationMinutes} min from ${userId}. Total: ${user.minutes_used}/${limit}`);

  return {
    minutes_used: user.minutes_used,
    minutes_remaining: Math.max(0, limit - user.minutes_used),
    limit
  };
}

/**
 * Upgrade user to premium
 */
async function upgradeToPremium(userId, stripeCustomerId, stripeSubscriptionId) {
  await updateUser(userId, {
    subscription_status: 'premium',
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubscriptionId
  });
  console.log(`[USER_STORAGE] Upgraded user ${userId} to premium`);
}

/**
 * Downgrade user to free
 */
async function downgradeToFree(userId) {
  await updateUser(userId, {
    subscription_status: 'free',
    stripe_subscription_id: null
  });
  console.log(`[USER_STORAGE] Downgraded user ${userId} to free`);
}

module.exports = {
  FREE_LIMIT_MINUTES,
  PREMIUM_LIMIT_MINUTES,
  getOrCreateUser,
  getUser,
  updateUser,
  getUserByStripeCustomerId,
  getRemainingMinutes,
  checkUsageLimit,
  deductMinutes,
  upgradeToPremium,
  downgradeToFree
};
