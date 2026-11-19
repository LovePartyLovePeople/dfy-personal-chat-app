# 大肥鱼 · 桌面 / 安卓聊天 App

> 作者：**Lessseriousness**　｜　本项目使用 **DSH（DeepSeek Harness）** 制作

把 AI 角色「大肥鱼」从 QQ 搬进一个独立的聊天 App。界面照 QQ/微信做，**本地优先**：
消息、记忆、表情包都只存在你自己的设备上，直连你自己填的模型接口，不经过任何中转服务器。

- Windows 便携版 exe，双击即用
- Android apk（minSdk 22 / target 34）
- 自带 API Key（OpenAI 兼容协议），支持 DeepSeek / 硅基流动 / 阿里百炼 / OpenAI 或自定义地址
- 多角色，每个角色独立的聊天记录、记忆、头像和背景

## 功能

| 模块 | 说明 |
| --- | --- |
| 聊天 | 左右气泡、时间分隔、右键/长按删单条、正在输入占位、Enter 发送 |
| 图片 | 发图自动压缩到长边 1280，聊天背景可换 |
| 表情包 | 自己导入，支持批量导入 / 删除，点一下即发 |
| 记忆 | 最近 20 条原文 + 每 40 条滚动摘要 + 长期事实（「记住 xxx」），设置里可查看、删除、清空 |
| 多角色 | 角色列表，消息按 characterId 隔离 |
| 备份 | 导出/导入 JSON（人格 + 全部对话 + 事实 + 摘要），走剪贴板 |
| 桌面 | 托盘、关闭行为开关（托盘/退出）、开机自启、系统通知 |
| 安卓 | 前台服务常驻（减少 MIUI 后台杀进程），通知权限申请 |
| 主动消息 | 3 小时没聊时她主动冒一句（可关） |

## 快速开始

1. 打开 App，右上角「＋」建一个角色（或第一次启动自带一个示例角色）。
2. 进聊天页 → 右上角「设置」→ 选服务商预设，填自己的 API Key，点「测试连接」。
3. 回聊天页开聊。

Key 只写在本机 `localStorage`，不会出现在导出的备份里，也不会发给除你填的接口地址以外的任何地方。


## 开发

需要 Node 18+ 与 pnpm；安卓需要 JDK 17 + Android SDK。

```bash
pnpm install

# 生成空白 seed（开源版必须，否则没有 src/seed.ts）
pnpm seed:public

pnpm dev            # 浏览器里调试
pnpm build:public   # 构建 web（空白配置，可发布）
pnpm dist:win       # 打 Windows 便携版 exe

pnpm cap:sync       # 把 dist 同步进 android/
cd android && gradlew.bat assembleDebug
```

`src/seed.ts` 是构建时生成的空白配置（不含任何 Key）：

- `pnpm seed:public` → 空配置，用户首次启动自己填
- 想预置服务商或角色，可以改 `scripts/gen-seed.mjs` 里生成的模板内容

桌面端调试时如果 Electron 以 Node 模式启动（`app` 未定义），检查环境变量
`ELECTRON_RUN_AS_NODE` 是否被系统设成了 `1`，运行前清空即可。

## 结构

```
src/                 React 界面与核心逻辑（Dexie/IndexedDB）
  core/db.ts         characters / messages / facts / summaries / stickers
  core/memory.ts     上下文拼装、摘要滚动、事实、导出
  core/llm.ts        OpenAI 兼容 chat()
  core/image.ts      压缩、单选/多选图片
electron/main.cjs    窗口、托盘、静态服务器、剪贴板、开机自启 IPC
electron/tests.cjs   26 项 headless 自动化测试
android/             Capacitor 工程（含 KeepAliveService 前台服务）
```

## 测试

```powershell
$env:DAFEIYU_TEST='1'; $env:ELECTRON_RUN_AS_NODE=''
node_modules\electron\dist\electron.exe .
# 结果写到 test-report.json
```

## 隐私

- 聊天记录、记忆、表情包：本机 IndexedDB，不上传。
- API Key：本机 localStorage。
- 唯一的外发请求：发给你自己配置的模型接口。
- 不含任何第三方素材；头像、背景、表情包全由用户自己导入。

## 许可

MIT，见 [LICENSE](LICENSE)。角色人格文本仅作示例，请自行确认使用场景与内容合规。

## 制作说明

本项目在 **DSH（DeepSeek Harness）** 里完成开发：需求拆分、代码实现、打包、真机联调、文档整理都是在这个环境里一步一步做出来的。

> 说明：不含预置 API Key、不含预置角色、不含任何个人地址——第一次用请填自己的 Key。
