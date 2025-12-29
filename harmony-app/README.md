# 高德去哪儿 - 鸿蒙应用

## 📱 项目说明

这是「高德去哪儿」的 HarmonyOS NEXT 原生应用，通过 WebView 技术将 H5 应用封装为鸿蒙原生应用。

## 🏗️ 项目结构

```
harmony-app/
├── AppScope/                    # 应用级配置
│   ├── app.json5               # 应用配置文件
│   └── resources/              # 应用级资源
│       └── base/
│           ├── element/        # 字符串资源
│           └── media/          # 应用图标
├── entry/                       # 入口模块（核心代码）
│   ├── src/main/
│   │   ├── ets/                # ArkTS 源代码
│   │   │   ├── entryability/   # Ability 入口
│   │   │   │   └── EntryAbility.ets
│   │   │   └── pages/          # 页面组件
│   │   │       └── Index.ets   # 主页面（WebView容器）
│   │   ├── resources/          # 模块资源
│   │   └── module.json5        # 模块配置
│   ├── build-profile.json5
│   └── oh-package.json5
├── build-profile.json5          # 构建配置
├── hvigorfile.ts               # 构建脚本
├── oh-package.json5            # 依赖配置
└── README.md
```

## 🛠️ 开发环境

- **IDE**: DevEco Studio 5.0.0 或更高版本
- **SDK**: HarmonyOS NEXT SDK (API 12)
- **语言**: ArkTS

## 📦 构建步骤

### 1. 环境准备

1. 下载安装 [DevEco Studio](https://developer.huawei.com/consumer/cn/deveco-studio/)
2. 配置 HarmonyOS SDK
3. 配置签名证书（用于真机调试和发布）

### 2. 导入项目

1. 打开 DevEco Studio
2. 选择 `File` → `Open` → 选择 `harmony-app` 文件夹
3. 等待项目同步完成

### 3. 配置 H5 地址

编辑 `entry/src/main/ets/pages/Index.ets`，修改 `webUrl` 变量：

```typescript
// 线上部署地址
@State private webUrl: string = 'https://your-domain.com';

// 或本地开发地址
@State private webUrl: string = 'http://localhost:5173';
```

### 4. 构建运行

- **模拟器运行**: 点击工具栏 ▶ 按钮
- **真机运行**: 连接设备后点击 ▶ 按钮
- **构建 HAP**: `Build` → `Build Hap(s)/APP(s)` → `Build Hap(s)`

## 📋 功能特性

- ✅ WebView 加载 H5 应用
- ✅ 支持 JavaScript 交互
- ✅ 支持地理位置权限（高德地图定位）
- ✅ 加载进度指示
- ✅ 错误处理与重试
- ✅ 沉浸式全屏体验
- ✅ 日志转发（H5 console → 鸿蒙 hilog）

## 🔐 权限说明

| 权限 | 说明 |
|------|------|
| ohos.permission.INTERNET | 访问网络加载 H5 页面 |
| ohos.permission.GET_NETWORK_INFO | 获取网络状态 |

## 📝 注意事项

1. **HTTPS 要求**: 生产环境建议使用 HTTPS 地址
2. **跨域问题**: WebView 默认允许混合内容，但建议 H5 端配置好 CORS
3. **调试模式**: 开发时已开启 Web 调试，发布时可关闭

## 🔗 相关链接

- [HarmonyOS 开发文档](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides-V5/application-dev-guide-V5)
- [ArkTS 语言指南](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides-V5/arkts-basic-syntax-V5)
- [Web 组件文档](https://developer.huawei.com/consumer/cn/doc/harmonyos-references-V5/ts-basic-components-web-V5)

