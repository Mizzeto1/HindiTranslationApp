/**
 * Clerk Authentication Middleware
 *
 * Verifies JWT tokens from Clerk and attaches user information to requests.
 */

const { createClerkClient } = require('@clerk/clerk-sdk-node');

// Initialize Clerk client
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

/**
 * Middleware to require authentication
 * Verifies the Clerk JWT token and attaches userId to the request
 */
async function requireAuth(req, res, next) {
  try {
    // Get the Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      console.log('[AUTH] No Authorization header provided');
      return res.status(401).json({
        error: 'unauthorized',
        message: 'No authorization token provided'
      });
    }

    // Extract the token (Bearer <token>)
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    if (!token) {
      console.log('[AUTH] Empty token');
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Invalid authorization token format'
      });
    }

    // Verify the token with Clerk
    try {
      const verifiedToken = await clerk.verifyToken(token);

      // Attach user info to the request
      req.userId = verifiedToken.sub; // Clerk user ID
      req.sessionId = verifiedToken.sid; // Session ID

      console.log(`[AUTH] Authenticated user: ${req.userId}`);
      next();
    } catch (verifyError) {
      console.log(`[AUTH] Token verification failed: ${verifyError.message}`);
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Invalid or expired token'
      });
    }

  } catch (error) {
    console.error('[AUTH] Unexpected error:', error);
    return res.status(500).json({
      error: 'server_error',
      message: 'Authentication service error'
    });
  }
}

/**
 * Get user email from Clerk
 * @param {string} userId - The Clerk user ID
 * @returns {Promise<string|null>} - The user's primary email or null
 */
async function getUserEmail(userId) {
  try {
    const user = await clerk.users.getUser(userId);
    // Get the primary email address
    const primaryEmail = user.emailAddresses.find(
      email => email.id === user.primaryEmailAddressId
    );
    return primaryEmail ? primaryEmail.emailAddress : null;
  } catch (error) {
    console.error(`[AUTH] Failed to get user email for ${userId}:`, error.message);
    return null;
  }
}

module.exports = {
  requireAuth,
  getUserEmail
};
