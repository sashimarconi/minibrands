const crypto = require('crypto');

// Simple webhook receiver for GhostsPay
// Optional verification: set GHOSTSPAYS_WEBHOOK_SECRET to verify HMAC-SHA256
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const secret = process.env.GHOSTSPAYS_WEBHOOK_SECRET;

  // Obtain raw body for signature verification if possible
  let raw = req.rawBody;
  if (!raw) {
    // fallback: reconstruct from body
    try { raw = JSON.stringify(req.body || {}); } catch (e) { raw = '' }
  }

  const sigHeader = req.headers['x-ghostspay-signature'] || req.headers['x-signature'] || req.headers['x-ghostspays-signature'];
  if (secret && sigHeader) {
    const hmac = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(String(sigHeader)))) {
      console.warn('Webhook signature mismatch');
      return res.status(401).send('invalid signature');
    }
  }

  const event = req.body;
  try {
    console.log('GhostsPay webhook received:', event && event.event ? event.event : 'unknown');
    // Handle events of interest
    if (event && event.event === 'transaction.paid') {
      // Example: extract transaction id and amount
      const data = event.data || {};
      console.log('Transaction paid:', data.id, 'amount:', data.amount);
      // TODO: mark order as paid in your system (depends on your backend)
    }

    // Always return 200 to acknowledge
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Webhook handler error', err);
    res.status(500).json({ success: false, error: String(err) });
  }
};
