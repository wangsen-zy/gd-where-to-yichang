## 今天去哪儿 · 宜昌（参赛 MVP）

输入空闲时间段 + 交通方式（步行/骑行/驾车），随机一个**可在时间内往返闭环**的目的地，并给出轻攻略。

### 项目结构

- `src/`：H5 WebApp（Vite + React）
- `api/`：Vercel Serverless Functions（线上推荐用：调用高德 WebService、可选调用智谱 GLM）
- `server/`：Node/Express（仅本地开发备用）

### 你需要准备的 Key

- **高德 JS API Key**：前端加载地图用
- **高德 WebService Key**：后端调用 POI 搜索、路径规划用（线上部署放在 Vercel 环境变量里）
- **智谱 GLM Key（可选）**：生成轻攻略文案；不填也能跑（会走规则兜底文案）

具体怎么配见：`ENV_SETUP.md`

### 本地启动

1) 安装依赖

```bash
cd /mnt/data/code/GaodeTesttemp/gaode-where-to
npm install
```

2) 配环境变量（见 `ENV_SETUP.md`）

3) 启动（前后端一起）

```bash
npm run dev
```

前端：`http://localhost:5173`  
后端：`http://localhost:8787/health`

### 部署到 Vercel（推荐，评委可直接访问 URL）

1) 把本仓库 push 到 GitHub

2) 在 Vercel 导入该仓库（Import Project）

3) 在 Vercel 项目 Settings → Environment Variables 配置（见 `ENV_SETUP.md`）

4) 部署完成后：
- 前端：`https://你的域名/`
- 后端健康检查：`https://你的域名/api/health`
- 推荐接口：`https://你的域名/api/recommend`

### 核心接口

- `POST /api/recommend`
  - 入参：起点经纬度、交通方式、时间段、可选偏好
  - 出参：目的地 POI + 去/玩/回预算 + 路线 polyline + 轻攻略

- `POST /api/egg`
  - 入参：时间段 + Top1 POI（前端结果卡触发）
  - 出参：白天可触发的“碎片时间挑战”故事 + 任务列表

- `POST /api/egg-verify`
  - 入参：用户当前位置 + 目的地坐标 + 半径
  - 出参：是否到达（不保存定位，仅计算距离）

### 参赛证据材料

见：`docs/EVIDENCE.md`
