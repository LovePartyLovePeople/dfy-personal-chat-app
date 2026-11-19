import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.dafeiyu.app",
  appName: "大肥鱼",
  webDir: "dist",
  android: {
    // 必须开：页面以 https://localhost 加载，而本地模型/搜索服务是 http://，
    // 不放开的话 WebView 会把请求当「混合内容」直接拦掉，表现就是 Failed to fetch，
    // 且请求根本不会发到电脑（Ollama 日志里一条记录都没有）。
    allowMixedContent: true,
    // http 明文访问局域网点名站点（Android 9+ 默认禁止）
    webContentsDebuggingEnabled: false,
  },
  server: {
    androidScheme: "https",
    cleartext: true,
  },
};

export default config;
