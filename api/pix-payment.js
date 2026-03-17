const fetch = globalThis.fetch || require('node-fetch');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const GHOST_SECRET = process.env.GHOSTSPAYS_SECRET_KEY;
  const GHOST_PUBLIC = process.env.GHOSTSPAYS_PUBLIC_KEY;
  const GATEWAY_ACCOUNT_ID = process.env.GHOSTSPAYS_GATEWAY_ACCOUNT_ID || 1;

  if (!GHOST_SECRET || !GHOST_PUBLIC) {
    return res.status(500).json({ success: false, error: 'Gateway keys not configured (set GHOSTSPAYS_SECRET_KEY and GHOSTSPAYS_PUBLIC_KEY)' });
  }

  let body = req.body;
  if (!body || typeof body !== 'object') {
    try { body = JSON.parse(req.body); } catch (e) { body = {}; }
  }

  const action = (body.action || body.type || 'create_pix');

  try {
    if (action === 'create_pix') {
      // normalize amount: accept cents or float reais
      let value = body.amount ?? body.value ?? 0;
      value = Number(value) || 0;
      if (value > 1000) value = value / 100; // likely cents -> reais

      const payload = {
        client_name: body.name || body.client_name || '',
        client_email: body.email || body.client_email || '',
        client_document: (body.document || body.client_document || '').toString().replace(/\D+/g, ''),
        client_mobile_phone: (body.phone || body.client_mobile_phone || '').toString().replace(/\D+/g, ''),
        value: Number(value.toFixed(2)),
        gateway_account_id: Number(body.gateway_account_id || GATEWAY_ACCOUNT_ID),
        external_ref: body.external_ref || body.description || null,
        post_back_url: process.env.GHOSTSPAYS_POSTBACK_URL || null,
        provider: body.provider || null,
        products: Array.isArray(body.items) ? body.items.map(it=>({ product_name: it.name||it.product_name||'', quantity: Number(it.quantity||1), value: Number(((it.price||0)>1000? (it.price/100) : (it.price||0)).toFixed(2)) })) : undefined
      };

      const r = await fetch('https://api.ghostspaysv1.com/api/pix/generate-transaction', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Secret-Key': GHOST_SECRET,
          'X-Public-Key': GHOST_PUBLIC
        },
        body: JSON.stringify(payload)
      });

      const j = await r.json().catch(()=>({ success: false, error: 'Invalid JSON from gateway' }));
      return res.status(r.status>=200&&r.status<300?200:502).json(j);
    }

    if (action === 'check_status') {
      const tx = body.transaction_id || body.id || body.txn_id;
      if (!tx) return res.status(400).json({ success: false, error: 'transaction_id required' });
      const url = `https://api.ghostspaysv1.com/api/transaction/${encodeURIComponent(tx)}`;
      const r = await fetch(url, { headers: { 'X-Secret-Key': GHOST_SECRET, 'X-Public-Key': GHOST_PUBLIC } });
      const j = await r.json().catch(()=>({ success:false, error:'Invalid JSON from gateway' }));
      return res.status(r.status>=200&&r.status<300?200:502).json(j);
    }

    return res.status(400).json({ success: false, error: 'Unknown action' });
  } catch (err) {
    console.error('pix endpoint error', err);
    return res.status(500).json({ success: false, error: String(err && err.message ? err.message : err) });
  }
};
