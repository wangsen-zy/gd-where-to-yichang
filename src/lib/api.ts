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

export async function recommend(params: {
  origin: { lng: number; lat: number };
  mode: TravelMode;
  startTime: string;
  endTime: string;
  mood?: string;
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


