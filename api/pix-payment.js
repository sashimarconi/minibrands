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

      // Build payload with sanitization: omit null/invalid fields and ensure product values >= 0.01
      const payload = {
        client_name: body.name || body.client_name || '',
        client_email: body.email || body.client_email || '',
        client_document: (body.document || body.client_document || '').toString().replace(/\D+/g, ''),
        client_mobile_phone: (body.phone || body.client_mobile_phone || '').toString().replace(/\D+/g, ''),
        value: Number(value.toFixed(2)),
        gateway_account_id: Number(body.gateway_account_id || GATEWAY_ACCOUNT_ID),
        external_ref: body.external_ref || body.description || undefined
      };

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

      const GHOSTSPAYS_API_URL = (process.env.GHOSTSPAYS_API_URL || 'https://api.ghostspaysv1.com').replace(/\/$/, '');

      const pathCandidates = ['/api/pix/generate-transaction', '/api/generate-transaction'];
      const headerVariants = [
        { 'X-Secret-Key': GHOST_SECRET, 'X-Public-Key': GHOST_PUBLIC },
        { 'secret_key': GHOST_SECRET, 'api_key': GHOST_PUBLIC },
        { 'api_key': GHOST_PUBLIC, 'secret_key': GHOST_SECRET }
      ];

      const attempts = [];
      let lastResponseText = '';
      for (const path of pathCandidates) {
        for (const headers of headerVariants) {
          const endpoint = `${GHOSTSPAYS_API_URL}${path}`;
          console.log('GhostsPay try', { endpoint, headerNames: Object.keys(headers) });
          try {
            const r = await fetch(endpoint, {
              method: 'POST',
              headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
              body: JSON.stringify(payload)
            });

            let rawText = '';
            try { rawText = await r.text(); } catch (e) { rawText = String(e); }
            lastResponseText = rawText;

            // Try parse
            try {
              const j = JSON.parse(rawText);
              if (r.status >= 200 && r.status < 300) {
                return res.status(200).json({ success: true, data: j });
              }

              // Handle duplicate external_ref: if gateway created the transaction but
              // internal DB raised duplicate key, GhostsPay may return 500 but include
              // the created transaction id inside the response payload (j.data.id).
              // In that case, fetch the transaction by id and return it as success.
              try {
                let innerId = null;
                // direct paths
                if (j && j.data && (j.data.id || (j.data.data && j.data.data.id))) {
                  innerId = j.data.id || (j.data.data && j.data.data.id);
                }
                // search JSON string for an UUID if not found
                if (!innerId) {
                  try {
                    const hay = JSON.stringify(j || {}) + ' ' + (rawText || '');
                    const m = hay.match(/"id"\s*:\s*"([0-9a-fA-F-]{36})"/) || hay.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
                    if (m) innerId = m[1];
                  } catch (e) {
                    // ignore
                  }
                }

                if (innerId) {
                  console.log('Detected duplicate external_ref, fetching existing transaction', innerId);
                  const statusUrl = `${GHOSTSPAYS_API_URL}/api/transaction/${encodeURIComponent(innerId)}`;
                  const sr = await fetch(statusUrl, { headers: { 'X-Secret-Key': GHOST_SECRET, 'X-Public-Key': GHOST_PUBLIC } });
                  const sj = await sr.json().catch(()=>null);
                  if (sr.status >= 200 && sr.status < 300 && sj) {
                    return res.status(200).json({ success: true, data: sj, note: 'recovered_from_duplicate' });
                  }
                }
              } catch (innerErr) {
                console.error('Error while recovering transaction after duplicate', innerErr);
              }

              return res.status(502).json({ success: false, error: 'Gateway error', gateway_status: r.status, data: j });
            } catch (e) {
              attempts.push({ endpoint, headerNames: Object.keys(headers), status: r.status, body_preview: rawText && rawText.length>1000 ? rawText.slice(0,1000) + '...[truncated]' : rawText });
              // continue trying other combos
            }
          } catch (err) {
            attempts.push({ endpoint, headerNames: Object.keys(headers), error: String(err) });
          }
        }
      }

      console.error('GhostsPay all attempts failed', { attempts });
      // Return last text preview plus the attempts to aid debugging (no secret values)
      return res.status(502).json({ success: false, error: 'Invalid JSON from gateway', gateway_status: attempts.length ? (attempts[attempts.length-1].status||0) : 0, gateway_body_preview: lastResponseText && lastResponseText.length>1000 ? lastResponseText.slice(0,1000) + '...[truncated]' : lastResponseText, attempts });
    }

    if (action === 'check_status') {
      const tx = body.transaction_id || body.id || body.txn_id;
      if (!tx) return res.status(400).json({ success: false, error: 'transaction_id required' });
      const GHOSTSPAYS_API_URL = (process.env.GHOSTSPAYS_API_URL || 'https://api.ghostspaysv1.com').replace(/\/$/, '');
      const url = `${GHOSTSPAYS_API_URL}/api/transaction/${encodeURIComponent(tx)}`;
      console.log('GhostsPay status check', { url, tx });
      const r = await fetch(url, { headers: { 'X-Secret-Key': GHOST_SECRET, 'X-Public-Key': GHOST_PUBLIC } });
      const j = await r.json().catch(()=>({ success:false, error:'Invalid JSON from gateway' }));
      if (r.status >= 200 && r.status < 300) {
        return res.status(200).json({ success: true, data: j });
      }
      return res.status(502).json({ success: false, error: 'Gateway error', gateway_status: r.status, data: j });
    }

    return res.status(400).json({ success: false, error: 'Unknown action' });
  } catch (err) {
    console.error('pix endpoint error', err);
    return res.status(500).json({ success: false, error: String(err && err.message ? err.message : err) });
  }
};
