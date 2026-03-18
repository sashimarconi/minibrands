const fetch = globalThis.fetch || require('node-fetch');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const SPEED_PUBLIC = process.env.SPEEDPAG_PUBLIC_KEY || process.env.SPEEDPAG_KEY || process.env.SPEEDPAG_PUBLIC;
  const SPEED_SECRET = process.env.SPEEDPAG_SECRET_KEY || process.env.SPEEDPAG_SECRET;
  const GATEWAY_ACCOUNT_ID = process.env.SPEEDPAG_GATEWAY_ACCOUNT_ID || process.env.GHOSTSPAYS_GATEWAY_ACCOUNT_ID || 1;

  if (!SPEED_SECRET || !SPEED_PUBLIC) {
    return res.status(500).json({ success: false, error: 'Gateway keys not configured (set SPEEDPAG_PUBLIC_KEY and SPEEDPAG_SECRET_KEY)' });
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

      // Build payload with sanitization: omit null/invalid fields and ensure product values >= 0.01
      const payload = {
        client_name: body.name || body.client_name || '',
        client_email: body.email || body.client_email || '',
        client_document: (body.document || body.client_document || '').toString().replace(/\D+/g, ''),
        client_mobile_phone: (body.phone || body.client_mobile_phone || '').toString().replace(/\D+/g, ''),
        value: Number(value.toFixed(2)),
        gateway_account_id: Number(body.gateway_account_id || GATEWAY_ACCOUNT_ID),
        // ensure external_ref is unique per attempt to avoid duplicate key errors
        external_ref: undefined
      };

      // Build a safe, unique external_ref: prefer provided value but append a short nonce
      const providedRef = body.external_ref || body.description;
      if (typeof providedRef === 'string' && providedRef.trim()) {
        const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`;
        payload.external_ref = `${providedRef.trim()}-${nonce}`;
      } else {
        payload.external_ref = `order-${Date.now().toString(36)}${Math.random().toString(36).slice(2,6)}`;
      }

      // post_back_url: only include if it's a valid URL
      const envPostback = process.env.GHOSTSPAYS_POSTBACK_URL;
      const candidatePostback = body.post_back_url || envPostback;
      if (typeof candidatePostback === 'string' && candidatePostback.trim()) {
        try {
          // validate URL
          new URL(candidatePostback);
          payload.post_back_url = candidatePostback;
        } catch (e) {
          // invalid URL - omit
          console.log('Skipping invalid post_back_url', candidatePostback);
        }
      }

      // provider: include only when it's a non-empty string
      if (typeof body.provider === 'string' && body.provider.trim()) {
        payload.provider = body.provider.trim();
      }

      // Products: prefer `body.products`, fallback to `body.items`.
      const rawProducts = Array.isArray(body.products) ? body.products : (Array.isArray(body.items) ? body.items : undefined);
      if (Array.isArray(rawProducts) && rawProducts.length) {
        const totalQty = rawProducts.reduce((s,it)=>s + (Number(it.quantity)||1), 0) || 1;
        const mapped = rawProducts.map(it => {
          const qty = Number(it.quantity) || 1;
          let rawPrice = (it.price !== undefined ? it.price : (it.value !== undefined ? it.value : 0));
          rawPrice = Number(rawPrice) || 0;
          // Heuristic: if rawPrice is likely cents (>1000), convert to reais
          if (rawPrice > 1000) rawPrice = rawPrice / 100;
          // If price is zero, fallback to proportional share of payload.value
          if (rawPrice <= 0) rawPrice = Number((payload.value / totalQty).toFixed(2)) || 0.01;
          const valuePerItem = Math.max(Number(rawPrice.toFixed(2)), 0.01);
          return {
            product_name: (it.name || it.product_name || payload.external_ref || 'Product') || 'Product',
            quantity: qty,
            value: Number(valuePerItem.toFixed(2))
          };
        }).filter(p => Number(p.value) >= 0.01);

        if (mapped.length) payload.products = mapped;
      }

      const SPEED_API_URL = (process.env.SPEEDPAG_API_URL || 'https://api.speedpag.com/v1').replace(/\/$/, '');

      // Build Basic auth header according to SpeedPag docs (public:secret)
      const auth = 'Basic ' + Buffer.from(`${SPEED_PUBLIC}:${SPEED_SECRET}`).toString('base64');
      const endpoint = `${SPEED_API_URL}/transactions`;
      console.log('SpeedPag try', { endpoint });

      try {
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': auth
          },
          body: JSON.stringify(Object.assign({}, payload, { paymentMethod: 'pix', amount: Math.round(Number(payload.value) * 100) }))
        });

        const j = await r.json().catch(async () => {
          const txt = await r.text().catch(()=>null);
          throw new Error('Invalid JSON from SpeedPag: ' + (txt ? txt.slice(0,1000) : 'no body'));
        });

        if (r.status >= 200 && r.status < 300) {
          // Normalize: return top-level fields and also under `data` for compatibility
          return res.status(200).json(Object.assign({ success: true }, j, { data: j }));
        }

        // Non-2xx: bubble gateway response for debugging
        return res.status(502).json({ success: false, error: 'Gateway error', gateway_status: r.status, data: j });
      } catch (e) {
        console.error('SpeedPag request failed', String(e));
        return res.status(502).json({ success: false, error: String(e) });
      }
    }

    if (action === 'check_status') {
      const tx = body.transaction_id || body.id || body.txn_id;
      if (!tx) return res.status(400).json({ success: false, error: 'transaction_id required' });
      const SPEED_API_URL = (process.env.SPEEDPAG_API_URL || 'https://api.speedpag.com/v1').replace(/\/$/, '');
      const auth = 'Basic ' + Buffer.from(`${SPEED_PUBLIC}:${SPEED_SECRET}`).toString('base64');
      const url = `${SPEED_API_URL}/transactions/${encodeURIComponent(tx)}`;
      console.log('SpeedPag status check', { url, tx });
      const r = await fetch(url, { headers: { 'Authorization': auth, 'Content-Type': 'application/json' } });
      const j = await r.json().catch(()=>({ success:false, error:'Invalid JSON from gateway' }));
      if (r.status >= 200 && r.status < 300) {
        return res.status(200).json(Object.assign({ success: true }, j, { data: j }));
      }
      return res.status(502).json({ success: false, error: 'Gateway error', gateway_status: r.status, data: j });
    }

    return res.status(400).json({ success: false, error: 'Unknown action' });
  } catch (err) {
    console.error('pix endpoint error', err);
    return res.status(500).json({ success: false, error: String(err && err.message ? err.message : err) });
  }
};
