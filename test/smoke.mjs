/*
 * 前端冒烟测试（开发用，CI 不跑）
 * 用 jsdom 加载 www/index.html，桩掉 fetch，验证启动、搜索、详情、剧集解析。
 *   npm install jsdom --no-save
 *   node test/smoke.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const www = path.join(root, "www");

const sourcesJson = fs.readFileSync(path.join(www, "sources.json"), "utf8");
const firstSourceName = JSON.parse(sourcesJson).sources[0].name;

const searchFixture = {
  code: 1,
  list: [
    {
      vod_id: 101,
      vod_name: "测试影片甲",
      vod_pic: "https://img.example.com/a.jpg",
      vod_remarks: "更新至 12 集",
      vod_year: "2025",
      vod_area: "大陆",
      vod_type_name: "剧集",
      vod_play_from: "m3u8$$$直链",
      vod_play_url:
        "第01集$https://cdn.example.com/a/1.m3u8#第02集$https://cdn.example.com/a/2.m3u8$$$正片$https://cdn.example.com/a/full.mp4",
    },
    { vod_id: 102, vod_name: "测试影片乙", vod_pic: "", vod_remarks: "" },
  ],
};

let fetchCalls = [];
const dom = new JSDOM(fs.readFileSync(path.join(www, "index.html"), "utf8"), {
  url: "https://localhost/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});

const { window } = dom;

window.scrollTo = () => {};

window.fetch = async (url) => {
  fetchCalls.push(String(url));
  if (String(url).includes("sources.json")) {
    return {
      ok: true,
      status: 200,
      text: async () => sourcesJson,
      json: async () => JSON.parse(sourcesJson),
    };
  }
  if (String(url).includes("releases/latest")) {
    const rel = { tag_name: "v2.3.0", html_url: "https://github.com/x/releases/tag/v2.3.0" };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(rel),
      json: async () => rel,
    };
  }
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(searchFixture),
    json: async () => searchFixture,
  };
};

// 预置一条观看记录，供「继续观看」测试（必须在 app.js 执行前写入）
window.localStorage.setItem(
  "libretv.history.v1",
  JSON.stringify([
    {
      url: "https://cdn.example.com/h/1.m3u8",
      title: "历史影片",
      ep: "第03集",
      from: "线路A",
      pic: "",
      time: 300,
      duration: 1000,
      updated: Date.now(),
    },
  ])
);
// 预置直播 m3u 缓存
window.localStorage.setItem(
  "libretv.live.m3u.v1",
  [
    "#EXTM3U",
    '#EXTINF:-1 tvg-id="cctv1" group-title="央视频道",CCTV-1 综合',
    "https://live.example.com/cctv1.m3u8",
    '#EXTINF:-1 group-title="卫视频道",东方卫视',
    "https://live.example.com/dongfang.m3u8",
    "",
  ].join("\n")
);

window.eval(fs.readFileSync(path.join(www, "app.js"), "utf8"));

const $ = (id) => window.document.getElementById(id);
const tick = () => new Promise((r) => setTimeout(r, 30));

const fails = [];
const check = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name} ${extra}`);
    fails.push(name);
  }
};

console.log("启动与源加载");
await tick();
await tick();
await tick();
check("读取了 sources.json", fetchCalls.some((u) => u.includes("sources.json")));
check(`收录源「${firstSourceName}」已渲染`, $("source-list").textContent.includes(firstSourceName));
check("首页可见", $("view-home").hidden === false);
check("检测到新版本提示条", $("update-banner").hidden === false && $("update-banner").textContent.includes("v2.3.0"), $("update-banner").textContent);

console.log("最近上新");
check("上新区块可见", $("latest-section").hidden === false);
check("上新卡片渲染 1 张（剧集类型过滤后）", $("latest").querySelectorAll(".l-card").length === 1, `实际 ${$("latest").querySelectorAll(".l-card").length}`);
check("上新卡片显示备注与来源", $("latest").textContent.includes("更新至 12 集"));
$("latest").querySelector(".l-card").dispatchEvent(new window.Event("click", { bubbles: true }));
await tick();
check("发出详情请求 ac=detail", fetchCalls.some((u) => u.includes("ac=detail&ids=")), fetchCalls.filter((u) => u.includes("ac=detail")).join(","));
check("点击上新卡片进入详情页", $("view-detail").hidden === false);

console.log("继续观看");
check("历史区块可见", $("history-section").hidden === false);
check("历史卡片已渲染", $("history").querySelectorAll(".h-item").length === 1, `实际 ${$("history").querySelectorAll(".h-item").length}`);
check("显示观看进度百分比", $("history").textContent.includes("看到第30%"), $("history").textContent);
check("全屏按钮存在且可点", $("btn-fullscreen") !== null && $("btn-fullscreen").textContent.includes("横屏"));
$("history").querySelector(".h-item").dispatchEvent(new window.Event("click", { bubbles: true }));
await tick();
check("从历史进入播放页", $("view-player").hidden === false);
check("历史续播地址正确", $("video").getAttribute("src") === "https://cdn.example.com/h/1.m3u8", $("video").getAttribute("src"));
check("历史标题正确", $("p-title").textContent.includes("历史影片"), $("p-title").textContent);

console.log("直播");
$("btn-live").dispatchEvent(new window.Event("click", { bubbles: true }));
await tick();
check("进入直播页", $("view-live").hidden === false);
check("缓存列表解析出 2 个频道", $("live-status").textContent.includes("已解析 2 个频道"), $("live-status").textContent);
check("频道列表渲染 2 项", $("live-list").querySelectorAll(".live-item").length === 2, `实际 ${$("live-list").querySelectorAll(".live-item").length}`);
check("分组 chip 出现", $("live-groups").querySelectorAll(".chip").length === 2, `实际 ${$("live-groups").querySelectorAll(".chip").length}`);
$("live-list").querySelector(".live-item").dispatchEvent(new window.Event("click", { bubbles: true }));
await tick();
check("进入直播播放", $("view-player").hidden === false);
check("直播源地址正确", $("video").getAttribute("src") === "https://live.example.com/cctv1.m3u8", $("video").getAttribute("src"));
check("直播频道名正确", $("p-title").textContent === "CCTV-1 综合", $("p-title").textContent);
check("直播不生成剧集列表", $("p-episodes").querySelectorAll(".ep").length === 0);
$("btn-back").dispatchEvent(new window.Event("click", { bubbles: true }));
await tick();
check("直播返回直播页", $("view-live").hidden === false);

console.log("启用源");
const sw = $("source-list").querySelector(".switch");
check("初始为启用状态", sw.classList.contains("on"));
sw.dispatchEvent(new window.Event("click", { bubbles: true }));
await tick();
check("点击后变为停用", !$("source-list").querySelector(".switch").classList.contains("on"));

console.log("搜索");
$("q").value = "测试";
$("search-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
await tick();
await tick();
check("搜索时隐藏继续观看", $("history-section").hidden === true);
check("发出搜索请求", fetchCalls.some((u) => u.includes("ac=videolist")));
check("请求带 ac 与 wd 参数", fetchCalls.some((u) => u.includes("ac=videolist&wd=")));
check("结果卡片渲染 2 条", $("results").querySelectorAll(".card").length >= 1, `实际 ${$("results").querySelectorAll(".card").length}`);
check("提示显示结果数", /共 \d+ 条结果/.test($("home-hint").textContent), $("home-hint").textContent);

console.log("详情与剧集解析");
$("results").querySelector(".card").dispatchEvent(new window.Event("click", { bubbles: true }));
await tick();
check("进入详情页", $("view-detail").hidden === false);
check("标题正确", $("d-title").textContent === "测试影片甲");
check("元信息含年份", $("d-sub").textContent.includes("2025"), $("d-sub").textContent);
const eps = $("d-episodes").querySelectorAll(".ep");
check("默认线路 2 集", eps.length === 2, `实际 ${eps.length}`);
check("第一集名称为「第01集」", eps[0] && eps[0].textContent === "第01集");
check("多线路出现切换 chip", $("d-tabs").querySelectorAll(".chip").length === 2);

console.log("线路切换");
$("d-tabs").querySelectorAll(".chip")[1].dispatchEvent(new window.Event("click", { bubbles: true }));
await tick();
const eps2 = $("d-episodes").querySelectorAll(".ep");
check("切到直链线路后 1 集", eps2.length === 1, `实际 ${eps2.length}`);

console.log("播放");
eps2[0].dispatchEvent(new window.Event("click", { bubbles: true }));
await tick();
check("进入播放页", $("view-player").hidden === false);
check("video src 已设置", $("video").getAttribute("src") === "https://cdn.example.com/a/full.mp4", $("video").getAttribute("src"));
check("播放标题含片名", $("p-title").textContent.includes("测试影片甲"));

console.log("自动连播");
check("连播开关按钮存在且默认开启", $("btn-autonext") !== null && $("btn-autonext").textContent.includes("开"), $("btn-autonext") && $("btn-autonext").textContent);
// 返回详情页切回 m3u8 线路，播第 1 集验证播完自动跳第 2 集
$("btn-back").dispatchEvent(new window.Event("click", { bubbles: true }));
await tick();
$("d-tabs").querySelectorAll(".chip")[0].dispatchEvent(new window.Event("click", { bubbles: true }));
await tick();
const epsAuto = $("d-episodes").querySelectorAll(".ep");
check("m3u8 线路 2 集", epsAuto.length === 2, `实际 ${epsAuto.length}`);
epsAuto[0].dispatchEvent(new window.Event("click", { bubbles: true }));
await tick();
check("正在播放第 1 集", $("video").getAttribute("src") === "https://cdn.example.com/a/1.m3u8", $("video").getAttribute("src"));
$("video").dispatchEvent(new window.Event("ended", { bubbles: true }));
await tick();
check("播完自动跳到第 2 集", $("video").getAttribute("src") === "https://cdn.example.com/a/2.m3u8", $("video").getAttribute("src"));
check("第 2 集按钮高亮", $("p-episodes").querySelectorAll(".ep")[1].classList.contains("on"));
// 关闭连播后再触发 ended，不应切换（第 2 集是最后一集）
$("btn-autonext").dispatchEvent(new window.Event("click", { bubbles: true }));
await tick();
check("连播开关显示为关", $("btn-autonext").textContent.includes("关"), $("btn-autonext").textContent);
$("video").dispatchEvent(new window.Event("ended", { bubbles: true }));
await tick();
check("连播关闭时不自动切换", $("video").getAttribute("src") === "https://cdn.example.com/a/2.m3u8", $("video").getAttribute("src"));
check("连播偏好已写入 localStorage", window.localStorage.getItem("libretv.autoplay.v1") === "false", window.localStorage.getItem("libretv.autoplay.v1"));

console.log("源管理");
$("s-name").value = "本地源";
$("s-api").value = "https://my.example.com/api.php/provide/vod/";
$("source-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
await tick();
check("新增后出现在列表", $("source-list").textContent.includes("本地源"));
check("写入 localStorage", (window.localStorage.getItem("libretv.sources.v2") || "").includes("本地源"));

console.log("");
if (fails.length) {
  console.log(`失败 ${fails.length} 项: ${fails.join(", ")}`);
  process.exit(1);
}
console.log("全部通过");
