import axios from 'axios';

function parseLngLat(s: string | undefined): { lng: number; lat: number } | null {
  if (!s) return null;
  const [lngStr, latStr] = s.split(',');
  const lng = Number(lngStr);
  const lat = Number(latStr);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat };
}

export default async function handler(req: any, res: any) {
  const amapKey = process.env.AMAP_WEB_SERVICE_KEY;
  if (!amapKey) return res.status(500).json({ error: 'missing_env', message: 'Missing AMAP_WEB_SERVICE_KEY' });

  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const origin = parseLngLat(req.query?.origin);
  const dest = parseLngLat(req.query?.dest);
  const zoom = Number(req.query?.zoom || 13);
  const size = String(req.query?.size || '750*300');

  if (!origin && !dest) return res.status(400).json({ error: 'bad_request', message: 'origin or dest required' });

  const markers: string[] = [];
  if (origin) markers.push(`mid,0x2563eb,A:${origin.lng},${origin.lat}`);
  if (dest) markers.push(`mid,0xef4444,B:${dest.lng},${dest.lat}`);

  const center = dest || origin!;

  try {
    const url = 'https://restapi.amap.com/v3/staticmap';
    const resp = await axios.get(url, {
      params: {
        key: amapKey,
        location: `${center.lng},${center.lat}`,
        zoom: Math.max(3, Math.min(18, zoom)),
        size,
        scale: 2,
        markers: markers.join('|'),
      },
      responseType: 'arraybuffer',
      timeout: 8000,
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(Buffer.from(resp.data));
  } catch (e: any) {
    return res.status(500).json({ error: 'server_error', message: e?.message || 'staticmap_failed' });
  }
}



