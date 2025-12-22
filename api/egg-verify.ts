import { z } from 'zod';

const VerifySchema = z.object({
  user: z.object({
    lng: z.number().min(-180).max(180),
    lat: z.number().min(-90).max(90),
  }),
  destLocation: z.string().min(3), // "lng,lat"
  radiusMeter: z.coerce.number().int().min(30).max(1000).default(140),
});

function haversineMeters(a: { lng: number; lat: number }, b: { lng: number; lat: number }) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const parsed = VerifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });

  const [lngStr, latStr] = parsed.data.destLocation.split(',');
  const dest = { lng: Number(lngStr), lat: Number(latStr) };
  if (!Number.isFinite(dest.lng) || !Number.isFinite(dest.lat)) {
    return res.status(400).json({ error: 'bad_request', message: 'Invalid destLocation' });
  }

  const dist = haversineMeters(parsed.data.user, dest);
  const reached = dist <= parsed.data.radiusMeter;

  return res.status(200).json({
    ok: true,
    reached,
    distanceMeter: Math.round(dist),
    radiusMeter: parsed.data.radiusMeter,
  });
}


