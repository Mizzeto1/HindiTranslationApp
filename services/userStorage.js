/**
 * User Storage Service
 *
 * Handles user data persistence in a JSON file.
 * Tracks usage minutes, subscription status, and Stripe information.
 */

const fs = require('fs').promises;
const path = require('path');

// Path to users.json file
const USERS_FILE = path.join(__dirname, '..', 'data', 'users.json');

// Usage limits
const FREE_LIMIT_MINUTES = 30;
const PREMIUM_LIMIT_MINUTES = 900; // 15 hours

/**
 * Ensure the data directory and users.json file exist
 */
async function ensureDataFile() {
  const dataDir = path.dirname(USERS_FILE);

  try {
    await fs.access(dataDir);
  } catch {
    await fs.mkdir(dataDir, { recursive: true });
    console.log('[USER_STORAGE] Created data directory');
  }

  try {
    await fs.access(USERS_FILE);
  } catch {
    await fs.writeFile(USERS_FILE, JSON.stringify({}, null, 2));
    console.log('[USER_STORAGE] Created users.json file');
  }
}

/**
 * Load all users from the JSON file
 * @returns {Promise<Object>} - The users object
 */
async function loadUsers() {
  await ensureDataFile();
  try {
    const data = await fs.readFile(USERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('[USER_STORAGE] Error loading users:', error.message);
    return {};
  }
}

/**
 * Save all users to the JSON file
 * @param {Object} users - The users object to save
 */
async function saveUsers(users) {
  await ensureDataFile();
  try {
    await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (error) {
    console.error('[USER_STORAGE] Error saving users:', error.message);
    throw error;
  }
}

/**
 * Get the reset date for the current month (1st of next month)
 * @returns {string} - ISO date string for the 1st of next month
 */
function getNextResetDate() {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return nextMonth.toISOString().split('T')[0];
}

/**
 * Check if the reset date has passed and reset if needed
 * @param {Object} userData - The user data object
 * @returns {boolean} - Whether a reset was performed
 */
function checkAndResetIfNeeded(userData) {
  const now = new Date();
  const resetDate = new Date(userData.reset_date);

  if (now >= resetDate) {
    userData.minutes_used = 0;
    userData.reset_date = getNextResetDate();
    console.log(`[USER_STORAGE] Reset usage for user. New reset date: ${userData.reset_date}`);
    return true;
  }
  return false;
}

/**
 * Get or create a user record
 * @param {string} userId - The Clerk user ID
 * @param {string} email - The user's email (optional)
 * @returns {Promise<Object>} - The user data
 */
async function getOrCreateUser(userId, email = null) {
  const users = await loadUsers();

  if (!users[userId]) {
    users[userId] = {
      email: email,
      minutes_used: 0,
      subscription_status: 'free',
      stripe_customer_id: null,
      stripe_subscription_id: null,
      reset_date: getNextResetDate(),
      created_at: new Date().toISOString()
    };
    await saveUsers(users);
    console.log(`[USER_STORAGE] Created new user: ${userId}`);
  } else {
    // Check if we need to reset the monthly usage
    if (checkAndResetIfNeeded(users[userId])) {
      await saveUsers(users);
    }
    // Update email if provided and different
    if (email && users[userId].email !== email) {
      users[userId].email = email;
      await saveUsers(users);
    }
  }

  return users[userId];
}

/**
 * Get user data by ID
 * @param {string} userId - The Clerk user ID
 * @returns {Promise<Object|null>} - The user data or null if not found
 */
async function getUser(userId) {
  const users = await loadUsers();
  const user = users[userId];

  if (user) {
    // Check if we need to reset the monthly usage
    if (checkAndResetIfNeeded(user)) {
      await saveUsers(users);
    }
  }

  return user || null;
}

/**
 * Update user data
 * @param {string} userId - The Clerk user ID
 * @param {Object} updates - The fields to update
 * @returns {Promise<Object>} - The updated user data
 */
async function updateUser(userId, updates) {
  const users = await loadUsers();

  if (!users[userId]) {
    throw new Error(`User not found: ${userId}`);
  }

  users[userId] = { ...users[userId], ...updates };
  await saveUsers(users);

  console.log(`[USER_STORAGE] Updated user ${userId}:`, Object.keys(updates));
  return users[userId];
}

/**
 * Get user by Stripe customer ID
 * @param {string} stripeCustomerId - The Stripe customer ID
 * @returns {Promise<{userId: string, userData: Object}|null>}
 */
async function getUserByStripeCustomerId(stripeCustomerId) {
  const users = await loadUsers();

  for (const [userId, userData] of Object.entries(users)) {
    if (userData.stripe_customer_id === stripeCustomerId) {
      return { userId, userData };
    }
  }

  return null;
}

/**
 * Get the user's remaining minutes
 * @param {string} userId - The Clerk user ID
 * @returns {Promise<Object>} - Object with remaining, used, and limit
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
 * @param {string} userId - The Clerk user ID
 * @param {number} durationSeconds - Video duration in seconds
 * @returns {Promise<{canTranslate: boolean, error?: Object}>}
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
 * @param {string} userId - The Clerk user ID
 * @param {number} durationSeconds - Duration to deduct in seconds
 * @returns {Promise<Object>} - Updated usage info
 */
async function deductMinutes(userId, durationSeconds) {
  const users = await loadUsers();
  const user = users[userId];

  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }

  const durationMinutes = Math.ceil(durationSeconds / 60);
  user.minutes_used += durationMinutes;

  await saveUsers(users);

  const limit = user.subscription_status === 'premium'
    ? PREMIUM_LIMIT_MINUTES
    : FREE_LIMIT_MINUTES;

  console.log(`[USER_STORAGE] Deducted ${durationMinutes} minutes from user ${userId}. Total: ${user.minutes_used}/${limit}`);

  return {
    minutes_used: user.minutes_used,
    minutes_remaining: Math.max(0, limit - user.minutes_used),
    limit: limit
  };
}

/**
 * Upgrade user to premium
 * @param {string} userId - The Clerk user ID
 * @param {string} stripeCustomerId - The Stripe customer ID
 * @param {string} stripeSubscriptionId - The Stripe subscription ID
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
 * @param {string} userId - The Clerk user ID
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
