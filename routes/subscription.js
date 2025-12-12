/**
 * Subscription Routes
 *
 * Handles Stripe subscription management including:
 * - Creating checkout sessions
 * - Stripe webhooks
 * - Subscription status
 * - Customer portal
 */

const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { requireAuth, getUserEmail } = require('../middleware/auth');
const userStorage = require('../services/userStorage');

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * POST /api/create-checkout-session
 * Creates a Stripe Checkout session for subscription
 * Protected: Requires Clerk authentication
 */
router.post('/create-checkout-session', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    console.log(`[CHECKOUT] Creating checkout session for user: ${userId}`);

    // Get user email from Clerk
    const email = await getUserEmail(userId);
    if (!email) {
      console.log(`[CHECKOUT] Could not get email for user: ${userId}`);
      return res.status(400).json({
        error: 'email_required',
        message: 'Could not retrieve user email from Clerk'
      });
    }

    // Get or create user in our storage
    const user = await userStorage.getOrCreateUser(userId, email);

    // Check if user already has an active subscription
    if (user.subscription_status === 'premium') {
      console.log(`[CHECKOUT] User ${userId} already has premium subscription`);
      return res.status(400).json({
        error: 'already_subscribed',
        message: 'You already have an active premium subscription'
      });
    }

    // Create or retrieve Stripe customer
    let customerId = user.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: email,
        metadata: {
          clerk_user_id: userId
        }
      });
      customerId = customer.id;

      // Store the customer ID
      await userStorage.updateUser(userId, { stripe_customer_id: customerId });
      console.log(`[CHECKOUT] Created Stripe customer: ${customerId}`);
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1
        }
      ],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/subscription/cancel`,
      metadata: {
        clerk_user_id: userId
      },
      subscription_data: {
        metadata: {
          clerk_user_id: userId
        }
      }
    });

    console.log(`[CHECKOUT] Created checkout session: ${session.id}`);

    res.json({
      checkout_url: session.url,
      session_id: session.id
    });

  } catch (error) {
    console.error('[CHECKOUT] Error:', error.message);
    res.status(500).json({
      error: 'checkout_error',
      message: 'Failed to create checkout session'
    });
  }
});

/**
 * POST /api/webhook
 * Stripe webhook handler
 * NO AUTH: Called by Stripe servers
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error(`[WEBHOOK] Signature verification failed:`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[WEBHOOK] Received event: ${event.type}`);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata.clerk_user_id;
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        console.log(`[WEBHOOK] Checkout completed for user: ${userId}`);

        if (userId && subscriptionId) {
          await userStorage.upgradeToPremium(userId, customerId, subscriptionId);
          console.log(`[WEBHOOK] User ${userId} upgraded to premium`);
        } else {
          console.error('[WEBHOOK] Missing userId or subscriptionId in checkout session');
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const status = subscription.status;

        console.log(`[WEBHOOK] Subscription updated: ${subscription.id}, status: ${status}`);

        // Get user by Stripe customer ID
        const userResult = await userStorage.getUserByStripeCustomerId(customerId);

        if (userResult) {
          const { userId } = userResult;

          if (status === 'active') {
            await userStorage.updateUser(userId, {
              subscription_status: 'premium',
              stripe_subscription_id: subscription.id
            });
            console.log(`[WEBHOOK] User ${userId} subscription active`);
          } else if (status === 'canceled' || status === 'unpaid' || status === 'past_due') {
            await userStorage.downgradeToFree(userId);
            console.log(`[WEBHOOK] User ${userId} subscription ${status}`);
          }
        } else {
          // Try to get user from subscription metadata
          const userId = subscription.metadata.clerk_user_id;
          if (userId) {
            if (status === 'active') {
              await userStorage.upgradeToPremium(userId, customerId, subscription.id);
            } else if (status === 'canceled' || status === 'unpaid' || status === 'past_due') {
              await userStorage.downgradeToFree(userId);
            }
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        console.log(`[WEBHOOK] Subscription deleted: ${subscription.id}`);

        // Get user by Stripe customer ID
        const userResult = await userStorage.getUserByStripeCustomerId(customerId);

        if (userResult) {
          const { userId } = userResult;
          await userStorage.downgradeToFree(userId);
          console.log(`[WEBHOOK] User ${userId} downgraded to free`);
        } else {
          // Try to get user from subscription metadata
          const userId = subscription.metadata.clerk_user_id;
          if (userId) {
            await userStorage.downgradeToFree(userId);
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;

        console.log(`[WEBHOOK] Payment failed for customer: ${customerId}`);

        const userResult = await userStorage.getUserByStripeCustomerId(customerId);
        if (userResult) {
          console.log(`[WEBHOOK] Payment failed for user ${userResult.userId}`);
          // Don't downgrade immediately - Stripe will retry
        }
        break;
      }

      default:
        console.log(`[WEBHOOK] Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });

  } catch (error) {
    console.error(`[WEBHOOK] Error processing event ${event.type}:`, error.message);
    res.status(500).json({ error: 'Webhook processing error' });
  }
});

/**
 * GET /api/subscription-status
 * Get user's subscription status and usage
 * Protected: Requires Clerk authentication
 */
router.get('/subscription-status', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    console.log(`[STATUS] Getting subscription status for user: ${userId}`);

    // Get user email from Clerk
    const email = await getUserEmail(userId);

    // Get or create user
    const user = await userStorage.getOrCreateUser(userId, email);

    // Get usage info
    const { remaining, used, limit } = await userStorage.getRemainingMinutes(userId);

    res.json({
      status: user.subscription_status,
      minutes_used: used,
      minutes_remaining: remaining,
      minutes_limit: limit,
      reset_date: user.reset_date,
      email: user.email || email,
      has_payment_method: !!user.stripe_customer_id
    });

  } catch (error) {
    console.error('[STATUS] Error:', error.message);
    res.status(500).json({
      error: 'status_error',
      message: 'Failed to get subscription status'
    });
  }
});

/**
 * POST /api/create-portal-session
 * Creates a Stripe Customer Portal session for managing subscription
 * Protected: Requires Clerk authentication
 */
router.post('/create-portal-session', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    console.log(`[PORTAL] Creating portal session for user: ${userId}`);

    // Get user
    const user = await userStorage.getUser(userId);

    if (!user || !user.stripe_customer_id) {
      console.log(`[PORTAL] User ${userId} has no Stripe customer ID`);
      return res.status(400).json({
        error: 'no_subscription',
        message: 'You do not have an active subscription to manage'
      });
    }

    // Create portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/account`
    });

    console.log(`[PORTAL] Created portal session for customer: ${user.stripe_customer_id}`);

    res.json({
      portal_url: session.url
    });

  } catch (error) {
    console.error('[PORTAL] Error:', error.message);
    res.status(500).json({
      error: 'portal_error',
      message: 'Failed to create customer portal session'
    });
  }
});

module.exports = router;
