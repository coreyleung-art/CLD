#!/usr/bin/env node
/**
 * device-status.mjs — 设备状态机：让每台设备知道自己是什么角色、数据在哪。
 *
 * 角色（状态）：
 *   server      — 持有权威共享数据（~/.dsh），监听 0.0.0.0:PORT（如 Mac mini）
 *   client      — 通过 CLD_REMOTE_URL 连到服务器，本地不持有共享数据
 *   standalone  — 本机独立运行（回环），数据只在本地
 *   offline     — Tailscale 离线/关机
 *
 * 数据总线：每台设备把自身状态写入 iCloud Drive/CLD-status/<hostname>.json
 * （iCloud 自动同步到各设备），任意设备聚合出全貌。
 *
 * Usage:
 *   node scripts/device-status.mjs             # 汇总展示（读共享状态）
 *   node scripts/device-status.mjs --write     # 刷新本机状态后展示
 *   node scripts/device-status.mjs --json      # 机器可读
 *   node scripts/device-status.mjs --diagram   # 追加 mermaid 状态图
 */
"use strict";

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const doWrite = args.includes("--write");
const json = args.includes("--json");
const diagram = args.includes("--diagram");

const HOME = os.homedir();
const CLD_DIR = path.join(HOME, ".cld");
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, ".dsh");
const ICLOUD = path.join(HOME, "Library", "Mobile Documents", "com~apple~CloudDocs");
const SHARE_DIR = path.join(ICLOUD, "CLD-status");
const DEVICE_STATE = path.join(CLD_DIR, "device-state.json"); // 由 CLD 主进程写入
const FOLDERS_REGISTRY = path.join(CLD_DIR, "folders.json");
const TAILSCALE = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

/* ------------------------------------------------------------ helpers */

function run(cmd, argsList) {
  try {
    return execFileSync(cmd, argsList, { encoding: "utf8", timeout: 8000 }).trim();
  } catch {
    return "";
  }
}

function tailscaleCmd() {
  const cands = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "tailscale"];
  for (const c of cands) {
    try {
      const out = execFileSync(c, ["ip", "-4"], { encoding: "utf8", timeout: 4000 });
      if (out.trim()) return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

function myInfo() {
  const ts = tailscaleCmd();
  const ip = ts ? run(ts, ["ip", "-4"]).split("\n")[0].trim() : "";
  const statusText = ts ? run(ts, ["status"]) : "";
  const devices = parseTailscale(statusText);
  // 用 tailnet 里的主机名展示（如 coreymac-mini），比系统 hostname 更统一
  const self = devices.find((d) => d.ip === ip);
  return {
    hostname: self ? self.hostname : os.hostname(),
    platform: process.platform,
    ts: Boolean(ts),
    ip,
    devices,
  };
}

function parseTailscale(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length < 3 || !/^\d+\.\d+\.\d+\.\d+$/.test(parts[0])) continue;
    out.push({
      ip: parts[0],
      hostname: parts[1],
      user: parts[2] || "",
      os: parts[3] || "",
      online: !/offline/.test(line),
      note: parts.slice(4).join(" "),
    });
  }
  return out;
}

function roleOf() {
  // 1) 环境变量最可靠（CLD 服务器/客户端模式的启动变量）
  if (process.env.CLD_REMOTE_URL) return { role: "client", remoteUrl: process.env.CLD_REMOTE_URL, method: "env" };
  if (process.env.CLD_BIND_HOST) {
    return {
      role: "server",
      bindHost: process.env.CLD_BIND_HOST,
      port: process.env.CLD_PORT || "3081",
      method: "env",
    };
  }
  // 2) CLD 主进程写入的状态
  try {
    const s = JSON.parse(readFileSync(DEVICE_STATE, "utf8"));
    if (s.role) return s;
  } catch {
    /* fall through to inference */
  }
  // 3) 进程推断：bin.js 参数
  try {
    const ps = execFileSync("pgrep", ["-fl", "bin.js"], { encoding: "utf8", timeout: 4000 }) || "";
    const lines = ps.split("\n").filter(Boolean);
    if (lines.some((l) => l.includes("--profile web --patch"))) return { role: "server", method: "process" };
    if (lines.some((l) => l.includes("bin.js web"))) return { role: "standalone", method: "process" };
  } catch {
    /* no pgrep */
  }
  return { role: "standalone", method: "inferred" };
}

function dataStats(dir) {
  if (!existsSync(dir)) return { exists: false };
  let size = 0;
  let sessions = 0;
  try {
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) {
          size += statSync(p).size;
          if (e.name === "session.jsonl.zstd") sessions += 1;
        }
      }
    };
    walk(dir);
  } catch {
    /* skip */
  }
  return { exists: true, sizeMB: Math.round(size / 1048576), sessions };
}

function foldersOf() {
  let entries = [];
  try {
    entries = JSON.parse(readFileSync(FOLDERS_REGISTRY, "utf8")) || [];
  } catch {
    /* no registry yet */
  }
  return entries.map((f) => {
    const p = typeof f === "string" ? f : f.path;
    const label = typeof f === "string" ? p : f.label || p;
    const abs = p.startsWith("~") ? path.join(HOME, p.slice(1)) : p;
    let sizeMB = 0;
    let exists = existsSync(abs);
    if (exists) {
      try {
        const st = statSync(abs);
        sizeMB = st.isDirectory() ? Math.round(du(abs) / 1048576) : Math.round(st.size / 1048576);
      } catch {
        sizeMB = -1;
      }
    }
    return { label, path: p, exists, sizeMB };
  });
}

function du(dir) {
  let total = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += du(p);
      else if (e.isFile()) total += statSync(p).size;
    }
  } catch {
    /* skip */
  }
  return total;
}

/* ------------------------------------------------------------ my state */

function myState() {
  const info = myInfo();
  const role = roleOf();
  const data = dataStats(DSH_HOME);
  return {
    hostname: info.hostname,
    platform: info.platform,
    ip: info.ip,
    tsOnline: Boolean(info.ip),
    role: role.role,
    roleNote: role.method === "process" ? "" : "(CLD 未写入角色，按进程推断)",
    remoteUrl: process.env.CLD_REMOTE_URL || role.remoteUrl || "",
    bindHost: process.env.CLD_BIND_HOST || role.bindHost || "",
    port: process.env.CLD_PORT || role.port || "",
    dshHome: DSH_HOME,
    data: data,
    folders: foldersOf(),
    updatedAt: new Date().toISOString(),
  };
}

function writeShared(state) {
  try {
    mkdirSync(SHARE_DIR, { recursive: true });
    // 清理本机旧主机名的状态文件（如系统 hostname 变化导致的重名条目）
    for (const f of readdirSync(SHARE_DIR)) {
      if (!f.endsWith(".json") || f === `${state.hostname}.json`) continue;
      try {
        const other = JSON.parse(readFileSync(path.join(SHARE_DIR, f), "utf8"));
        if (other.ip && state.ip && other.ip === state.ip) {
          const stale = path.join(SHARE_DIR, f);
          try {
            // 仅当它是本机的旧名（无 tailnet 反向确认），删掉
            const ts = tailscaleCmd();
            const known = ts ? run(ts, ["status"]) : "";
            const self = parseTailscale(known).find((d) => d.ip === state.ip);
            if (!self || self.hostname === state.hostname) {
              rmSync(stale, { force: true });
            }
          } catch {
            /* keep it on uncertainty */
          }
        }
      } catch {
        /* skip bad file */
      }
    }
    writeFileSync(path.join(SHARE_DIR, `${state.hostname}.json`), JSON.stringify(state, null, 2));
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------- aggregate */

function aggregate() {
  const mine = myState();
  const info = myInfo();
  const map = new Map();
  // 共享状态里的设备
  try {
    for (const f of readdirSync(SHARE_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(readFileSync(path.join(SHARE_DIR, f), "utf8"));
        map.set(s.hostname, s);
      } catch {
        /* skip bad */
      }
    }
  } catch {
    /* no share dir */
  }
  // Tailscale 里的设备（补充在线信息）
  for (const d of info.devices) {
    const cur = map.get(d.hostname) || {};
    map.set(d.hostname, { ...cur, hostname: d.hostname, ip: cur.ip || d.ip, tsOnline: d.online, tsOs: d.os });
  }
  // 本机覆盖
  map.set(mine.hostname, mine);
  const devices = [...map.values()].sort((a, b) => (a.hostname < b.hostname ? -1 : 1));
  return { mine, devices, tsAvailable: info.ts };
}

/* -------------------------------------------------------------- render */

function renderText(agg) {
  const L = [];
  const mine = agg.mine;
  L.push(`设备状态机  ·  最后刷新 ${new Date().toLocaleTimeString("zh-CN")}${agg.tsAvailable ? "" : "  ⚠️ 无 Tailscale"}`);
  L.push("");
  L.push(`角色  ${mine.hostname} = ${roleLabel(mine)}${mine.roleNote ? " " + mine.roleNote : ""}`);
  if (mine.remoteUrl) L.push(`      → 远程服务器: ${mine.remoteUrl}`);
  if (mine.bindHost) L.push(`      → 监听 ${mine.bindHost}:${mine.port || 3081}`);
  L.push("");
  L.push("设备全景:");
  L.push("  " + ["设备", "角色", "在线", "会话", "数据", "连接目标"].join(" │ "));
  L.push("  " + "-".repeat(74));
  for (const d of agg.devices) {
    const isMine = d.hostname === mine.hostname ? " *" : "";
    const online = d.tsOnline === false ? "❌" : d.tsOnline === true ? "✅" : "?";
    const sessions = d.data?.sessions ?? "-";
    const dataMB = d.data?.sizeMB ?? "-";
    const target = d.remoteUrl ? `→${new URL(d.remoteUrl).host}` : d.bindHost ? `:${d.port || 3081}` : d.role === "client" ? "远程" : d.role === "server" ? ":3081" : "本机";
    L.push(`  ${(d.hostname + isMine).padEnd(16)} │ ${roleLabel(d).padEnd(10)} │ ${online}   │ ${String(sessions).padEnd(5)} │ ${String(dataMB).padEnd(6)}M │ ${target}`);
  }
  L.push("");
  // 文件夹矩阵
  const folderLabels = [...new Set(agg.devices.flatMap((d) => (d.folders || []).map((f) => f.label)))];
  if (folderLabels.length > 0) {
    L.push("文件夹在哪台设备:");
    L.push("  " + ["文件夹"].concat(agg.devices.map((d) => d.hostname)).join(" │ "));
    for (const label of folderLabels) {
      const row = agg.devices.map((d) => {
        const f = (d.folders || []).find((x) => x.label === label);
        if (!f) return "  -  ";
        return f.exists ? ` ✅${f.sizeMB >= 0 ? f.sizeMB + "M" : ""}` : "  ✗  ";
      });
      L.push(`  ${label.padEnd(24)} │ ${row.join(" │ ")}`);
    }
  }
  L.push("");
  L.push("提示: 每台设备运行一次 `node scripts/device-status.mjs --write` 后，上面的");
  L.push("     在线/角色/文件夹矩阵才会包含那台设备（状态经 iCloud CLD-status 共享）。");
  return L.join("\n");
}

function roleLabel(d) {
  const r = d.role || "standalone";
  return r === "server" ? "服务器" : r === "client" ? "客户端" : "本机";
}

/* ----------------------------------------------------------------- main */

const agg = aggregate();
if (doWrite) writeShared(agg.mine);

if (json) {
  process.stdout.write(JSON.stringify(agg, null, 2) + "\n");
} else {
  process.stdout.write(renderText(agg) + "\n");
  if (diagram) {
    process.stdout.write("\n--- Mermaid 状态图 ---\n");
    process.stdout.write(
      "stateDiagram-v2\n" +
        agg.devices
          .map((d) => `  ${d.hostname}: ${roleLabel(d)}${d.tsOnline === false ? " (离线)" : ""}`)
          .join("\n") +
        "\n" +
        agg.devices
          .filter((d) => d.role === "client" && d.remoteUrl)
          .map((d) => `  ${d.hostname} --> 服务器: ${new URL(d.remoteUrl).host}`)
          .join("\n") +
        "\n",
    );
  }
}
