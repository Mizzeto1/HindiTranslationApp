/**
 * User Storage Service
 *
 * Handles user data persistence using PostgreSQL.
 * Tracks usage minutes, subscription status, and Stripe information.
 */

const { Pool } = require('pg');

// Usage limits
const FREE_LIMIT_MINUTES = 30;
const PREMIUM_LIMIT_MINUTES = 900; // 15 hours

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

/**
 * Initialize the database table
 */
async function initDatabase() {
  try {
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
    console.log('[USER_STORAGE] Database initialized');
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
 * Check if reset is needed and return updated minutes
 */
function checkAndResetIfNeeded(user) {
  const now = new Date();
  const resetDate = new Date(user.reset_date);

  if (now >= resetDate) {
    return {
      needsReset: true,
      newResetDate: getNextResetDate()
    };
  }
  return { needsReset: false };
}

/**
 * Get or create a user record
 */
async function getOrCreateUser(userId, email = null) {
  try {
    // Try to get existing user
    const result = await pool.query(
      'SELECT * FROM users WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length > 0) {
      const user = result.rows[0];

      // Check if reset is needed
      const resetCheck = checkAndResetIfNeeded(user);
      if (resetCheck.needsReset) {
        await pool.query(
          'UPDATE users SET minutes_used = 0, reset_date = $1 WHERE user_id = $2',
          [resetCheck.newResetDate, userId]
        );
        user.minutes_used = 0;
        user.reset_date = resetCheck.newResetDate;
        console.log(`[USER_STORAGE] Reset usage for user ${userId}`);
      }

      // Update email if needed
      if (email && user.email !== email) {
        await pool.query(
          'UPDATE users SET email = $1 WHERE user_id = $2',
          [email, userId]
        );
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
    console.error('[USER_STORAGE] Error in getOrCreateUser:', error.message);
    throw error;
  }
}

/**
 * Get user data by ID
 */
async function getUser(userId) {
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length > 0) {
      const user = result.rows[0];

      // Check if reset is needed
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
    console.error('[USER_STORAGE] Error in getUser:', error.message);
    return null;
  }
}

/**
 * Update user data
 */
async function updateUser(userId, updates) {
  try {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }

    values.push(userId);

    await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE user_id = $${paramIndex}`,
      values
    );

    console.log(`[USER_STORAGE] Updated user ${userId}:`, Object.keys(updates));

    return await getUser(userId);
  } catch (error) {
    console.error('[USER_STORAGE] Error in updateUser:', error.message);
    throw error;
  }
}

/**
 * Get user by Stripe customer ID
 */
async function getUserByStripeCustomerId(stripeCustomerId) {
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE stripe_customer_id = $1',
      [stripeCustomerId]
    );

    if (result.rows.length > 0) {
      return {
        userId: result.rows[0].user_id,
        userData: result.rows[0]
      };
    }

    return null;
  } catch (error) {
    console.error('[USER_STORAGE] Error in getUserByStripeCustomerId:', error.message);
    return null;
  }
}

/**
 * Get remaining minutes for a user
 */
async function getRemainingMinutes(userId) {
  const user = await getOrCreateUser(userId);
  const limit = user.subscription_status === 'premium'
    ? PREMIUM_LIMIT_MINUTES
    : FREE_LIMIT_MINUTES;

  return {
    remaining: Math.max(0, limit - user.minutes_used),
    used: user.minutes_used,
    limit: limit
  };
}

/**
 * Check if user can translate a video of given duration
 */
async function checkUsageLimit(userId, durationSeconds) {
  const user = await getOrCreateUser(userId);
  const durationMinutes = Math.ceil(durationSeconds / 60);
  const limit = user.subscription_status === 'premium'
    ? PREMIUM_LIMIT_MINUTES
    : FREE_LIMIT_MINUTES;
  const remaining = limit - user.minutes_used;

  if (remaining <= 0) {
    return {
      canTranslate: false,
      error: {
        error: 'limit_reached',
        message: 'You have reached your monthly limit',
        minutes_used: user.minutes_used,
        limit: limit,
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
        limit: limit,
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
  try {
    const durationMinutes = Math.ceil(durationSeconds / 60);

    await pool.query(
      'UPDATE users SET minutes_used = minutes_used + $1 WHERE user_id = $2',
      [durationMinutes, userId]
    );

    const user = await getUser(userId);
    const limit = user.subscription_status === 'premium'
      ? PREMIUM_LIMIT_MINUTES
      : FREE_LIMIT_MINUTES;

    console.log(`[USER_STORAGE] Deducted ${durationMinutes} minutes from user ${userId}. Total: ${user.minutes_used}/${limit}`);

    return {
      minutes_used: user.minutes_used,
      minutes_remaining: Math.max(0, limit - user.minutes_used),
      limit: limit
    };
  } catch (error) {
    console.error('[USER_STORAGE] Error in deductMinutes:', error.message);
    throw error;
  }
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
