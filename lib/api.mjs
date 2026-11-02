// 设置页 API（v1.2）：只读写本机文件，不联网
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as C from './config.mjs'
import * as S from './store.mjs'
import * as B from './bootstrap.mjs'
import * as IMG from './image.mjs'
import { nowIso, readJson, writeJsonAtomic, writeTextAtomic, appendLine, readJsonl, dirSize } from './util.mjs'
import { listSessionLogs, readSessionMeta, readSessionImageAttachments } from './decode.mjs'
import { resolveModel, describeImage, descQuality } from './scoring.mjs'

// 插件自身根目录：lib/api.mjs → 上级 lib → 再上级 = 插件根
const PLUGIN_DIR = path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
// 插件版本：从 package.json 读，显示在总览页
const PLUGIN_VERSION = (() => { try { return readJson(path.join(PLUGIN_DIR, 'package.json'), {}).version || '' } catch { return '' } })()

const json = (res, code, obj) => {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(obj))
}

// 必须按字节缓冲再一次性解码：逐 chunk 拼字符串会把跨 chunk 的多字节字符切坏
const readBody = (req) => new Promise((resolve) => {
  const chunks = []
  let size = 0
  req.on('data', (c) => {
    chunks.push(c)
    size += c.length
    if (size > 4e6) req.destroy()
  })
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve({}) }
  })
})

const qs = (req) => { try { return new URL(req.url, 'http://x').searchParams } catch { return new URLSearchParams() } }

export function registerRoutes(ctx, { dataRoot, dshHome, log = () => {}, getConfig, setConfig, wake, scorerFor, defaultModel, getDataRoot, runSelftest, runRecoveryTest, buildBlock, setReplay }) {
  // dataRoot 是「配置根」：config.json 永远在这里（含 testMode 开关本身）；
  // 数据根 D() 在测试模式下指向独立沙箱目录，不碰真实会话存档。
  const D = () => (typeof getDataRoot === 'function' ? getDataRoot() : dataRoot)
  const rootOfKey = (key) => C.sessionRoot(D(), key)
  const entryOf = (sid) => C.findSession(C.loadRegistry(D()), sid)
  const backfillJobs = new Map()   // sessionId -> { running, done, total, added, skipped, result }
  const saveJobs = new Map()       // sessionId -> { running, done, total, scored, result }

  // 会话标题同步：DSH 里改了会话名，插件注册表也要跟上（TTL 缓存，避免频繁读大日志）
  let titleSyncAt = 0
  const syncSessionTitles = () => {
    if (Date.now() - titleSyncAt < 30000) return
    titleSyncAt = Date.now()
    try {
      const logs = listSessionLogs(dshHome)
      const reg = C.loadRegistry(D())
      let changed = false
      for (const e of reg.sessions) {
        if (e.status !== 'attached') continue
        const l = logs.find((x) => x.sessionId === e.sessionId)
        if (!l) continue
        try {
          const m = metaOf(l.file, l.mtime)
          if (m && m.title && m.title !== e.title) { e.title = m.title; changed = true }
        } catch {}
      }
      if (changed) C.saveRegistry(D(), reg)
    } catch {}
  }

  let metaCache = new Map()   // file -> {at, meta}
  const metaOf = (file, mtime) => {
    const hit = metaCache.get(file)
    if (hit && hit.at === mtime) return hit.meta
    const meta = readSessionMeta(file)
    metaCache.set(file, { at: mtime, meta })
    return meta
  }

  const withStats = (entry) => {
    const root = rootOfKey(entry.key)
    let st = {}
    try { st = S.stats(root) } catch {}
    return {
      ...entry,
      stats: {
        baseItems: st.baseItems || 0,
        optimizedItems: st.optimizedItems || 0,
        vctxItems: st.vctxItems || 0,
        vctxTokens: st.vctxTokens || 0,
        expiringToday: st.expiringToday || 0,
        salvaged: st.salvaged || 0,
        bytes: st.bytes || 0,
        usage: st.usage || null,
        mood: st.mood?.value ?? 70,
        affection: st.affection?.value ?? 0,
        axes: st.traits?.axes || {},
        alignment: st.traits?.alignment || { order: 0, moral: 0 },
        qaSamples: st.qaSamples || 0,
        bootstrap: st.bootstrap || entry.bootstrap || {},
        snapshots: st.snapshots || 0,
      },
    }
  }

  const handlers = {
    async overview(req, res) {
      const cfg = C.loadConfig(dataRoot)
      const reg = C.loadRegistry(D())
      const wk = readJson(path.join(D(), 'wake.json'), null)
      const sel = resolveModel(cfg, { defaultModel })
      json(res, 200, {
        config: cfg, dataRoot: D(), dshHome, enabled: cfg.enabled,
        version: PLUGIN_VERSION,
        sessions: reg.sessions.length,
        attached: reg.sessions.filter((s) => s.status === 'attached').length,
        bytes: dirSize(D()),
        zstd: B.zstdAvailable(),
        maxWakeIntervalDays: Math.max(0.5, Number(cfg.minDecayDays) || 3),
        lastWakeAt: wk?.lastWakeAt || null,
        lastWakeReport: wk?.report || null,
        scorer: {
          subject: cfg.scorerSubject, mode: cfg.scorerMode,
          provider: sel.provider, model: sel.model,
          llmAvailable: (() => { try { return !!ctx.get('llm') } catch { return false } })(),
        },
      })
    },

    async config(req, res) {
      if (req.method === 'GET') return json(res, 200, { ok: true, config: C.loadConfig(dataRoot) })
      const b = await readBody(req)
      const prev = C.loadConfig(dataRoot)
      const next = { ...prev, ...(b.config && typeof b.config === 'object' ? b.config : {}) }
      // 硬约束：唤醒间隔 ≤ 最短衰变期，否则条目会在写进优化存储之前就衰变掉
      const warnings = []
      const maxGap = Math.max(0.5, Number(next.minDecayDays) || 3)
      if (Number(next.wakeEveryDays) > maxGap) {
        next.wakeEveryDays = maxGap
        warnings.push(`唤醒间隔已压到 ${maxGap} 天：必须 ≤ 最短衰变期，否则记忆会在备份前失效`)
      }
      // 唤醒时段校验
      const okTime = (s) => /^\d{1,2}:\d{2}$/.test(String(s || ''))
      if (!okTime(next.wakeStart) || !okTime(next.wakeEnd)) {
        next.wakeStart = prev.wakeStart
        next.wakeEnd = prev.wakeEnd
        warnings.push('唤醒时段格式应为 HH:mm，已保留原值')
      }
      if (!['hosted', 'session'].includes(next.scorerSubject)) { next.scorerSubject = prev.scorerSubject; warnings.push('评分器主体取值非法') }
      if (!['instant', 'onSave'].includes(next.scorerMode)) { next.scorerMode = prev.scorerMode; warnings.push('评分器模式取值非法') }
      C.saveConfig(dataRoot, next)
      if (typeof setConfig === 'function') setConfig(next)
      if (!prev.enabled && next.enabled) {
        for (const e of C.loadRegistry(D()).sessions) {
          if (e.status === 'attached' && e.bootstrap?.status !== 'done') {
            C.updateSession(D(), e.sessionId, { bootstrap: { ...(e.bootstrap || {}), status: 'pending' } })
          }
        }
      }
      log(`config 更新：enabled=${next.enabled}`)
      json(res, 200, { ok: true, config: next, warnings })
    },

    async sessions(req, res) {
      syncSessionTitles()
      json(res, 200, { ok: true, sessions: C.loadRegistry(D()).sessions.map(withStats) })
    },

    // 选择会话：给标题、工作区、时间，不暴露"文件名"
    async candidates(req, res) {
      const known = new Set(C.loadRegistry(D()).sessions.filter((s) => s.status === 'attached').map((s) => s.sessionId))
      // 只列「工作区里有的」会话：读 DSH 工作区注册表的 sessionIds + 置顶会话
      let wsIds = null
      try {
        const ws = readJson(path.join(dshHome, 'storages', 'workspace.json'), null)
        if (ws && ws.tables && ws.global) {
          wsIds = new Set()
          for (const id of (ws.global.workspaceIds || [])) {
            const w = ws.tables.workspaces && ws.tables.workspaces[id]
            for (const sid of ((w && w.sessionIds) || [])) wsIds.add(sid)
          }
          for (const sid of (ws.global.pinnedSessionIds || [])) wsIds.add(sid)
        }
      } catch {}
      // 过滤测试会话
      const isTestTitle = (t) => /(测试|test|验证|从萌娘百科|请只回复|空白对照|This is a test)/i.test(String(t || ''))
      const out = []
      for (const l of listSessionLogs(dshHome)) {
        if (wsIds && !wsIds.has(l.sessionId)) continue
        const meta = metaOf(l.file, l.mtime)
        const title = meta.title || (meta.cwd ? path.basename(meta.cwd) + ' 的会话' : '未命名会话')
        if (isTestTitle(title)) continue
        out.push({
          sessionId: l.sessionId,
          title,
          titleSource: meta.titleSource,
          cwd: meta.cwd,
          workspace: path.basename(meta.cwd || '') || l.workspace.replace(/^-+|-+$/g, ''),
          createdAt: meta.createdAt || 0,
          bytes: l.bytes,
          mtime: new Date(l.mtime).toISOString(),
          added: known.has(l.sessionId),
        })
      }
      out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      json(res, 200, { ok: true, candidates: out })
    },

    async addSession(req, res) {
      const b = await readBody(req)
      if (!b.sessionId) return json(res, 400, { ok: false, why: '缺少 sessionId' })
      const found = listSessionLogs(dshHome).find((l) => l.sessionId === String(b.sessionId))
      const meta = found ? metaOf(found.file, found.mtime) : null
      const entry = C.addSession(D(), String(b.sessionId), {
        title: b.title || meta?.title || String(b.sessionId),
        capture: b.capture !== false,
        inject: b.inject !== false,
      })
      S.ensureLayout(rootOfKey(entry.key))
      json(res, 200, { ok: true, session: withStats(entry) })
    },

    async updateSession(req, res) {
      const b = await readBody(req)
      const e = entryOf(b.sessionId)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      const patch = {}
      for (const k of ['capture', 'inject', 'title']) if (b[k] !== undefined) patch[k] = b[k]
      json(res, 200, { ok: true, session: withStats(C.updateSession(D(), b.sessionId, patch)) })
    },

    async removeSession(req, res) {
      const b = await readBody(req)
      json(res, 200, { ok: C.removeSession(D(), b.sessionId, { purge: !!b.purge }) })
    },

    // 会话优先级：上移 / 下移
    async moveSession(req, res) {
      const b = await readBody(req).catch(() => ({}))
      const ok = C.moveSession(D(), b.sessionId, b.dir === 'up' ? 'up' : 'down')
      json(res, 200, { ok })
    },

    // 读档：选择"哪个智能体/会话的档"接到当前会话
    async archives(req, res) {
      const list = C.loadRegistry(D()).sessions.map((e) => {
        const st = (() => { try { return S.stats(rootOfKey(e.key)) } catch { return {} } })()
        return {
          sessionId: e.sessionId, title: e.title || e.sessionId, status: e.status,
          optimizedItems: st.optimizedItems || 0, baseItems: st.baseItems || 0,
          bytes: st.bytes || 0, lastActivityAt: e.lastActivityAt || e.addedAt,
        }
      })
      json(res, 200, { ok: true, archives: list })
    },

    async read(req, res) {
      const b = await readBody(req)
      const target = entryOf(b.targetSession)
      if (!target) return json(res, 404, { ok: false, why: '当前会话未挂载' })
      if (!b.sourceSession) return json(res, 400, { ok: false, why: '没有选择要读的档' })
      if (target.sessionId === b.sourceSession) return json(res, 400, { ok: false, why: '不能从自己读档' })

      const cfg = C.loadConfig(dataRoot)
      let source = entryOf(b.sourceSession)
      let built = null
      // 源会话还没建档：先只读地建一份档（不采集、不注入），再导入
      if (!source) {
        const found = listSessionLogs(dshHome).find((l) => l.sessionId === String(b.sourceSession))
        const meta = found ? metaOf(found.file, found.mtime) : null
        source = C.addSession(D(), String(b.sourceSession), { capture: false, inject: false, title: meta?.title || undefined })
        S.ensureLayout(rootOfKey(source.key))
        built = B.runBootstrap(dshHome, rootOfKey(source.key), source.sessionId, cfg, log)
        if (!built || built.status === 'failed') {
          return json(res, 200, { ok: false, why: '源会话无法入档：' + (built?.error || '未知原因') })
        }
        for (let i = 0; i < 20; i++) {
          const r = await S.processPending(rootOfKey(source.key), cfg, 200, scorerFor())
          if (!r.remaining) break
        }
      }
      const r = S.importArchive(rootOfKey(target.key), rootOfKey(source.key), cfg, { deep: true, targetSessionId: target.sessionId })
      log(`读档：${source.sessionId} → ${target.sessionId}，导入 ${r.imported} 条，底层 ${r.deepJournal} 条，优化 ${r.deepOptimized} 条`)
      json(res, 200, { ok: true, ...r, built: built?.status || null, sourceTitle: source.title })
    },

    // 存档：把日志里新的内容补进来（幂等），再拍快照
    async save(req, res) {
      const b = await readBody(req)
      const e = entryOf(b.sessionId)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      const root = rootOfKey(e.key)
      S.ensureLayout(root)
      const cfg = C.loadConfig(dataRoot)
      const cur = saveJobs.get(b.sessionId)
      if (cur && cur.running) return json(res, 200, { ok: true, started: false, why: '已在存档' })
      const state = { running: true, done: 0, total: 0, scored: 0, result: null }
      saveJobs.set(b.sessionId, state)
      ;(async () => {
        try {
          // 存用户发的图（先做，不被打分拖住）：视觉模型生成"差异点"描述 → 质量闸 → 不合格标 unscored 稍后重试
          let savedImages = 0
          if (cfg.imageSaveEnabled !== false) try {
            const llm = (() => { try { return ctx.get('llm') } catch { return undefined } })()
            const sel = resolveModel(cfg, { defaultModel: () => { try { return ctx.get('agentDefaultModel')?.currentSelection?.() } catch { return null } } })
            const tryDescribe = async (bytes, attachment, mimeType) => {
              try {
                const d = await describeImage({ llm, provider: sel.provider, model: sel.model, base64: attachment ? undefined : bytes.toString('base64'), mimeType, attachment })
                if (d.desc) {
                  const q = descQuality(d.desc)
                  if (q.ok) return d.desc
                  log('描述质量闸未过：' + q.reason + ' → ' + d.desc.slice(0, 40))
                } else log('describeImage 失败：' + (d.error || '空'))
              } catch (e3) { log('describeImage 异常：' + String(e3 && e3.message)) }
              return ''
            }
            // 1) 新图（只存用户发的）
            const ag = ctx.agents?.get?.(e.sessionId)
            const msgs = ag?.session?.messages || ag?.messages || []
            let imgs = IMG.extractImagesFromMessages(msgs)
            if (!imgs.length) {
              const found = listSessionLogs(dshHome).find((l) => l.sessionId === e.sessionId)
              if (found) imgs = readSessionImageAttachments(found.file)
            }
            for (const im of imgs) {
              let bytes = null
              if (im.data) bytes = Buffer.from(im.data, 'base64')
              else if (im.attachmentId) {
                const hash = String(im.attachmentId).replace(/^sha256:/, '')
                const p = path.join(dshHome, 'attachments', 'v1', 'objects', hash.slice(0, 2), hash)
                try { bytes = fs.readFileSync(p) } catch {}
              }
              if (!bytes || !bytes.length) continue
              const att = im.attachment || (im.attachmentId ? { attachmentId: im.attachmentId, mediaType: im.mimeType || 'image/jpeg' } : undefined)
              const visionDesc = await tryDescribe(bytes, att, im.mimeType)
              const finalDesc = visionDesc || im.caption || '待描述（待重试）'
              const verified = visionDesc ? 'suspect' : (im.caption ? 'suspect' : 'unscored')
              const ext = (im.mimeType || 'image/jpeg').split('/')[1] || 'jpg'
              const rr = IMG.saveImage(root, { bytes, ext, desc: finalDesc, source: '会话消息', date: nowIso(), verified, by: 'save' })
              if (rr.ok) {
                if (rr.dup) {
                  if (visionDesc) IMG.updateImageDesc(root, rr.id, visionDesc, 'suspect')
                } else savedImages++
              }
            }
            // 2) 重试标记为 unscored 的图（上次质量闸没过）
            for (const it of IMG.listImages(root).filter((x) => x.verified === 'unscored')) {
              const p = path.join(IMG.imagePaths(root).dir, String(it.file || ''))
              let bytes = null
              try { bytes = fs.readFileSync(p) } catch {}
              if (!bytes || !bytes.length) continue
              const mime = /\.png$/i.test(it.file) ? 'image/png' : /\.webp$/i.test(it.file) ? 'image/webp' : 'image/gif' ? 'image/gif' : 'image/jpeg'
              const desc = await tryDescribe(bytes, undefined, mime)
              if (desc) IMG.updateImageDesc(root, it.id, desc, 'suspect')
            }
          } catch (e2) { log('存档存图失败：' + String(e2 && e2.message)) }
          let scored = 0
          if (typeof scorerFor === 'function') {
            const scorer = scorerFor()
            const totalPending = S.pendingCount(root)
            state.total = totalPending
            for (let i = 0; i < 20; i++) {
              const r = await S.processPending(root, cfg, 200, scorer)
              scored += r.done || 0
              state.done += r.done || 0
              state.scored = scored
              if (!r.remaining) break
            }
          }
          const r = B.runBootstrap(dshHome, root, e.sessionId, cfg, log)
          const snap = S.snapshot(root, { keep: cfg.snapshotKeep })
          C.updateSession(D(), e.sessionId, { bootstrap: readJson(path.join(root, 'bootstrap.json'), {}), lastSavedAt: nowIso() })
          const costTokens = cfg.scorerSubject === 'session' ? scored * 100 : 0
          state.result = { ok: true, bootstrap: r, snapshot: snap ? path.basename(snap) : null, stats: S.stats(root), scored, costTokens, savedImages }
        } catch (err) {
          state.result = { ok: false, error: String(err && err.message) }
        } finally {
          state.running = false
        }
      })()
      json(res, 200, { ok: true, started: true })
    },

    async saveStatus(req, res) {
      const sp = qs(req)
      const st = saveJobs.get(sp.get('sessionId'))
      json(res, 200, { ok: true, state: st || null })
    },

    // 比对底层存储，补齐未保存进优化存储的条目（异步 + 可查进度）
    async backfill(req, res) {
      const b = await readBody(req).catch(() => ({}))
      const e = entryOf(b.sessionId)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      const root = rootOfKey(e.key)
      const cfg = C.loadConfig(dataRoot)
      // 已有任务在跑则不重复启动
      const cur = backfillJobs.get(b.sessionId)
      if (cur && cur.running) return json(res, 200, { ok: true, started: false, why: '已在运行' })
      const state = { running: true, done: 0, total: 0, added: 0, skipped: 0, result: null }
      backfillJobs.set(b.sessionId, state)
      const scorer = typeof scorerFor === 'function' ? scorerFor() : undefined
      ;(async () => {
        try {
          const r = await S.backfillOptimized(root, cfg, scorer, (p) => {
            state.done = p.done; state.total = p.total; state.added = p.added; state.skipped = p.skipped
          })
          state.result = r
        } catch (err) {
          state.result = { ok: false, error: String(err && err.message) }
        } finally {
          state.running = false
        }
      })()
      json(res, 200, { ok: true, started: true })
    },

    async backfillStatus(req, res) {
      const sp = qs(req)
      const st = backfillJobs.get(sp.get('sessionId'))
      json(res, 200, { ok: true, state: st || null })
    },

    // 源会话提取：从原始会话日志重建底层（覆盖派生存储），异步 + 可查进度
    async rebuildBase(req, res) {
      const b = await readBody(req).catch(() => ({}))
      const e = entryOf(b.sessionId)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      const root = rootOfKey(e.key)
      const cur = backfillJobs.get(b.sessionId)
      if (cur && cur.running) return json(res, 200, { ok: true, started: false, why: '已有任务在运行' })
      const state = { running: true, done: 0, total: 0, added: 0, skipped: 0, result: null }
      backfillJobs.set(b.sessionId, state)
      ;(async () => {
        try {
          const r = await S.rebuildBaseFromLog(root, dshHome, e.sessionId, (p) => {
            state.done = p.done; state.total = p.total; state.added = p.added; state.skipped = p.skipped
          })
          state.result = r
        } catch (err) {
          state.result = { ok: false, error: String(err && err.message) }
        } finally {
          state.running = false
        }
      })()
      json(res, 200, { ok: true, started: true })
    },

    // 跨平台建档：解析文件文本的 Q&A，写底层覆盖
    async importQA(req, res) {
      const b = await readBody(req).catch(() => ({}))
      const e = entryOf(b.sessionId)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      if (!b.text) return json(res, 400, { ok: false, why: '没有文件内容' })
      const r = S.importQA(rootOfKey(e.key), e.sessionId, String(b.text))
      json(res, 200, r)
    },

    // 存档迁移：主人点按钮 → 记录目标目录，智能体用 archive_migrate 工具决定携带的文件和备注
    async migrate(req, res) {
      const b = await readBody(req).catch(() => ({}))
      const e = entryOf(b.sessionId)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      const dir = String(b.targetDir || '').trim()
      if (!dir) return json(res, 400, { ok: false, why: '没有目标目录' })
      try { fs.mkdirSync(dir, { recursive: true }) } catch (err) { return json(res, 400, { ok: false, why: '目录无法创建：' + err.message }) }
      S.setMigrateRequest(rootOfKey(e.key), dir)
      json(res, 200, { ok: true, targetDir: dir })
    },

    // 自更新：上传 zip 更新包，解压覆盖到插件目录，重载后生效
    async update(req, res) {
      const b = await readBody(req).catch(() => ({}))
      const b64 = String(b.zipBase64 || '').replace(/^data:[^;]+;base64,/, '')
      if (!b64) return json(res, 400, { ok: false, why: '没有更新包内容' })
      const buf = Buffer.from(b64, 'base64')
      if (!buf.length || buf.length > 32 * 1024 * 1024) return json(res, 400, { ok: false, why: '更新包大小异常（限 32MB）' })
      // 校验是 zip（PK 头）
      if (buf[0] !== 0x50 || buf[1] !== 0x4b) return json(res, 400, { ok: false, why: '不是 zip 文件' })
      const tmp = path.join(os.tmpdir(), 'offmem-update-' + Date.now() + '.zip')
      fs.writeFileSync(tmp, buf)
      const cmd = `Expand-Archive -LiteralPath '${tmp}' -DestinationPath '${PLUGIN_DIR}' -Force`
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true }, (err) => {
        try { fs.rmSync(tmp, { force: true }) } catch {}
        if (err) return json(res, 500, { ok: false, why: '解压失败：' + String(err && err.message) })
        log('插件自更新完成 → ' + PLUGIN_DIR)
        json(res, 200, { ok: true, dir: PLUGIN_DIR, note: '已更新，重载插件后生效（设置→插件：关闭再开启，或重启软件）' })
      })
    },

    // 从 GitHub 更新：下载仓库 zip → 解压 → 覆盖插件目录
    async updateGithub(req, res) {
      const b = await readBody(req).catch(() => ({}))
      const cfg = C.loadConfig(dataRoot)
      const repo = String(b.repo || cfg.updateRepo || '').trim()
        .replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '')
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json(res, 400, { ok: false, why: '仓库格式应为 owner/repo' })
      // 宿主进程的 fetch 在部分网络下连不上 GitHub；改用 PowerShell 的 Invoke-WebRequest（与沙箱同栈）
      const stamp = Date.now()
      const tmpZip = path.join(os.tmpdir(), 'offmem-gh-' + stamp + '.zip')
      const tmpDir = path.join(os.tmpdir(), 'offmem-gh-' + stamp)
      let used = ''
      const tryDownload = (url) => new Promise((resolve) => {
        try { fs.rmSync(tmpZip, { force: true }) } catch {}
        const cmd = `Invoke-WebRequest -Uri '${url}' -OutFile '${tmpZip}' -UseBasicParsing`
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 90000 }, (err) => {
          if (err) { log('GitHub 下载失败：' + url.slice(0, 90) + '｜' + String(err && err.message).slice(0, 120)); return resolve(false) }
          try {
            const b2 = fs.readFileSync(tmpZip)
            if (b2.length > 0 && b2[0] === 0x50 && b2[1] === 0x4b) return resolve(true)
          } catch {}
          resolve(false)
        })
      })
      for (const br of ['main', 'master']) {
        if (used) break
        const direct = `https://github.com/${repo}/archive/refs/heads/${br}.zip`
        const urls = [direct, `https://ghfast.top/${direct}`, `https://ghproxy.net/${direct}`, `https://mirror.ghproxy.com/${direct}`]
        for (const url of urls) {
          const ok = await tryDownload(url)
          if (ok) { used = br + ' @ ' + (url === direct ? 'github' : new URL(url).host); break }
        }
      }
      if (!used) return json(res, 500, { ok: false, why: '下载失败（仓库不存在或网络不可达）' })
      const cmd = `Expand-Archive -LiteralPath '${tmpZip}' -DestinationPath '${tmpDir}' -Force`
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true }, (err) => {
        try { fs.rmSync(tmpZip, { force: true }) } catch {}
        if (err) return json(res, 500, { ok: false, why: '解压失败：' + String(err && err.message) })
        try {
          // GitHub 归档会多一层 repo-main/ 目录，取其内容覆盖插件目录
          let root = tmpDir
          const subs = fs.readdirSync(tmpDir).filter((n) => { try { return fs.statSync(path.join(tmpDir, n)).isDirectory() } catch { return false } })
          if (subs.length === 1) root = path.join(tmpDir, subs[0])
          fs.cpSync(root, PLUGIN_DIR, { recursive: true, force: true })
          if (repo !== cfg.updateRepo) { try { const n = { ...cfg, updateRepo: repo }; C.saveConfig(dataRoot, n); if (typeof setConfig === 'function') setConfig(n) } catch {} }
        } catch (e) {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
          return json(res, 500, { ok: false, why: '覆盖失败：' + String(e && e.message) })
        }
        try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
        log('GitHub 更新完成：' + repo + ' (' + used + ') → ' + PLUGIN_DIR)
        json(res, 200, { ok: true, repo, branch: used, note: '已从 GitHub 更新，重载插件后生效（关闭再开启，或重启软件）' })
      })
    },

    async bootstrapSession(req, res) {
      const b = await readBody(req)
      const e = entryOf(b.sessionId)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      const root = rootOfKey(e.key)
      if (b.full) {
        // 全量重建：清空派生存储（journal/optimized/vctx/vectors），再从原始会话日志重跑
        S.clearStore(root)
      } else if (b.reset) {
        writeJsonAtomic(path.join(root, 'bootstrap.json'), { status: 'pending', cursor: 0, turns: 0, bytes: 0, attempts: 0 })
      }
      const r = B.runBootstrap(dshHome, root, e.sessionId, C.loadConfig(dataRoot), log)
      C.updateSession(D(), e.sessionId, { bootstrap: readJson(path.join(root, 'bootstrap.json'), {}) })
      json(res, 200, { ok: true, result: r, stats: S.stats(root) })
    },

    async rollback(req, res) {
      const b = await readBody(req)
      const e = entryOf(b.sessionId)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      const dir = S.rollback(rootOfKey(e.key))
      json(res, dir ? 200 : 404, dir ? { ok: true, from: path.basename(dir) } : { ok: false, why: '没有可用快照' })
    },

    async state(req, res) {
      const sid = qs(req).get('session')
      const e = sid ? entryOf(sid) : C.loadRegistry(D()).sessions.find((s) => s.status === 'attached')
      if (!e) return json(res, 200, { ok: true, empty: true, sessions: [] })
      const root = rootOfKey(e.key)
      const st = S.stats(root)
      const v = S.loadVctx(root)
      json(res, 200, {
        ok: true, session: withStats(e), stats: st,
        items: v.items.slice(-60).reverse().map((i) => ({
          id: i.id, at: i.at, state: i.expiresAt && new Date(i.expiresAt) < new Date() ? 'expired' : 'active',
          score: i.score, role: i.role, summary: i.summary, tokens: i.tokens, important: i.important === true,
          hitCount: i.hitCount, origin: i.origin, originAt: i.originAt, salvagedAt: i.salvagedAt,
          decayDays: i.decayDays === Infinity ? null : Math.round(i.decayDays), expiresAt: i.expiresAt,
        })),
        affectionEvents: (() => {
          try {
            return fs.readFileSync(path.join(root, 'state', 'affection-events.jsonl'), 'utf8')
              .trim().split('\n').slice(-3).reverse().map((l) => JSON.parse(l))
          } catch { return [] }
        })(),
        moodEvents: (() => {
          try {
            return fs.readFileSync(path.join(root, 'state', 'mood-events.jsonl'), 'utf8')
              .trim().split('\n').slice(-5).reverse().map((l) => JSON.parse(l))
          } catch { return [] }
        })(),
      })
    },

    // 清空并重新计算萌属性 / 阵营：不动 Q&A 样本
    async traitsRecalc(req, res) {
      const b = await readBody(req)
      const e = entryOf(b.sessionId)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      const r = S.recalcTraits(rootOfKey(e.key))
      json(res, 200, r)
    },

    async retrieve(req, res) {
      const b = await readBody(req)
      const e = entryOf(b.sessionId)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      if (!b.query) return json(res, 400, { ok: false, why: '把一句话填进 query' })
      const hits = S.retrieve(rootOfKey(e.key), String(b.query), C.loadConfig(dataRoot), { limit: 8, revive: false })
      json(res, 200, {
        ok: true,
        hits: hits.map((h) => ({
          id: h.id, where: h.where, rel: h.rel, final10: h.final10, score: h.score,
          tokens: h.tokens, summary: h.summary, originAt: h.originAt || h.at,
        })),
        tokens: hits.reduce((n, h) => n + (h.tokens || 0), 0),
      })
    },

    // 管理存档：三层各自的用量、位置、条目数
    async manage(req, res) {
      const sid = qs(req).get('session')
      const e = sid ? entryOf(sid) : C.loadRegistry(D()).sessions.find((s) => s.status === 'attached')
      if (!e) return json(res, 200, { ok: true, empty: true })
      const root = rootOfKey(e.key)
      json(res, 200, { ok: true, session: { sessionId: e.sessionId, title: e.title || e.sessionId }, usage: S.storeUsage(root) })
    },

    // 打开文件：给前 N 行预览（Web 端无法直接调起系统编辑器）
    async preview(req, res) {
      const sp = qs(req)
      const e = entryOf(sp.get('session'))
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      const scope = sp.get('store') || 'optimized'
      const p = S.paths(rootOfKey(e.key))
      let file = p.optimized
      if (scope === 'vctx') file = p.vctx
      if (scope === 'base') {
        const segs = fs.readdirSync(p.journal).filter((f) => /^seg-\d+\.jsonl$/.test(f)).sort()
        file = path.join(p.journal, segs[segs.length - 1] || 'seg-0000.jsonl')
      }
      let lines = []
      try {
        if (scope === 'vctx') lines = [JSON.stringify(readJson(file, {}), null, 2).split('\n').slice(0, 40).join('\n')]
        else lines = fs.readFileSync(file, 'utf8').split('\n').slice(0, 40)
      } catch (err) {
        return json(res, 200, { ok: false, why: '文件还不存在', path: file })
      }
      json(res, 200, { ok: true, path: file, lines })
    },

    // 清理存储：按"清理多久之前"删；scope = base | optimized
    async clean(req, res) {
      const b = await readBody(req)
      const e = entryOf(b.session)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      if (b.confirm !== true) return json(res, 400, { ok: false, why: '清理需要确认' })
      if (b.scope !== 'base' && b.scope !== 'optimized') return json(res, 400, { ok: false, why: 'scope 只能是 base 或 optimized' })
      const days = Number(b.beforeDays)
      if (!isFinite(days) || days < 0) return json(res, 400, { ok: false, why: 'beforeDays 不合法' })
      const r = S.cleanStore(rootOfKey(e.key), b.scope, days, C.loadConfig(dataRoot))
      log(`清理 ${b.scope}：${b.session} 早于 ${days} 天，删除 ${r.removed} 条`)
      json(res, 200, { ...r })
    },

    // 人设属性：独立模块，人和智能体都能写
    async persona(req, res) {
      const sid = qs(req).get('session')
      const e = sid ? entryOf(sid) : C.loadRegistry(D()).sessions.find((s) => s.status === 'attached')
      if (!e) return json(res, 200, { ok: false, why: '没有可用会话' })
      const p = S.paths(rootOfKey(e.key))
      const file = path.join(p.root, 'persona.md')
      if (req.method === 'GET') {
        let text = ''
        try { text = fs.readFileSync(file, 'utf8') } catch {}
        let mtime = null
        try { mtime = new Date(fs.statSync(file).mtimeMs).toISOString() } catch {}
        return json(res, 200, { ok: true, sessionId: e.sessionId, title: e.title, text, mtime, path: file })
      }
      const b = await readBody(req)
      if (typeof b.text !== 'string') return json(res, 400, { ok: false, why: '缺少 text' })
      const who = b.by === 'agent' ? 'agent' : 'human'
      const body = `${String(b.text).slice(0, 20000)}`
      writeTextAtomic(file, body)
      S.upsertPersona(rootOfKey(e.key), body)
      appendLine(path.join(p.logs, 'events.log'), { at: nowIso(), type: 'persona-write', by: who, bytes: Buffer.byteLength(body) })
      json(res, 200, { ok: true, bytes: Buffer.byteLength(body), by: who, path: file })
    },

    // Q&A 样本记录本
    async qa(req, res) {
      const sp = qs(req)
      const e = entryOf(sp.get('session'))
      if (!e) return json(res, 200, { ok: false, why: '该会话未挂载' })
      const p = S.paths(rootOfKey(e.key))
      const rows = readJsonl(p.qa).slice(-Number(sp.get('limit') || 200)).reverse()
      json(res, 200, { ok: true, total: readJsonl(p.qa).length, samples: rows, path: p.qa })
    },

    // 手动唤醒一次（打分 + 淡忘 + 自动存档）
    async wakeNow(req, res) {
      const b = await readBody(req).catch(() => ({}))
      const r = typeof wake === 'function'
        ? await wake({ manual: true, only: b.sessionId || null, reason: 'manual' })
        : { ok: false, why: '唤醒不可用' }
      json(res, 200, r)
    },

    // 自测：一轮记忆恢复验证（testMode 决定写沙箱还是真实目录）
    async selftest(req, res) {
      if (typeof runSelftest !== 'function') return json(res, 200, { ok: false, why: '自测不可用' })
      const b = await readBody(req).catch(() => ({}))
      const r = await runSelftest({
        testMode: !!b.testMode,
        subject: b.subject === 'session' ? 'session' : 'hosted',
        samples: Number(b.samples) || 200,
      })
      json(res, 200, { ok: true, ...r })
    },

    // 记忆恢复矩阵：100 条 Q&A × 3 种索引模式
    async recoveryTest(req, res) {
      if (typeof runRecoveryTest !== 'function') return json(res, 200, { ok: false, why: '不可用' })
      const b = await readBody(req).catch(() => ({}))
      const r = await runRecoveryTest({ subject: b.subject === 'session' ? 'session' : 'hosted' })
      json(res, 200, { ok: true, ...r })
    },
    // —— 重要会话管理（手动降级，永久档的退路）——
    async importantList(req, res) {
      const sp = qs(req)
      const e = entryOf(sp.get('session'))
      if (!e) return json(res, 200, { ok: false, why: '该会话未挂载' })
      json(res, 200, { ok: true, items: S.listImportant(rootOfKey(e.key)) })
    },

    async importantDemote(req, res) {
      const b = await readBody(req).catch(() => ({}))
      const e = entryOf(b.session)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      const r = S.demoteImportant(rootOfKey(e.key), b.id, C.loadConfig(dataRoot))
      json(res, 200, r)
    },

    // —— 图片记忆：保存 + 列表 + 标记可信度 ——
    async imageSave(req, res) {
      const b = await readBody(req).catch(() => ({}))
      const e = entryOf(b.session)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      let bytes = null
      if (typeof b.base64 === 'string' && b.base64) bytes = Buffer.from(b.base64, 'base64')
      else if (b.bytes) bytes = Buffer.from(b.bytes)
      if (!bytes) return json(res, 200, { ok: false, why: '没有图片数据（base64 或 bytes）' })
      const r = IMG.saveImage(rootOfKey(e.key), {
        bytes, ext: b.ext || 'jpg', desc: b.desc || '', source: b.source || '',
        date: b.date || nowIso(), privateFlag: !!b.private, verified: b.verified === true ? 'verified' : 'suspect', by: b.by || '',
      })
      json(res, 200, r)
    },

    async images(req, res) {
      const sp = qs(req)
      const e = entryOf(sp.get('session'))
      if (!e) return json(res, 200, { ok: false, why: '该会话未挂载' })
      json(res, 200, { ok: true, items: IMG.listImages(rootOfKey(e.key)).reverse() })
    },

    async imageMark(req, res) {
      const b = await readBody(req).catch(() => ({}))
      const e = entryOf(b.session)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      const r = IMG.markImage(rootOfKey(e.key), b.id, b.verified === true)
      json(res, 200, r)
    },

    // 删除单张图（删文件 + 索引条目）
    async imageDelete(req, res) {
      const b = await readBody(req).catch(() => ({}))
      const e = entryOf(b.session)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      if (b.confirm !== true) return json(res, 400, { ok: false, why: '删除需要确认' })
      const r = IMG.deleteImage(rootOfKey(e.key), b.id)
      json(res, 200, r)
    },

    // 打开图库文件夹（资源管理器）
    async revealImages(req, res) {
      const b = await readBody(req).catch(() => ({}))
      const e = entryOf(b.session)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      const dir = IMG.imagePaths(rootOfKey(e.key)).dir
      try { fs.mkdirSync(dir, { recursive: true }) } catch {}
      try {
        // Windows 标准做法：cmd /c start "" "<dir>"，detached 不阻塞宿主
        const p = spawn('cmd', ['/c', 'start', '', dir], { detached: true, stdio: 'ignore', windowsHide: true })
        p.on('spawn', () => log('打开文件夹已发起：' + dir))
        p.on('error', (err) => log('打开文件夹失败：' + String(err && err.message) + ' dir=' + dir))
        p.unref()
      } catch (err) {
        return json(res, 500, { ok: false, why: '打开失败：' + String(err && err.message), dir })
      }
      json(res, 200, { ok: true, dir })
    },

    // 图库页面（浏览器打开，可靠替代"打开资源管理器"）
    async imageGallery(req, res) {
      const sp = qs(req)
      const e = entryOf(sp.get('session'))
      if (!e) { res.statusCode = 404; res.end('no session'); return }
      const root = rootOfKey(e.key)
      const items = IMG.listImages(root).reverse()
      const base = '/dsh-offline-memory/images/file?session=' + encodeURIComponent(e.sessionId) + '&id='
      const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))
      const html = '<!doctype html><meta charset="utf-8"><title>图片记忆</title>'
        + '<style>body{font:14px/1.6 system-ui;background:#1e1f26;color:#ddd;margin:0;padding:16px}h1{font-size:16px;font-weight:600}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.card{background:#2a2c36;border-radius:8px;padding:8px}.card img{width:100%;border-radius:6px;display:block;max-height:180px;object-fit:contain;background:#111}.d{color:#9aa;font-size:12px;margin-top:6px;word-break:break-all}.v{color:#f0a;font-size:11px}</style>'
        + '<h1>图片记忆 · ' + items.length + ' 张</h1><div class="grid">'
        + items.map((it) => '<div class="card"><img src="' + base + encodeURIComponent(it.id) + '"><div class="d">' + esc(it.desc) + '<div class="v">' + esc(it.verified || '') + ' · ' + esc(it.hash8 || '') + '</div></div></div>').join('')
        + '</div>'
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(html)
    },

    // 图库页面里的单张图（读文件返回字节）
    async imageFile(req, res) {
      const sp = qs(req)
      const e = entryOf(sp.get('session'))
      if (!e) { res.statusCode = 404; res.end('no session'); return }
      const root = rootOfKey(e.key)
      const it = IMG.listImages(root).find((x) => x.id === sp.get('id'))
      if (!it) { res.statusCode = 404; res.end('not found'); return }
      const p = path.join(IMG.imagePaths(root).dir, String(it.file || ''))
      try {
        const bytes = fs.readFileSync(p)
        res.statusCode = 200
        res.setHeader('content-type', /\.png$/i.test(it.file) ? 'image/png' : /\.webp$/i.test(it.file) ? 'image/webp' : /\.gif$/i.test(it.file) ? 'image/gif' : 'image/jpeg')
        res.setHeader('cache-control', 'no-store')
        res.end(bytes)
      } catch { res.statusCode = 404; res.end('not found') }
    },

    // 手动删除一条（从虚拟上下文 + 优化存储彻底移除）
    async importantDelete(req, res) {
      const b = await readBody(req).catch(() => ({}))
      const e = entryOf(b.session)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      const r = S.deleteItem(rootOfKey(e.key), b.id)
      json(res, 200, r)
    },

    async injectRecent(req, res) {
      const n = Number(qs(req).get('n')) || 20
      const rows = readJsonl(path.join(D(), 'inject.log.jsonl')).slice(-n).reverse().map((r) => ({
        at: r.at, session: r.session, trigger: r.trigger, used: r.used, budget: r.budget,
        blockHash: r.blockHash, items: (r.items || []).length, dropped: (r.dropped || []).length, preview: r.preview,
      }))
      json(res, 200, { ok: true, rows })
    },

    async injectBlock(req, res) {
      const hash = qs(req).get('hash')
      const row = readJsonl(path.join(D(), 'inject.log.jsonl')).slice().reverse().find((r) => r.blockHash === hash)
      if (!row) return json(res, 404, { ok: false, why: '找不到该次注入' })
      json(res, 200, { ok: true, block: row })
    },

    async injectPreview(req, res) {
      const b = await readBody(req).catch(() => ({}))
      const e = entryOf(b.session)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      if (typeof buildBlock !== 'function') return json(res, 200, { ok: false, why: '不可用' })
      const r = buildBlock(e.sessionId, String(b.query || ''))
      json(res, 200, { ok: true, text: r.text, used: r.used, dropped: r.dropped, kept: r.kept })
    },

    async injectReplay(req, res) {
      const b = await readBody(req).catch(() => ({}))
      const e = entryOf(b.session)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      const row = readJsonl(path.join(D(), 'inject.log.jsonl')).slice().reverse().find((r) => r.blockHash === b.hash)
      if (!row || !row.text) return json(res, 404, { ok: false, why: '找不到该次注入或没有全文' })
      if (row.session && String(row.session) !== String(e.sessionId)) return json(res, 404, { ok: false, why: '该次注入不属于当前会话' })
      if (typeof setReplay === 'function') setReplay(e.sessionId, row.text)
      json(res, 200, { ok: true, replayed: true })
    },

    async purge(req, res) {
      const b = await readBody(req)
      const e = entryOf(b.sessionId)
      if (!e) return json(res, 404, { ok: false, why: '该会话未挂载' })
      if (b.confirm !== true) return json(res, 400, { ok: false, why: '需要二次确认（confirm=true）' })
      const root = rootOfKey(e.key)
      S.snapshot(root, { keep: 1 })
      for (const f of ['vctx.json', 'optimized.jsonl', 'important.jsonl']) {
        try { fs.rmSync(path.join(root, f), { force: true }) } catch {}
      }
      try { fs.rmSync(path.join(root, 'journal'), { recursive: true, force: true }) } catch {}
      try { fs.rmSync(path.join(root, 'state'), { recursive: true, force: true }) } catch {}
      const reset = { status: 'pending', cursor: 0, turns: 0, bytes: 0, attempts: 0, purgedAt: nowIso() }
      writeJsonAtomic(path.join(root, 'bootstrap.json'), reset)
      C.updateSession(D(), b.sessionId, { bootstrap: reset })
      log(`清空存档：${b.sessionId}`)
      json(res, 200, { ok: true })
    },
  }

  const table = [
    ['overview', '/dsh-offline-memory/overview'],
    ['config', '/dsh-offline-memory/config'],
    ['sessions', '/dsh-offline-memory/sessions'],
    ['candidates', '/dsh-offline-memory/candidates'],
    ['addSession', '/dsh-offline-memory/sessions/add'],
    ['updateSession', '/dsh-offline-memory/sessions/update'],
    ['removeSession', '/dsh-offline-memory/sessions/remove'],
    ['moveSession', '/dsh-offline-memory/sessions/move'],
    ['archives', '/dsh-offline-memory/archives'],
    ['read', '/dsh-offline-memory/read'],
    ['save', '/dsh-offline-memory/save'],
    ['saveStatus', '/dsh-offline-memory/save/status'],
    ['backfill', '/dsh-offline-memory/backfill'],
    ['backfillStatus', '/dsh-offline-memory/backfill/status'],
    ['rebuildBase', '/dsh-offline-memory/rebuild-base'],
    ['importQA', '/dsh-offline-memory/import-qa'],
    ['migrate', '/dsh-offline-memory/migrate'],
    ['update', '/dsh-offline-memory/update'],
    ['updateGithub', '/dsh-offline-memory/update/github'],
    ['bootstrapSession', '/dsh-offline-memory/bootstrap'],
    ['rollback', '/dsh-offline-memory/rollback'],
    ['state', '/dsh-offline-memory/state'],
    ['retrieve', '/dsh-offline-memory/retrieve'],
    ['manage', '/dsh-offline-memory/manage'],
    ['preview', '/dsh-offline-memory/preview'],
    ['persona', '/dsh-offline-memory/persona'],
    ['qa', '/dsh-offline-memory/qa'],
    ['traitsRecalc', '/dsh-offline-memory/traits-recalc'],
    ['wakeNow', '/dsh-offline-memory/wake'],
    ['selftest', '/dsh-offline-memory/selftest'],
    ['recoveryTest', '/dsh-offline-memory/recovery-test'],
    ['injectRecent', '/dsh-offline-memory/inject/recent'],
    ['injectBlock', '/dsh-offline-memory/inject/block'],
    ['injectPreview', '/dsh-offline-memory/inject/preview'],
    ['injectReplay', '/dsh-offline-memory/inject/replay'],
    ['importantList', '/dsh-offline-memory/important/list'],
    ['importantDemote', '/dsh-offline-memory/important/demote'],
    ['importantDelete', '/dsh-offline-memory/important/delete'],
    ['images', '/dsh-offline-memory/images'],
    ['imageSave', '/dsh-offline-memory/images/save'],
    ['imageMark', '/dsh-offline-memory/images/mark'],
    ['imageDelete', '/dsh-offline-memory/images/delete'],
    ['revealImages', '/dsh-offline-memory/images/reveal'],
    ['imageGallery', '/dsh-offline-memory/images/gallery'],
    ['imageFile', '/dsh-offline-memory/images/file'],
    ['clean', '/dsh-offline-memory/clean'],
    ['purge', '/dsh-offline-memory/purge'],
  ]

  for (const [name, p] of table) {
    const handler = handlers[name]
    try { ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: p, handler })) } catch (e) { log(`路由注册失败 ${p}: ${e.message}`) }
  }
}
