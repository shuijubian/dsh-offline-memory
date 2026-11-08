// 三层存储（v1.1，按 2026-10-29 的架构调整重写）
//
//   底层存储 base      : journal/seg-*.jsonl  全部会话原文，带日期索引，保证"接续"
//   优化存储 optimized : optimized.jsonl      虚拟上下文里被评分压缩过的内容备份，长期保存，带日期索引
//   虚拟上下文 vctx    : vctx.json            智能体的"临时记忆"：会被淡忘删除，删了可从优化存储打捞
//
// 关键语义：
//   · 评分 = 衰变期。评分低衰变快，评分高衰变慢；衰变 = 从虚拟上下文删除。
//   · 存到优化存储的间隔必须 ≤ 最短衰变期，否则条目会在备份前先死掉，接不上。
//   · 打捞只从优化存储取；需要细节再回底层存储比对日期与前后文补全。
//   · 打捞回来的条目自然衰变、不回写优化存储（那里已有备份）。
import fs from 'node:fs'
import path from 'node:path'
import {
  ensureDir, readJson, writeJsonAtomic, writeTextAtomic, appendLine, readJsonl,
  sha, sha256, estTokens, nowIso, redact, dirSize, parseQA,
} from './util.mjs'
import * as SC from './score.mjs'
import * as V from './vector.mjs'
import * as IMG from './image.mjs'
import * as G from './graph.mjs'
import { readSessionMessages } from './decode.mjs'
import { DEFAULT_CONFIG } from './config.mjs'

const SEG_MAX_BYTES = 8 * 1024 * 1024
const DAY = 864e5

export function paths(root) {
  return {
    root,
    meta: path.join(root, 'meta.json'),
    bootstrap: path.join(root, 'bootstrap.json'),
    journal: path.join(root, 'journal'),
    manifest: path.join(root, 'journal', 'manifest.json'),
    seen: path.join(root, 'journal', 'seen.txt'),
    pending: path.join(root, 'journal', 'pending.jsonl'),
    vctx: path.join(root, 'vctx.json'),
    optimized: path.join(root, 'optimized.jsonl'),
    vectors: path.join(root, 'vectors', 'index.jsonl'),
    scoreBook: path.join(root, 'score-book.json'),
    important: path.join(root, 'important.jsonl'),
    systemSnapshot: path.join(root, 'system-snapshot.json'),
    snapshots: path.join(root, 'snapshots'),
    logs: path.join(root, 'logs'),
    state: path.join(root, 'state', 'mood.json'),
    mood: path.join(root, 'state', 'mood.json'),
    moodEvents: path.join(root, 'state', 'mood-events.jsonl'),
    affection: path.join(root, 'state', 'affection.json'),
    affectionEvents: path.join(root, 'state', 'affection-events.jsonl'),
    traits: path.join(root, 'state', 'traits.json'),
    qa: path.join(root, 'state', 'qa-samples.jsonl'),
  }
}

export function ensureLayout(root) {
  const p = paths(root)
  for (const d of [root, p.journal, p.snapshots, p.logs, path.dirname(p.state)]) ensureDir(d)
  if (!fs.existsSync(p.meta)) writeJsonAtomic(p.meta, { schemaVersion: 2, createdAt: nowIso(), title: path.basename(root) })
  if (!fs.existsSync(p.vctx)) writeJsonAtomic(p.vctx, { version: 2, capacityTokens: 3000, items: [], updatedAt: nowIso() })
  if (!fs.existsSync(p.manifest)) writeJsonAtomic(p.manifest, { schemaVersion: 2, seq: 0, segment: 0, bytes: 0, totalItems: 0 })
  return p
}

// 评分 → 衰变期（天）。评分越高活得越久。
export function decayDaysOf(score, cfg) {
  const s = Math.max(0, Math.min(10, Number(score) || 0))
  const mid = Number(cfg.scoreMid ?? 7)
  const lo = Number(cfg.minDecayDays ?? 7)          // 寿命下限（可调）
  const lmax = Number(cfg.lmaxDays ?? 90)           // v2：Lmax 固定，不随 N 缩放
  const d7 = Number(cfg.decay7Months ?? 8) * 30     // 7 分超长寿命（8 个月）
  // v2 新衰变公式：8 分永久，7 分 8 个月，4~6 分 Lmax×0.85^(7−s)，<4 分寿命下限
  if (s >= 8) return cfg.pinForever === false ? d7 : Infinity
  if (s >= mid) return d7
  if (s >= 4) return Math.max(lo, Math.round(lmax * Math.pow(0.85, 7 - s)))
  return lo
}

export function minSaveIntervalMinutes(cfg) {
  // 存档间隔必须 ≤ 最短衰变期，否则条目在备份前就死了
  return Math.max(1, Math.floor(Number(cfg.minDecayDays ?? 3) * 24 * 60))
}

// ---------- 底层存储 ----------

let seenCache = new Map()
function seenFor(p) {
  if (!seenCache.has(p.root)) {
    const set = new Set()
    try {
      for (const line of fs.readFileSync(p.seen, 'utf8').split('\n')) if (line.trim()) set.add(line.trim())
    } catch {}
    seenCache.set(p.root, set)
  }
  return seenCache.get(p.root)
}

function currentSegment(p) {
  const m = readJson(p.manifest, { seq: 0, segment: 0, bytes: 0, totalItems: 0 })
  let seg = Number(m.segment) || 0
  let file = path.join(p.journal, `seg-${String(seg).padStart(4, '0')}.jsonl`)
  let size = 0
  try { size = fs.statSync(file).size } catch {}
  if (size > SEG_MAX_BYTES) {
    seg += 1
    file = path.join(p.journal, `seg-${String(seg).padStart(4, '0')}.jsonl`)
    writeJsonAtomic(p.manifest, { ...m, segment: seg, bytes: 0 })
  }
  return { file, manifest: m }
}

export function appendJournal(root, entry) {
  try {
    const p = ensureLayout(root)
    const seen = seenFor(p)
    const h = entry.hash || sha(`${entry.sessionId || ''}|${entry.role}|${entry.seq ?? ''}|${entry.text}`)
    if (seen.has(h)) return { ok: false, dup: true }
    const { file, manifest } = currentSegment(p)
    const item = {
      id: entry.id || `j-${h}`,
      seq: (Number(manifest.seq) || 0) + 1,
      at: entry.at || nowIso(),
      sessionId: entry.sessionId,
      turnIndex: entry.turnIndex ?? 0,
      role: entry.role || 'user',
      text: entry.text,
      tokens: estTokens(entry.text),
      hash: h,
      origin: entry.origin || 'from',
      status: entry.status || 'unscored',
      refs: entry.refs || null,
    }
    appendLine(file, item)
    try { fs.appendFileSync(p.seen, h + '\n', 'utf8') } catch {}
    seen.add(h)
    writeJsonAtomic(p.manifest, {
      ...manifest, seq: item.seq,
      totalItems: (Number(manifest.totalItems) || 0) + 1,
      bytes: (Number(manifest.bytes) || 0) + Buffer.byteLength(JSON.stringify(item)) + 1,
    })
    return { ok: true, dup: false, item }
  } catch (e) {
    return { ok: false, error: String(e && e.message) }
  }
}

export function readJournal(root, limit = Infinity) {
  try {
    const p = ensureLayout(root)
    const m = readJson(p.manifest, { segment: 0 })
    const segs = Number(m.segment) || 0
    const all = []
    for (let i = 0; i <= segs; i++) {
      const f = path.join(p.journal, `seg-${String(i).padStart(4, '0')}.jsonl`)
      if (fs.existsSync(f)) all.push(...readJsonl(f))
    }
    all.sort((a, b) => (a.seq || 0) - (b.seq || 0))
    return limit === Infinity ? all : all.slice(-limit)
  } catch { return [] }
}

// ---------- 优化存储（长期备份） ----------

export function readOptimized(root) {
  try { return readJsonl(ensureLayout(root).optimized) } catch { return [] }
}

export function appendOptimized(root, item) {
  try {
    const p = ensureLayout(root)
    const exists = readJsonl(p.optimized).some((x) => x.id === item.id)
    if (exists) return false
    return appendLine(p.optimized, item)
  } catch { return false }
}

// v2：追加向量（与优化存储同源，向量基于原文、原样存，不参与压缩）
export function appendVector(root, item) {
  try {
    const p = ensureLayout(root)
    const exists = readJsonl(p.vectors).some((x) => x.eventId === item.eventId)
    if (exists) return false
    return appendLine(p.vectors, item)
  } catch { return false }
}

// v2：向量检索（余弦 top-K），返回 { idx, sim }；embedding 失败返回空数组（BM25 兜底）
export function vectorSearch(root, query, k = 10) {
  try {
    const p = ensureLayout(root)
    const rows = readJsonl(p.vectors)
    if (!rows.length) return []
    const qv = V.embed(query)
    return V.topK(qv, rows, k).map((r) => ({ eventId: rows[r.idx].eventId, sim: r.sim }))
  } catch { return [] }
}

// P7：v1 → v2 迁移（幂等）：给旧数据补四要素打标 + 向量 + 事件编号
export function migrateToV2(root, cfg = DEFAULT_CONFIG) {
  try {
    const p = ensureLayout(root)
    const result = { events: 0, vectors: 0 }
    // 1. 补向量：优化存储里每个事件算向量，写入 vectors/index.jsonl
    const optRows = readJsonl(p.optimized)
    const vecIds = new Set(readJsonl(p.vectors).map((x) => x.eventId))
    for (const it of optRows) {
      if (vecIds.has(it.id)) continue
      appendVector(root, { eventId: it.id, vec: Array.from(V.embed(it.text || it.summary || '')), date: it.at, seq: it.seq ?? it.eventSeq ?? null })
      vecIds.add(it.id)
      result.vectors++
    }
    // 2. 补四要素 + 事件编号：vctx 条目缺 event/eventSeq 时补上
    const v = readJson(p.vctx, null)
    if (v && Array.isArray(v.items)) {
      let dirty = false
      for (const it of v.items) {
        if (!it.event) { it.event = tagEvent(it.summary || '', it.at); dirty = true }
        if (it.eventSeq == null && it.seq != null) { it.eventSeq = it.seq; dirty = true }
      }
      if (dirty) writeJsonAtomic(p.vctx, { ...v, updatedAt: nowIso() })
      result.events = v.items.length
    }
    appendLine(path.join(p.logs, 'events.log'), { at: nowIso(), type: 'migrate-v2', ...result })
    return result
  } catch (e) {
    return { error: String(e && e.message) }
  }
}

// 懒迁移：向量索引空但优化存储有数据时，一次性补齐
function ensureVectors(root) {
  try {
    const p = ensureLayout(root)
    if (readJsonl(p.vectors).length === 0 && readJsonl(p.optimized).length > 0) {
      migrateToV2(root)
    }
  } catch {}
}

// 向量 map：eventId → Float32Array（检索/网格化共用）
function loadVectorMap(root) {
  try {
    ensureVectors(root)
    const m = new Map()
    for (const r of readJsonl(paths(root).vectors)) m.set(r.eventId, new Float32Array(r.vec || []))
    // 图片描述向量并入（保存时算好，检索时不再读图）
    for (const img of IMG.listImages(root)) if (img.vec) m.set(img.id, new Float32Array(img.vec))
    return m
  } catch { return new Map() }
}

// v2：网格化三子级扩展——从已命中项沿向量邻居扩散（深度/条数/阈值均可设置）
function gridExpand(root, picked, cfg, vecMap) {
  try {
    const rows = readJsonl(paths(root).vectors)
    if (!rows.length || !picked.length) return []
    const depth = Number(cfg.gridDepth) || 3
    const perLevel = Number(cfg.gridPerLevel) || 5
    const total = Number(cfg.gridTotal) || 15
    const threshold = Number(cfg.gridClusterThreshold) || 0.3
    const seen = new Set(picked.map((x) => x.id))
    const added = []
    let frontier = rows.filter((r) => seen.has(r.eventId))
    for (let d = 1; d <= depth && added.length < total; d++) {
      const next = []
      for (const f of frontier) {
        for (const t of V.topK(f.vec, rows, perLevel + 1)) {
          if (t.sim < threshold) continue   // 同类事件阈值，低于则不算同网格
          const rid = rows[t.idx].eventId
          if (seen.has(rid)) continue
          seen.add(rid)
          added.push({ eventId: rid, sim: t.sim, depth: d })
          next.push(rows[t.idx])
          if (added.length >= total) break
        }
        if (added.length >= total) break
      }
      frontier = next
    }
    return added
  } catch { return [] }
}

// ---------- 虚拟上下文（临时记忆） ----------

export function loadVctx(root) {
  const p = ensureLayout(root)
  const v = readJson(p.vctx, null)
  if (v && Array.isArray(v.items)) {
    if (v.version !== 2) return migrateVctx(root, v)
    // 自愈：同一 id 的重复条目合并成一条（旧迁移/并发写入可能产生重复，导致同一段文字反复注入）
    if (v.items.length > 1) {
      const byId = new Map()
      for (const it of v.items) {
        if (!it || !it.id) continue
        const cur = byId.get(it.id)
        if (!cur) { byId.set(it.id, it); continue }
        if (it.injectedAt && !cur.injectedAt) cur.injectedAt = it.injectedAt
        if ((Number(it.score) || 0) > (Number(cur.score) || 0)) cur.score = it.score
      }
      if (byId.size !== v.items.length) v.items = [...byId.values()]
    }
    return v
  }
  return { version: 2, capacityTokens: 3000, items: [], updatedAt: nowIso() }
}

// v1 → v2：旧条目只有 state(active/down/archive/pinned)，没有衰变期；补上并按优化存储建索引
function migrateVctx(root, v) {
  try {
    const p = paths(root)
    const seen = new Set(readJsonl(p.optimized).map((x) => x.id))
    const items = []
    for (const it of v.items || []) {
      const score = Number(it.score) || 0
      const decayDays = it.state === 'pinned' ? Infinity : decayDaysOf(score, DEFAULT_CONFIG)
      const at = it.at || nowIso()
      const item = {
        ...it,
        decayDays,
        expiresAt: decayDays === Infinity ? null : new Date(new Date(at).getTime() + decayDays * DAY).toISOString(),
        origin: it.origin || (it.state === 'archive' ? 'from' : 'from'),
        originAt: it.originAt || at,
        salvagedAt: it.salvagedAt || null,
        hitCount: Number(it.hitCount) || 0,
        lastHitAt: it.lastHitAt || null,
      }
      delete item.state
      items.push(item)
      if (!seen.has(item.id)) {
        appendLine(p.optimized, { ...item, text: it.summary, savedAt: nowIso(), migrated: true })
        seen.add(item.id)
      }
    }
    const next = { ...v, version: 2, items, updatedAt: nowIso() }
    delete next.mode
    writeJsonAtomic(p.vctx, next)
    appendLine(path.join(p.logs, 'events.log'), { at: nowIso(), type: 'migrate-v2', items: items.length })
    return next
  } catch {
    return { version: 2, capacityTokens: 3000, items: [], updatedAt: nowIso() }
  }
}

function saveVctx(root, v) {
  return writeJsonAtomic(paths(root).vctx, { ...v, updatedAt: nowIso() })
}

export function summarize(text, max = 90) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const lastPunct = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf('. '), cut.lastIndexOf(' '))
  return (lastPunct > max * 0.6 ? cut.slice(0, lastPunct) : cut) + '…'
}

function tagsOf(text) {
  const tags = new Set()
  for (const m of String(text || '').matchAll(/\b\d{4}-\d{2}-\d{2}\b|\b[A-Za-z_]{4,}\b/g)) {
    tags.add(String(m[0]))
    if (tags.size > 6) break
  }
  return [...tags]
}

// 四要素打标：名称(主体) / 日期 / 事因(为什么记) / 地点(位置)
export function tagEvent(text, at) {
  try {
    const s = String(text || '')
    const name = []
    const zhName = s.match(/(?:我叫|我是|他叫|她叫|叫做|名叫|主人)([\u4e00-\u9fff]{2,6})/)
    if (zhName) name.push(zhName[1])
    for (const m of s.matchAll(/\b[A-Za-z_]{4,}\b|\b\d{4}-\d{2}-\d{2}\b/g)) {
      name.push(String(m[0]))
      if (name.length >= 4) break
    }
    const cause = /(约定|答应|以后|今后|从此|不许|不能|不准|规则|必须|务必|永远|边界|底线)/.test(s) ? '约定'
      : /(我是|我叫|我喜欢|我讨厌|我不喜欢|我的|住在|身份|人格|性格|偏好)/.test(s) ? '陈述'
      : /(结论|搞定|完成|解决|通过|成功|最终|就这么定)/.test(s) ? '结论'
      : '日常'
    const place = []
    const pm = s.match(/(?:在|去|到|回)([\u4e00-\u9fff]{2,6})/)
    if (pm) place.push(pm[1])
    return { name: name.slice(0, 3), date: String(at || '').slice(0, 10), cause, place: place.slice(0, 2) }
  } catch {
    return { name: [], date: String(at || '').slice(0, 10), cause: '日常', place: [] }
  }
}

function makeItem(item, score, cfg, extra = {}) {
  const summary = summarize(item.text)
  const decayDays = decayDaysOf(score, cfg)
  return {
    id: `v-${item.hash}`,
    refTo: item.id,
    seq: item.seq ?? null,
    at: item.at,
    summary,
    tokens: estTokens(summary),
    score,
    decayDays,
    expiresAt: decayDays === Infinity ? null : new Date(new Date(item.at).getTime() + decayDays * DAY).toISOString(),
    lastHitAt: null,
    hitCount: 0,
    origin: item.origin === 'bootstrap' ? 'bootstrap' : 'from',
    originAt: item.at,
    salvagedAt: null,
    tags: tagsOf(item.text),
    event: tagEvent(item.text, item.at),
    eventSeq: item.seq ?? null,
    role: item.role,
    replyTo: item.refs?.replyTo || null,
    important: false,
    ...extra,
  }
}

/** 评分分流：压缩 → 优化存储（长期） + 虚拟上下文（临时）
 *  scoreOverride 可外部传入（会话智能体打分 / 延迟打分），不传则用内置规则 */
export function route(root, item, cfg, scoreOverride) {
  try {
    ensureLayout(root)
    const score = typeof scoreOverride === 'number' && isFinite(scoreOverride)
      ? Math.max(0, Math.min(10, scoreOverride))
      : SC.rate(item.text, item.role).score
    const v = loadVctx(root)
    const base = makeItem(item, score, cfg, {
      // 重要会话：宁空不可错。只认 user 原文 + 三类内容 + 高分
      important: item.role === 'user' && score >= cfg.scoreMid && SC.isImportant(item.text, item.role),
    })
    if (v.items.some((i) => i.id === base.id)) return { score, state: 'dup' }

    // 优化存储：长期备份（含原文，便于补全细节）
    appendOptimized(root, { ...base, text: item.text, sourceTokens: item.tokens, savedAt: nowIso() })
    // 向量索引：基于原文算向量，原样存（零依赖特征哈希，可换稠密模型）
    appendVector(root, { eventId: base.id, vec: Array.from(V.embed(item.text)), date: base.at, seq: base.eventSeq })
    // 虚拟上下文：临时记忆
    v.items.push(base)
    saveVctx(root, v)
    return { score, state: 'active', decayDays: base.decayDays }
  } catch {
    return null
  }
}

export function enqueuePending(root, id) {
  try {
    appendLine(paths(root).pending, { id, at: nowIso() })
    return true
  } catch { return false }
}

// 手动把重要会话降级为普通存档（给个只进不出的永久档留退路）
export function demoteImportant(root, id, cfg) {
  try {
    const v = loadVctx(root)
    const it = v.items.find((x) => x.id === id)
    if (!it) return { ok: false, error: '找不到该条目' }
    if (it.important === true) {
      it.important = false
      // 降级后要给有限衰变期，否则还是"永久"
      if (it.decayDays === Infinity) {
        it.decayDays = decayDaysOf(Math.min(Number(it.score) || 6, (cfg?.scoreMid ?? 7) - 0.1), cfg)
        it.expiresAt = new Date(Date.now() + it.decayDays * DAY).toISOString()
      }
      saveVctx(root, v)
      appendLine(path.join(paths(root).logs, 'events.log'), { at: nowIso(), type: 'demote-important', id })
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e && e.message) }
  }
}

// 重要会话清单（供存档设置里管理/降级）
export function listImportant(root) {
  try {
    const v = loadVctx(root)
    return v.items.filter((i) => i.important === true)
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .map((i) => ({ id: i.id, at: i.at, seq: i.seq, score: i.score, summary: i.summary, role: i.role }))
  } catch { return [] }
}

// 手动删除一条（从虚拟上下文 + 优化存储里彻底移除）
export function deleteItem(root, id) {
  try {
    const p = ensureLayout(root)
    const v = loadVctx(root)
    const before = v.items.length
    v.items = v.items.filter((i) => i.id !== id)
    let optimizedRemoved = 0
    if (fs.existsSync(p.optimized)) {
      const rows = readJsonl(p.optimized).filter((r) => r.id !== id)
      optimizedRemoved = readJsonl(p.optimized).length - rows.length
      writeTextAtomic(p.optimized, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
    }
    if (v.items.length !== before) saveVctx(root, v)
    appendLine(path.join(p.logs, 'events.log'), { at: nowIso(), type: 'delete-item', id, optimizedRemoved })
    return { ok: true, removed: before - v.items.length, optimizedRemoved }
  } catch (e) {
    return { ok: false, error: String(e && e.message) }
  }
}

// ---------- v2 打分对照本（score-book.json） ----------
// 事件类型(cause) → 基线分。托管打分用它做先验；智能体接管打分时补打/更新。
const SCORE_BOOK_DEFAULT = { 约定: 8, 陈述: 7, 结论: 7, 日常: 4 }

export function loadScoreBook(root) {
  try {
    const p = ensureLayout(root)
    return { ...SCORE_BOOK_DEFAULT, ...(readJson(p.scoreBook, null) || {}) }
  } catch { return { ...SCORE_BOOK_DEFAULT } }
}

export function saveScoreBook(root, book) {
  try {
    const p = ensureLayout(root)
    return writeJsonAtomic(p.scoreBook, book)
  } catch { return false }
}

// 分数 ±2 浮动：新分相对旧分最多变 range，避免大起大落（漂移是正常的，但不能剧变）
export function clampFloat(oldScore, newScore, range = 2) {
  try {
    const old = Number(oldScore)
    if (!isFinite(old)) return Number(newScore)
    const nw = Number(newScore)
    const d = Math.max(-range, Math.min(range, nw - old))
    return Math.round((old + d) * 10) / 10
  } catch { return Number(newScore) }
}

// 智能体接管补打：把现有条目的分数按事因(cause)聚合，更新对照本基线
// （"对照本里的事件标签做相似性合并优化"——这里用平均值合并同类事件）
export function recalcScoreBook(root) {
  try {
    const v = loadVctx(root)
    const book = loadScoreBook(root)
    const acc = {}
    for (const it of v.items) {
      const cause = (it.event && it.event.cause) || '日常'
      if (!acc[cause]) acc[cause] = { sum: 0, n: 0 }
      acc[cause].sum += Number(it.score) || 0
      acc[cause].n += 1
    }
    for (const [cause, a] of Object.entries(acc)) {
      if (a.n >= 1) book[cause] = Math.round((a.sum / a.n) * 10) / 10
    }
    saveScoreBook(root, book)
    return book
  } catch { return null }
}

export function ingestMessages(root, sessionId, messages, cfg, { origin = 'from', defer = false } = {}) {
  let added = 0
  let dup = 0
  let redactions = 0
  let skipped = 0
  let lastUserId = null
  for (const m of messages) {
    // 注入块、诊断日志、运行时上下文不进记忆库
    if (isNoise(m.text)) { skipped++; continue }
    if (m.role === 'system') { skipped++; continue }   // 系统提示不是"记忆"，不入底层
    const { text, hits } = redact(m.text)
    if (!String(text || '').trim()) continue
    redactions += hits
    const res = appendJournal(root, {
      sessionId, role: m.role, text, at: new Date(m.at || Date.now()).toISOString(),
      turnIndex: m.turn, origin, seq: m.seq,
      // 把"这一句是在回谁"记下来：检索时要成对取回，否则只捞到问题、答不上
      refs: m.role === 'assistant' && lastUserId ? { replyTo: lastUserId } : (hits ? { redacted: true } : null),
    })
    if (res.dup) { dup++; continue }
    if (!res.ok) continue
    if (m.role === 'user') lastUserId = res.item.id
    if (m.role === 'system') { added++; continue }   // system 只落底层 + 快照
    addSignals(root, text, m.role)
    if (origin === 'bootstrap' || defer) appendLine(paths(root).pending, { id: res.item.id, at: nowIso() })
    else route(root, res.item, cfg)
    added++
  }
  return { added, dup, redactions, skipped }
}

// 心情 / 好感度 / 萌属性 / Q&A 样本：全部内置
export function addSignals(root, text, role) {
  try {
    const p = ensureLayout(root)

    // —— 心情（独立项 A）——
    const m = SC.mood(text)
    const cur = readJson(p.mood, { value: 70, at: nowIso() })
    const hours = Math.max(0, (Date.now() - new Date(cur.at).getTime()) / 3.6e6)
    let v = Number(cur.value) || 70
    v = 70 + (v - 70) * Math.pow(0.5, hours / 6)
    v = Math.max(0, Math.min(100, v + m.delta))
    writeJsonAtomic(p.mood, { value: Math.round(v * 10) / 10, at: nowIso(), dims: m.dims })
    // 心情「最近变动」：只记录有情绪词推动的每一次变化
    if (Math.abs(m.delta) > 0) {
      appendLine(p.moodEvents, {
        at: nowIso(), delta: m.delta, value: Math.round(v * 10) / 10,
        reason: (m.dims && (m.dims.pos || m.dims.neg)) ? `${m.dims.pos} 正向词 / ${m.dims.neg} 负向词` : '情绪词触发',
        quote: String(text || '').slice(0, 80),
      })
    }

    // —— 好感度（独立项 B）——
    const ev = SC.affectionEvent(text, role)
    if (ev && ev.quote) {
      const prev = readJson(p.affection, { value: 0, day: nowIso().slice(0, 10), dayAbs: 0 })
      const today = nowIso().slice(0, 10)
      const dayAbs = prev.day === today ? Number(prev.dayAbs) || 0 : 0
      const delta = Math.min(ev.cap, 3)
      if (dayAbs + delta <= 10) {
        appendLine(p.affectionEvents, {
          at: nowIso(), type: ev.type, delta, reason: ev.type,
          evidence: { quote: ev.quote, offsets: null, hash: sha(ev.quote) }, reviewer: 'rule-engine', version: 2,
        })
        writeJsonAtomic(p.affection, {
          value: Math.max(-100, Math.min(100, (Number(prev.value) || 0) + delta)), day: today, dayAbs: dayAbs + delta,
        })
      } else {
        appendLine(path.join(p.logs, 'events.log'), { at: nowIso(), type: 'affection-rejected', why: '日累计超 10', ev })
      }
    }

    // —— 萌属性 / 阵营（依据对话，娱乐性质）——
    const tr = readJson(p.traits, { axes: {}, alignment: { order: 0, moral: 0 } })
    for (const [axis, target] of Object.entries(SC.trait(text))) {
      const old = Number(tr.axes[axis] ?? 50)
      const next = old + 0.2 * (target - old)
      tr.axes[axis] = Math.round(Math.max(0, Math.min(100, next)) * 10) / 10
    }
    const al = SC.alignment(text)
    tr.alignment = {
      order: Math.max(-100, Math.min(100, (tr.alignment?.order || 0) * 0.95 + al.order * 0.3)),
      moral: Math.max(-100, Math.min(100, (tr.alignment?.moral || 0) * 0.95 + al.moral * 0.3)),
    }
    writeJsonAtomic(p.traits, tr)

    // —— Q&A 问答样本（供属性模块取依据）——
    const qa = SC.qaSample(text, role)
    if (qa) appendLine(p.qa, qa)
  } catch {}
}

// 清空并重新计算萌属性 / 阵营：不动 Q&A 样本，只用样本重新推一遍（修正用）
export function recalcTraits(root) {
  try {
    const p = ensureLayout(root)
    const samples = readJsonl(p.qa)
    const tr = { axes: {}, alignment: { order: 0, moral: 0 }, recalcAt: nowIso() }
    for (const s of samples) {
      const text = s.text || ''
      const role = s.role || 'assistant'
      for (const [axis, target] of Object.entries(SC.trait(text))) {
        const old = Number(tr.axes[axis] ?? 50)
        const next = old + 0.2 * (target - old)
        tr.axes[axis] = Math.round(Math.max(0, Math.min(100, next)) * 10) / 10
      }
      const al = SC.alignment(text)
      tr.alignment = {
        order: Math.max(-100, Math.min(100, tr.alignment.order * 0.95 + al.order * 0.3)),
        moral: Math.max(-100, Math.min(100, tr.alignment.moral * 0.95 + al.moral * 0.3)),
      }
    }
    writeJsonAtomic(p.traits, tr)
    return { ok: true, samples: samples.length, axes: Object.keys(tr.axes).length, alignment: tr.alignment }
  } catch (e) {
    return { ok: false, error: String(e && e.message) }
  }
}

// ---------- 回填 ----------

/**
 * 处理待打分队列：bootstrap 回填 与 onSave 延迟打分共用。
 * scorer: async (text, role) => number | undefined
 */
export async function processPending(root, cfg, n = 50, scorer) {
  try {
    const p = ensureLayout(root)
    const pending = readJsonl(p.pending)
    if (!pending.length) return { done: 0, remaining: 0 }
    const byId = new Map(readJournal(root).map((j) => [j.id, j]))
    const todo = pending.slice(0, n)
    const rest = pending.slice(n)
    let done = 0
    for (const { id } of todo) {
      const j = byId.get(id)
      if (!j) continue
      let score
      try { score = await scorer(j.text, j.role) } catch { score = undefined }
      if (route(root, j, cfg, score)) done++
    }
    writeTextAtomic(p.pending, rest.map((r) => JSON.stringify(r)).join('\n') + (rest.length ? '\n' : ''))
    return { done, remaining: rest.length }
  } catch {
    return { done: 0, error: true }
  }
}

// 用内置规则同步回填
export function warmStep(root, cfg, n = 50) {
  return processPending(root, cfg, n, async (text, role) => SC.rate(text, role).score)
}

export function pendingCount(root) {
  try { return readJsonl(ensureLayout(root).pending).length } catch { return 0 }
}

// 比对底层存储，把还没进优化存储的条目补齐（重评分 + 入优化 + 入虚拟上下文）
export async function backfillOptimized(root, cfg, scorer, onProgress) {
  try {
    const p = ensureLayout(root)
    const optIds = new Set(readJsonl(p.optimized).map((x) => x.id))
    const v = loadVctx(root)
    const journal = readJournal(root)
    let added = 0
    let skipped = 0
    let tokens = 0
    let done = 0
    const total = journal.length
    for (const it of journal) {
      done++
      if (onProgress) { try { onProgress({ done, total, added, skipped, seq: it.seq }) } catch {} }
      const vid = `v-${it.hash}`
      if (optIds.has(vid)) continue
      if (it.role === 'system') { skipped++; continue }
      if (isNoise(it.text)) { skipped++; continue }
      // 在虚拟上下文但不在优化存储：直接补写优化（route 的 dup 检查会挡掉，需单独处理）
      const inVctx = v.items.find((x) => x.id === vid)
      if (inVctx) {
        appendOptimized(root, { ...inVctx, text: it.text, sourceTokens: it.tokens, savedAt: nowIso() })
        added++
        tokens += estTokens(it.text)
        continue
      }
      let score
      try { score = scorer ? await scorer(it.text, it.role) : SC.rate(it.text, it.role).score } catch { score = undefined }
      const r = route(root, it, cfg, score)
      if (r && r.state !== 'dup') { added++; tokens += estTokens(it.text) }
    }
    return { ok: true, added, skipped, journalTotal: journal.length, tokens }
  } catch (e) {
    return { ok: false, error: String(e && e.message) }
  }
}

// ---------- 淡忘（衰变删除）与容量淘汰 ----------

export function keepWeight(item, cfg) {
  const ageDays = Math.max(0, (Date.now() - new Date(item.at).getTime()) / DAY)
  const base = Math.pow(Math.max(0, Number(item.score) || 0) / 10, 1.5)
  const decay = Math.pow(0.5, ageDays / Math.max(1, cfg.halfLifeDays))
  const hit = 1 + 0.3 * Math.min(Number(item.hitCount) || 0, cfg.hitCap)
  const boost = (item.tags || []).length ? 1.1 : 1
  return base * decay * hit * boost
}

export function forget(root, cfg) {
  try {
    const v = loadVctx(root)
    const now = Date.now()
    let expired = 0
    const kept = []
    for (const it of v.items) {
      if (it.kind === 'persona') { kept.push(it); continue }   // 人设属性：不参与衰变
      const exp = it.expiresAt ? new Date(it.expiresAt).getTime() : Infinity
      if (exp !== Infinity && now >= exp) { expired++; continue }   // 衰变 = 删除（优化存储有备份）
      kept.push(it)
    }
    const total = () => kept.reduce((n, i) => n + (Number(i.tokens) || 0), 0)
    let evicted = 0
    let guard = 0
    while (total() > cfg.capacityTokens && kept.length > 1 && guard++ < 5000) {
      kept.sort((a, b) => keepWeight(a, cfg) - keepWeight(b, cfg))
      kept.shift()
      evicted++
    }
    if (expired || evicted) {
      saveVctx(root, { ...v, items: kept })
      appendLine(path.join(paths(root).logs, 'migration.log'), {
        at: nowIso(), type: 'forget', expired, evicted, remain: kept.length, tokens: total(),
      })
    }
    return { expired, evicted, remain: kept.length, tokens: total() }
  } catch {
    return { expired: 0, evicted: 0, error: true }
  }
}

// 兼容旧名
export const evict = forget

// ---------- 检索：虚拟上下文 + 优化存储（打捞） ----------

const STOP = new Set(['的', '了', '是', '在', '和', '就', '都', '也', '我', '你', 'the', 'a', 'is', 'to', 'and'])

// 查询清洗：把"只给答案""不要解释""第几个问题"这类指令词剥掉，
// 只留真正要查的那半句。否则 BM25 会被指令词带偏。
const QUERY_NOISE = /(只给答案|只回答|只回复|不要解释|不用解释|别解释|请回答|回答我|请告诉我|麻烦|请问|谢谢|第[一二三四五六七八九十\d]+个?问题|问题[：:]|question)/gi

export function buildQuery(text) {
  let s = String(text || '').replace(QUERY_NOISE, ' ')
  const parts = s.split(/[，,。.；;！!？?：:\n]/).map((x) => x.trim()).filter(Boolean)
  const last = parts.length ? parts[parts.length - 1] : ''
  const q = last && last.length >= 4 ? last : (s.trim() || String(text || ''))
  return q.replace(/\s+/g, ' ').slice(0, 80)
}

// ---------- 问句实体加权（可关：cfg.entityBoost === false 时完全不生效） ----------
// 解决的错位：用户问「我的狗叫什么名字」，字面匹配到的是"别人问过同样的话"，
// 而不是"一条很丑萌的狗，它叫多宝"这条答案。做法：抽「意图 + 实体」，命中实体+意图的候选加权。
const Q_STOP = new Set(['什么', '怎么', '为什么', '多少', '哪里', '哪儿', '哪个', '哪些', '名字', '样子', '时候', '这个', '那个', '我们', '你们', '他们', '自己', '一下', '可以', '知道', '记得', '告诉', '还有', '之前', '现在'])
const Q_FILLER = /(考考你|请问|告诉我|你知道|帮我|我想问|问你|说一下|记得|还记得|能不能|可不可以)/g
const Q_HINTS = {
  name: /叫什么|什么名字|名字是/,
  where: /在哪|住哪|什么地方|地址|位置/,
  who: /是谁|什么人/,
  when: /什么时候|哪天|几号|几点/,
}
const Q_INTENT_WORD = { name: /叫|名字|称为|称呼/, where: /在|住|地址|地方|位置/, who: /是|身份|叫/, when: /时间|日期|点|天|号/ }
const Q_QUESTION_LIKE = /[?？]\s*$|吗[?？]?\s*$|呢[?？]?\s*$|什么|怎么|为什么|哪/

/** 从问句里抽 { intent, ents }；抽不到就返回空（不参与加权） */
export function queryInfo(query) {
  const q = String(query || '')
  if (!q.trim()) return { intent: '', ents: [] }
  let intent = ''
  for (const [k, re] of Object.entries(Q_HINTS)) if (re.test(q)) { intent = k; break }
  if (!intent) return { intent: '', ents: [] }
  const subj = q.replace(/[?？。，,！!、；;：:"'“”]/g, ' ')
    .replace(/(叫|是)(什么|啥|谁|哪)[\u3400-\u9fff]*/g, ' ')
    .replace(/在(哪|什么)[\u3400-\u9fff]*/g, ' ')
    .replace(new RegExp(Q_FILLER.source, 'g'), ' ')
    .replace(/(我的|你的|他的|她的|我们的|你们的|我|你|他|她)/g, ' ')
  const ents = (subj.match(/[\u3400-\u9fff]{1,6}/g) || [])
    .map((x) => x.trim())
    .filter((x) => x && !Q_STOP.has(x))
  return { intent, ents }
}

/** 候选的加权倍率：命中实体+意图 1.8；只命中实体 1.25；候选本身是问句则不加权 */
export function queryEntityBoostOf(text, info) {
  if (!info || !info.intent || !info.ents || !info.ents.length) return 1
  const t = String(text || '')
  if (Q_QUESTION_LIKE.test(t.trim())) return 1
  if (!info.ents.some((e) => t.includes(e))) return 1
  const re = Q_INTENT_WORD[info.intent]
  return (re && re.test(t)) ? 1.8 : 1.25
}

// 不该进记忆库的东西：插件自己的注入块、诊断日志、运行时上下文、子代理完成通知
const NOISE_PREFIX = /^(【外置记忆】|【记忆·|\[外置记忆\]|<system-reminder>|Current runtime context|The runtime context names|The current working directory|Time sampled while preparing|Elapsed since|DeepSeek Harness Web GUI URL|=== )/
const NOISE_BODY = /(inject\.log|scorer-fallback|"type":"wake"|offline-memory\/sessions|Background subagent|will do no further work|Its closing message|delivered to agent|implementation checkout)/

export function isNoise(text) {
  const t = String(text || '')
  return NOISE_PREFIX.test(t) || NOISE_BODY.test(t)
}

// 实体命中：查询里 3 字以上的中文串整体出现在条目里，说明不是靠通用二元组撞上的
function entityBoost(docText, query) {
  const runs = String(query || '').match(/[\u3400-\u9fff]{3,}/g) || []
  let boost = 1
  for (const r of runs) {
    if (String(docText).includes(r)) boost *= 1.5
    const pre = r.slice(0, 3)
    if (pre !== r && String(docText).includes(pre)) boost *= 1.15
  }
  return Math.min(3, boost)
}

// 命中词：优先最长的中文整串，其次拉丁词；用于注入块的「命中"X"」
function matchedToken(text, query) {
  const t = String(text || '')
  const q = String(query || '')
  for (const run of (q.match(/[\u3400-\u9fff]{2,}/g) || []).sort((a, b) => b.length - a.length)) {
    if (t.includes(run)) return run
  }
  for (const w of (q.match(/[a-z0-9_'-]{2,}/gi) || []).sort((a, b) => b.length - a.length)) {
    if (t.toLowerCase().includes(w.toLowerCase())) return w
  }
  return ''
}

export function tokenize(text) {
  const s = String(text || '').toLowerCase()
  const toks = []
  for (const run of s.match(/[\u3400-\u9fff]+/g) || []) {
    if (run.length === 1) toks.push(run)
    for (let i = 0; i < run.length - 1; i++) toks.push(run.slice(i, i + 2))
  }
  for (const w of s.match(/[a-z0-9_'-]{2,}/g) || []) toks.push(w)
  return toks.filter((t) => !STOP.has(t))
}

export function bm25(docs, query) {
  const q = tokenize(query)
  if (!q.length || !docs.length) return docs.map(() => 0)
  const df = new Map()
  const tfs = docs.map((d) => {
    const tf = new Map()
    for (const t of d.tokens) tf.set(t, (tf.get(t) || 0) + 1)
    for (const t of new Set(d.tokens)) df.set(t, (df.get(t) || 0) + 1)
    return tf
  })
  const avg = docs.reduce((n, d) => n + d.tokens.length, 0) / docs.length || 1
  const N = docs.length
  const k1 = 1.2
  const b = 0.75
  return docs.map((d, i) => {
    let s = 0
    for (const t of q) {
      const f = tfs[i].get(t) || 0
      if (!f) continue
      const n = df.get(t) || 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.tokens.length) / avg)))
    }
    return s
  })
}

/**
 * 打捞：先在虚拟上下文找，再从优化存储补；命中的话重新打分放回虚拟上下文，
 * 并标注「原本生成日期」与「打捞日期」。不回写优化存储。
 */
export function retrieve(root, query, cfg, { limit = 6, revive = true } = {}) {
  try {
    const v = loadVctx(root)
    const inVctx = new Set(v.items.map((i) => i.id))
    const pool = [
      ...v.items.filter((i) => i.kind !== 'persona').map((i) => ({ ...i, _where: 'vctx' })),   // 人设属性不参与检索（单独注入）
      ...readOptimized(root).filter((i) => !inVctx.has(i.id)).map((i) => ({ ...i, _where: 'optimized' })),
      // 图片描述进检索池（私密图不参与检索/注入）
      ...IMG.listImages(root).filter((img) => !img.private).map((img) => ({
        id: img.id, summary: img.desc, at: img.date, score: null, tokens: estTokens(img.desc),
        tags: [img.hash8], role: 'assistant', kind: 'image', _where: 'image', verified: img.verified,
      })),
    ]
    if (!pool.length) return []

    const docs = pool.map((i) => ({ item: i, tokens: tokenize(`${i.summary} ${(i.tags || []).join(' ')}`) }))
    const q = buildQuery(query)
    // 问句实体加权（可关）：只在 cfg.entityBoost !== false 时生效
    const entityInfo = cfg.entityBoost === false ? null : queryInfo(query)
    // 实体图扩展（可关）：问句里的实体，顺着图把别名/一跳邻居带出来（"狗" → "多宝"）
    let graphInfo = null
    if (cfg.graphEnabled !== false) {
      try { graphInfo = G.expandQuery(root, query) } catch { graphInfo = null }
      if (graphInfo && (!graphInfo.terms || !graphInfo.terms.length)) graphInfo = null
      // 图扩展词也要有区分度：超过 graphMaxDf（默认 5%）的泛词直接丢（"主人"这类）
      if (graphInfo && pool.length) {
        const N = pool.length
        const texts = pool.map((x) => String(x.summary || ''))
        const gMaxDf = Number(cfg.graphMaxDf) > 0 ? Number(cfg.graphMaxDf) : 0.05
        graphInfo.terms = graphInfo.terms.filter((t) => {
          let df = 0
          for (const s of texts) { if (s.includes(t)) { df += 1; if (df / N > gMaxDf) return false } }
          return df > 0
        })
        if (!graphInfo.terms.length) graphInfo = null
      }
    }
    // 自动停用：候选实体如果在库里太常见（>30% 条目都含它）或压根不出现，就没有区分度，自动丢掉。
    // 这样静态停用词表只是兜底，日常不用手动维护。
    if (entityInfo && entityInfo.ents.length && pool.length) {
      const N = pool.length
      const texts = pool.map((x) => String(x.summary || ''))
      const maxDf = Number(cfg.entityMaxDf) > 0 ? Number(cfg.entityMaxDf) : 0.3
      const extra = new Set((Array.isArray(cfg.entityStopwords) ? cfg.entityStopwords : []).map((x) => String(x || '').trim()).filter(Boolean))
      entityInfo.ents = entityInfo.ents.filter((e) => {
        if (extra.has(e)) return false
        let df = 0
        for (const t of texts) {
          if (t.includes(e)) { df += 1; if (df / N > maxDf) return false }
        }
        return df > 0
      })
    }
    const raw = bm25(docs, q)
    // 实体加权：把整串出现的名字/地点抬上来，避免被通用二元组淹没
    const scores = raw.map((v, k) => v * entityBoost(docs[k].item.summary, q))
    const max = Math.max(...scores, 0.0001)
    // v2：RRF 混合检索——BM25 基座(0.7) + 向量增强(0.3)；向量不可用时退化纯 BM25
    const vecMap = loadVectorMap(root)
    const qv = V.embed(q)
    const vecScores = pool.map((i) => { const v = vecMap.get(i.id); return v ? V.cosine(qv, v) : 0 })
    const now = Date.now()
    const out = []
    for (let k = 0; k < pool.length; k++) {
      const it = pool[k]
      const rel = scores[k] / max
      const vecRel = vecScores[k] || 0
      // v2：索引模式——hybrid=混合增强(0.7 BM25 + 0.3 向量) | vector=纯向量 | bm25=纯关键词
      const mode = cfg.indexMode || 'hybrid'
      const combined = mode === 'vector' ? vecRel : mode === 'bm25' ? rel : 0.7 * rel + 0.3 * vecRel
      if (combined < 0.05) continue
      const ageDays = Math.max(0, (now - new Date(it.at).getTime()) / DAY)
      const decay = Math.pow(0.5, ageDays / Math.max(1, cfg.halfLifeDays))
      const eMul = entityInfo ? queryEntityBoostOf(it.summary, entityInfo) : 1
      const gMul = (graphInfo && graphInfo.terms.some((x) => String(it.summary || '').includes(x))) ? 1.5 : 1
      const final10 = Math.round(10 * (0.55 * combined + 0.25 * ((Number(it.score) || 0) / 10) + 0.2 * decay) * eMul * gMul * 10) / 10
      out.push({ ...it, rel: Math.round(rel * 1000) / 1000, vecRel: Math.round(vecRel * 1000) / 1000, final10, where: it._where, hit: matchedToken(it.summary, q) })
    }
    out.sort((a, b) => b.final10 - a.final10)
    let picked = out.slice(0, limit)

    // v2：网格化三子级扩展——沿向量邻居扩散，补同网格相关事件
    const expanded = gridExpand(root, picked, cfg, vecMap)
    if (expanded.length) {
      const poolById = new Map(pool.map((i) => [i.id, i]))
      const pickedIds = new Set(picked.map((i) => i.id))
      for (const e of expanded) {
        const item = poolById.get(e.eventId)
        if (item && !pickedIds.has(item.id)) {
          picked.push({
            ...item, viaGrid: true, gridDepth: e.depth, where: item._where,
            rel: Math.max(0.05, Math.round(e.sim * 100) / 100),
            final10: Number(item.score) || 5,
            hit: matchedToken(item.summary, q),
          })
          pickedIds.add(item.id)
        }
      }
    }

    // 成对取回：命中问题时挂上当时的回答；命中回答时挂上问题
    const byRef = new Map()
    for (const it of pool) if (it.refTo) byRef.set(it.refTo, it)
    for (const hh of picked) {
      if (hh.role === 'user') {
        const reply = pool.find((x) => x.replyTo === hh.refTo)
        if (reply) hh.pair = { summary: reply.summary, at: reply.at, id: reply.id, role: reply.role }
      } else if (hh.replyTo) {
        const q = byRef.get(hh.replyTo)
        if (q) hh.pair = { summary: q.summary, at: q.at, id: q.id, role: q.role }
      }
    }

    if (revive) {
      const salvaged = []
      for (const it of picked) {
        if (it.where !== 'optimized') {
          // 已在虚拟上下文：只记一次命中
          const t = v.items.find((x) => x.id === it.id)
          if (t) { t.hitCount = (Number(t.hitCount) || 0) + 1; t.lastHitAt = nowIso() }
          continue
        }
        if (it.rel < cfg.reviveMinRel || it.final10 < cfg.reviveMinFinal) continue
        if (v.items.some((x) => x.id === it.id)) continue
        const item = {
          id: it.id, refTo: it.refTo, at: it.at, summary: it.summary, tokens: it.tokens,
          // v2：打捞重打分按 ±2 浮动，不覆盖原分（重要程度会变，但不剧变）
          score: clampFloat(Number(it.score) || 0, it.final10, Number(cfg.scoreFloatRange) || 2),
          decayDays: decayDaysOf(clampFloat(Number(it.score) || 0, it.final10, Number(cfg.scoreFloatRange) || 2), cfg),
          expiresAt: null, hitCount: 1, lastHitAt: nowIso(),
          origin: 'salvage', originAt: it.originAt || it.at, salvagedAt: nowIso(),
          tags: it.tags || [], role: it.role, event: it.event || null, eventSeq: it.eventSeq ?? null,
        }
        item.expiresAt = item.decayDays === Infinity ? null : new Date(now + item.decayDays * DAY).toISOString()
        v.items.push(item)
        salvaged.push(item.id)
      }
      if (salvaged.length) {
        saveVctx(root, v)
        appendLine(path.join(paths(root).logs, 'migration.log'), { at: nowIso(), type: 'salvage', ids: salvaged })
      }
    }
    return picked
  } catch {
    return []
  }
}

/**
 * 组装注入块（新格式，按 offmem-inject-spec）：
 *   第一行【记忆·不是当前对话】、末行免责声明、每条 [来源·日期｜分N｜命中"X"]
 * entries: [{ id, source, date, score, hit, summary, pair, kind, hitCount }]
 * 返回 { text, used, dropped, kept }
 */
export function composeInjection(entries, budget, prefBudget = 300) {
  const head = '【记忆·不是当前对话】'
  const foot = '（上面是我过去记下的，不是当前对话；用不上就别提，不要复述。若与当前对话冲突，一律以你此刻听到的为准，并明说「我记得的是 X，你现在说的是 Y」。）'
  if (!entries || !entries.length) return { text: '', used: 0, prefUsed: 0, dropped: [], kept: [] }
  let used = estTokens(head) + estTokens(foot)   // 记忆部分消耗（不含偏好）
  let prefUsed = 0                               // 偏好独立预算消耗
  const lines = [head]
  const kept = []
  const dropped = []
  for (const e of entries) {
    const isPersona = e.kind === 'persona' || e.kind === 'migrate'
    const isPref = e.kind === 'pref'   // 偏好：独立预算、固定项，不占记忆预算
    let label = `[${e.source}·${e.date}`
    if (e.remark) label += `｜${e.remark}`
    if (e.score != null) label += `｜分${e.score}`
    if (e.hit) label += `｜命中"${e.hit}"`
    if (e.locator) label += `｜${e.locator}`
    label += ']'
    let summary = String(e.summary || '').replace(/\s+/g, ' ').trim()
    // 人设/偏好：独立内容，不截断、不参与记忆注入预算
    if (!isPersona && !isPref && summary.length > 120) summary = summary.slice(0, 120) + '…'
    let line = `- ${label} ${summary}`
    if (e.pair) line += `（我的转述，非原话：${String(e.pair).replace(/\s+/g, ' ').slice(0, 60)}）`
    const t = estTokens(line)
    if (isPref) {
      if (prefUsed + t > prefBudget) {
        dropped.push({ id: e.id, reason: '偏好超预算', tokens: t })
        continue
      }
      prefUsed += t
    } else if (!isPersona && used + t > budget) {
      dropped.push({ id: e.id, reason: '超预算', tokens: t })
      continue
    } else {
      used += t
    }
    lines.push(line)
    kept.push({
      id: e.id, source: e.source, date: e.date, score: e.score ?? null,
      reason: e.hit ? `命中"${e.hit}"` : (e.kind === 'file' ? '最近一天' : ''),
      locator: e.locator || null,
      chars: summary.length, tokens: t, state: e.kind || 'active', hitCount: e.hitCount ?? 0,
    })
  }
  if (!kept.length) return { text: '', used: 0, prefUsed: 0, dropped, kept: [] }
  lines.push(foot)
  return { text: lines.join('\n'), used: used + prefUsed, prefUsed, dropped, kept }
}

// ---------- 读档：把别的智能体/会话的档接到当前会话 ----------

export function importArchive(targetRoot, sourceRoot, cfg, { limit = 500, deep = true, targetSessionId = '' } = {}) {
  try {
    ensureLayout(targetRoot)
    const target = loadVctx(targetRoot)
    const have = new Set(target.items.map((i) => i.id))
    const opt = readOptimized(sourceRoot)
    const seenSrc = new Set(opt.map((x) => x.id))
    const src = [...opt, ...loadVctx(sourceRoot).items.filter((x) => !seenSrc.has(x.id))]
    let n = 0
    let deepJournal = 0
    let deepOptimized = 0
    // 深度读档：覆盖底层 + 优化存储（否则只覆盖虚拟上下文，不算是读档）
    if (deep) {
      for (const j of readJournal(sourceRoot)) {
        const r = appendJournal(targetRoot, {
          sessionId: targetSessionId || j.sessionId, role: j.role, text: j.text,
          at: j.at, turnIndex: j.turnIndex ?? 0, origin: 'import', seq: j.seq,
        })
        if (r.ok && !r.dup) deepJournal++
      }
      for (const o of readOptimized(sourceRoot)) {
        if (appendOptimized(targetRoot, { ...o, origin: 'import', originAt: o.originAt || o.at, salvagedAt: nowIso() })) deepOptimized++
      }
    }
    for (const it of src.slice(-limit)) {
      if (have.has(it.id)) continue
      target.items.push({
        ...it,
        origin: 'import',
        originAt: it.originAt || it.at,
        salvagedAt: nowIso(),
        salvagedFrom: path.basename(sourceRoot),
        hitCount: 0,
        lastHitAt: null,
      })
      have.add(it.id)
      n++
    }
    if (n) saveVctx(targetRoot, target)
    return { imported: n, deepJournal, deepOptimized, sourceTotal: src.length }
  } catch (e) {
    return { imported: 0, error: String(e && e.message) }
  }
}

// ---------- 管理存档：用量 / 清理 ----------

export function storeUsage(root) {
  const p = ensureLayout(root)
  // 先读 vctx：首次调用可能触发 v1→v2 迁移，迁移会补写优化存储，晚读就拿不到新行
  const v = loadVctx(root)
  const jsize = (() => {
    try {
      let n = 0
      for (const f of fs.readdirSync(p.journal)) if (f.endsWith('.jsonl')) n += fs.statSync(path.join(p.journal, f)).size
      return n
    } catch { return 0 }
  })()
  const osize = (() => { try { return fs.statSync(p.optimized).size } catch { return 0 } })()
  const vs = (() => { try { return fs.statSync(p.vctx).size } catch { return 0 } })()
  const oCount = readJsonl(p.optimized).length
  return {
    base: { bytes: jsize, files: (() => { try { return fs.readdirSync(p.journal).filter((f) => f.endsWith('.jsonl')).length } catch { return 0 } })(), path: p.journal, items: readJournal(root).length },
    optimized: { bytes: osize, files: osize ? 1 : 0, path: p.optimized, items: oCount },
    vctx: { bytes: vs, files: vs ? 1 : 0, path: p.vctx, items: v.items.length, tokens: v.items.reduce((n, i) => n + (Number(i.tokens) || 0), 0) },
    snapshots: { bytes: dirSize(p.snapshots), path: p.snapshots },
  }
}

/** 清理：按"清理多久之前"删数据。scope = base | optimized */
export function cleanStore(root, scope, beforeDays, cfg) {
  try {
    const p = ensureLayout(root)
    const cutoff = Date.now() - Math.max(0, Number(beforeDays) || 0) * DAY
    let removed = 0
    let bytes = 0
    if (scope === 'base') {
      const segs = fs.readdirSync(p.journal).filter((f) => /^seg-\d+\.jsonl$/.test(f))
      for (const f of segs) {
        const full = path.join(p.journal, f)
        const rows = readJsonl(full)
        const keep = rows.filter((r) => new Date(r.at).getTime() >= cutoff)
        removed += rows.length - keep.length
        if (removed > 0) {
          const before = fs.statSync(full).size
          writeTextAtomic(full, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''))
          const after = (() => { try { return fs.statSync(full).size } catch { return 0 } })()
          bytes += Math.max(0, before - after)
          // seen.txt 同步，避免删掉后又被当成已存档
          if (!keep.length) { try { fs.rmSync(full) } catch {} }
        }
      }
      const remaining = readJournal(root)
      const seen = seenFor(p)
      seen.clear()
      for (const r of remaining) if (r.hash) seen.add(r.hash)
      writeTextAtomic(p.seen, [...seen].join('\n') + (seen.size ? '\n' : ''))
    } else if (scope === 'optimized') {
      const rows = readJsonl(p.optimized)
      const keep = rows.filter((r) => new Date(r.originAt || r.at).getTime() >= cutoff)
      removed = rows.length - keep.length
      const before = (() => { try { return fs.statSync(p.optimized).size } catch { return 0 } })()
      writeTextAtomic(p.optimized, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''))
      const after = (() => { try { return fs.statSync(p.optimized).size } catch { return 0 } })()
      bytes = Math.max(0, before - after)
      // 虚拟上下文里指向已删备份的条目也一并清掉（否则会留下无法打捞的悬空记忆）
      if (removed) {
        const ids = new Set(keep.map((r) => r.id))
        const v = loadVctx(root)
        const before2 = v.items.length
        v.items = v.items.filter((i) => ids.has(i.id) || i.origin === 'from')
        if (v.items.length !== before2) saveVctx(root, v)
      }
    }
    appendLine(path.join(p.logs, 'events.log'), { at: nowIso(), type: 'clean', scope, beforeDays, removed, bytes })
    return { ok: true, scope, removed, bytes }
  } catch (e) {
    return { ok: false, error: String(e && e.message) }
  }
}

// 清空会话的派生存储（journal/seen/manifest/optimized/vctx/vectors/pending + 重置 bootstrap），
// 供"重建"用：原始会话日志（源真相）不受影响，清空后重新 bootstrap 即可从源重跑一遍。
// 用途：清除历史污染（如 reasoning 被当正文存进底层）后重建，不破坏原始记录完整性。
export function clearStore(root) {
  try {
    const p = ensureLayout(root)
    let removed = 0
    const files = [p.seen, p.manifest, p.optimized, p.vctx, p.vectors, p.pending]
    for (const f of files) {
      if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed++ }
    }
    if (fs.existsSync(p.journal)) {
      for (const f of fs.readdirSync(p.journal)) {
        if (f.endsWith('.jsonl')) { fs.rmSync(path.join(p.journal, f), { force: true }); removed++ }
      }
    }
    // 图片记忆（pics）是独立存储，不属于污染范围，保留
    writeJsonAtomic(p.bootstrap, { status: 'pending', cursor: 0, turns: 0, bytes: 0, attempts: 0 })
    seenCache.delete(root)
    return { ok: true, removed }
  } catch (e) {
    return { ok: false, error: String(e && e.message) }
  }
}

// 从原始会话日志重建底层存储（只写 journal，跳过 reasoning/system/噪音，不写 optimized/vctx）
export async function rebuildBaseFromLog(root, dshHome, sessionId, onProgress) {
  try {
    let file = null
    if (fs.existsSync(path.join(dshHome, 'sessions'))) {
      for (const w of fs.readdirSync(path.join(dshHome, 'sessions'))) {
        const f = path.join(dshHome, 'sessions', w, sessionId, 'session.v4.jsonl.zstd')
        if (fs.existsSync(f)) { file = f; break }
      }
    }
    if (!file) return { ok: false, error: '找不到原始会话日志' }
    const { messages, failed } = readSessionMessages(file)
    clearStore(root)
    let added = 0
    let skipped = 0
    let lastUserId = null
    let done = 0
    const total = messages.length
    for (const m of messages) {
      done++
      if (onProgress) { try { onProgress({ done, total, added, skipped }) } catch {} }
      if (m.role === 'system') { skipped++; continue }
      const text = String(m.text || '').trim()
      if (!text) { skipped++; continue }
      const r = appendJournal(root, {
        sessionId, role: m.role, text, at: new Date(m.at).toISOString(),
        turnIndex: m.turn ?? 0, origin: 'bootstrap', seq: m.seq,
        refs: m.role === 'assistant' && lastUserId ? { replyTo: lastUserId } : null,
      })
      if (r.ok && !r.dup) { added++; if (m.role === 'user') lastUserId = r.item.id }
      else skipped++
    }
    return { ok: true, added, skipped, failed }
  } catch (e) {
    return { ok: false, error: String(e && e.message) }
  }
}

// 跨平台建档：解析文件文本为 Q&A 对，写入底层 journal（覆盖：清空派生存储后重建底层）
export function importQA(root, sessionId, text) {
  try {
    const pairs = parseQA(text)
    if (!pairs.length) return { ok: false, error: '没解析出 Q&A' }
    clearStore(root)
    let added = 0
    let lastUserId = null
    let seq = 0
    const at = nowIso()
    for (const [q, a] of pairs) {
      const r1 = appendJournal(root, { sessionId, role: 'user', text: String(q), at, turnIndex: 0, origin: 'import', seq: ++seq })
      if (r1.ok && !r1.dup) { added++; lastUserId = r1.item.id }
      const r2 = appendJournal(root, { sessionId, role: 'assistant', text: String(a || ''), at, turnIndex: 0, origin: 'import', seq: ++seq, refs: lastUserId ? { replyTo: lastUserId } : null })
      if (r2.ok && !r2.dup) added++
    }
    return { ok: true, added, pairs: pairs.length }
  } catch (e) {
    return { ok: false, error: String(e && e.message) }
  }
}

// 人设属性：独立内容，合并到虚拟上下文但不参与容量/衰变/索引，分数固定 10
export function upsertPersona(root, text) {
  try {
    const v = loadVctx(root)
    const id = 'persona'
    const item = {
      id, refTo: null, seq: null, at: nowIso(),
      summary: String(text || ''), tokens: 0, score: 10, decayDays: Infinity, expiresAt: null,
      hitCount: 0, lastHitAt: null, origin: 'persona', originAt: nowIso(), salvagedAt: null,
      tags: [], role: 'system', kind: 'persona', important: false,
    }
    v.items = v.items.filter((i) => i.id !== id).concat(item)
    saveVctx(root, v)
    return true
  } catch { return false }
}

export function getPersona(root) {
  try {
    const v = loadVctx(root)
    const it = v.items.find((i) => i.id === 'persona')
    if (it && String(it.summary || '').trim()) return String(it.summary)
    // 回退：vctx 里没有（比如重建过），从 persona.md 读
    const file = path.join(root, 'persona.md')
    if (fs.existsSync(file)) { const t = fs.readFileSync(file, 'utf8').trim(); if (t) return t }
    return ''
  } catch { return '' }
}

// ---------- 外部源（日记等）：每个会话独立 ----------
export function loadSources(root) {
  try {
    const j = readJson(path.join(root, 'sources.json'), null)
    return (j && Array.isArray(j.items)) ? j.items : []
  } catch { return [] }
}

export function saveSources(root, items) {
  try { writeJsonAtomic(path.join(root, 'sources.json'), { version: 1, items: Array.isArray(items) ? items : [], updatedAt: nowIso() }) } catch {}
}

// 偏好库（方案 B）：独立、稳定、可校准
export function loadPrefs(root) {
  try {
    const j = readJson(path.join(root, 'prefs.json'), null)
    if (j && Array.isArray(j.items)) return { version: 1, items: j.items }
    return { version: 1, items: [] }
  } catch { return { version: 1, items: [] } }
}

export function savePrefs(root, j) {
  try { writeJsonAtomic(path.join(root, 'prefs.json'), { version: 1, items: j.items || [], updatedAt: nowIso() }) } catch {}
}

export function addPref(root, text) {
  try {
    const t = String(text || '').replace(/\s+/g, ' ').trim()
    if (!t) return { ok: false, why: '内容为空' }
    const j = loadPrefs(root)
    const id = 'p-' + sha256(t).slice(0, 12)
    if (j.items.some((x) => x.id === id || x.text === t)) return { ok: true, dup: true, id }
    j.items.push({ id, text: t.slice(0, 160), at: nowIso(), status: 'active' })
    savePrefs(root, j)
    return { ok: true, id }
  } catch (e) { return { ok: false, why: String(e && e.message) } }
}

export function removePref(root, key) {
  try {
    const k = String(key || '').trim()
    if (!k) return { ok: false, why: '缺少 id 或内容' }
    const j = loadPrefs(root)
    const before = j.items.length
    j.items = j.items.filter((x) => x.id !== k && x.text !== k)
    if (j.items.length !== before) savePrefs(root, j)
    return { ok: true, removed: before - j.items.length }
  } catch (e) { return { ok: false, why: String(e && e.message) } }
}

// 人设内容指纹：以 persona.md 文件为唯一真相，算 mtime/size/hash8（SHA-256 前 8 位）
export function personaFileState(root) {
  try {
    const file = path.join(root, 'persona.md')
    if (!fs.existsSync(file)) return { text: '', mtime: null, size: 0, hash8: '', chars: 0, exists: false }
    const text = fs.readFileSync(file, 'utf8')
    const st = fs.statSync(file)
    return {
      text, mtime: new Date(st.mtimeMs).toISOString(), size: st.size,
      hash8: sha256(text).slice(0, 8), chars: text.length, exists: true,
    }
  } catch { return { text: '', mtime: null, size: 0, hash8: '', chars: 0, exists: false } }
}

// 落盘人设指纹状态（只留最新一份）
export function savePersonaState(root, state) {
  try {
    const dir = path.join(root, 'state')
    ensureDir(dir)
    writeJsonAtomic(path.join(dir, 'persona.json'), state)
  } catch {}
}

// 标记"已注入"：一条内容只注入一次（除非开了「允许重复注入」）
// vctx 条目靠 injectedAt；优化存储里的条目没有 injectedAt，另记一份 id 清单兜底
export function markInjected(root, ids) {
  try {
    const v = loadVctx(root)
    const set = new Set(ids)
    let changed = false
    for (const it of v.items) {
      if (set.has(it.id) && !it.injectedAt) { it.injectedAt = nowIso(); changed = true }
    }
    if (changed) saveVctx(root, v)
    const file = path.join(root, 'injected-ids.json')
    const map = readJson(file, {})
    const at = nowIso()
    let dirty = false
    for (const id of ids) if (id && !map[id]) { map[id] = at; dirty = true }
    if (dirty) writeJsonAtomic(file, map)
  } catch {}
}

// 已注入过的条目 id（含优化存储里的那些，靠 injected-ids.json）
// 带时间窗：只在窗口内算"刚注过"，过了窗口还能再注入（否则长期记忆就永远出不来）
export function loadInjectedIds(root, ttlHours = 24) {
  try {
    const map = readJson(path.join(root, 'injected-ids.json'), {}) || {}
    const hours = Math.max(0.1, Number(ttlHours) || 24)
    const cutoff = Date.now() - hours * 3600000
    const set = new Set()
    for (const [id, at] of Object.entries(map)) {
      const t = Date.parse(String(at || ''))
      if (!t || t >= cutoff) set.add(id)
    }
    return set
  } catch { return new Set() }
}

// 内容级注入去重：同一段文字（不管来自 vctx / optimized、不管身份戳怎么变）在窗口期内只注入一次
export function loadInjectedHashes(root, ttlDays = 7) {
  try {
    const map = readJson(path.join(root, 'injected.json'), {})
    const cutoff = Date.now() - (Math.max(1, Number(ttlDays) || 7) * 86400000)
    const set = new Set()
    for (const [h, at] of Object.entries(map || {})) {
      const t = Date.parse(String(at || ''))
      if (!t || t >= cutoff) set.add(h)
    }
    return set
  } catch { return new Set() }
}
export function markInjectedHashes(root, hashes) {
  try {
    if (!hashes || !hashes.length) return
    const file = path.join(root, 'injected.json')
    const map = readJson(file, {})
    const at = nowIso()
    let changed = false
    for (const h of hashes) { if (h && !map[h]) { map[h] = at; changed = true } }
    if (changed) writeJsonAtomic(file, map)
  } catch {}
}

// 存档迁移：主人点按钮 → 选携带清单 → 复制数据 → 智能体补写备注
export const MIGRATE_ITEMS = [
  ['journal', '底层原文'],
  ['optimized', '优化存储'],
  ['vctx', '虚拟上下文'],
  ['persona', '人设'],
  ['pics', '图片记忆'],
  ['prefs', '偏好库'],
  ['sources', '外部源（日记等）'],
  ['graph', '实体图'],
  ['stickers', '表情包'],
]

/** 按清单把数据复制到目标目录，返回每一项是否成功 */
export function exportArchive(root, targetDir, items) {
  const p = paths(root)
  const picked = new Set(Array.isArray(items) && items.length ? items : MIGRATE_ITEMS.map((x) => x[0]))
  const out = {}
  const cp = (src, dst) => {
    try {
      if (!fs.existsSync(src)) return false
      // 先清掉目标（否则重复迁移到同一目录时会嵌套成 journal/journal）
      try { fs.rmSync(dst, { recursive: true, force: true }) } catch {}
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.cpSync(src, dst, { recursive: true, force: true })
      return true
    } catch { return false }
  }
  if (picked.has('journal')) out.journal = cp(p.journal, path.join(targetDir, 'journal'))
  if (picked.has('optimized')) out.optimized = cp(p.optimized, path.join(targetDir, 'optimized.jsonl'))
  if (picked.has('vctx')) out.vctx = cp(p.vctx, path.join(targetDir, 'vctx.json'))
  if (picked.has('persona')) out.persona = cp(path.join(root, 'persona.md'), path.join(targetDir, 'persona.md'))
  if (picked.has('pics')) out.pics = cp(path.join(root, 'pics'), path.join(targetDir, 'pics'))
  if (picked.has('prefs')) out.prefs = cp(path.join(root, 'prefs.json'), path.join(targetDir, 'prefs.json'))
  if (picked.has('sources')) out.sources = cp(path.join(root, 'sources.json'), path.join(targetDir, 'sources.json'))
  if (picked.has('graph')) out.graph = cp(path.join(root, 'graph'), path.join(targetDir, 'graph'))
  if (picked.has('stickers')) out.stickers = cp(path.join(root, 'stickers'), path.join(targetDir, 'stickers'))
  return out
}

export function setMigrateRequest(root, targetDir, items) {
  try {
    writeJsonAtomic(path.join(root, 'migrate-request.json'), {
      targetDir, pending: true, at: nowIso(),
      items: Array.isArray(items) && items.length ? items : MIGRATE_ITEMS.map((x) => x[0]),
    })
    return true
  } catch { return false }
}
export function getMigrateRequest(root) {
  try { return readJson(path.join(root, 'migrate-request.json'), null) } catch { return null }
}
export function clearMigrateRequest(root) {
  try { fs.rmSync(path.join(root, 'migrate-request.json'), { force: true }) } catch {}
}
export function setMigratePending(root, pending) {
  try {
    const req = readJson(path.join(root, 'migrate-request.json'), null)
    if (!req) return
    req.pending = pending
    writeJsonAtomic(path.join(root, 'migrate-request.json'), req)
  } catch {}
}

export function snapshot(root, { keep = 5 } = {}) {
  try {
    const p = ensureLayout(root)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = path.join(p.snapshots, stamp)
    ensureDir(dir)
    for (const f of [p.vctx, p.optimized, p.meta]) {
      if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, path.basename(f)))
    }
    const all = fs.readdirSync(p.snapshots).filter((d) => !d.startsWith('.')).sort()
    for (const old of all.slice(0, Math.max(0, all.length - keep))) {
      try { fs.rmSync(path.join(p.snapshots, old), { recursive: true, force: true }) } catch {}
    }
    return dir
  } catch { return null }
}

export function rollback(root) {
  try {
    const p = ensureLayout(root)
    const all = fs.readdirSync(p.snapshots).filter((d) => !d.startsWith('.')).sort()
    if (!all.length) return null
    const dir = path.join(p.snapshots, all[all.length - 1])
    for (const name of ['vctx.json', 'optimized.jsonl', 'meta.json']) {
      const src = path.join(dir, name)
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(root, name))
    }
    appendLine(path.join(p.logs, 'events.log'), { at: nowIso(), type: 'rollback', from: all[all.length - 1] })
    return dir
  } catch { return null }
}

export function stats(root) {
  try {
    const p = ensureLayout(root)
    const v = loadVctx(root)
    const u = storeUsage(root)
    const now = Date.now()
    const soon = v.items.filter((i) => i.expiresAt && new Date(i.expiresAt).getTime() - now < DAY).length
    return {
      baseItems: u.base.items,
      optimizedItems: u.optimized.items,
      vctxItems: v.items.length,
      vctxTokens: u.vctx.tokens,
      expiringToday: soon,
      salvaged: v.items.filter((i) => i.origin === 'salvage').length,
      bytes: dirSize(root),
      usage: u,
      mood: readJson(p.mood, { value: 70 }),
      affection: readJson(p.affection, { value: 0 }),
      traits: readJson(p.traits, { axes: {}, alignment: { order: 0, moral: 0 } }),
      qaSamples: readJsonl(p.qa).length,
      bootstrap: readJson(p.bootstrap, { status: 'pending' }),
      snapshots: (() => { try { return fs.readdirSync(p.snapshots).length } catch { return 0 } })(),
    }
  } catch { return { error: true } }
}

export { dirSize }
