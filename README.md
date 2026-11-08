# LibreTV iOS — 内置播放源的独立播放器

这是一个**不依赖任何服务器**的 iOS App：界面、播放源列表、播放器全部打包进安装包，装到手机上就能直接搜索和播放。

---

## 一、架构：为什么这次不用远程地址了

上一版的思路是「外壳加载你部署好的实例」，因为 LibreTV 的播放依赖服务端代理转发 HLS 请求。这次改成把三层全部放进 App 里：

| 层 | 实现 | 解决什么问题 |
|---|---|---|
| 界面与逻辑 | `www/` 下的静态 HTML/CSS/JS，随包分发 | 不需要打开网页，断网也能进主界面 |
| 网络请求 | Capacitor 内置 `CapacitorHttp`，接管 `fetch` 走原生 URLSession | 第三方接口没有 CORS 头，浏览器里必被拦，原生请求不受此限制 |
| 播放 | WKWebView 的原生 `<video>` + HLS | 不用引入 hls.js，iOS 自己就能解 m3u8 |

关键点是第二层。Capacitor 官方文档写明：`CapacitorHttp` 会把 `window.fetch` 和 `XMLHttpRequest` 打补丁改为调用原生网络库，开关在 `capacitor.config.json` 里：

```json
{ "plugins": { "CapacitorHttp": { "enabled": true } } }
```

这一层是整个方案能成立的前提——没有它，App 里搜任何第三方源都会因为跨域失败。

---

## 二、播放源怎么"装在 App 里"

源列表是一个普通数组，存在三个地方，按优先级生效：

1. **`www/sources.json`** — 打包进 App 的初始列表，首次启动时读入。
2. **localStorage** — 用户在 App 里增删改后存在本地，优先级高于第 1 项。
3. **应用内「源」页面** — 手动添加、开关、删除、JSON 批量导入导出。

`www/sources.json` 的格式：

```json
{
  "sources": [
    { "id": "a", "name": "我的源 A", "api": "https://你的接口域名/api.php/provide/vod/", "enabled": true }
  ]
}
```

`api` 填的是苹果CMS（maccms）风格的 JSON 接口根地址。App 会自动拼接 `?ac=videolist&wd=关键词&pg=1` 并发起请求，再解析返回的 `list[].vod_play_url`。

**仓库里带的示例源是占位地址且默认停用**，你需要换成自己的接口，或者在 App 里手动添加。我不在仓库里预置任何具体站点：一是这类地址失效极快，二是用什么源属于使用者的选择。

改完 `sources.json` 重新构建一次就打进包里；只想在已装的 App 里加源，用「源」页面即可，不必重新编译。

---

## 三、构建与安装

**本机已有的东西**：`ios/` 原生工程、共享 scheme、ATS 配置都已生成并提交在仓库里，推上去就能编译。

```bash
cd libretv-ios
git init && git add . && git commit -m "LibreTV iOS player"
git branch -M main
git remote add origin https://github.com/<你的账号>/<仓库名>.git
git push -u origin main
```

然后到 GitHub 的 Actions 页面手动跑一次 `Build unsigned iOS IPA`，完成后在 Artifacts 里下载 `LibreTV-unsigned-ipa`。

装机：Windows 上用 [Sideloadly](https://sideloadly.io/)，把 `.ipa` 拖进去，输入 Apple ID，插上 iPhone 安装；装完去「设置 → 通用 → VPN与设备管理」信任证书。免费 Apple ID 签出的证书 **7 天失效**，到期需重签。

逐步骤的装机说明（含 iTunes 依赖、开发者模式、常见报错）见 [`docs/安装到手机.md`](docs/安装到手机.md)。

有 Mac 的话更省事：`npx cap open ios` 打开工程，选你的开发者账号直接跑真机。

---

## 四、已经做过的验证

以下是在本机真实执行过的，不是推测：

- `node --check www/app.js` 通过，`sources.json` 是合法 JSON。
- `npx cap add ios` 在本机成功生成完整 `ios/` 工程（Capacitor 8.6.0，Swift Package Manager 依赖）。
- `Info.plist` 已加入 `NSAppTransportSecurity` 三项开关，dict 标签开闭配对校验平衡。
- `test/smoke.mjs` 用 jsdom 跑了 20 项断言全部通过：源加载、启停开关、搜索请求参数、结果渲染、详情页字段、多线路切换、剧集解析、播放页 src 赋值、新增源与 localStorage 落盘。

```bash
node test/smoke.mjs     # 需先 npm install jsdom --no-save
```

**没有验证的**：真机上的实际编译与播放。这台机器是 Windows，无法调用 Xcode，所以「能不能编译成功」「m3u8 能不能播」这两件事必须由第一次 CI 运行和你的手机来回答。

---

## 五、已知限制

1. **播放失败最常见的原因是防盗链。** 很多源的 m3u8 要求特定 `Referer` 或 `User-Agent`，而 `<video src>` 无法附加自定义请求头。出现「有画面无声音」「点了没反应」「黑屏」，优先怀疑这条，换线路或换源。
2. **接口失效是常态。** 这类第三方接口生命周期很短，搜索无结果时先到「源」页面单独开关某个源，能快速定位是哪个源挂了。
3. **http 源能用但要注意。** 我在 `Info.plist` 里放开了 ATS，所以 `http://` 的接口和媒体也能加载；代价是安全性下降，且上架审核必被质疑。
4. **上架 App Store 不可行。** 审核指南 4.2 要求应用提供"超越重新打包网站"的功能，并点名排除内容聚合器与网页剪藏。这个 App 本质是播放器外壳，正落在这一条上。
5. **内容合规由使用者承担。** LibreTV 项目自身声明它只是搜索工具，不存储、不上传、不分发视频内容。你接入哪些接口、在什么地区使用，责任在使用者。

---

## 六、目录

```
libretv-ios/
├─ www/                       # 全部界面与逻辑（随包分发）
│  ├─ index.html
│  ├─ app.js                  # 搜索 / 解析 / 播放 / 源管理
│  ├─ style.css
│  └─ sources.json            # 内置源列表，构建时打进包里
├─ ios/App/                   # 已生成的原生工程（含共享 scheme 与 ATS 配置）
├─ scripts/disable_signing.py # CI 里关掉签名，产出未签名包
├─ test/smoke.mjs             # jsdom 冒烟测试
├─ capacitor.config.json      # 开启 CapacitorHttp
└─ .github/workflows/ios-unsigned.yml
```

改应用名：`capacitor.config.json` 的 `appName` 与 `ios/App/App/Info.plist` 的 `CFBundleDisplayName`。
改 Bundle ID：`capacitor.config.json` 的 `appId`（侧载工具会沿用它，建议改成你自己的反向域名）。

---

## 参考来源

Ionic Team. "Capacitor iOS Documentation." *Capacitor Docs*, v8, capacitorjs.com/docs/ios. 访问日期 2026-11-08.

Ionic Team. "CapacitorHttp Plugin API." *Capacitor Docs*, capacitorjs.com/docs/apis/http. 访问日期 2026-11-08.

GitHub. "macos-26 is now generally available for GitHub-hosted runners." *GitHub Changelog*, 2026-02-26.

Apple Inc. "Guideline 4.2 — Minimum Functionality." *App Store Review Guidelines*, developer.apple.com/app-store/review/guidelines/.

LibreSpark. "LibreTV Wiki." *GitHub*, github.com/LibreSpark/LibreTV/wiki. 访问日期 2026-11-08.
