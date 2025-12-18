import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { recommend, type RecommendResponse, type TravelMode } from './lib/api';
import { loadAMap } from './lib/amapLoader';

const PRESETS = {
  yichangCBD: { name: '宜昌CBD（默认）', lng: 111.286, lat: 30.691 },
  xilin: { name: '西陵区（预设）', lng: 111.2855, lat: 30.694 },
  wujiagang: { name: '伍家岗区（预设）', lng: 111.318, lat: 30.668 },
  dianjun: { name: '点军区（预设）', lng: 111.266, lat: 30.703 },
} as const;

function nowHHmm() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function addMinutesHHmm(hhmm: string, deltaMin: number) {
  const [h, m] = hhmm.split(':').map(Number);
  let total = h * 60 + m + deltaMin;
  total = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const nh = String(Math.floor(total / 60)).padStart(2, '0');
  const nm = String(total % 60).padStart(2, '0');
  return `${nh}:${nm}`;
}

function modeName(m: TravelMode) {
  if (m === 'walk') return '步行';
  if (m === 'bike') return '骑行';
  return '驾车';
}

export default function App() {
  const [mode, setMode] = useState<TravelMode>('walk');
  const [startTime, setStartTime] = useState(() => nowHHmm());
  const [endTime, setEndTime] = useState(() => addMinutesHHmm(nowHHmm(), 180));
  const [mood, setMood] = useState('');
  const [originMode, setOriginMode] = useState<'preset' | 'geo'>('preset');
  const [presetKey, setPresetKey] = useState<keyof typeof PRESETS>('yichangCBD');
  const [cityScope, setCityScope] = useState<'yichang' | 'auto'>('yichang');
  const [origin, setOrigin] = useState<{ lng: number; lat: number } | null>(() => PRESETS.yichangCBD);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [data, setData] = useState<RecommendResponse | null>(null);

  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const polylineRef = useRef<any>(null);

  const canDrawMap = useMemo(() => {
    return Boolean(import.meta.env.VITE_AMAP_JS_KEY);
  }, []);

  async function ensureMap(center?: { lng: number; lat: number }) {
    const AMap = await loadAMap();
    if (!mapRef.current) {
      mapRef.current = new AMap.Map('map', {
        zoom: 13,
        center: center ? [center.lng, center.lat] : undefined,
      });
    } else if (center) {
      mapRef.current.setCenter([center.lng, center.lat]);
    }
    return AMap;
  }

  function clearOverlays() {
    if (polylineRef.current && mapRef.current) mapRef.current.remove(polylineRef.current);
    if (markerRef.current && mapRef.current) mapRef.current.remove(markerRef.current);
    polylineRef.current = null;
    markerRef.current = null;
  }

  async function locate() {
    setErrorMsg(null);
    return new Promise<{ lng: number; lat: number }>((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('当前浏览器不支持定位'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          resolve({ lng: pos.coords.longitude, lat: pos.coords.latitude });
        },
        (err) => reject(new Error(err.message || '定位失败')),
        { enableHighAccuracy: true, timeout: 8000 }
      );
    });
  }

  async function onQuick(deltaMin: number) {
    const s = nowHHmm();
    setStartTime(s);
    setEndTime(addMinutesHHmm(s, deltaMin));
  }

  async function onRecommend() {
    setErrorMsg(null);
    setLoading(true);
    try {
      let o = origin;
      if (originMode === 'geo') {
        o = await locate();
        setOrigin(o);
      } else {
        const p = PRESETS[presetKey];
        o = { lng: p.lng, lat: p.lat };
        setOrigin(o);
      }

      const resp = await recommend({
        origin: o,
        mode,
        startTime,
        endTime,
        mood: mood.trim(),
        city: cityScope === 'yichang' ? '宜昌' : '',
      });
      setData(resp);

      if (resp.ok && !resp.empty) {
        const [lngStr, latStr] = resp.result.location.split(',');
        const dest = { lng: Number(lngStr), lat: Number(latStr) };

        if (canDrawMap) {
          const AMap = await ensureMap(o);
          clearOverlays();

          markerRef.current = new AMap.Marker({ position: [dest.lng, dest.lat] });
          mapRef.current.add(markerRef.current);

          if (resp.result.polyline) {
            const path = resp.result.polyline.split(';').map((p) => {
              const [lng, lat] = p.split(',').map(Number);
              return [lng, lat];
            });
            polylineRef.current = new AMap.Polyline({
              path,
              strokeColor: '#2563eb',
              strokeWeight: 6,
              strokeOpacity: 0.85,
            });
            mapRef.current.add(polylineRef.current);
            mapRef.current.setFitView([markerRef.current, polylineRef.current]);
          } else {
            mapRef.current.setCenter([dest.lng, dest.lat]);
          }
        }
      }
    } catch (e: any) {
      setErrorMsg(e?.message || '发生错误');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Best-effort pre-locate when user chooses "geo".
    if (originMode !== 'geo') return;
    locate().then(setOrigin).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originMode]);

  useEffect(() => {
    // Show base map ASAP (center on origin) to avoid "blank map" confusion.
    if (!origin || !canDrawMap) return;
    ensureMap(origin).catch((e) => {
      setErrorMsg(e?.message || '地图加载失败');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, canDrawMap]);

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <div className="title">今天去哪儿 · 宜昌</div>
          <div className="subtitle">输入空闲时间 + 交通方式，随机一个“去玩就行”的小确幸</div>
        </div>
      </header>

      <main className="grid">
        <section className="panel">
          <div className="panelTitle">输入</div>

          <div className="row">
            <label className="label">范围</label>
            <div className="seg">
              <button
                className={cityScope === 'yichang' ? 'segBtn active' : 'segBtn'}
                onClick={() => setCityScope('yichang')}
                type="button"
              >
                宜昌
              </button>
              <button
                className={cityScope === 'auto' ? 'segBtn active' : 'segBtn'}
                onClick={() => setCityScope('auto')}
                type="button"
              >
                不限城市
              </button>
            </div>
          </div>

          <div className="row">
            <label className="label">交通方式</label>
            <div className="seg">
              {(['walk', 'bike', 'drive'] as const).map((m) => (
                <button
                  key={m}
                  className={m === mode ? 'segBtn active' : 'segBtn'}
                  onClick={() => setMode(m)}
                  type="button"
                >
                  {modeName(m)}
                </button>
              ))}
            </div>
          </div>

          <div className="row">
            <label className="label">时间段</label>
            <div className="timeRow">
              <input className="time" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              <span className="to">→</span>
              <input className="time" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </div>
          </div>

          <div className="row">
            <label className="label">快捷</label>
            <div className="chips">
              <button className="chip" type="button" onClick={() => onQuick(60)}>
                1小时
              </button>
              <button className="chip" type="button" onClick={() => onQuick(120)}>
                2小时
              </button>
              <button className="chip" type="button" onClick={() => onQuick(180)}>
                3小时
              </button>
              <button className="chip" type="button" onClick={() => onQuick(240)}>
                4小时
              </button>
            </div>
          </div>

          <div className="row">
            <label className="label">一句话偏好（可选）</label>
            <input
              className="text"
              placeholder="比如：想找个安静的地方喝咖啡/不想太累/想江边走走…"
              value={mood}
              onChange={(e) => setMood(e.target.value)}
            />
          </div>

          <div className="row">
            <label className="label">起点</label>
            <div className="hint">
              <div className="seg">
                <button
                  className={originMode === 'preset' ? 'segBtn active' : 'segBtn'}
                  onClick={() => {
                    setOriginMode('preset');
                    const p = PRESETS[presetKey];
                    setOrigin({ lng: p.lng, lat: p.lat });
                  }}
                  type="button"
                >
                  宜昌预设
                </button>
                <button
                  className={originMode === 'geo' ? 'segBtn active' : 'segBtn'}
                  onClick={() => setOriginMode('geo')}
                  type="button"
                >
                  我的定位
                </button>
              </div>
            </div>
            {originMode === 'preset' ? (
              <div className="hint">
                <select
                  className="text"
                  value={presetKey}
                  onChange={(e) => {
                    const k = e.target.value as keyof typeof PRESETS;
                    setPresetKey(k);
                    const p = PRESETS[k];
                    setOrigin({ lng: p.lng, lat: p.lat });
                  }}
                >
                  {Object.entries(PRESETS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.name}
                    </option>
                  ))}
                </select>
                <span className="muted small">
                  当前起点：{origin?.lng.toFixed(5)}, {origin?.lat.toFixed(5)}
                </span>
              </div>
            ) : (
              <div className="hint">
                {origin ? (
                  <span className="muted">
                    已定位：{origin.lng.toFixed(5)}, {origin.lat.toFixed(5)}
                  </span>
                ) : (
                  <span className="muted">未定位（点击按钮获取）</span>
                )}
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => locate().then(setOrigin).catch((e) => setErrorMsg(e.message))}
                >
                  获取定位
                </button>
              </div>
            )}
          </div>

          <div className="actions">
            <button className="btn primary" type="button" onClick={onRecommend} disabled={loading}>
              {loading ? '正在随机…' : '随机一个方案'}
            </button>
          </div>

          {errorMsg ? <div className="error">{errorMsg}</div> : null}
        </section>

        <section className="panel">
          <div className="panelTitle">结果</div>
          {!data ? (
            <div className="empty">点击“随机一个方案”，我就给你一个 3 小时内能闭环的目的地。</div>
          ) : data.ok && data.empty ? (
            <div className="empty">{data.message || '暂时没有找到合适地点'}</div>
          ) : data.ok && !data.empty ? (
            <div className="result">
              <div className="cardTitle">{data.result.name}</div>
              <div className="meta">
                <span className="badge">{data.result.category}</span>
                <span className="muted">{data.result.address}</span>
              </div>
              <div className="timeline">
                <div className="tlItem">
                  <div className="tlK">去</div>
                  <div className="tlV">{data.result.goMin} 分</div>
                </div>
                <div className="tlItem">
                  <div className="tlK">玩</div>
                  <div className="tlV">{data.result.playMin} 分</div>
                </div>
                <div className="tlItem">
                  <div className="tlK">回</div>
                  <div className="tlV">{data.result.backMin} 分</div>
                </div>
              </div>

              <div className="block">
                <div className="blockTitle">为什么是它</div>
                <ul className="list">
                  {data.result.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>

              <div className="block">
                <div className="blockTitle">轻攻略</div>
                <ul className="list">
                  {data.result.guide.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </div>

              <div className="actions">
                <a
                  className="btn"
                  href={`https://uri.amap.com/marker?position=${encodeURIComponent(data.result.location)}&name=${encodeURIComponent(
                    data.result.name
                  )}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  用高德打开/导航
                </a>
                <button className="btn ghost" type="button" onClick={onRecommend} disabled={loading}>
                  再随机一次
                </button>
              </div>
            </div>
          ) : (
            <div className="empty">结果解析失败</div>
          )}
        </section>

        <section className="panel mapPanel">
          <div className="panelTitle">
            地图
            {!canDrawMap ? <span className="muted small">（未配置高德 JS Key，暂不显示地图）</span> : null}
          </div>
          <div id="map" className="map" />
        </section>
      </main>

      <footer className="footer">
        <span className="muted small">
          提示：这是参赛 MVP，先把“时间预算闭环 + 一键导航 + 轻攻略”做扎实，再逐步加天气/等时圈/去重等加分项。
        </span>
      </footer>
    </div>
  );
}
