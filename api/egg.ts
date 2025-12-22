import axios from 'axios';
import { z } from 'zod';

// Vercel Functions run on Node, but this TS file is linted under the Vite tsconfig (no Node types).
// Declare process to keep lint happy without widening project tsconfig scope.
declare const process: any;

const DAY_START_MIN = 6 * 60; // 06:00
const DAY_END_MIN = 20 * 60; // 20:00

const EggRequestSchema = z.object({
  mode: z.enum(['walk', 'bike', 'drive']).default('walk'),
  startTime: z.string().min(4), // HH:mm
  endTime: z.string().min(4), // HH:mm
  mood: z.string().optional().default(''),
  city: z.string().optional().default('宜昌'),
  poi: z.object({
    name: z.string().min(1),
    category: z.string().optional().default(''),
    address: z.string().optional().default(''),
    location: z.string().min(3), // "lng,lat"
  }),
  playMin: z.coerce.number().int().min(0).max(24 * 60).optional(),
});

const StorySchema = z.object({
  title: z.string().min(1),
  story: z.string().min(1),
  tasks: z.array(z.string()).min(2).max(5),
});

function hhmmToMin(hhmm: string) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function isDaytimeWindow(startTime: string, endTime: string) {
  const s = hhmmToMin(startTime);
  const e = hhmmToMin(endTime);
  // We treat "crossing midnight" as not-daytime for safety.
  if (e < s) return false;
  return s >= DAY_START_MIN && e <= DAY_END_MIN;
}

function safeTasksByCategory(poi: { name: string; category: string }, playMin?: number) {
  const full = `${poi.name} ${poi.category}`.toLowerCase();
  const isPark = /公园|风景|景点|广场|江|湖|湿地|绿地/.test(full);
  const isMall = /商场|购物|步行街|mall/.test(full);
  const isMuseum = /博物馆|展馆|美术馆|图书馆/.test(full);

  const walkSteps = playMin && playMin < 20 ? 300 : 600;
  if (isPark) {
    return [
      `在园内慢走 ${walkSteps} 步，找一处你觉得“最松弛”的角落`,
      `停留 2 分钟，拍一张“树影/水面/天空”（可不上传）`,
      `离开前深呼吸 10 次，把今天的烦恼丢在这里`,
    ];
  }
  if (isMuseum) {
    return [
      `找到一块你最感兴趣的展牌，读完并用一句话总结`,
      `选一个角落安静坐 2 分钟，观察人群节奏`,
      `离开前在脑子里记住 1 个新知识点`,
    ];
  }
  if (isMall) {
    return [
      `随便逛 10 分钟，只进 1 家你没去过的店看看`,
      `找到一个光线舒服的地方停留 2 分钟，放空一下`,
      `离开前给自己一个“今日小奖励”的想法（不一定要买）`,
    ];
  }
  return [
    `到达后慢走 ${walkSteps} 步，寻找一个“能让你放松”的视角`,
    `停留 2 分钟，观察周围 3 个有趣细节`,
    `离开前给这段碎片时间取个名字`,
  ];
}

function fallbackStory(input: { poi: { name: string; category: string; address: string }; tasks: string[] }) {
  const title = `碎片时间挑战：${input.poi.name}`;
  const story = [
    `你收到一条匿名线索：`,
    `“白天的${input.poi.name}，藏着一枚不会被人看见的‘时间碎片’。”`,
    `走到人来人往的公共区域，别靠近危险边缘，别进入封闭区域。`,
    `当你完成挑战，‘宝藏’会在你的脑海里自动解锁。`,
  ].join('\n');
  return { title, story, tasks: input.tasks };
}

async function glmEggStory(params: { mood: string; poi: { name: string; category: string; address: string }; tasks: string[] }) {
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) return fallbackStory({ poi: params.poi, tasks: params.tasks });

  const prompt = [
    `你是“碎片时间定向挑战”的文案生成器。`,
    `目标：基于给定地点，生成一个轻悬疑/轻玄幻风格的“线索故事”，并给出 2-4 条安全任务。`,
    `硬性安全要求：公共场所、白天触发、不引导翻找/攀爬/进入封闭区域、不涉及真实社交。`,
    `输出必须是严格 JSON（不要 Markdown），格式：{"title":"...","story":"...","tasks":["...","..."]}`,
    `地点：${params.poi.name}（${params.poi.category}） ${params.poi.address}`,
    params.mood ? `用户偏好：${params.mood}` : `用户偏好：（未填写）`,
    `可参考任务（可改写但不要更危险）：${JSON.stringify(params.tasks)}`,
  ].join('\n');

  try {
    const resp = await axios.post(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      {
        model: process.env.ZHIPU_MODEL || 'GLM-4-Flash-250414',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
      },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 10000 }
    );
    const content = String(resp.data?.choices?.[0]?.message?.content || '').trim();
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    const json = start >= 0 && end > start ? content.slice(start, end + 1) : content;
    const parsed = StorySchema.safeParse(JSON.parse(json));
    if (!parsed.success) return fallbackStory({ poi: params.poi, tasks: params.tasks });
    return parsed.data;
  } catch {
    return fallbackStory({ poi: params.poi, tasks: params.tasks });
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const parsed = EggRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });

  const { startTime, endTime, poi, mood, playMin } = parsed.data;
  const eligible = isDaytimeWindow(startTime, endTime);
  if (!eligible) {
    return res.status(200).json({
      ok: true,
      eligible: false,
      message: `彩蛋仅在白天可触发（建议选择 ${String(DAY_START_MIN / 60).padStart(2, '0')}:00-${String(DAY_END_MIN / 60).padStart(2, '0')}:00）`,
    });
  }

  const tasks = safeTasksByCategory({ name: poi.name, category: poi.category || '' }, playMin).slice(0, 3);
  const story = await glmEggStory({ mood, poi: { name: poi.name, category: poi.category || '', address: poi.address || '' }, tasks });

  return res.status(200).json({
    ok: true,
    eligible: true,
    egg: {
      kind: 'challenge',
      title: story.title,
      story: story.story,
      tasks: story.tasks,
      verify: {
        radiusMeter: 140,
        destLocation: poi.location,
      },
      safety: ['公共场所触发', '仅白天可触发', '不需要与陌生人见面', '注意交通与台阶/水边'],
    },
  });
}


