import axios from 'axios';
import { z } from 'zod';

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
  return ['咖啡', '甜品', '小吃', '夜市', '公园', '江边', '商场', '电影院', '博物馆', '展馆', '景点'];
}

function suggestedRadiusMeters(mode: Mode, availableMinutes: number): number {
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
  key: string;
  location: string;
  keywords: string;
  radius: number;
  pageSize: number;
  page: number;
  city?: string;
}) {
  const url = 'https://restapi.amap.com/v3/place/around';
  const resp = await axios.get(url, {
    params: {
      key: params.key,
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

async function amapRegeo(params: { key: string; location: string }) {
  const url = 'https://restapi.amap.com/v3/geocode/regeo';
  const resp = await axios.get(url, {
    params: {
      key: params.key,
      location: params.location,
      radius: 1000,
      extensions: 'base',
    },
    timeout: 8000,
  });
  return resp.data as any;
}

async function amapDirection(params: {
  key: string;
  mode: Mode;
  origin: string;
  destination: string;
}) {
  const baseParams = {
    key: params.key,
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

  const url = 'https://restapi.amap.com/v4/direction/bicycling';
  const resp = await axios.get(url, { params: baseParams, timeout: 4500 });
  return { raw: resp.data, type: 'bike' as const };
}

function extractDurationAndPolyline(result: { type: 'walk' | 'bike' | 'drive'; raw: any }) {
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

  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) return fallback;

  const prompt =
    `你是一个“临时空闲去哪儿”的轻攻略助手。请严格输出4条要点，每条不超过28个字，务必具体可执行，不要编造不存在的项目。\n` +
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
        headers: { Authorization: `Bearer ${apiKey}` },
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
  } catch {
    return fallback;
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const amapKey = process.env.AMAP_WEB_SERVICE_KEY;
  if (!amapKey) {
    return res.status(500).json({ error: 'missing_env', message: 'Missing AMAP_WEB_SERVICE_KEY' });
  }

  const parsed = RecommendSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
  }

  try {
    const { origin, mode, startTime, endTime, mood, city } = parsed.data;
    const availableMin = minutesBetween(startTime, endTime);
    const safeAvailableMin = clamp(availableMin, 30, 10 * 60);

    const location = `${origin.lng},${origin.lat}`;
    // If city is provided, scope search to that city (default: 宜昌).
    // If you want to support "follow my city", you can pass city="" from frontend to disable citylimit.
    const scopedCity = city?.trim() ? city.trim() : undefined;

    const radius = suggestedRadiusMeters(mode, safeAvailableMin);
    const keywords = (parsed.data.categories?.length ? parsed.data.categories : defaultCategoryKeywords()).slice(0, 8);

    const poiCandidates: Array<{
      id: string;
      name: string;
      category: string;
      address: string;
      location: string;
      distanceMeter?: number;
      weightBase: number;
    }> = [];

    for (const kw of keywords) {
      const data = await amapPlaceAround({
        key: amapKey,
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

    // IMPORTANT: Vercel 线上环境很容易超时；这里采用“距离粗筛 + 少量路径规划精算”策略：
    // - 先用 POI 的 distance（或哈弗辛）估算往返时间，挑出可行候选
    // - 只对 1~3 个候选做路径规划（去/回），避免 N*2 次调用导致 500 timeout
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
        const travelMinEst = oneWayMin * 2;
        const playMinEst = safeAvailableMin - travelMinEst;
        const closeness = 1 - Math.min(1, Math.abs(oneWayMin - idealOneWay) / idealOneWay);
        const novelty = 0.7 + Math.random() * 0.6;
        const weight = (0.6 * closeness + 0.4 * novelty) * 100;
        return { poi, oneWayMin, travelMinEst, playMinEst, weight };
      })
      .filter((x) => x.playMinEst >= 20 && x.oneWayMin >= 6)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 10); // keep small for stability

    if (rough.length === 0) {
      return res.status(200).json({
        ok: true,
        empty: true,
        message: '时间段有点紧，往返后游玩时间不足（建议增加时长或切换交通方式）',
      });
    }

    // Try a few candidates to avoid occasional direction failures.
    const candidates = rough.slice(0, 6);
    for (let i = 0; i < Math.min(3, candidates.length); i++) {
      const pick = weightedRandom(candidates.map((c) => ({ ...c, weight: c.weight })), Math.random);
      const chosen = pick ?? candidates[i];

      const [goRes, backRes] = await Promise.all([
        amapDirection({ key: amapKey, mode, origin: location, destination: chosen.poi.location }),
        amapDirection({ key: amapKey, mode, origin: chosen.poi.location, destination: location }),
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

      return res.status(200).json({
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
    return res.status(500).json({ error: 'server_error', message: err?.message || 'unknown' });
  }
}


