// 基础设施：原子写、会话锁、哈希、token 估算、日志
// 设计约束：这里的每个函数都不许抛到调用方，失败一律降级返回
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const nowIso = () => new Date().toISOString()

export function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}

export function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    if (!raw.trim()) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

// 原子写：先写同目录临时文件再 rename。
// 旧版 bug：临时文件路径的父目录未确保存在 → ENOENT: vctx.json.16452.tmp
export function writeJsonAtomic(file, value) {
  const dir = ensureDir(path.dirname(file))
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    try { fs.unlinkSync(tmp) } catch {}
    return false
  }
}

export function writeTextAtomic(file, text) {
  const dir = ensureDir(path.dirname(file))
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  try {
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    try { fs.unlinkSync(tmp) } catch {}
    return false
  }
}

export function appendLine(file, obj) {
  try {
    ensureDir(path.dirname(file))
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

export function appendRaw(file, line) {
  try {
    ensureDir(path.dirname(file))
    fs.appendFileSync(file, line, 'utf8')
    return true
  } catch {
    return false
  }
}

// 读 JSONL，丢弃末行截断等非法行
export function readJsonl(file) {
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out
}

export const sha = (s, len = 16) =>
  crypto.createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex').slice(0, len)

export const sha256 = (s) => crypto.createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex')

// 粗估 token：CJK 约 1 字 1 token，拉丁按词
export function estTokens(text) {
  const s = String(text || '')
  if (!s) return 0
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length
  const latin = (s.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ').match(/[A-Za-z0-9_'.+-]+/g) || []).length
  return Math.ceil(cjk + latin * 1.3)
}

const SESSION_KEY_RE = /[^A-Za-z0-9._-]+/g
export function sessionKey(sessionId) {
  const s = String(sessionId || 'default').trim()
  const k = s.replace(SESSION_KEY_RE, '_').slice(0, 80)
  return k || 'default'
}

// 单写者锁：wx 创建；超过 60s 视为陈旧可抢
export function acquireLock(dir, ttlMs = 60_000) {
  ensureDir(dir)
  const file = path.join(dir, '.lock')
  const payload = JSON.stringify({ pid: process.pid, at: Date.now() })
  try {
    fs.writeFileSync(file, payload, { flag: 'wx' })
    return { ok: true, file }
  } catch {
    const info = readJson(file, null)
    if (info && Number(info.at) && Date.now() - Number(info.at) < ttlMs) return { ok: false, file }
    try { fs.writeFileSync(file, payload, 'utf8'); return { ok: true, file, stale: true } } catch { return { ok: false, file } }
  }
}

export function releaseLock(lock) {
  if (!lock || !lock.ok) return
  try { fs.unlinkSync(lock.file) } catch {}
}

// 简单日志：写到 data root 的 logs 里，带轮转上界
export function makeLogger(dir) {
  const file = path.join(dir, 'host.log')
  let bytes = (() => { try { return fs.statSync(file).size } catch { return 0 } })()
  const cap = 2 * 1024 * 1024
  return function log(msg) {
    try {
      ensureDir(dir)
      const line = `[${nowIso()}] ${msg}\n`
      if (bytes > cap) {
        try {
          fs.renameSync(file, file + '.1')
          bytes = 0
        } catch {}
      }
      fs.appendFileSync(file, line, 'utf8')
      bytes += Buffer.byteLength(line)
    } catch {}
  }
}

export function dirSize(dir) {
  let total = 0
  const walk = (d) => {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) { try { total += fs.statSync(p).size } catch {} }
    }
  }
  walk(dir)
  return total
}

// 跨平台建档：从文件文本解析 Q&A 对，支持 JSON 数组 / JSONL / 问答文本 / 聊天记录（名字：内容交替）
export function parseQA(text) {
  const s = String(text || '').trim()
  if (!s) return []
  // 1. JSON 数组 [{q,a}|{question,answer}|[q,a]]
  try {
    const arr = JSON.parse(s)
    if (Array.isArray(arr)) {
      const out = []
      for (const x of arr) {
        if (!x) continue
        if (Array.isArray(x)) { out.push([String(x[0] || ''), String(x[1] || '')]); continue }
        if (x.role) { out.push([String(x.text || ''), '']); continue }
        const q = x.q ?? x.question ?? ''
        const a = x.a ?? x.answer ?? ''
        if (q) out.push([String(q), String(a)])
      }
      return out.filter(([q]) => q)
    }
  } catch {}
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean)
  // 2. JSONL
  if (lines.every((l) => l.startsWith('{'))) {
    try {
      const out = []
      for (const l of lines) {
        const x = JSON.parse(l)
        if (!x) continue
        if (x.role) { out.push([String(x.text || ''), '']); continue }
        if (x.q) out.push([String(x.q), String(x.a ?? '')])
      }
      if (out.length) return out
    } catch {}
  }
  // 3. 问：/答： 文本
  const qa = []
  let curQ = null
  for (const line of lines) {
    const qm = line.match(/^(?:问|Q|问题|question)\s*[:：]\s*(.+)$/i)
    const am = line.match(/^(?:答|A|回答|answer)\s*[:：]\s*(.+)$/i)
    if (qm) curQ = qm[1]
    else if (am && curQ) { qa.push([curQ, am[1]]); curQ = null }
  }
  if (qa.length) return qa
  // 4. 聊天记录（名字：内容 交替）
  const chat = lines.filter((l) => /[：:]/.test(l))
  const pairs = []
  for (let i = 0; i + 1 < chat.length; i += 2) {
    pairs.push([chat[i].replace(/^[^:：]+[:：]\s*/, ''), chat[i + 1].replace(/^[^:：]+[:：]\s*/, '')])
  }
  if (pairs.length) return pairs
  // 5. 兜底：每两行一组
  const fb = []
  for (let i = 0; i + 1 < lines.length; i += 2) fb.push([lines[i], lines[i + 1]])
  return fb
}

// 隐私脱敏：落盘前执行，保留原文哈希用于去重
const SECRET_PATTERNS = [
  /\bSESSDATA\s*[=:]\s*[^\s;&"']+/gi,
  /\bbili_jct\s*[=:]\s*[^\s;&"']+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
  /\b(password|passwd|pwd)\s*[=:]\s*[^\s;&"']+/gi,
  /\b(token|api[_-]?key|secret)\s*[=:]\s*[^\s;&"']+/gi,
  /\bsk-[A-Za-z0-9]{8,}/g,
  /[A-Za-z]:\\[^\s"'<>|]{6,}/g,
]

export function redact(text) {
  let s = String(text || '')
  let hits = 0
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, (m) => {
      hits++
      // 绝对路径只留盘符，避免整段信息丢失
      if (/^[A-Za-z]:\\/.test(m)) return String(m).slice(0, 2) + '\\[REDACTED]'
      return '[REDACTED]'
    })
  }
  return { text: s, hits }
}
