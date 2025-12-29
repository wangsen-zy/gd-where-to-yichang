import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

/**
 * 高德去哪儿 - 鸿蒙应用主页面
 * 
 * 通过WebView加载H5应用，实现鸿蒙原生套壳
 * 支持加载线上部署的H5页面或本地rawfile资源
 */
@Entry
@Component
struct Index {
  // WebView控制器
  private webviewController: webview.WebviewController = new webview.WebviewController();
  
  // H5应用的URL地址 - 请根据实际部署地址修改
  // 线上地址示例: 'https://your-domain.com'
  // 本地开发地址: 'http://localhost:5173'
  // 若使用本地rawfile: $rawfile('index.html')
  @State private webUrl: string = 'https://gaode-where-to.pages.dev';
  
  // 页面加载状态
  @State private isLoading: boolean = true;
  @State private loadProgress: number = 0;
  @State private hasError: boolean = false;
  @State private errorMessage: string = '';

  aboutToAppear(): void {
    // 配置Web组件的调试模式（开发时可开启）
    webview.WebviewController.setWebDebuggingAccess(true);
    hilog.info(0x0000, 'GaodeWhereTo', 'WebView页面初始化');
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      // WebView组件 - 核心H5容器
      Web({ src: this.webUrl, controller: this.webviewController })
        .width('100%')
        .height('100%')
        .javaScriptAccess(true)  // 启用JavaScript
        .domStorageAccess(true)  // 启用DOM存储
        .fileAccess(true)        // 启用文件访问
        .imageAccess(true)       // 启用图片加载
        .mixedMode(MixedMode.All) // 允许混合内容
        .cacheMode(CacheMode.Default) // 缓存模式
        .verticalScrollBarAccess(false) // 隐藏滚动条
        .horizontalScrollBarAccess(false)
        .geolocationAccess(true) // 启用地理位置（高德地图需要）
        .onPageBegin(() => {
          hilog.info(0x0000, 'GaodeWhereTo', '页面开始加载: %{public}s', this.webUrl);
          this.isLoading = true;
          this.hasError = false;
        })
        .onPageEnd(() => {
          hilog.info(0x0000, 'GaodeWhereTo', '页面加载完成');
          this.isLoading = false;
        })
        .onProgressChange((event) => {
          if (event) {
            this.loadProgress = event.newProgress;
            hilog.debug(0x0000, 'GaodeWhereTo', '加载进度: %{public}d%%', this.loadProgress);
          }
        })
        .onErrorReceive((event) => {
          if (event) {
            this.hasError = true;
            this.isLoading = false;
            this.errorMessage = `错误码: ${event.error.getErrorCode()}, ${event.error.getErrorInfo()}`;
            hilog.error(0x0000, 'GaodeWhereTo', '页面加载错误: %{public}s', this.errorMessage);
          }
        })
        .onHttpErrorReceive((event) => {
          if (event) {
            hilog.warn(0x0000, 'GaodeWhereTo', 'HTTP错误: %{public}d', event.response.getResponseCode());
          }
        })
        .onConsole((event) => {
          // 转发H5的console日志到鸿蒙日志系统
          if (event) {
            hilog.info(0x0000, 'GaodeWhereTo-H5', '[%{public}s] %{public}s', 
              event.message.getMessageLevel().toString(),
              event.message.getMessage());
          }
          return false;
        })

      // 加载进度条
      if (this.isLoading && this.loadProgress < 100) {
        Column() {
          // 高德蓝色主题的加载指示器
          LoadingProgress()
            .width(60)
            .height(60)
            .color('#3385FF')
          
          Text('正在加载...')
            .fontSize(14)
            .fontColor('#666666')
            .margin({ top: 12 })
          
          // 进度条
          Progress({ value: this.loadProgress, total: 100, type: ProgressType.Linear })
            .width('60%')
            .height(4)
            .margin({ top: 16 })
            .color('#3385FF')
            .backgroundColor('#E0E0E0')
        }
        .width('100%')
        .height('100%')
        .backgroundColor('#FFFFFF')
        .justifyContent(FlexAlign.Center)
      }

      // 错误提示界面
      if (this.hasError) {
        Column() {
          Image($r('sys.media.ohos_ic_public_fail'))
            .width(80)
            .height(80)
            .fillColor('#FF6B6B')
          
          Text('页面加载失败')
            .fontSize(18)
            .fontColor('#333333')
            .fontWeight(FontWeight.Medium)
            .margin({ top: 16 })
          
          Text(this.errorMessage)
            .fontSize(12)
            .fontColor('#999999')
            .margin({ top: 8 })
            .textAlign(TextAlign.Center)
            .maxLines(3)
            .padding({ left: 32, right: 32 })
          
          Button('重新加载')
            .width(160)
            .height(44)
            .fontSize(16)
            .fontColor('#FFFFFF')
            .backgroundColor('#3385FF')
            .borderRadius(22)
            .margin({ top: 32 })
            .onClick(() => {
              this.hasError = false;
              this.isLoading = true;
              this.webviewController.refresh();
            })
        }
        .width('100%')
        .height('100%')
        .backgroundColor('#FFFFFF')
        .justifyContent(FlexAlign.Center)
      }
    }
    .width('100%')
    .height('100%')
  }
}

