import axios from 'axios';
import { z } from 'zod';
// Vercel Functions run on Node, but this TS file is linted under the Vite tsconfig (no Node types).
// Declare process to keep lint happy without widening project tsconfig scope.
declare const process: any;

type Mode = 'walk' | 'bike' | 'drive';

// User preference (contest demo): AI must try hard to output; allow waiting.
// Still keep a fallback so the core (AMap) flow never breaks.
const GLM_TIMEOUT_REPORT_MS = Number(process.env.GLM_TIMEOUT_REPORT_MS || 15000);
const GLM_MAX_RETRY = Number(process.env.GLM_MAX_RETRY || 2);

type CacheEntry<T> = { value: T; expiresAt: number };
function cacheGet<T>(m: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = m.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    m.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet<T>(m: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number) {
  m.set(key, { value, expiresAt: Date.now() + ttlMs });
}
const intentCache = new Map<string, CacheEntry<any>>();
const guideCache = new Map<string, CacheEntry<string[]>>();
const rerankCache = new Map<string, CacheEntry<{ top3: number[]; reportMarkdown: string }>>();

// Serialize GLM requests within one runtime to reduce 429 in demo.
let glmQueue: Promise<any> = Promise.resolve();
function withGlmLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = glmQueue.then(fn, fn);
  glmQueue = next.catch(() => {});
  return next;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function is429(e: any) {
  return Number(e?.response?.status) === 429;
}

const GlmOneCallSchema = z.object({
  reportMarkdown: z.string(),
  guide: z.array(z.string()).min(3).max(6),
});

async function glmReportAndGuide(params: {
  mood: string;
  mode: Mode;
  startTime: string;
  endTime: string;
  availableMin: number;
  minStayMin: number;
  intent: { primaryIntent: string; keywords: string[] };
  candidatesTop3: Array<{
    name: string;
    category: string;
    address: string;
    oneWayMinEst: number;
    playMinEst: number;
  }>;
  chosenTop1: {
    name: string;
    category: string;
    address: string;
    goMin: number;
    backMin: number;
    playMin: number;
  };
}) {
  const fallbackGuide = [
    `从现在出发，${modeLabel(params.mode)}约 ${params.chosenTop1.goMin} 分钟可到。`,
    `建议停留约 ${params.chosenTop1.playMin} 分钟，随手逛逛/拍照/吃点小东西。`,
    `返程预计 ${params.chosenTop1.backMin} 分钟，整体时间正好卡在空档里。`,
    `小贴士：留 10-15 分钟机动更舒服。`,
  ];

  const fallbackReport = [
    `## 推荐结论：${params.chosenTop1.name}`,
    ``,
    `### 你的意图`,
    params.mood ? `- ${params.mood}` : `- （未填写）`,
    `- 意图识别：${params.intent.primaryIntent}（规则兜底）`,
    ``,
    `### Top3对比（估算）`,
    ...params.candidatesTop3.map(
      (c, idx) => `- **${idx + 1}. ${c.name}**（${c.category}）· 预估单程 ${c.oneWayMinEst} 分 · 预估可停留 ${c.playMinEst} 分`
    ),
    ``,
    `### 为什么这么选`,
    `- 时间闭环：去${params.chosenTop1.goMin}分 + 玩${params.chosenTop1.playMin}分 + 回${params.chosenTop1.backMin}分`,
    `- 交通方式：${modeLabel(params.mode)}`,
    params.mood ? `- 偏好提示：${params.mood}` : `- 随机小确幸`,
    ``,
    `### 时间预算建议`,
    `- 建议预留 10-15 分钟机动`,
  ].join('\n');

  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) return { reportMarkdown: fallbackReport, guide: fallbackGuide, source: 'rule' as const };

  const cacheKey = JSON.stringify({
    mood: params.mood || '',
    mode: params.mode,
    startTime: params.startTime,
    endTime: params.endTime,
    minStayMin: params.minStayMin,
    intent: params.intent,
    c3: params.candidatesTop3.map((c) => [c.name, c.category, c.oneWayMinEst, c.playMinEst]),
    top1: [params.chosenTop1.name, params.chosenTop1.goMin, params.chosenTop1.backMin, params.chosenTop1.playMin],
  });
  const cached = cacheGet(guideCache as any, `onecall:${cacheKey}`) as any;
  if (cached) return cached;

  const prompt = [
    `你是“临时空闲去哪儿”的决策助手。请基于给定候选 Top3 与已确定的 Top1 精算时间，输出一份可直接展示的报告 + 轻攻略。`,
    `硬性约束：不得编造地点；不得添加候选列表外的地点名；用中文；避免安全风险（不建议夜间/偏僻）。`,
    `输入：交通方式=${modeLabel(params.mode)}；时间段=${params.startTime}-${params.endTime}（可用${params.availableMin}分钟）；最短停留=${params.minStayMin}分钟；用户偏好=${params.mood || '（未填写）'}。`,
    `意图（规则兜底）：primaryIntent=${params.intent.primaryIntent}；keywords=${params.intent.keywords.join('、') || '（无）'}`,
    ``,
    `候选Top3（估算）：`,
    JSON.stringify(
      params.candidatesTop3.map((c, index) => ({
        index,
        name: c.name,
        category: c.category,
        address: c.address,
        oneWayMinEst: c.oneWayMinEst,
        playMinEst: c.playMinEst,
      })),
      null,
      2
    ),
    ``,
    `Top1 精算时间（必须在报告中体现闭环）：`,
    JSON.stringify(params.chosenTop1, null, 2),
    ``,
    `请严格输出 JSON（不要 Markdown 包裹，不要多余文本）。格式：`,
    `{"reportMarkdown":"...markdown...","guide":["...","...","...","..."]}`,
    `reportMarkdown 必须包含：## 推荐结论、### Top3对比、### 为什么这么选、### 时间预算建议`,
    `guide 要求：3-5条，每条<=28字，具体可执行，不要编造不存在的项目。`,
  ].join('\n');

  const call = async () =>
    axios.post(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      {
        model: process.env.ZHIPU_MODEL || 'GLM-4-Flash-250414',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
      },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: GLM_TIMEOUT_REPORT_MS }
    );

  const run = async () => {
    for (let attempt = 0; attempt <= GLM_MAX_RETRY; attempt++) {
      try {
        const resp = await call();
        const content = String(resp.data?.choices?.[0]?.message?.content || '').trim();
        const json = extractFirstJsonObject(content) || content;
        const parsed = GlmOneCallSchema.safeParse(JSON.parse(json));
        if (!parsed.success) throw new Error('glm_bad_json');
        const out = { ...parsed.data, source: 'glm' as const };
        cacheSet(guideCache as any, `onecall:${cacheKey}`, out, 10 * 60 * 1000);
        return out;
      } catch (e: any) {
        if (is429(e) && attempt < GLM_MAX_RETRY) {
          await sleep(1200 * (attempt + 1));
          continue;
        }
        return { reportMarkdown: fallbackReport, guide: fallbackGuide, source: 'rule' as const };
      }
    }
    return { reportMarkdown: fallbackReport, guide: fallbackGuide, source: 'rule' as const };
  };

  // serialize for demo stability
  return withGlmLock(run);
}

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
  minStayMin: z.coerce.number().int().min(0).max(24 * 60).optional(),
  allowRelax: z.coerce.boolean().optional().default(true),
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

const IntentProfileSchema = z.object({
  keywords: z.array(z.string()).optional().default([]),
  primaryIntent: z.enum(['park', 'food', 'shopping', 'culture', 'movie', 'spa', 'other']).optional().default('other'),
  confidence: z.coerce.number().min(0).max(1).optional().default(0.5),
  explain: z.string().optional().default(''),
});

function heuristicKeywords(mood: string): string[] {
  const m = mood.trim();
  if (!m) return [];
  const out: string[] = [];
  const push = (...xs: string[]) => xs.forEach((x) => out.push(x));

  if (/温泉|泡汤|汤泉|汗蒸/.test(m)) push('温泉', '汤泉', '泡汤');
  if (/咖啡|拿铁|美式/.test(m)) push('咖啡', '咖啡馆');
  if (/夜宵|宵夜|烧烤/.test(m)) push('夜宵', '烧烤');
  if (/烧烤|烤串|烤肉|撸串|串串/.test(m)) push('烧烤', '烤串', '烤肉', '串串香');
  if (/火锅|涮肉|涮锅|麻辣烫|串串香/.test(m)) push('火锅', '重庆火锅', '牛肉火锅', '涮肉', '麻辣烫');
  if (/逛街|商场|室内/.test(m)) push('商场');
  // NOTE: "公园" 和 "江边" 分开触发，避免用户只想逛公园时也把餐饮类（江边烧烤等）一起搜出来
  if (/江边/.test(m)) push('江边');
  if (/公园/.test(m)) push('公园');
  if (/散步|走走/.test(m)) push('江边', '公园');
  if (/电影|电影院/.test(m)) push('电影院');
  if (/展|博物馆|美术馆|展馆/.test(m)) push('博物馆', '展馆');

  // fallback: use user text as keyword if short enough
  if (out.length === 0 && m.length <= 8) out.push(m);
  return Array.from(new Set(out)).slice(0, 6);
}

function normalizeText(s: string) {
  return (s || '').toLowerCase().replace(/\s+/g, '');
}

function intentMatchScore(params: { keywords: string[]; name: string; address: string; category: string }) {
  const kws = params.keywords.map((k) => k.trim()).filter(Boolean);
  if (kws.length === 0) return { hits: 0, score: 0 };
  const text = normalizeText([params.name, params.address, params.category].join(' '));
  let hits = 0;
  for (const kw of kws) {
    if (!kw) continue;
    if (text.includes(normalizeText(kw))) hits += 1;
  }
  // soft-score: more hits => higher
  return { hits, score: hits / kws.length };
}

type IntentPrimary = 'park' | 'food' | 'shopping' | 'culture' | 'movie' | 'spa' | 'other';

function poiTopType(typeStr: string) {
  return String(typeStr || '').split(';')[0] || '';
}

function inferIntentPrimary(mood: string, intentKeywords: string[]): { primary: IntentPrimary; strong: boolean } {
  const text = `${mood || ''} ${(intentKeywords || []).join(' ')}`.trim();
  if (!text) return { primary: 'other', strong: false };

  // strong signals
  if (/温泉|泡汤|汤泉|汗蒸/.test(text)) return { primary: 'spa', strong: true };
  if (/电影|电影院/.test(text)) return { primary: 'movie', strong: true };
  if (/博物馆|展馆|美术馆|展览|看展/.test(text)) return { primary: 'culture', strong: true };
  if (/公园|景点|风景|江边|散步|走走|遛弯|拍照/.test(text)) return { primary: 'park', strong: true };
  if (/商场|逛街|购物/.test(text)) return { primary: 'shopping', strong: true };
  if (/吃|喝|咖啡|甜品|小吃|夜宵|宵夜|火锅|烧烤|烤串|烤肉/.test(text)) return { primary: 'food', strong: true };

  // weak (fallback)
  return { primary: 'other', strong: false };
}

function poiAffinity(primary: IntentPrimary, poi: { name: string; category: string }) {
  const name = String(poi.name || '');
  const category = String(poi.category || '');
  const top = poiTopType(category);
  const full = `${name} ${category}`;

  const isFood = top === '餐饮服务' || /餐饮服务|小吃|烧烤|火锅|咖啡|甜品/.test(full);
  const isPark =
    /公园|公园广场|江边|滨江|绿地|湿地/.test(full) ||
    top === '风景名胜' ||
    /风景名胜|旅游景点|公园广场/.test(category);
  const isShopping = top === '购物服务' || /商场|购物|步行街/.test(full);
  const isCulture = top === '科教文化服务' || /博物馆|展馆|美术馆|图书馆/.test(full);
  const isMovie = /电影院/.test(full);
  const isSpa = /温泉|汤泉|汗蒸|浴场/.test(full);

  // affinity in [-1, 1] (1 means strongly preferred)
  if (primary === 'park') {
    if (isPark) return 1;
    if (isFood) return -0.85;
    if (isShopping) return -0.4;
    return -0.15;
  }
  if (primary === 'food') {
    if (isFood) return 1;
    if (isPark) return -0.2;
    if (isCulture) return -0.35;
    return -0.15;
  }
  if (primary === 'shopping') {
    if (isShopping) return 1;
    if (isFood) return 0.1; // 商场吃喝算合理伴随
    if (isPark) return -0.4;
    return -0.15;
  }
  if (primary === 'culture') {
    if (isCulture) return 1;
    if (isFood) return -0.4;
    return -0.15;
  }
  if (primary === 'movie') {
    if (isMovie) return 1;
    if (isFood) return 0.1;
    return -0.2;
  }
  if (primary === 'spa') {
    if (isSpa) return 1;
    if (isFood) return -0.4;
    return -0.2;
  }
  return 0;
}

function inferMinStayMin(params: { mood: string; intentKeywords: string[]; availableMin: number }) {
  const m = params.mood || '';
  const kws = params.intentKeywords.join(' ');
  let minStay = 30;
  if (/温泉|泡汤|汤泉|汗蒸/.test(m + kws)) minStay = 120;
  else if (/电影|电影院/.test(m + kws)) minStay = 120;
  else if (/火锅|涮肉|烧烤|烤串|夜宵|宵夜|麻辣烫/.test(m + kws)) minStay = 60;
  else if (/咖啡|甜品/.test(m + kws)) minStay = 45;
  else if (/商场|逛街/.test(m + kws)) minStay = 90;
  else if (/江边|公园|散步|走走/.test(m + kws)) minStay = 30;
  else if (/博物馆|展馆|美术馆/.test(m + kws)) minStay = 60;
  // keep some buffer
  return clamp(minStay, 0, Math.max(0, params.availableMin - 10));
}

const RerankSchema = z.object({
  top3: z.array(z.number().int()).min(1).max(3),
  reportMarkdown: z.string(),
});

// NOTE: Previously we used two GLM calls (rerank+report, lightGuide).
// For stability, we now generate report+guide in ONE GLM call (see glmReportAndGuide).

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

async function glmIntentProfile(mood: string) {
  const apiKey = process.env.ZHIPU_API_KEY;
  // rule fallback
  const fallback = () => {
    const keywords = heuristicKeywords(mood);
    const inferred = inferIntentPrimary(mood, keywords);
    return { keywords, primaryIntent: inferred.primary, confidence: inferred.strong ? 0.75 : 0.55, explain: '', source: 'rule' as const };
  };

  // Intentionally NOT calling LLM here (keep ONE LLM call total in recommend flow).
  // We still accept apiKey so the signature stays stable for future feature flags.
  void apiKey;
  return fallback();
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

  // kept for legacy callers; recommend flow uses glmReportAndGuide instead.
  return fallback;
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
    const relaxNotes: string[] = [];

    const location = `${origin.lng},${origin.lat}`;
    // If city is provided, scope search to that city (default: 宜昌).
    // If you want to support "follow my city", you can pass city="" from frontend to disable citylimit.
    const scopedCity = city?.trim() ? city.trim() : undefined;

    const radius = suggestedRadiusMeters(mode, safeAvailableMin);
    const intentProfile = parsed.data.categories?.length
      ? (() => {
          const keywords = parsed.data.categories;
          const inferred = inferIntentPrimary(mood, keywords);
          return {
            keywords,
            primaryIntent: inferred.primary,
            confidence: inferred.strong ? 0.9 : 0.7,
            explain: '',
            source: 'manual' as const,
          };
        })()
      : (() => {
          const keywords = heuristicKeywords(mood);
          const inferred = inferIntentPrimary(mood, keywords);
          return {
            keywords,
            primaryIntent: inferred.primary,
            confidence: inferred.strong ? 0.75 : 0.55,
            explain: '',
            source: 'rule' as const,
          };
        })();

    const intentKeywords = intentProfile.keywords;
    const searchKeywords = (intentKeywords?.length ? intentKeywords : defaultCategoryKeywords()).slice(0, 8);
    const intent = { primary: intentProfile.primaryIntent as IntentPrimary, strong: intentProfile.confidence >= 0.55 };

    const poiCandidates: Array<{
      id: string;
      name: string;
      category: string;
      address: string;
      location: string;
      distanceMeter?: number;
      weightBase: number;
    }> = [];

    async function fetchPoisByKeywords(kws: string[]) {
      for (const kw of kws) {
        // 拉两页，避免“只取最近8个全被过滤/全不相关”
        for (const page of [1, 2]) {
          const data = await amapPlaceAround({
            key: amapKey,
            location,
            keywords: kw,
            radius,
            pageSize: 15,
            page,
            city: scopedCity,
          });
          const pois = Array.isArray(data?.pois) ? data.pois : [];
          for (const p of pois) {
            if (!p?.location || !p?.name) continue;
            poiCandidates.push({
              id: String(p.id || `${kw}:${p.location}:${p.name}`),
              name: String(p.name),
              // 这里用高德返回的 type 作为真实类别；kw 只是“搜索词”
              category: String(p.type || kw),
              address: String(p.address || p.pname || '宜昌'),
              location: String(p.location),
              distanceMeter: Number(p.distance || 0) || undefined,
              weightBase: 1,
            });
          }
          if (poiCandidates.length >= 45) return;
        }
      }
    }

    await fetchPoisByKeywords(searchKeywords);
    // 若意图搜索一个都没拉到，自动 fallback 到通用类目（保证“总有结果”）
    if (poiCandidates.length === 0 && intentKeywords.length > 0) {
      await fetchPoisByKeywords(defaultCategoryKeywords());
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

    let minStayMin = parsed.data.minStayMin ?? inferMinStayMin({ mood, intentKeywords, availableMin: safeAvailableMin });
    minStayMin = clamp(minStayMin, 0, Math.max(0, safeAvailableMin - 10));

    const mapped = limit
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
        const match = intentMatchScore({
          keywords: intentKeywords,
          name: poi.name,
          address: poi.address,
          category: poi.category,
        });
        const affinity = poiAffinity(intent.primary, { name: poi.name, category: poi.category });
        // 只有当“意图关键词”存在时，才做强约束过滤；否则不要误杀。
        const requiresMatch = intentKeywords.length > 0;
        if (requiresMatch && match.hits === 0) {
          return null;
        }

        // 意图强时：降低“距离”对结果的支配性，并用“类别亲和度”强惩罚冲突类（如逛公园时餐饮靠后）
        const wCloseness = intent.strong ? 0.4 : 0.55;
        const wNovelty = intent.strong ? 0.2 : 0.25;
        const wMatch = 0.2;
        const base = (wCloseness * closeness + wNovelty * novelty + wMatch * match.score) * 100;
        const affinityFactor = intent.strong ? clamp(1 + affinity * 1.2, 0.05, 2.6) : clamp(1 + affinity * 0.6, 0.2, 1.8);
        const weight = base * affinityFactor;
        return { poi, oneWayMin, travelMinEst, playMinEst, weight, matchHits: match.hits, affinity };
      })
      .filter(Boolean)
      .filter((x: any) => x.playMinEst >= 0);

    // 如果存在足够“同意图”的候选，进一步压制强冲突类，避免榜单被“碰巧命中地址词”的 POI 霸榜。
    const hasHighAffinity = (mapped as any[]).some((x) => typeof x.affinity === 'number' && x.affinity >= 0.7);
    const intentFiltered =
      intent.strong && hasHighAffinity
        ? (mapped as any[]).filter((x) => (typeof x.affinity === 'number' ? x.affinity >= -0.2 : true))
        : (mapped as any[]);

    // 先按最短停留过滤；如果一个都没了，允许自动放宽并解释
    let rough = intentFiltered.filter((x) => x.playMinEst >= minStayMin);
    if (rough.length === 0 && parsed.data.allowRelax) {
      const relaxed = Math.min(minStayMin, 20);
      if (relaxed < minStayMin) {
        relaxNotes.push(`为确保给出方案，已将最短停留从 ${minStayMin} 分钟放宽到 ${relaxed} 分钟。`);
        minStayMin = relaxed;
      }
      rough = (mapped as any[]).filter((x) => x.playMinEst >= minStayMin);
    }

    // 默认避免“太近没意思”，但如果因此一个都没了，就放宽（餐饮类通常就近更合理）。
    const minOneWay = intentKeywords.length > 0 ? 1 : 6;
    rough = rough.filter((x) => x.oneWayMin >= minOneWay);
    if (rough.length === 0) {
      // 最终兜底：允许很近的点（尤其是餐饮类）
      relaxNotes.push('附近地点较集中，已允许推荐更近的地点。');
      rough = (mapped as any[]).filter((x) => x.playMinEst >= minStayMin);
    }

    rough = rough.sort((a, b) => b.weight - a.weight).slice(0, 10); // keep small for stability

    if (rough.length === 0) {
      return res.status(200).json({
        ok: true,
        empty: true,
        message: '时间段有点紧，往返后游玩时间不足（建议增加时长或切换交通方式）',
      });
    }

    const candidatesForAi = rough.slice(0, 12).map((c) => ({
      name: c.poi.name,
      category: c.poi.category,
      address: c.poi.address,
      location: c.poi.location,
      oneWayMinEst: c.oneWayMin,
      playMinEst: c.playMinEst,
    }));
    const topCandidates = candidatesForAi.slice(0, 3);
    const chosen = rough[0];
    const [goRes, backRes] = await Promise.all([
      amapDirection({ key: amapKey, mode, origin: location, destination: chosen.poi.location }),
      amapDirection({ key: amapKey, mode, origin: chosen.poi.location, destination: location }),
    ]);
    const go = extractDurationAndPolyline(goRes);
    const back = extractDurationAndPolyline(backRes);

    const goMin = Math.max(1, Math.round(go.durationSec / 60));
    const backMin = Math.max(1, Math.round(back.durationSec / 60));
    const playMin = safeAvailableMin - (goMin + backMin);
    if (playMin < 0) {
      return res.status(200).json({
        ok: true,
        empty: true,
        message: '路线规划有点慢（网络波动）。请再点一次“随机一个方案”。',
      });
    }
    if (playMin < minStayMin && parsed.data.allowRelax) {
      relaxNotes.push(`受时间/距离影响，实际可停留约 ${playMin} 分钟，低于期望的 ${minStayMin} 分钟。你可以适当延长结束时间或切换交通方式。`);
    }

    const ai = await glmReportAndGuide({
      mood,
      mode,
      startTime,
      endTime,
      availableMin: safeAvailableMin,
      minStayMin,
      intent: { primaryIntent: intentProfile.primaryIntent, keywords: intentProfile.keywords },
      candidatesTop3: topCandidates.map((c) => ({
        name: c.name,
        category: c.category,
        address: c.address,
        oneWayMinEst: c.oneWayMinEst || 0,
        playMinEst: c.playMinEst || 0,
      })),
      chosenTop1: {
        name: chosen.poi.name,
        category: chosen.poi.category,
        address: chosen.poi.address,
        goMin,
        backMin,
        playMin,
      },
    });

    const reasons = [
      `时间闭环：去${goMin}分 + 玩${playMin}分 + 回${backMin}分`,
      `交通方式：${modeLabel(mode)}`,
      mood ? `偏好提示：${mood}` : '随机小确幸',
      `意图识别：${intentProfile.primaryIntent}${intentProfile.source === 'manual' ? '（手动）' : '（规则兜底）'}`,
      `AI文案：${ai.source === 'glm' ? '已生成' : '兜底文案'}`,
    ];

    return res.status(200).json({
      ok: true,
      city: scopedCity || '不限城市',
      input: { origin, mode, startTime, endTime, availableMin: safeAvailableMin },
      intent: {
        primaryIntent: intentProfile.primaryIntent,
        confidence: intentProfile.confidence,
        keywords: intentProfile.keywords,
        explain: intentProfile.explain,
        source: intentProfile.source,
      },
      relaxNotes: relaxNotes.length ? relaxNotes : undefined,
      candidates: topCandidates,
      reportMarkdown: [
        `![路线概览](/api/staticmap?origin=${encodeURIComponent(location)}&dest=${encodeURIComponent(chosen.poi.location)}&zoom=13&size=900*360)`,
        ``,
        ai.reportMarkdown,
        ``,
        `---`,
        `### 精算后的时间闭环（Top1）`,
        `- 去：${goMin} 分`,
        `- 玩：${playMin} 分`,
        `- 回：${backMin} 分`,
        ...(relaxNotes.length ? [``, `### 放宽说明`, ...relaxNotes.map((x) => `- ${x}`)] : []),
      ].filter(Boolean).join('\n'),
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
        guide: ai.guide,
      },
    });

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


