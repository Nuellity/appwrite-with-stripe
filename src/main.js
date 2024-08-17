import StripeService from './stripe.js';
import AppwriteService from './appwrite.js';
import { getStaticFile, interpolate, throwIfMissing } from './utils.js';

export default async (context) => {
  const { req, res, log, error } = context;

  throwIfMissing(process.env, [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'APPWRITE_API_KEY',
  ]);

  const databaseId = process.env.APPWRITE_DATABASE_ID ?? 'orders';
  const collectionId = process.env.APPWRITE_COLLECTION_ID ?? 'orders';

  if (req.method === 'GET') {
    const html = interpolate(getStaticFile('index.html'), {
      APPWRITE_ENDPOINT:
        process.env.APPWRITE_ENDPOINT ?? 'https://cloud.appwrite.io/v1',
      APPWRITE_FUNCTION_PROJECT_ID: process.env.APPWRITE_FUNCTION_PROJECT_ID,
      APPWRITE_FUNCTION_ID: process.env.APPWRITE_FUNCTION_ID,
      APPWRITE_DATABASE_ID: databaseId,
      APPWRITE_COLLECTION_ID: collectionId,
    });

    return res.send(html, 200, { 'Content-Type': 'text/html; charset=utf-8' });
  }

  const appwrite = new AppwriteService();
  const stripe = new StripeService();

  switch (req.path) {
    case '/checkout':
      const fallbackUrl = req.scheme + '://' + req.headers['host'] + '/';
      const amountInfo = (req.body.amount * 100).toString();
      const amount = Math.floor(parseFloat(amountInfo));

      const successUrl = req.body?.successUrl ?? fallbackUrl;
      const failureUrl = req.body?.failureUrl ?? fallbackUrl;

      const userId = req.headers['x-user-id'];

      if (!userId) {
        error('User ID not found in request.');
        return res.redirect(failureUrl, 303);
      }

      const session = await stripe.checkoutPayment(
        context,
        amount,
        userId,
        successUrl,
        failureUrl
      );
      if (!session) {
        error('Failed to create Stripe checkout session.');
        return res.redirect(failureUrl, 303);
      }

      context.log('Session:');
      context.log(session);

      log(`Created Stripe checkout session for user ${userId}.`);
      return res.redirect(session.url, 303);

    case '/create-intent': // New case for creating a Payment Intent
      try {
        log(`Received request body: ${JSON.stringify(req.body.amount)}`);
        const amountStr = req.body.amount;
        const amount = Math.floor(parseFloat(amountStr) * 100);
        const currency = 'usd';

        const userId = req.headers['x-user-id'];

        if (isNaN(amount) || amount <= 0) {
          error('Invalid amount');
          return res.json({ error: 'Invalid amount' }, 400);
        }

        if (!userId) {
          error('User ID not found in request.');
          return res.json({ error: 'User ID is required' }, 400);
        }

        const intent = await stripe.client.paymentIntents.create({
          amount,
          currency,
          automatic_payment_methods: { enabled: true },
          metadata: { userId },
        });

        return res.json({ client_secret: intent.client_secret });
      } catch (err) {
        error(err.message);
        return res.json({ error: err.message }, err.statusCode || 500);
      }

    case '/webhook':
      const event = stripe.validateWebhook(context, req);
      if (!event) {
        return res.json({ success: false }, 401);
      }

      context.log('Event:');
      context.log(event);

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.metadata.userId;
        const orderId = session.id;

        await appwrite.createOrder(databaseId, collectionId, userId, orderId);
        log(
          `Created order document for user ${userId} with Stripe order ID ${orderId}`
        );
        return res.json({ success: true });
      }

      return res.json({ success: true });

    default:
      return res.send('Not Found', 404);
  }
};
