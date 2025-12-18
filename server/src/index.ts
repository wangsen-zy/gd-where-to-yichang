import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import cors from 'cors';
import express from 'express';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const AMAP_KEY = process.env.AMAP_WEB_SERVICE_KEY;
const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;
const PORT = Number(process.env.PORT || 8787);

if (!AMAP_KEY) {
  // We still boot so the frontend can load, but API calls will 500 with clear error.
  console.warn('[server] Missing env AMAP_WEB_SERVICE_KEY');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

type Mode = 'walk' | 'bike' | 'drive';

const RecommendSchema = z.object({
  origin: z.object({
    lng: z.number().min(-180).max(180),
    lat: z.number().min(-90).max(90),
  }),
  mode: z.enum(['walk', 'bike', 'drive']).default('walk'),
  startTime: z.string().min(4), // "HH:mm"
  endTime: z.string().min(4), // "HH:mm"
  mood: z.string().optional().default(''),
  categories: z.array(z.string()).optional(),
  city: z.string().optional().default('宜昌'),
});

function minutesBetween(startHHmm: string, endHHmm: string): number {
  const [sh, sm] = startHHmm.split(':').map(Number);
  const [eh, em] = endHHmm.split(':').map(Number);
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  // Allow crossing midnight (rare for this app, but safe).
  return e >= s ? e - s : 24 * 60 - s + e;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function modeLabel(mode: Mode) {
  if (mode === 'walk') return '步行';
  if (mode === 'bike') return '骑行';
  return '驾车';
}

function defaultCategoryKeywords(): string[] {
  // Simple keyword-based around-search for MVP (no need to maintain AMap "types" codes).
  return ['咖啡', '甜品', '小吃', '夜市', '公园', '江边', '商场', '电影院', '博物馆', '展馆', '景点'];
}

function suggestedRadiusMeters(mode: Mode, availableMinutes: number): number {
  // Heuristic: keep one-way travel under ~25% of total time.
  const oneWayMin = clamp(Math.floor(availableMinutes * 0.25), 8, 60);
  const metersPerMin = mode === 'walk' ? 85 : mode === 'bike' ? 250 : 550;
  return clamp(oneWayMin * metersPerMin, 800, 12000);
}

function metersPerMin(mode: Mode) {
  return mode === 'walk' ? 85 : mode === 'bike' ? 250 : 550;
}

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

async function amapPlaceAround(params: {
  location: string; // "lng,lat"
  keywords: string;
  radius: number;
  pageSize: number;
  page: number;
  city?: string;
}) {
  if (!AMAP_KEY) throw new Error('Missing AMAP_WEB_SERVICE_KEY');
  const url = 'https://restapi.amap.com/v3/place/around';
  const resp = await axios.get(url, {
    params: {
      key: AMAP_KEY,
      location: params.location,
      keywords: params.keywords,
      radius: params.radius,
      sortrule: 'distance',
      page_size: params.pageSize,
      page: params.page,
      ...(params.city ? { city: params.city, citylimit: true } : {}),
      extensions: 'base',
    },
    timeout: 8000,
  });
  return resp.data as any;
}

async function amapDirection(params: {
  mode: Mode;
  origin: string; // "lng,lat"
  destination: string; // "lng,lat"
}) {
  if (!AMAP_KEY) throw new Error('Missing AMAP_WEB_SERVICE_KEY');

  const baseParams = {
    key: AMAP_KEY,
    origin: params.origin,
    destination: params.destination,
  };

  if (params.mode === 'walk') {
    const url = 'https://restapi.amap.com/v3/direction/walking';
    const resp = await axios.get(url, { params: baseParams, timeout: 4500 });
    return { raw: resp.data, type: 'walk' as const };
  }

  if (params.mode === 'drive') {
    const url = 'https://restapi.amap.com/v3/direction/driving';
    const resp = await axios.get(url, {
      params: { ...baseParams, strategy: 0, extensions: 'base' },
      timeout: 4500,
    });
    return { raw: resp.data, type: 'drive' as const };
  }

  // bike
  const url = 'https://restapi.amap.com/v4/direction/bicycling';
  const resp = await axios.get(url, { params: baseParams, timeout: 4500 });
  return { raw: resp.data, type: 'bike' as const };
}

function extractDurationAndPolyline(result: { type: 'walk' | 'bike' | 'drive'; raw: any }) {
  // Return durationSec and polyline string (for frontend polyline).
  if (result.type === 'bike') {
    const data = result.raw?.data;
    const path = data?.paths?.[0];
    const duration = Number(path?.duration || 0);
    const polyline = String(path?.polyline || '');
    return { durationSec: duration, polyline };
  }

  const route = result.raw?.route;
  const path = route?.paths?.[0];
  const duration = Number(path?.duration || 0);
  const steps = Array.isArray(path?.steps) ? path.steps : [];
  const polyline = steps.map((s: any) => s?.polyline).filter(Boolean).join(';');
  return { durationSec: duration, polyline };
}

function weightedRandom<T extends { weight: number }>(items: T[], rng: () => number): T | null {
  const sum = items.reduce((a, b) => a + Math.max(0, b.weight), 0);
  if (sum <= 0) return null;
  let r = rng() * sum;
  for (const it of items) {
    r -= Math.max(0, it.weight);
    if (r <= 0) return it;
  }
  return items[items.length - 1] ?? null;
}

async function glmLightGuide(input: {
  poiName: string;
  category: string;
  address: string;
  mode: Mode;
  startTime: string;
  endTime: string;
  goMin: number;
  backMin: number;
  playMin: number;
}) {
  const fallback = [
    `从现在出发，${modeLabel(input.mode)}约 ${input.goMin} 分钟可到。`,
    `建议停留约 ${input.playMin} 分钟，随手逛逛/拍照/吃点小东西。`,
    `返程预计 ${input.backMin} 分钟，整体时间正好卡在空档里。`,
    `小贴士：留 10-15 分钟机动更舒服。`,
  ];

  if (!ZHIPU_API_KEY) return fallback;

  // Minimal, controllable prompt for reproducibility.
  const prompt = `你是一个“临时空闲去哪儿”的轻攻略助手。请严格输出4条要点，每条不超过28个字，务必具体可执行，不要编造不存在的项目。\n` +
    `信息：城市=宜昌；地点=${input.poiName}；类别=${input.category}；地址=${input.address}；交通=${modeLabel(input.mode)}；时间段=${input.startTime}-${input.endTime}；去程=${input.goMin}分钟；返程=${input.backMin}分钟；可游玩=${input.playMin}分钟。\n` +
    `输出格式：每行以“- ”开头。`;

  try {
    const resp = await axios.post(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      {
        model: process.env.ZHIPU_MODEL || 'glm-4.5-flash',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
      },
      {
        headers: { Authorization: `Bearer ${ZHIPU_API_KEY}` },
        timeout: 12000,
      }
    );

    const text = String(resp.data?.choices?.[0]?.message?.content || '').trim();
    const lines = text
      .split('\n')
      .map((l: string) => l.trim())
      .filter(Boolean)
      .map((l: string) => l.replace(/^[•\-]\s*/g, '').trim());

    const sliced = lines.slice(0, 6);
    return sliced.length ? sliced : fallback;
  } catch (e) {
    console.warn('[glm] failed, fallback to rule text');
    return fallback;
  }
}

app.post('/api/recommend', async (req, res) => {
  const parsed = RecommendSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
  }

  try {
    const { origin, mode, startTime, endTime, mood } = parsed.data;
    const scopedCity = parsed.data.city?.trim() ? parsed.data.city.trim() : undefined;
    const availableMin = minutesBetween(startTime, endTime);
    const safeAvailableMin = clamp(availableMin, 30, 10 * 60);

    const location = `${origin.lng},${origin.lat}`;
    const radius = suggestedRadiusMeters(mode, safeAvailableMin);
    const keywords = (parsed.data.categories?.length ? parsed.data.categories : defaultCategoryKeywords())
      .slice(0, 8);

    // Gather candidate POIs (small N for reliability).
    const poiCandidates: Array<{
      id: string;
      name: string;
      category: string;
      address: string;
      location: string; // "lng,lat"
      distanceMeter?: number;
      weightBase: number;
    }> = [];

    for (const kw of keywords) {
      const data = await amapPlaceAround({
        location,
        keywords: kw,
        radius,
        pageSize: 8,
        page: 1,
        city: scopedCity,
      });
      const pois = Array.isArray(data?.pois) ? data.pois : [];
      for (const p of pois) {
        if (!p?.location || !p?.name) continue;
        poiCandidates.push({
          id: String(p.id || `${kw}:${p.location}:${p.name}`),
          name: String(p.name),
          category: kw,
          address: String(p.address || p.pname || '宜昌'),
          location: String(p.location),
          distanceMeter: Number(p.distance || 0) || undefined,
          weightBase: 1,
        });
      }
      if (poiCandidates.length >= 30) break;
    }

    // De-dup by location+name
    const seen = new Set<string>();
    const unique = poiCandidates.filter((p) => {
      const k = `${p.location}::${p.name}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const limit = unique.slice(0, 18);
    if (limit.length === 0) {
      return res.status(200).json({
        ok: true,
        empty: true,
        message: '没有找到合适的附近地点（可尝试扩大时间段或切换交通方式）',
      });
    }

    // IMPORTANT: avoid too many direction requests (N*2) which causes timeouts.
    const originPt = { lng: origin.lng, lat: origin.lat };
    const idealOneWay = clamp(Math.round(safeAvailableMin * 0.2), 10, 30);
    const mpmin = metersPerMin(mode);

    const rough = limit
      .map((poi) => {
        const [dlng, dlat] = poi.location.split(',').map(Number);
        const dist =
          typeof poi.distanceMeter === 'number' && poi.distanceMeter > 0
            ? poi.distanceMeter
            : haversineMeters(originPt, { lng: dlng, lat: dlat });
        const oneWayMin = Math.max(1, Math.round(dist / mpmin));
        const playMinEst = safeAvailableMin - oneWayMin * 2;
        const closeness = 1 - Math.min(1, Math.abs(oneWayMin - idealOneWay) / idealOneWay);
        const novelty = 0.7 + Math.random() * 0.6;
        const weight = (0.6 * closeness + 0.4 * novelty) * 100;
        return { poi, oneWayMin, playMinEst, weight };
      })
      .filter((x) => x.playMinEst >= 20 && x.oneWayMin >= 6)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 10);

    if (rough.length === 0) {
      return res.status(200).json({
        ok: true,
        empty: true,
        message: '时间段有点紧，往返后游玩时间不足（建议增加时长或切换交通方式）',
      });
    }

    const candidates = rough.slice(0, 6);
    for (let i = 0; i < Math.min(3, candidates.length); i++) {
      const pick = weightedRandom(candidates.map((c) => ({ ...c, weight: c.weight })), Math.random);
      const chosen = pick ?? candidates[i];

      const [goRes, backRes] = await Promise.all([
        amapDirection({ mode, origin: location, destination: chosen.poi.location }),
        amapDirection({ mode, origin: chosen.poi.location, destination: location }),
      ]);
      const go = extractDurationAndPolyline(goRes);
      const back = extractDurationAndPolyline(backRes);

      const goMin = Math.max(1, Math.round(go.durationSec / 60));
      const backMin = Math.max(1, Math.round(back.durationSec / 60));
      const playMin = safeAvailableMin - (goMin + backMin);
      if (playMin < 20) continue;

      const reasons = [
        `时间闭环：去${goMin}分 + 玩${playMin}分 + 回${backMin}分`,
        `交通方式：${modeLabel(mode)}`,
        mood ? `偏好提示：${mood}` : '随机小确幸',
      ];

      const guideLines = await glmLightGuide({
        poiName: chosen.poi.name,
        category: chosen.poi.category,
        address: chosen.poi.address,
        mode,
        startTime,
        endTime,
        goMin,
        backMin,
        playMin,
      });

      return res.json({
        ok: true,
        city: scopedCity || '不限城市',
        input: { origin, mode, startTime, endTime, availableMin: safeAvailableMin },
        result: {
          name: chosen.poi.name,
          category: chosen.poi.category,
          address: chosen.poi.address,
          location: chosen.poi.location,
          goMin,
          backMin,
          playMin,
          polyline: go.polyline,
          reasons,
          guide: guideLines,
        },
      });
    }

    return res.status(200).json({
      ok: true,
      empty: true,
      message: '路线规划有点慢（网络波动）。请再点一次“随机一个方案”。',
    });
  } catch (err: any) {
    console.error(err?.response?.data || err);
    return res.status(500).json({
      error: 'server_error',
      message: err?.message || 'unknown',
    });
  }
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});


