export type TravelMode = 'walk' | 'bike' | 'drive';

export type RecommendResponse =
  | {
      ok: true;
      empty: true;
      message?: string;
    }
  | {
      ok: true;
      empty?: false;
      city: string;
      input: {
        origin: { lng: number; lat: number };
        mode: TravelMode;
        startTime: string;
        endTime: string;
        availableMin: number;
      };
      intent?: {
        primaryIntent: string;
        confidence: number;
        keywords: string[];
        explain?: string;
        source: 'rule' | 'glm' | 'manual';
      };
      relaxNotes?: string[];
      reportMarkdown?: string;
      candidates?: Array<{
        name: string;
        category: string;
        address: string;
        location: string;
        oneWayMinEst?: number;
        playMinEst?: number;
      }>;
      result: {
        name: string;
        category: string;
        address: string;
        location: string; // "lng,lat"
        goMin: number;
        backMin: number;
        playMin: number;
        polyline: string; // "lng,lat;lng,lat;..."
        reasons: string[];
        guide: string[];
      };
    };

export type EggResponse =
  | { ok: true; eligible: false; message: string }
  | {
      ok: true;
      eligible: true;
      egg: {
        kind: 'challenge';
        title: string;
        story: string;
        tasks: string[];
        safety: string[];
        verify: { radiusMeter: number; destLocation: string };
      };
    };

export type EggVerifyResponse = { ok: true; reached: boolean; distanceMeter: number; radiusMeter: number };

export async function recommend(params: {
  origin: { lng: number; lat: number };
  mode: TravelMode;
  startTime: string;
  endTime: string;
  mood?: string;
  city?: string; // default: 宜昌
  minStayMin?: number; // 最短停留分钟（可选，后端会兜底）
  allowRelax?: boolean; // 默认 true：必要时自动放宽并解释
}): Promise<RecommendResponse> {
  const resp = await fetch('/api/recommend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`API error ${resp.status}: ${text || resp.statusText}`);
  }
  return resp.json();
}

export async function getEgg(params: {
  mode: TravelMode;
  startTime: string;
  endTime: string;
  mood?: string;
  city?: string;
  poi: { name: string; category: string; address: string; location: string };
  playMin?: number;
}): Promise<EggResponse> {
  const resp = await fetch('/api/egg', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`API error ${resp.status}: ${text || resp.statusText}`);
  }
  return resp.json();
}

export async function verifyEgg(params: {
  user: { lng: number; lat: number };
  destLocation: string;
  radiusMeter: number;
}): Promise<EggVerifyResponse> {
  const resp = await fetch('/api/egg-verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`API error ${resp.status}: ${text || resp.statusText}`);
  }
  return resp.json();
}


