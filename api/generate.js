// POST /api/generate — FAL gpt-image-2/edit 단일 호출 (Vercel Pro, maxDuration 300s)
// 서버가 submit → polling → result 전부 처리해서 최종 이미지만 리턴.
export const config = { maxDuration: 300 };

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

export default async function handler(req, res) {
  // CORS (file:// 로컬 테스트 + GitHub Pages 등에서 호출 가능)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { image, referenceImages = [], prompt, quality = 'low' } = req.body || {};
  if (!image || !prompt) return res.status(400).json({ error: 'image, prompt required' });

  const KEY = process.env.FAL_KEY;
  if (!KEY) return res.status(500).json({ error: 'FAL_KEY not configured on server' });

  const images = [image, ...(Array.isArray(referenceImages) ? referenceImages : [])].filter(Boolean);
  const auth = { Authorization: `Key ${KEY}` };

  try {
    // 1) 큐 제출
    const submit = await fetch('https://queue.fal.run/fal-ai/gpt-image-2/edit', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        image_urls: images,
        quality,
        size: 'auto',
        n: 1,
        output_format: 'png',
      }),
    });
    if (!submit.ok) {
      const t = await submit.text();
      return res.status(502).json({ error: `fal submit ${submit.status}: ${t.slice(0, 200)}` });
    }
    const sj = await submit.json();
    const requestId = sj.request_id || (sj.status_url && sj.status_url.split('/').slice(-2, -1)[0]);
    if (!requestId) return res.status(502).json({ error: 'no request_id' });

    // 2) 폴링 (최대 270초, Pro maxDuration 300s 안쪽)
    const t0 = Date.now();
    const statusUrl = `https://queue.fal.run/fal-ai/gpt-image-2/requests/${requestId}/status`;
    let last = '';
    while (Date.now() - t0 < 270000) {
      await sleep(2500);
      const s = await fetch(statusUrl, { headers: auth });
      if (!s.ok) continue;
      const j = await s.json();
      last = j.status || '';
      if (last === 'COMPLETED') break;
      if (last === 'FAILED' || last === 'ERROR' || last === 'CANCELLED') {
        return res.status(502).json({ error: `fal ${last}`, raw: j });
      }
    }
    if (last !== 'COMPLETED') return res.status(504).json({ error: 'fal timeout' });

    // 3) 결과 가져오기
    const r = await fetch(`https://queue.fal.run/fal-ai/gpt-image-2/requests/${requestId}`, { headers: auth });
    const data = await r.json();
    const imageUrl = data && data.images && data.images[0] && data.images[0].url;
    if (!imageUrl) return res.status(502).json({ error: 'no image in result' });

    return res.status(200).json({ success: true, imageUrl, requestId });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}
