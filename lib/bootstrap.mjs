// R3 首次开启的全量存档
// 契约：只落 L1（journal），不打分、不进 vctx；L2 由 background warming 回填。
// 幂等：sourceContextHash 相同即跳过；可续传：cursor 持久化；超限：降级但账目必须能对上。
import fs from 'node:fs'
import path from 'node:path'
import { readJson, writeJsonAtomic, nowIso, redact, sha256, estTokens, ensureDir } from './util.mjs'
import { paths, ensureLayout, ingestMessages, loadVctx } from './store.mjs'
import { listSessionLogs, readSessionMessages, zstdAvailable } from './decode.mjs'
import * as SC from './score.mjs'

export function findLog(dshHome, sessionId) {
  try {
    const logs = listSessionLogs(dshHome)
    return logs.find((l) => l.sessionId === sessionId) || null
  } catch { return null }
}

function sourceHashOf(sessionId, messages) {
  return sha256(`${sessionId}|${messages.length}|${messages[0]?.seq ?? ''}|${messages[messages.length - 1]?.seq ?? ''}`).slice(0, 32)
}

/** 超限降级：保留全部 user + 高分 assistant 原文，其余按窗口压成块摘要；账目必须闭合 */
function degrade(messages, cfg) {
  const keep = []
  const blocks = []
  let window = []
  const flush = () => {
    if (!window.length) return
    const text = window.map((m) => `${m.role}: ${m.text}`).join('\n')
    const { score } = SC.rate(text, 'assistant')
    blocks.push({
      seq: window[0].seq, at: window[0].at, turn: window[0].turn, role: 'assistant',
      text: `【压缩块·${window.length}条】${text.slice(0, 400)}`, covers: window.length, score,
    })
    window = []
  }
  for (const m of messages) {
    if (m.role === 'system') continue   // 系统提示不进记忆库
    const { score } = SC.rate(m.text, m.role)
    const worth = m.role === 'user' || score >= cfg.scoreLow
    if (worth) { flush(); keep.push(m) } else {
      window.push(m)
      if (window.length >= 20) flush()
    }
  }
  flush()
  const covered = blocks.reduce((n, b) => n + b.covers, 0)
  return { messages: [...keep, ...blocks].sort((a, b) => (a.seq || 0) - (b.seq || 0)), kept: keep.length, blocks, covered }
}

/**
 * 执行（或续跑）一次全量存档。
 * @returns {{status:'done'|'running'|'skipped'|'failed', ...}}
 */
export function runBootstrap(dshHome, root, sessionId, cfg, log = () => {}) {
  const p = ensureLayout(root)
  try {
    const state = readJson(p.bootstrap, { status: 'pending', cursor: 0, turns: 0, bytes: 0, attempts: 0 })

    const found = findLog(dshHome, sessionId)
    if (!found) return fail(p, state, '找不到会话日志文件（该会话可能从未落盘）', log)
    const { messages: raw, failed } = readSessionMessages(found.file)
    if (!raw.length) return fail(p, state, '会话日志里没有可存档的消息', log)

    const srcHash = sourceHashOf(sessionId, raw)
    if (state.status === 'done' && state.sourceHash === srcHash) {
      return { status: 'skipped', reason: 'hash 相同，已存档过', turns: state.turns }
    }

    // system prompt 入档（已决议），与消息同一套脱敏
    if (cfg.includeSystemPrompt) {
      const sys = raw.find((m) => m.role === 'system')
      if (sys) {
        const { text, hits } = redact(sys.text)
        writeJsonAtomic(p.systemSnapshot, {
          at: nowIso(), hash: sha256(sys.text).slice(0, 32), redacted: hits > 0,
          bytes: Buffer.byteLength(text), text,
        })
      }
    }

    let plan = raw
    let manifest = null
    if (raw.length > cfg.maxBootstrapItems) {
      const d = degrade(raw, cfg)
      plan = d.messages
      manifest = { at: nowIso(), sourceTotal: raw.length, kept: d.kept, blocks: d.blocks.length, covered: d.covered }
      // 账目闭合：原文条数 + Σ块覆盖 = 源总条数
      writeJsonAtomic(path.join(root, 'bootstrap-manifest.json'), manifest)
      const sum = d.kept + d.covered
      log(`bootstrap 降级：源 ${raw.length} 条 → 原文 ${d.kept} + 压缩 ${d.blocks.length} 块覆盖 ${d.covered}（合计 ${sum}）`)
      if (sum !== raw.length) log(`bootstrap 账目不平：${sum} != ${raw.length}（需人工核对）`)
    }

    let cursor = Math.min(Number(state.cursor) || 0, plan.length)
    writeJsonAtomic(p.bootstrap, {
      ...state, status: 'running', startedAt: state.startedAt || nowIso(),
      sourceHash: srcHash, sourceTotal: raw.length, planTotal: plan.length,
      cursor, attempts: (Number(state.attempts) || 0) + 1, failedFrames: failed,
    })

    // 分块写入，每块更新 cursor（进程被杀也能从断点续）
    while (cursor < plan.length) {
      const chunk = plan.slice(cursor, cursor + cfg.bootstrapChunk)
      const res = ingestMessages(root, sessionId, chunk, cfg, { origin: 'bootstrap' })
      cursor += chunk.length
      const prev = readJson(p.bootstrap, state)
      writeJsonAtomic(p.bootstrap, {
        ...prev, cursor, turns: cursor,
        bytes: (Number(prev.bytes) || 0) + chunk.reduce((n, m) => n + estTokens(m.text), 0),
        lastChunkAt: nowIso(),
      })
      if (!res.added && !res.dup && chunk.length) { /* 允许全 dup（续跑） */ }
      log(`bootstrap 块 ${Math.floor(cursor / cfg.bootstrapChunk)}：+${res.added} 条（dup ${res.dup}）`)
    }

    // 落地后不立刻算 L2：置 warming
    const v = loadVctx(root)
    writeJsonAtomic(p.vctx, { ...v, mode: 'warming', updatedAt: nowIso() })
    const done = readJson(p.bootstrap, {})
    writeJsonAtomic(p.bootstrap, {
      ...done, status: 'done', finishedAt: nowIso(), cursor, turns: cursor,
      manifest: manifest || null,
    })
    log(`bootstrap 完成：${cursor} 条入 L1，vctx 进入 warming`)
    return { status: 'done', turns: cursor, dupInfo: manifest }
  } catch (e) {
    return fail(p, readJson(p.bootstrap, {}), String(e && e.message), log)
  }
}

function fail(p, state, message, log) {
  writeJsonAtomic(p.bootstrap, { ...state, status: 'failed', lastError: message, failedAt: nowIso() })
  log(`bootstrap 失败：${message}`)
  return { status: 'failed', error: message }
}

export { zstdAvailable }
