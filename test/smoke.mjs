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
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(searchFixture),
    json: async () => searchFixture,
  };
};

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
check("读取了 sources.json", fetchCalls.some((u) => u.includes("sources.json")));
check("示例源已渲染", $("source-list").textContent.includes("示例源"));
check("首页可见", $("view-home").hidden === false);

console.log("启用源");
const sw = $("source-list").querySelector(".switch");
check("初始为停用状态", !sw.classList.contains("on"));
sw.dispatchEvent(new window.Event("click", { bubbles: true }));
await tick();
check("点击后变为启用", $("source-list").querySelector(".switch").classList.contains("on"));

console.log("搜索");
$("q").value = "测试";
$("search-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
await tick();
await tick();
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

console.log("源管理");
$("s-name").value = "本地源";
$("s-api").value = "https://my.example.com/api.php/provide/vod/";
$("source-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
await tick();
check("新增后出现在列表", $("source-list").textContent.includes("本地源"));
check("写入 localStorage", (window.localStorage.getItem("libretv.sources.v1") || "").includes("本地源"));

console.log("");
if (fails.length) {
  console.log(`失败 ${fails.length} 项: ${fails.join(", ")}`);
  process.exit(1);
}
console.log("全部通过");
