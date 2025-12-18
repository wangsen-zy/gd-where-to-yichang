## 环境变量怎么配（本地开发）

本项目分为：
- 前端：Vite（浏览器端，需要高德 **JS API Key**）
- 后端：两种方式
  - **本地开发**：Node/Express（`server/`，服务端需要高德 **WebService Key**，以及可选的智谱 GLM Key）
  - **线上部署（推荐）**：Vercel Serverless Functions（`/api/*`，同样需要这些 Key）

### 1) 前端（Vite）

在 `gaode-where-to/` 目录下创建一个本地文件 `.env.local`（不要提交到仓库），内容示例：

```
VITE_AMAP_JS_KEY=你的高德JSAPI_KEY
VITE_AMAP_SECURITY_JS_CODE=可选_你的_securityJsCode
```

> 如果你没有开启“JS安全密钥”，可以先不填 `VITE_AMAP_SECURITY_JS_CODE`。

### 2) 后端（server）

在 `gaode-where-to/server/` 目录下创建 `.env`（不要提交到仓库），内容示例：

```
PORT=8787
AMAP_WEB_SERVICE_KEY=你的高德WebService_Key
ZHIPU_API_KEY=可选_你的智谱APIKey
ZHIPU_MODEL=glm-4.5-flash
```

### 3) 线上部署（Vercel 环境变量）

在 Vercel 项目 Settings → Environment Variables 中配置（不要写进仓库）：

- `VITE_AMAP_JS_KEY`
- `VITE_AMAP_SECURITY_JS_CODE`（可选）
- `AMAP_WEB_SERVICE_KEY`
- `ZHIPU_API_KEY`（可选）
- `ZHIPU_MODEL`（可选，默认 `glm-4.5-flash`）


