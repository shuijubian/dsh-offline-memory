// 表情包收录库（并入外置记忆；与图片记忆 pics/ 分开存，互不引用）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const nowIso = () => new Date().toISOString()
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

export function paths(root) {
  return {
    root,
    dir: path.join(root, 'stickers'),
    index: path.join(root, 'stickers', 'index.jsonl'),
    quotaDir: path.join(root, 'stickers', 'quota'),
  }
}

export function ensureLayout(root) {
  const p = paths(root)
  for (const d of [p.dir, p.quotaDir]) { try { fs.mkdirSync(d, { recursive: true }) } catch {} }
  return p
}

// 扩展名嗅探：GIF / PNG（含 APNG）/ WebP / JPEG
export function sniffExt(bytes) {
  const b = bytes || []
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpg'
  return 'png'
}

export function readIndex(root) {
  const out = []
  try {
    const raw = fs.readFileSync(paths(root).index, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try { const row = JSON.parse(line); if (row && row.id) out.push(row) } catch {}
    }
  } catch {}
  return out
}

export function writeIndex(root, rows) {
  const p = ensureLayout(root)
  const tmp = p.index + '.tmp'
  try {
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
    fs.renameSync(tmp, p.index)
    return true
  } catch { return false }
}

export function saveSticker(root, { bytes, ext, meaning, usage, tags, status, source, privateFlag }) {
  try {
    if (!bytes || !bytes.length) return { ok: false, why: '没有图片数据' }
    if (bytes.length > 8 * 1024 * 1024) return { ok: false, why: '单张限 8MB' }
    const p = ensureLayout(root)
    const hash = sha256(bytes)
    const hash8 = hash.slice(0, 8)
    const e = String(ext || sniffExt(bytes)).replace(/^\./, '').toLowerCase()
    const id = 's-' + hash8
    const rows = readIndex(root)
    const dup = rows.find((r) => r.hash8 === hash8)
    if (dup) {
      let changed = false
      if (meaning && meaning !== dup.meaning) { dup.meaning = String(meaning).slice(0, 300); changed = true }
      if (usage && usage !== dup.usage) { dup.usage = String(usage).slice(0, 300); changed = true }
      if (tags && typeof tags === 'object') { dup.tags = { ...(dup.tags || {}), ...tags }; changed = true }
      if (changed) writeIndex(root, rows)
      return { ok: true, id: dup.id, hash8, dup: true, status: dup.status, file: dup.file }
    }
    const d = new Date()
    const sub = path.join(p.dir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'))
    fs.mkdirSync(sub, { recursive: true })
    const name = `${id}.${e}`
    fs.writeFileSync(path.join(sub, name), Buffer.from(bytes))
    const rel = path.join('stickers', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), name).replace(/\\/g, '/')
    const row = {
      id, hash8, file: rel, bytes: bytes.length, ext: e,
      tags: (tags && typeof tags === 'object') ? tags : {},
      meaning: String(meaning || '').slice(0, 300),
      usage: String(usage || '').slice(0, 300),
      status: status === 'ready' ? 'ready' : 'pending',
      private: privateFlag === true,
      at: nowIso(), source: String(source || '').slice(0, 80),
    }
    rows.push(row)
    writeIndex(root, rows)
    return { ok: true, id, hash8, dup: false, status: row.status, file: rel }
  } catch (err) { return { ok: false, why: String(err && err.message) } }
}

export function listStickers(root, { status } = {}) {
  const rows = readIndex(root)
  return status ? rows.filter((r) => r.status === status) : rows
}

export function getSticker(root, id) {
  return readIndex(root).find((r) => r.id === id) || null
}

export function updateSticker(root, id, patch) {
  const rows = readIndex(root)
  const it = rows.find((r) => r.id === id)
  if (!it) return { ok: false, why: '没有这个表情包' }
  const p = patch || {}
  if (p.meaning !== undefined) it.meaning = String(p.meaning).slice(0, 300)
  if (p.usage !== undefined) it.usage = String(p.usage).slice(0, 300)
  if (p.tags && typeof p.tags === 'object') it.tags = { ...(it.tags || {}), ...p.tags }
  if (p.status === 'ready' || p.status === 'pending' || p.status === 'retired') it.status = p.status
  writeIndex(root, rows)
  return { ok: true, item: it }
}

export function deleteSticker(root, id) {
  const rows = readIndex(root)
  const it = rows.find((r) => r.id === id)
  if (!it) return { ok: false, why: '没有这个表情包' }
  try { fs.rmSync(path.join(paths(root).root, it.file), { force: true }) } catch {}
  writeIndex(root, rows.filter((r) => r.id !== id))
  return { ok: true }
}

export function absFile(root, row) {
  return path.join(paths(root).root, String(row.file || '').replace(/\//g, path.sep))
}

export function findStickers(root, query, limit = 8) {
  const q = String(query || '').trim().toLowerCase()
  const rows = readIndex(root).filter((r) => r.status === 'ready' || r.status === 'pending')
  if (!q) return rows.slice(-limit)
  const hit = (r) => {
    const hay = [...Object.values(r.tags || {}), r.meaning, r.usage, r.source]
      .map((x) => String(x || '').toLowerCase()).join(' ')
    return hay.includes(q) || q.split(/\s+/).some((w) => w && hay.includes(w))
  }
  return rows.filter(hit).slice(0, limit)
}

// ---------- 发送配额（按会话独立） ----------
function quotaFile(root, sid) {
  return path.join(paths(root).quotaDir, String(sid || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) + '.json')
}

export function loadQuota(root, sid) {
  try {
    const j = JSON.parse(fs.readFileSync(quotaFile(root, sid), 'utf8'))
    return { day: '', count: 0, turn: 0, perTurn: 0, lastAt: null, ...(j || {}) }
  } catch { return { day: '', count: 0, turn: 0, perTurn: 0, lastAt: null } }
}

export function saveQuota(root, sid, q) {
  try { ensureLayout(root); fs.writeFileSync(quotaFile(root, sid), JSON.stringify(q, null, 2), 'utf8') } catch {}
}

export function takeQuota(root, sid, turn, cfg) {
  const today = nowIso().slice(0, 10)
  const q = loadQuota(root, sid)
  if (q.day !== today) { q.day = today; q.count = 0 }
  const cur = Number(turn) || 0
  if (q.turn !== cur) { q.turn = cur; q.perTurn = 0 }
  const maxPerTurn = Math.max(1, Number(cfg.stickerMaxPerTurn) || 1)
  const dailyCap = Math.max(1, Number(cfg.stickerDailyCap) || 30)
  if (q.perTurn >= maxPerTurn) return { ok: false, why: `本轮已用满 ${maxPerTurn} 张` }
  if (q.count >= dailyCap) return { ok: false, why: `今天已用满 ${dailyCap} 张` }
  q.perTurn += 1
  q.count += 1
  q.lastAt = nowIso()
  saveQuota(root, sid, q)
  return { ok: true, perTurn: q.perTurn, count: q.count, maxPerTurn, dailyCap }
}

export function stats(root) {
  const rows = readIndex(root)
  return {
    total: rows.length,
    ready: rows.filter((r) => r.status === 'ready').length,
    pending: rows.filter((r) => r.status === 'pending').length,
    bytes: rows.reduce((s, r) => s + (Number(r.bytes) || 0), 0),
  }
}

/** 速查表：把 ready 的表情包列成「id 标签」，给系统提示用 */
export function injectText(root, cfg) {
  try {
    if (!cfg || cfg.stickerEnabled === false || cfg.stickerInject === false) return ''
    const rows = listStickers(root, { status: 'ready' })
    if (!rows.length) return ''
    const max = Math.max(1, Number(cfg.stickerInjectLimit) || 20)
    const lines = rows.slice(-max).map((r) => {
      const t = r.tags || {}
      const tag = [t['情绪'], t['场景']].filter(Boolean).join('·') || String(r.meaning || '').slice(0, 8)
      return `#${r.id} ${tag}`
    })
    return `【表情包·可调用】\n${lines.join('\n')}\n（要发就用 sticker_send 拿 markdown，或先 sticker_find 查具体路径）`
  } catch { return '' }
}
