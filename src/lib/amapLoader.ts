type AMapWindow = Window & {
  _AMapSecurityConfig?: { securityJsCode?: string };
  AMap?: any;
};

let loadingPromise: Promise<any> | null = null;

export function loadAMap(): Promise<any> {
  const w = window as AMapWindow;
  if (w.AMap) return Promise.resolve(w.AMap);

  if (loadingPromise) return loadingPromise;

  const key = import.meta.env.VITE_AMAP_JS_KEY as string | undefined;
  const securityJsCode = import.meta.env.VITE_AMAP_SECURITY_JS_CODE as string | undefined;

  if (!key) {
    return Promise.reject(new Error('Missing VITE_AMAP_JS_KEY'));
  }

  if (securityJsCode) {
    w._AMapSecurityConfig = { securityJsCode };
  }

  loadingPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;
    script.onload = () => {
      if (w.AMap) resolve(w.AMap);
      else reject(new Error('AMap loaded but window.AMap missing'));
    };
    script.onerror = () => reject(new Error('Failed to load AMap JS API'));
    document.head.appendChild(script);
  });

  return loadingPromise;
}


