// dsh-offline-memory v1.3 · 宿主侧
// 关键变更：
//  · 总开关 = 总闸门：关闭时不订阅任何事件/定时器（只有设置页路由活着），
//    出故障也不会卡住任何会话的链路。
//  · 只处理开启存档的会话：事件是进程级的，但每条都先 O(1) 命中缓存注册表再决定。
//  · 测试模式：所有数据写入独立沙箱 .test-sandbox/，不碰真实会话；关闭即清空沙箱。
import fs from 'node:fs'
import path from 'node:path'
import * as C from './config.mjs'
import * as S from './store.mjs'
import * as B from './bootstrap.mjs'
import * as SC from './scoring.mjs'
import * as ST from './selftest.mjs'
import * as DIARY from './diary.mjs'
import * as IMG from './image.mjs'
import * as STICKER from './sticker.mjs'
import * as G from './graph.mjs'
import { makeLogger, ensureDir, nowIso, appendLine, readJson, writeJsonAtomic, sha256 } from './util.mjs'
import { registerRoutes } from './api.mjs'

export const name = 'offline-memory'
export const inject = ['systemPrompt', 'agents', 'webServer', 'tools']

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
const DATA_ROOT = path.join(DSH_HOME, 'offline-memory')
const TEST_ROOT = path.join(DATA_ROOT, '.test-sandbox')

const textOf = (msg) => {
  try {
    const m = msg && msg.message ? msg.message : msg
    if (!m) return ''
    const c = m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      // 只取正文块：跳过 reasoning（模型思考）和 tool 调用，确保存的是原文/最终回复，
      // 而不是模型的转述或推理摘要
      return c
        .filter((b) => {
          if (!b) return false
          const t = b.type
          if (t === 'reasoning' || t === 'tool-call' || t === 'tool-removal' || t === 'tool-addition') return false
          return typeof b.text === 'string'
        })
        .map((b) => b.text || '')
        .join('')
    }
    return typeof m.text === 'string' ? m.text : ''
  } catch { return '' }
}
const sidOf = (agent) => {
  try { return String(agent?.sessionId || agent?.session?.id || '') } catch { return '' }
}

const mins = (hhmm) => {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
const inWindow = (now, start, end) => {
  const a = mins(start), b = mins(end)
  if (a === null || b === null) return true
  const cur = now.getHours() * 60 + now.getMinutes()
  return a <= b ? (cur >= a && cur <= b) : (cur >= a || cur <= b)
}

export function apply(ctx) {
  ensureDir(DATA_ROOT)
  const log = makeLogger(DATA_ROOT)

  let cfg = C.loadConfig(DATA_ROOT)
  // 数据根：测试模式下用沙箱，其余用真实目录；config.json 永远在真实目录
  const activeRoot = () => (cfg.testMode ? TEST_ROOT : DATA_ROOT)

  const lastUser = new Map()
  const lastInject = new Map()
  const personaStamp = new Map()   // sid -> { key, ts } 人设按需注入
  const stickerTurns = new Map()   // sid -> 当前轮次（表情包限流用）
  const diaryWarned = new Set()     // 外部源告警去重（每个原因只报一次）
  const mounted = new Map()
  const bootQueue = []
  const booting = new Set()
  let waking = false
  let hooks = []
  let regCache = { root: '', at: 0, data: null }
  const replayQueue = new Map()   // sid -> 要重放的整块文本

  const registry = () => {
    const r = activeRoot()
    if (regCache.root !== r || !regCache.data || Date.now() - regCache.at > 5000) {
      regCache = { root: r, at: Date.now(), data: C.loadRegistry(r) }
    }
    return regCache.data
  }
  const invalidateReg = () => { regCache = { root: '', at: 0, data: null } }
  const rootOf = (entry) => C.sessionRoot(activeRoot(), entry.key)
  const entryOf = (sid) => C.findSession(registry(), sid)
  const logEvent = (obj) => appendLine(path.join(activeRoot(), 'events.log'), { at: nowIso(), ...obj })

  const scorerFor = () => {
    const llm = (() => { try { return ctx.get('llm') } catch { return undefined } })()
    const sel = SC.resolveModel(cfg, {
      defaultModel: () => { try { return ctx.get('agentDefaultModel')?.currentSelection?.() } catch { return null } },
    })
    return async (text, role) => {
      const r = await SC.scoreText(text, role, cfg, { llm, provider: sel.provider, model: sel.model })
      if (r.subject === 'hosted-fallback') logEvent({ type: 'scorer-fallback', error: String(r.error || '').slice(0, 200) })
      return r.score
    }
  }

  // ---------- 注入 ----------
  // 精确去重：摘要/成对回答/关键中文片段是否已出现在当前上下文里
  function ctxHas(ctxText, summary, pairSummary) {
    if (!ctxText) return false
    const s = String(summary || '').replace(/\s+/g, ' ').trim()
    if (s && ctxText.includes(s)) return true
    const p = pairSummary && String(pairSummary).replace(/\s+/g, ' ').trim()
    if (p && ctxText.includes(p)) return true
    const runs = s.match(/[\u3400-\u9fff]{4,}/g) || []
    for (const r of runs) if (ctxText.includes(r)) return true
    return false
  }

  // 组装一次注入块（不落盘、不记 lastInject）：记忆按需取，去重 + 单次注入
  function buildBlock(sid, query, ctxText, opts = {}) {
    const dry = opts.dryRun === true
    const entry = entryOf(sid)
    const root = rootOf(entry)
    const items = query ? S.retrieve(root, query, cfg, { limit: Math.max(4, Number(cfg.retrieveLimit) || 10) }) : []
    const entries = []
    // 重复注入开关：关（默认）= 同一条内容只注入一次（v2.1.0 行为）；开 = 允许反复出现
    const repeat = cfg.repeatInject === true
    // 已注入过的条目 id（vctx 靠 injectedAt，优化存储靠这份清单）——只在时间窗内算"刚注过"
    const dedupHours = Number(cfg.injectDedupHours) || 24
    const injectedIds = repeat ? new Set() : S.loadInjectedIds(root, dedupHours)
    const dedupCutoff = Date.now() - dedupHours * 3600000
    // 人设属性：按需注入（更新后 / 上下文缺失 / 周期），内容指纹可核对
    let personaInfo = { injected: false, hash8: null, mtime: null, chars: 0, source: 'none', reason: 'none' }
    let personaMarker = ''
    try {
      const pf = S.personaFileState(root)
      if (pf.exists && pf.text) {
        personaInfo = { injected: false, hash8: pf.hash8, mtime: pf.mtime, chars: pf.chars, source: 'file', reason: 'unchanged' }
        const last = personaStamp.get(sid)
        const days = Number(cfg.personaInjectDays) || 0
        // 只在「人设文件变了」或「本次加载还没注入过」或「周期到」时注入；
        // 不再用"消息里有没有"判断（人设只进系统提示、不进消息历史，会导致每轮都判"缺失"而反复注入）
        const updated = !last || last.key !== pf.hash8
        const periodic = days > 0 && last && (Date.now() - last.ts) > days * 86400000
        if (updated || periodic) {
          entries.push({
            id: 'persona', source: '人设', date: String(new Date().toISOString()).slice(0, 10),
            remark: '人设修正·不是当前对话', locator: null, score: 10, hit: '', summary: pf.text, pair: null, kind: 'persona',
          })
          if (!dry) personaStamp.set(sid, { key: pf.hash8, ts: Date.now() })
          personaInfo.injected = true
          personaInfo.reason = updated ? 'updated' : 'periodic'
          personaMarker = `（人设：${pf.chars} 字 · 指纹 ${pf.hash8} · ${String(pf.mtime).slice(0, 16).replace('T', ' ')}）`
        }
      }
      S.savePersonaState(root, { at: nowIso(), mtime: pf.mtime, size: pf.size, hash8: pf.hash8, injected: personaInfo.injected, reason: personaInfo.reason })
    } catch {}
    // 存档迁移：主人勾选清单后，数据已复制；这里注入一次性提示让智能体补写说明
    try {
      const req = S.getMigrateRequest(root)
      if (req && req.pending) {
        const labels = { journal: '底层原文', optimized: '优化存储', vctx: '虚拟上下文', persona: '人设', pics: '图片记忆', prefs: '偏好库', sources: '外部源', graph: '实体图', stickers: '表情包' }
        const carried = (req.items || []).map((k) => labels[k] || k).join('、') || '（未选）'
        entries.push({
          id: 'migrate', source: '迁移', date: String(new Date().toISOString()).slice(0, 10),
          remark: '存档迁移·待处理', locator: null, score: 10, hit: '',
          summary: `主人刚做了一次「存档迁移」，目标目录：${req.targetDir}。已按清单复制：${carried}。请用 archive_migrate 工具补写一份「迁移说明.md」，逐项说明每个文件的用途和注意事项（没有重要内容可空置）。`,
          pair: null, kind: 'migrate',
        })
      }
    } catch {}
    // 外部源（日记等文件级底座）：每个会话独立，每次注入最近 N 天摘要，受预算约束，不参与内容去重
    try {
      for (const src of S.loadSources(root)) {
        if (src.enabled === false) continue
        const file = DIARY.resolveSourcePath(DSH_HOME, src)
        if (!file) continue
        if (!fs.existsSync(file)) {
          const k = 'missing|' + file
          if (!diaryWarned.has(k)) { diaryWarned.add(k); log('外部源已启用但文件不存在：' + file) }
          continue
        }
        let days = []
        try {
          days = DIARY.readDiary(file, Number(src.recentDays) || 3, Number(src.maxChars) || 400, (info) => {
            const k = info.why + '|' + file
            if (diaryWarned.has(k)) return
            diaryWarned.add(k)
            if (info.why === 'no-headings') log('外部源解析不出任何二级标题：' + file)
            else if (info.why === 'no-dates') log('外部源有 ' + info.headings + ' 个二级标题，但没有一个带 YYYY-MM-DD 日期：' + file)
            else if (info.why === 'out-of-window') log('外部源有 ' + info.sections + ' 段，但都不在最近 ' + info.days + ' 天内（最新 ' + info.newest + '）：' + file)
            else log('外部源读取失败（' + info.why + '）：' + file + (info.error ? ' — ' + info.error : ''))
          })
        } catch { days = [] }
        for (const d of days) {
          if (!d || !d.text) continue
          entries.push({
            id: 'ext:' + src.id + ':' + d.date,
            source: src.kind || '日记',
            date: d.date,
            remark: src.label ? ('外部源·' + src.label) : '外部源',
            locator: null, score: null, hit: '',
            summary: d.text, pair: null, kind: 'file',
          })
        }
      }
    } catch {}
    // 偏好块：独立偏好库，稳定注入（不参与内容去重，可校准）
    if (cfg.prefInject !== false) {
      try {
        const prefs = S.loadPrefs(root).items.filter((x) => x.status !== 'retired')
        const max = Math.max(1, Number(cfg.prefCount) || 12)
        for (const p of prefs.slice(-max)) {
          if (!p || !p.text) continue
          entries.push({
            id: p.id, source: '偏好', date: String(p.at || '').slice(0, 10),
            remark: '偏好校准', locator: null, score: null, hit: '',
            summary: p.text, pair: null, kind: 'pref',
          })
        }
      } catch {}
    }
    // 图片记忆：空查询（warm）时注入最近几张非私密图的文字描述；有查询时图片已由 retrieve 语义召回
    if (!query) {
      try {
        for (const img of IMG.listImages(root).filter((x) => !x.private).slice(-6).reverse()) {
          entries.push({
            id: img.id, source: '图', date: String(img.date || '').slice(0, 10),
            remark: (img.source || '图') + (img.verified === 'suspect' ? '·存疑' : ''),
            locator: '#' + img.hash8, score: null, hit: '',
            summary: img.desc, pair: null, kind: 'image',
          })
        }
      } catch {}
    }
    for (const it of items) {
      if (it.kind === 'image') {
        entries.push({
          id: it.id, source: '图', date: String(it.at || '').slice(0, 10),
          remark: '图' + (it.verified === 'suspect' ? '·存疑' : ''),
          locator: '#' + ((it.tags && it.tags[0]) || ''), score: null,
          hit: '',
          summary: it.summary, pair: null, kind: 'image',
        })
        continue
      }
      // 单次注入：一条内容只注入一次（repeatInject 打开时允许重复出现）
      if (!repeat && ((it.injectedAt && Date.parse(String(it.injectedAt)) >= dedupCutoff) || injectedIds.has(it.id))) continue
      // 精确去重：上下文里已有则不重复注入
      if (ctxHas(ctxText, it.summary, it.pair?.summary)) continue
      const score = Number(it.score) || 0
      const source = it.important === true ? '重要会话' : '存档'
      const date = it.origin === 'salvage'
        ? `${String(it.originAt || it.at).slice(0, 10)}→捞于${String(it.salvagedAt || '').slice(0, 10)}`
        : String(it.at).slice(0, 10)
      entries.push({
        id: it.id, source, date, score: Math.round(score),
        // v2：网格关联项不用"命中词"，改标"网格关联"，与直接命中区分
        hit: it.viaGrid ? '' : (it.hit || ''),
        remark: it.viaGrid ? '网格关联' : undefined,
        summary: it.summary,
        locator: it.seq != null ? '#' + it.seq : (it.refTo ? '#' + it.refTo : null),
        pair: it.pair?.summary || null, kind: 'active', hitCount: it.hitCount ?? 0,
      })
    }
    const r = S.composeInjection(entries, cfg.injectBudget)
    // 人设自查标记：追加到注入块末尾，给智能体看这是哪一版
    if (personaMarker && r.text) r.text = r.text + '\n' + personaMarker
    // 只标记真正注入成功的记忆条目（persona/image/file 不在此列）；dry-run 和"允许重复"模式都不落标记
    const keptIds = (r.kept || []).filter((k) => k.state === 'active').map((k) => k.id)
    if (!dry && !repeat && keptIds.length) S.markInjected(root, keptIds)
    return { ...r, persona: personaInfo, hash: r.text ? sha256(r.text).slice(0, 12) : '' }
  }

  function mountAgent(agent) {
    const sid = sidOf(agent)
    if (!sid || mounted.has(sid)) return
    const offs = []
    try {
      offs.push(agent.ctx.systemPrompt.context({
        name: 'offline-memory',
        order: 910,
        text: () => {
          try {
            const entry = entryOf(sid)
            if (!C.injectEnabled(cfg, entry)) return ''
            // 重放覆盖：复现问题用，原样再注入一次
            const replayed = replayQueue.get(sid)
            if (replayed) { replayQueue.delete(sid); return replayed }
            const last = lastUser.get(sid)
            const msgs = (() => { try { return agent?.session?.messages || agent?.messages || [] } catch { return [] } })()
            const liveQuery = (() => {
              for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i]
                if (m && m.role === 'user') {
                  const t = textOf(m)
                  if (t && t.trim()) return t
                }
              }
              return ''
            })()
            // 当前上下文文本（精确去重比对用）：取末尾若干条拼成归一化文本
            const ctxText = (() => {
              const parts = []
              for (let i = Math.max(0, msgs.length - 12); i < msgs.length; i++) {
                const t = textOf(msgs[i])
                if (t && t.trim()) parts.push(t)
              }
              return parts.join('\n').replace(/\s+/g, ' ')
            })()
            const fp = `${last?.seq ?? 0}|${liveQuery.length}|${liveQuery.slice(-12)}`
            if (lastInject.get(sid) === fp) return ''
            const query = liveQuery || last?.text || ''
            const blk = buildBlock(sid, query, ctxText)
            if (!blk.text) return ''
            lastInject.set(sid, fp)
            appendLine(path.join(activeRoot(), 'inject.log.jsonl'), {
              at: nowIso(), session: sid, trigger: 'auto', budget: cfg.injectBudget, used: blk.used,
              blockHash: blk.hash, preview: blk.text.slice(0,80), text: blk.text, items: blk.kept, dropped: blk.dropped,
              persona: blk.persona,
            })
            return blk.text
          } catch (e) { log('注入失败：' + e.message); return '' }
        },
      }))
      // 表情包速查表：把 ready 的表情包以「id + 标签」注入（可关）
      offs.push(agent.ctx.systemPrompt.context({
        name: 'offline-memory-stickers',
        order: 905,
        text: () => {
          try {
            const entry = entryOf(sid)
            if (!entry || !C.injectEnabled(cfg, entry)) return ''
            return STICKER.injectText(rootOf(entry), cfg)
          } catch { return '' }
        },
      }))
    } catch (e) { log('systemPrompt.context 失败：' + e.message) }
    mounted.set(sid, offs)
  }

  // ---------- 事件处理（只对开启存档/注入的会话做实事） ----------
  const onSessionEvent = (session, event) => {
    try {
      const sid = String(session?.id || session?.sessionId || '')
      if (!sid) return
      // 表情包限流：任何带 data.turn 的事件都记一下当前轮次
      try {
        const tn = Number(event?.data?.turn)
        if (Number.isFinite(tn) && tn > 0) stickerTurns.set(sid, tn)
      } catch {}
      const t = String(event?.type || '')
      // 会话改名：同步到插件注册表，否则设置页的名字一直是旧的
      if (t === 'session/title') {
        const entry = entryOf(sid)
        if (entry) {
          const title = event?.data?.title || event?.data?.message || ''
          if (title && title !== entry.title) { C.updateSession(activeRoot(), sid, { title }); invalidateReg() }
        }
        return
      }
      if (t !== 'user/message' && t !== 'assistant/message') return
      const entry = entryOf(sid)
      if (!C.captureEnabled(cfg, entry)) return
      const d = event.data || {}
      const m = d.message || (d.content ? d : null)
      if (!m) return
      const text = textOf(m)
      if (!text.trim()) return
      const role = m.role || (t === 'user/message' ? 'user' : 'assistant')
      if (role === 'system') return

      const root = rootOf(entry)
      S.ensureLayout(root)
      if (!mounted.has(sid) && entry.inject) {
        try { const ag = ctx.agents?.get?.(sid); if (ag) mountAgent(ag) } catch {}
      }
      const defer = cfg.scorerMode === 'onSave' || cfg.scorerSubject === 'session'
      const res = S.ingestMessages(root, sid, [{ role, text, at: event.time || Date.now(), turn: d.turn, seq: event.seq }], cfg, { defer })
      if (role === 'user' && res.added) lastUser.set(sid, { text, seq: event.seq })
      if (res.added) {
        C.updateSession(activeRoot(), sid, { lastActivityAt: nowIso() })
        invalidateReg()
        if (cfg.scorerMode === 'instant' && cfg.scorerSubject === 'session') {
          const scorer = scorerFor()
          void S.processPending(root, cfg, 1, scorer).catch(() => {})
        }
      }
    } catch (e) { log('采集失败：' + e.message) }
  }

  const onPreStep = (payload, next) => {
    try {
      const ag = payload && payload.agent
      const sid = sidOf(ag)
      if (sid) {
        const entry = entryOf(sid)
        if (entry && entry.inject && cfg.enabled) {
          if (!mounted.has(sid)) mountAgent(ag)
          const msgs = (payload && payload.messages) || []
          for (let i = msgs.length - 1; i >= 0; i--) {
            const t = textOf(msgs[i])
            if (t && t.trim()) { lastUser.set(sid, { text: t, seq: `${payload.turn ?? 0}:${payload.step ?? 0}` }); break }
          }
        }
      }
    } catch (e) { log('pre-step 处理失败：' + e.message) }
    return next()   // waterfall：无条件交回，绝不吞链路
  }

  const onAgentCreated = ({ agent }) => { try { mountAgent(agent) } catch {} }
  const scanAgents = () => { try { for (const a of (ctx.agents?.list?.() || [])) mountAgent(a) } catch {} }

  // ---------- 唤醒 ----------
  async function wake({ manual = false, only = null, reason = 'schedule' } = {}) {
    if (waking) return { ok: false, why: '正在唤醒中' }
    waking = true
    const started = Date.now()
    const report = { at: nowIso(), reason, manual, sessions: [] }
    try {
      const scorer = scorerFor()
      for (const entry of registry().sessions) {
        if (entry.status !== 'attached') continue
        if (only && entry.sessionId !== only) continue
        if (!manual && !entry.capture) continue
        const root = rootOf(entry)
        S.ensureLayout(root)
        let scored = 0
        for (let i = 0; i < 20; i++) {
          const r = await S.processPending(root, cfg, 100, scorer)
          scored += r.done || 0
          if (!r.remaining) break
        }
        const fg = S.forget(root, cfg)
        let save = null
        if (cfg.autoSave || manual) {
          const br = B.runBootstrap(DSH_HOME, root, entry.sessionId, cfg, log)
          S.snapshot(root, { keep: cfg.snapshotKeep })
          save = br?.status || 'skip'
        }
        report.sessions.push({ sessionId: entry.sessionId, scored, expired: fg.expired, evicted: fg.evicted, save })
      }
      writeJsonAtomic(path.join(activeRoot(), 'wake.json'), { lastWakeAt: nowIso(), ms: Date.now() - started, report })
      logEvent({ type: 'wake', ...report })
      log(`唤醒完成：${report.sessions.length} 个会话，${Date.now() - started}ms`)
      return { ok: true, report }
    } catch (e) {
      log('唤醒失败：' + e.message)
      return { ok: false, why: String(e && e.message) }
    } finally {
      waking = false
    }
  }

  const checkWake = () => {
    try {
      const now = new Date()
      if (!inWindow(now, cfg.wakeStart, cfg.wakeEnd)) return
      const w = readJson(path.join(activeRoot(), 'wake.json'), null)
      const last = w?.lastWakeAt ? new Date(w.lastWakeAt).getTime() : 0
      const gapMs = Math.max(0.5, Number(cfg.wakeEveryDays) || 1) * 864e5
      if (!last || Date.now() - last >= gapMs) void wake({ reason: 'schedule' })
    } catch {}
  }

  const tick = () => {
    try {
      scanAgents()
      for (const entry of registry().sessions) {
        if (entry.status !== 'attached') continue
        const root = rootOf(entry)
        const bs = readJson(path.join(root, 'bootstrap.json'), null)
        // bootstrap 失败（如会话日志不落盘）就不再反复重试，避免刷日志
        if (bs?.status !== 'failed') {
          if (entry.bootstrap?.status !== 'done' && bs?.status !== 'done' && !booting.has(entry.sessionId)) {
            if (!bootQueue.includes(entry.sessionId)) bootQueue.push(entry.sessionId)
          } else if (entry.bootstrap?.status !== 'done' && bs?.status === 'done') {
            C.updateSession(activeRoot(), entry.sessionId, { bootstrap: bs })
            invalidateReg()
          }
        }
        S.forget(root, cfg)
        if (cfg.scorerSubject === 'hosted' && S.pendingCount(root) > 0) {
          const scorer = scorerFor()
          void S.processPending(root, cfg, 100, scorer).catch(() => {})
        }
      }
      const next = bootQueue.shift()
      if (next) {
        booting.add(next)
        const entry = entryOf(next)
        if (entry) {
          const r = B.runBootstrap(DSH_HOME, rootOf(entry), next, cfg, log)
          C.updateSession(activeRoot(), next, { bootstrap: readJson(path.join(rootOf(entry), 'bootstrap.json'), {}) })
          invalidateReg()
          logEvent({ type: 'bootstrap', sessionId: next, result: r })
        }
        booting.delete(next)
      }
    } catch (e) { log('tick 失败：' + e.message) }
  }

  function startTimers() {
    const clearFns = []
    const iv = (fn, ms) => { const h = setInterval(fn, ms); if (h && typeof h.unref === 'function') h.unref(); clearFns.push(() => clearInterval(h)) }
    const to = (fn, ms) => { const h = setTimeout(fn, ms); if (h && typeof h.unref === 'function') h.unref(); clearFns.push(() => clearTimeout(h)) }
    iv(() => { try { tick() } catch {} }, 10_000)
    iv(() => { try { checkWake() } catch {} }, 60_000)
    to(() => { try { if (cfg.wakeOnStartup) void wake({ reason: 'startup' }) } catch {} }, 15_000)
    return () => { for (const f of clearFns) { try { f() } catch {} } }
  }

  // ---------- 订阅管理：总开关决定是否监听 ----------
  function registerHooks() {
    if (hooks.length) return
    const offs = []
    try { offs.push(ctx.on('session/event', onSessionEvent)) } catch (e) { log('session/event 订阅失败：' + e.message) }
    try { offs.push(ctx.on('agent/pre-step', onPreStep)) } catch (e) { log('agent/pre-step 订阅失败：' + e.message) }
    try { offs.push(ctx.on('agent/created', onAgentCreated)) } catch (e) { log('agent/created 订阅失败：' + e.message) }
    offs.push(startTimers())
    hooks = offs
    log('已启用：监听与定时器开始工作')
  }

  function disposeHooks() {
    for (const off of hooks) { try { off() } catch {} }
    hooks = []
    for (const offs of mounted.values()) for (const off of offs) { try { off() } catch {} }
    mounted.clear()
    lastUser.clear()
    lastInject.clear()
    personaStamp.clear()
    bootQueue.length = 0
    log('已关闭：监听与定时器全部停止')
  }

  function syncEnabled() {
    cfg = C.loadConfig(DATA_ROOT)
    if (cfg.enabled) registerHooks()
    else disposeHooks()
  }

  // 设置变更（含测试模式开关）
  function applyConfig(next) {
    const prevMode = cfg.testMode
    cfg = next
    invalidateReg()
    if (prevMode && !next.testMode) {
      try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }) } catch {}
      log('测试模式关闭：已清除虚拟测试内容')
    }
    if (!prevMode && next.testMode) ensureDir(TEST_ROOT)
    syncEnabled()
  }

  // ---------- 自测：200 条样本 + 10 组问答，验证清空后能恢复 ----------
  async function runSelftest({ testMode = false, subject = 'hosted', samples = 200 } = {}) {
    const root = testMode ? TEST_ROOT : DATA_ROOT
    ensureDir(root)
    const roundCfg = { ...C.loadConfig(DATA_ROOT), scorerSubject: subject, scorerMode: 'instant' }
    const llm = (() => { try { return ctx.get('llm') } catch { return undefined } })()
    const sel = SC.resolveModel(roundCfg, {
      defaultModel: () => { try { return ctx.get('agentDefaultModel')?.currentSelection?.() } catch { return null } },
    })
    const counter = { session: 0, fallback: 0, hosted: 0 }
    const scorer = async (text, role) => {
      const r = await SC.scoreText(text, role, roundCfg, { llm, provider: sel.provider, model: sel.model })
      if (r.subject === 'session') counter.session++
      else if (r.subject === 'hosted-fallback') counter.fallback++
      else counter.hosted++
      return r.score
    }
    const sid = `selftest-${testMode ? 'test' : 'real'}-${subject}-${Date.now()}`
    const rr = await ST.runRound(root, {
      ...roundCfg,
      sessionId: sid,
      title: `自测·${testMode ? '测试' : '真实'}·${subject === 'session' ? '接管' : '托管'}`,
      messages: ST.buildSample(samples),
    }, scorer, { purge: true })
    return { mode: testMode ? 'test' : 'normal', subject, samples, scoring: counter, ...rr }
  }

  // 记忆恢复矩阵：100 条 Q&A × 3 种索引模式
  async function runRecoveryTest({ subject = 'hosted' } = {}) {
    const root = DATA_ROOT
    ensureDir(root)
    const roundCfg = { ...C.loadConfig(DATA_ROOT), scorerSubject: subject, scorerMode: 'instant' }
    const llm = (() => { try { return ctx.get('llm') } catch { return undefined } })()
    const sel = SC.resolveModel(roundCfg, {
      defaultModel: () => { try { return ctx.get('agentDefaultModel')?.currentSelection?.() } catch { return null } },
    })
    const counter = { session: 0, fallback: 0, hosted: 0 }
    const scorer = async (text, role) => {
      const r = await SC.scoreText(text, role, roundCfg, { llm, provider: sel.provider, model: sel.model })
      if (r.subject === 'session') counter.session++
      else if (r.subject === 'hosted-fallback') counter.fallback++
      else counter.hosted++
      return r.score
    }
    const sid = `recovery-${subject}-${Date.now()}`
    const rr = await ST.runRecoveryMatrix(root, {
      ...roundCfg,
      sessionId: sid,
      title: `恢复测试·${subject === 'session' ? '接管' : '托管'}`,
    }, scorer)
    return { subject, scoring: counter, ...rr }
  }

  // ---------- 控制面（永远在线） ----------
  try {
    registerRoutes(ctx, {
      dataRoot: DATA_ROOT, dshHome: DSH_HOME, log,
      getConfig: () => cfg,
      setConfig: applyConfig,
      getDataRoot: activeRoot,
      wake: (opts) => wake(opts),
      scorerFor,
      runSelftest,
      runRecoveryTest,
      buildBlock,
      setReplay: (sid, text) => { replayQueue.set(sid, text) },
      defaultModel: () => { try { return ctx.get('agentDefaultModel')?.currentSelection?.() } catch { return null } },
    })
  } catch (e) { log('路由注册失败：' + e.message) }

  // ---------- function calling：存图工具（由"看得见图的那一端"在对话里调用） ----------
  try {
    const tools = ctx.tools
    if (tools) {
      // 重名检测：别的电脑/软件若已有同名工具，跳过注册（复用），避免同层重复注册失败
      const existing = (() => { try { return tools.get('save_image') } catch { return undefined } })()
      if (!existing) {
        tools.register({
        name: 'save_image',
        description: '把一张图片存进外置记忆。必须由你现在能看到的图片传入 base64 或 bytes，并写一句能核对的文字描述（不要猜）；存图不等于看图，插件只保存文件+描述，供以后按描述文字召回。',
        parameters: {
          type: 'object',
          properties: {
            base64: { type: 'string', description: '图片的 base64 编码（与 bytes 二选一）' },
            bytes: { type: 'array', description: '图片字节数组（与 base64 二选一）', items: { type: 'number' } },
            ext: { type: 'string', description: '文件扩展名，如 jpg/png/webp，默认 jpg' },
            desc: { type: 'string', description: '你看到的内容描述，一句能核对的话（如"银白长发、后倾冰晶角、三视图"）' },
            source: { type: 'string', description: '标题/来源，如"角色设定板"' },
            private: { type: 'boolean', description: '私密图只存不注入，默认 false' },
            verified: { type: 'boolean', description: '你能否核对描述属实，默认 false（存疑）' },
          },
          required: ['desc'],
        },
        output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' }, id: { type: 'string' }, hash8: { type: 'string' }, dup: { type: 'boolean' }, error: { type: 'string' } } },
          render: (_a, v) => [{ type: 'text', text: v?.ok ? `已存图 #${v.hash8}${v.dup ? '（同图去重）' : ''}` : '存图失败：' + ((v && v.error) || '未知') }],
        },
        async execute(args, exec) {
          try {
            const a = exec?.agent
            const sid = String(a?.id || a?.sessionId || a?.session?.id || '')
            const entry = entryOf(sid)
            if (!entry) return { ok: false, error: '当前会话未挂载到外置记忆' }
            const root = rootOf(entry)
            let bytes = null
            if (typeof args?.base64 === 'string' && args.base64) bytes = Buffer.from(args.base64, 'base64')
            else if (args?.bytes) bytes = Buffer.from(args.bytes)
            if (!bytes) return { ok: false, error: '没有图片数据（base64 或 bytes）' }
            return IMG.saveImage(root, {
              bytes, ext: args.ext || 'jpg', desc: args.desc || '', source: args.source || '',
              date: nowIso(), privateFlag: !!args.private,
              verified: args.verified === true ? 'verified' : 'suspect', by: 'agent',
            })
          } catch (e) { return { ok: false, error: String(e && (e.message || e)) } }
        },
        })
        tools.register({
        name: 'prefs',
        description: '维护「主人偏好」清单。add：加一条（text）；remove：删一条（id 或原文）；list：列出全部。偏好会稳定注入你的上下文，只在主人明确表达长期偏好时添加，不要拿闲聊当偏好。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'remove', 'list'], description: '操作类型' },
            text: { type: 'string', description: 'add：偏好内容，如「喜欢猫」「讨厌加班」' },
            id: { type: 'string', description: 'remove：偏好 id 或原文' },
          },
          required: ['action'],
        },
        output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' }, id: { type: 'string' }, removed: { type: 'number' }, items: { type: 'array' }, error: { type: 'string' } } },
          render: (_a, v) => [{ type: 'text', text: v?.ok
            ? (v.items ? ('偏好 ' + v.items.length + ' 条：' + v.items.map((x) => x.text).join('；')).slice(0, 240)
              : (v.removed ? ('已删除 ' + v.removed + ' 条偏好') : ('已添加偏好 ' + (v.id || ''))))
            : ('偏好操作失败：' + ((v && v.error) || '未知')) }],
        },
        async execute(args, exec) {
          try {
            const a = exec?.agent
            const sid = String(a?.id || a?.sessionId || a?.session?.id || '')
            const entry = entryOf(sid)
            if (!entry) return { ok: false, error: '当前会话未挂载到外置记忆' }
            const root = rootOf(entry)
            const action = String(args?.action || '')
            if (action === 'add') return S.addPref(root, args?.text)
            if (action === 'remove') return S.removePref(root, args?.id || args?.text)
            if (action === 'list') return { ok: true, items: S.loadPrefs(root).items }
            return { ok: false, error: 'action 必须是 add / remove / list' }
          } catch (e) { return { ok: false, error: String(e && (e.message || e)) } }
        },
        })
      } else {
        log('已存在同名 save_image 工具，跳过注册（复用那台机器已有的）')
      }
    }
  } catch (e) { log('存图工具注册失败：' + e.message) }

  // ---------- function calling：表情包（收录 / 检索 / 发送） ----------
  try {
    const tools = ctx.tools
    const rootOfAgent = (exec) => {
      const a = exec?.agent
      const sid = String(a?.id || a?.sessionId || a?.session?.id || '')
      const entry = entryOf(sid)
      return entry ? { sid, root: rootOf(entry) } : null
    }
    if (tools && C.loadConfig(DATA_ROOT).stickerEnabled !== false) {
      tools.register({
        name: 'sticker_add',
        description: '把一张表情包存进表情包库。必须传图片数据（base64 或 bytes）+ 含义（这张图表达什么）+ 标签（情绪/场景）。存图不等于看图：插件只存文件+标签，供以后检索和发送。',
        parameters: {
          type: 'object',
          properties: {
            base64: { type: 'string', description: '图片 base64（与 bytes 二选一）' },
            bytes: { type: 'array', description: '图片字节（与 base64 二选一）', items: { type: 'number' } },
            ext: { type: 'string', description: '扩展名，gif/webp/png/jpg；不填自动嗅探（APNG 用 png）' },
            meaning: { type: 'string', description: '这张表情包表达什么（一句话）' },
            usage: { type: 'string', description: '什么场合用、什么场合别用（可选）' },
            tags: { type: 'object', description: '标签，如 {"情绪":"无语","场景":"被吐槽","强度":"轻"}' },
            source: { type: 'string', description: '来源（如「主人发的」）' },
            status: { type: 'string', enum: ['pending', 'ready'], description: 'ready=可直接用；pending=待确认' },
          },
          required: ['meaning'],
        },
        output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' }, id: { type: 'string' }, hash8: { type: 'string' }, dup: { type: 'boolean' }, status: { type: 'string' }, why: { type: 'string' } } },
          render: (_a, v) => [{ type: 'text', text: v?.ok ? `已存表情包 ${v.id}${v.dup ? '（同图去重）' : ''}，状态 ${v.status || ''}` : '存失败：' + ((v && v.why) || '未知') }],
        },
        async execute(args, exec) {
          try {
            const ctxa = rootOfAgent(exec)
            if (!ctxa) return { ok: false, why: '当前会话未挂载到外置记忆' }
            const cfgNow = C.loadConfig(DATA_ROOT)
            if (cfgNow.stickerCollect === 'manual') return { ok: false, why: '当前是手动收录模式：只有主人能在设置页添加，智能体不能自己存' }
            let bytes = null
            if (typeof args?.base64 === 'string' && args.base64) bytes = Buffer.from(args.base64.replace(/^data:[^;]+;base64,/, ''), 'base64')
            else if (args?.bytes) bytes = Buffer.from(args.bytes)
            if (!bytes) return { ok: false, why: '没有图片数据' }
            const status = args?.status === 'ready' ? 'ready' : (cfgNow.stickerCollect === 'auto' && cfgNow.stickerDefaultStatus === 'ready' ? 'ready' : 'pending')
            return STICKER.saveSticker(ctxa.root, { bytes, ext: args.ext || '', meaning: args.meaning || '', usage: args.usage || '', tags: args.tags || {}, status, source: args.source || 'agent' })
          } catch (e) { return { ok: false, why: String(e && e.message) } }
        },
      })

      tools.register({
        name: 'sticker_find',
        description: '按情绪/场景/含义检索表情包，返回 id、标签、含义和可发送的本地路径。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键词，如「无语」「被吐槽」；留空列出最近几张' },
            limit: { type: 'number', description: '最多返回几条，默认 8' },
          },
        },
        output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' }, items: { type: 'array' }, why: { type: 'string' } } },
          render: (_a, v) => [{ type: 'text', text: v?.ok ? (v.items || []).map((x) => `${x.id} [${x.tagsText}] ${x.meaning}`).join('\n') || '没有匹配的表情包' : '检索失败：' + ((v && v.why) || '未知') }],
        },
        async execute(args, exec) {
          try {
            const ctxa = rootOfAgent(exec)
            if (!ctxa) return { ok: false, why: '当前会话未挂载到外置记忆' }
            const rows = STICKER.findStickers(ctxa.root, args?.query || '', Math.max(1, Number(args?.limit) || 8))
            return {
              ok: true,
              items: rows.map((r) => ({
                id: r.id, tags: r.tags || {},
                tagsText: [r.tags?.['情绪'], r.tags?.['场景']].filter(Boolean).join('·'),
                meaning: r.meaning, path: STICKER.absFile(ctxa.root, r), status: r.status,
              })),
            }
          } catch (e) { return { ok: false, why: String(e && e.message) } }
        },
      })

      tools.register({
        name: 'sticker_send',
        description: '发一张表情包（受限流约束）。返回一行 markdown，把它原样放进你的回复里就会显示成图。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: '表情包 id（先用 sticker_find 查）' } },
          required: ['id'],
        },
        output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' }, markdown: { type: 'string' }, why: { type: 'string' } } },
          render: (_a, v) => [{ type: 'text', text: v?.ok ? v.markdown : '发不了：' + ((v && v.why) || '未知') }],
        },
        async execute(args, exec) {
          try {
            const ctxa = rootOfAgent(exec)
            if (!ctxa) return { ok: false, why: '当前会话未挂载到外置记忆' }
            const row = STICKER.getSticker(ctxa.root, String(args?.id || ''))
            if (!row) return { ok: false, why: '没有这个表情包' }
            if (row.status !== 'ready' && row.status !== 'pending') return { ok: false, why: '这张已下架' }
            const cfgNow = C.loadConfig(DATA_ROOT)
            const q = STICKER.takeQuota(ctxa.root, ctxa.sid, stickerTurns.get(ctxa.sid) || 0, cfgNow)
            if (!q.ok) return { ok: false, why: q.why }
            const label = [row.tags?.['情绪'], row.tags?.['场景']].filter(Boolean).join('·') || String(row.meaning || '').slice(0, 8) || '表情'
            const abs = STICKER.absFile(ctxa.root, row).replace(/\\/g, '/')
            return { ok: true, markdown: `![${label}](${abs})` }
          } catch (e) { return { ok: false, why: String(e && e.message) } }
        },
      })
    } else {
      log('表情包总开关关闭：跳过工具注册（避免和其它插件撞名）')
    }
  } catch (e) { log('表情包工具注册失败：' + e.message) }

  // ---------- function calling：存档迁移工具（主人点按钮后，智能体决定携带的文件+备注） ----------
  try {
    const tools = ctx.tools
    if (tools) {
      const existing = (() => { try { return tools.get('archive_migrate') } catch { return undefined } })()
      if (!existing) {
        tools.register({
        name: 'archive_migrate',
        description: '存档迁移：把外部文件（日记、图片说明、插件依赖说明等）写到主人指定的迁移目录。你可以自己决定携带哪些文件，并为每个文件写清楚用途和注意事项；写一个文件调一次。',
        parameters: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: '要写的文件名（含相对路径，如 diary.md / 依赖说明.md / README.md）' },
            content: { type: 'string', description: '文件内容（文本）' },
            note: { type: 'string', description: '这个文件的备注：是做什么的、需要注意哪些事项（会汇总进 迁移说明.md）' },
          },
          required: ['filename', 'content'],
        },
        output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' }, file: { type: 'string' }, error: { type: 'string' } } },
          render: (_a, v) => [{ type: 'text', text: v?.ok ? `已迁移写入 ${v.file}` : '迁移失败：' + ((v && v.error) || '未知') }],
        },
        async execute(args, exec) {
          try {
            const a = exec?.agent
            const sid = String(a?.id || a?.sessionId || a?.session?.id || '')
            const entry = entryOf(sid)
            if (!entry) return { ok: false, error: '当前会话未挂载到外置记忆' }
            const root = rootOf(entry)
            const req = S.getMigrateRequest(root)
            if (!req || !req.targetDir) return { ok: false, error: '没有待处理的存档迁移（先让主人在设置里点「存档迁移」）' }
            const dir = req.targetDir
            const name = String(args?.filename || '').replace(/[/\\]/g, '_')
            const target = path.join(dir, name)
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.writeFileSync(target, String(args?.content || ''), 'utf8')
            if (args?.note) {
              const readme = path.join(dir, '迁移说明.md')
              const line = `\n- **${name}**：${String(args.note)}`
              try { fs.appendFileSync(readme, line, 'utf8') } catch {}
            }
            S.setMigratePending(root, false)
            return { ok: true, file: name }
          } catch (e) { return { ok: false, error: String(e && (e.message || e)) } }
        },
        })
      } else {
        log('已存在同名 archive_migrate 工具，跳过注册')
      }
    }
  } catch (e) { log('存档迁移工具注册失败：' + e.message) }

  // ---------- function calling：实体图（别名 / 关系 / 出处 / 时间范围） ----------
  try {
    const tools = ctx.tools
    if (tools && C.loadConfig(DATA_ROOT).graphEnabled !== false) {
      const existing = (() => { try { return tools.get('graph_note') } catch { return undefined } })()
      if (!existing) {
        tools.register({
          name: 'graph_note',
          description: '把实体和关系记进实体图，让「狗=多宝」这类关联以后能被顺着找到。op=node 建/改实体（可带别名）；op=link 建关系（带出处、置信度、有效时间）；op=alias 给实体加别名。拿不准的标 pending 等主人确认。',
          parameters: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['node', 'link', 'alias'], description: 'node=实体，link=关系，alias=别名' },
              name: { type: 'string', description: '实体名（op=node 必填；op=alias 时是目标实体名）' },
              type: { type: 'string', description: '实体类型，如 宠物 / 人 / 地点 / 事件 / 工具' },
              aliases: { type: 'array', items: { type: 'string' }, description: '别名，如 ["狗","那只狗"]' },
              summary: { type: 'string', description: '一句话说明这是什么' },
              from: { type: 'string', description: '关系起点（op=link）' },
              to: { type: 'string', description: '关系终点（op=link）' },
              edgeType: { type: 'string', description: '关系类型，如 主人 / 名字 / 住在 / 属于' },
              validFrom: { type: 'string', description: '这条事实从哪天开始（YYYY-MM-DD，可选）' },
              validTo: { type: 'string', description: '到哪天结束（不填 = 至今有效）' },
              sourceRef: { type: 'string', description: '出处定位，如 journal#462' },
              sourceExcerpt: { type: 'string', description: '原文里那句话' },
              confidence: { type: 'number', description: '置信度 0-100，默认 90' },
              status: { type: 'string', enum: ['approved', 'pending'], description: 'pending = 待主人确认' },
            },
            required: ['op'],
          },
          output: {
            schema: { type: 'object', properties: { ok: { type: 'boolean' }, id: { type: 'string' }, name: { type: 'string' }, error: { type: 'string' } } },
            render: (_a, v) => [{ type: 'text', text: v?.ok ? `已记入实体图：${v.name || v.id}` : '记失败：' + ((v && v.error) || '未知') }],
          },
          async execute(args, exec) {
            try {
              const a = exec?.agent
              const sid = String(a?.id || a?.sessionId || a?.session?.id || '')
              const entry = entryOf(sid)
              if (!entry) return { ok: false, error: '当前会话未挂载到外置记忆' }
              const root = rootOf(entry)
              const op = String(args?.op || '')
              const reviewStatus = args?.status === 'pending' ? 'pending' : 'approved'
              const confidence = Number.isFinite(Number(args?.confidence)) ? Number(args.confidence) : 90
              if (op === 'node') {
                if (!args?.name) return { ok: false, error: 'op=node 需要 name' }
                const n = G.upsertNode(root, { name: args.name, type: args.type, aliases: args.aliases, summary: args.summary, confidence, reviewStatus })
                return n ? { ok: true, id: n.id, name: n.name } : { ok: false, error: '写入失败' }
              }
              if (op === 'link') {
                if (!args?.from || !args?.to) return { ok: false, error: 'op=link 需要 from 和 to' }
                const e = G.upsertEdge(root, { fromName: args.from, toName: args.to, type: args.edgeType, validFrom: args.validFrom, validTo: args.validTo, sourceRef: args.sourceRef, sourceExcerpt: args.sourceExcerpt, confidence, reviewStatus })
                return e ? { ok: true, id: e.id, name: `${e.fromName} -${e.type}-> ${e.toName}` } : { ok: false, error: '写入失败' }
              }
              if (op === 'alias') {
                if (!args?.name || !Array.isArray(args.aliases) || !args.aliases.length) return { ok: false, error: 'op=alias 需要 name + aliases[]' }
                const node = G.findNode(root, args.name) || G.upsertNode(root, { name: args.name, type: args.type })
                if (!node) return { ok: false, error: '找不到也没有建成实体' }
                let n = 0
                for (const al of args.aliases) if (G.addAlias(root, node.name, al)) n++
                return { ok: true, id: node.id, name: `${node.name}（新增 ${n} 个别名）` }
              }
              return { ok: false, error: 'op 必须是 node / link / alias' }
            } catch (e) { return { ok: false, error: String(e && (e.message || e)) } }
          },
        })
      } else {
        log('已存在同名 graph_note 工具，跳过注册')
      }
    }
  } catch (e) { log('实体图工具注册失败：' + e.message) }

  syncEnabled()

  ctx.effect(() => () => disposeHooks())
}
