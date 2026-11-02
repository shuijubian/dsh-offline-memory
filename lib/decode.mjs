// 会话日志解码器
// DSH 把每个会话存成 <DSH_HOME>/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd，
// 文件是「多帧拼接」的 zstd：每帧压一条 JSONL 事件（已验证：2637 帧 / 4534 行 / 0 失败）。
// 单帧 zstdDecompressSync 只会解出第一条，所以这里按帧魔数切分后逐帧解。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

export const zstdAvailable = () => typeof zlib.zstdDecompressSync === 'function'

function magicOffsets(buf) {
  const offs = []
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) offs.push(i)
  }
  return offs
}

// 逐帧解压。压缩数据内部偶然出现魔数时，会让该边界解压失败 → 自动并入下一帧重试。
export function decodeZstdJsonl(buf) {
  if (!zstdAvailable()) throw new Error('当前 Node 不支持 zstd（需要 Node >= 23.8）')
  const offs = magicOffsets(buf)
  if (!offs.length) throw new Error('未找到 zstd 帧')
  const lines = []
  let failed = 0
  for (let i = 0; i < offs.length; i++) {
    const start = offs[i]
    let text = null
    for (let j = i + 1; j <= offs.length; j++) {
      const end = j < offs.length ? offs[j] : buf.length
      try {
        text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
        i = j - 1
        break
      } catch { /* 边界不对，扩到下一帧 */ }
    }
    if (text === null) { failed++; continue }
    for (const line of text.split('\n')) if (line.trim()) lines.push(line)
  }
  return { lines, failed, frames: offs.length }
}

// 扫描所有会话日志，返回可挂载的会话清单
export function listSessionLogs(dshHome) {
  const root = path.join(dshHome, 'sessions')
  const out = []
  let workspaces = []
  try { workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()) } catch { return out }
  for (const ws of workspaces) {
    const wsDir = path.join(root, ws.name)
    let sessions = []
    try { sessions = fs.readdirSync(wsDir, { withFileTypes: true }).filter((e) => e.isDirectory()) } catch { continue }
    for (const s of sessions) {
      const dir = path.join(wsDir, s.name)
      let files = []
      try { files = fs.readdirSync(dir).filter((f) => /^session\.v\d+\.jsonl\.zstd$/.test(f)) } catch { continue }
      for (const f of files) {
        const p = path.join(dir, f)
        let st = null
        try { st = fs.statSync(p) } catch {}
        out.push({
          sessionId: s.name,
          workspace: ws.name,
          file: p,
          bytes: st ? st.size : 0,
          mtime: st ? st.mtimeMs : 0,
        })
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => {
      if (!b) return ''
      if (typeof b === 'string') return b
      const t = b.type
      // 与 host.js 的 textOf 一致：跳过 reasoning（模型思考）和 tool 调用，只取正文/最终回复
      if (t === 'reasoning' || t === 'tool-call' || t === 'tool-removal' || t === 'tool-addition') return ''
      if (t === 'text' || b.text !== undefined) return String(b.text ?? '')
      return ''
    })
    .join('')
}

// 从事件流里抽出对话消息（user / assistant / system），按 seq 升序
export function extractMessages(events) {
  const msgs = []
  for (const e of events) {
    if (!e || typeof e !== 'object') continue
    const t = String(e.type || '')
    if (t !== 'user/message' && t !== 'assistant/message' && t !== 'system/message') continue
    const d = e.data || {}
    // 两种落盘形状：assistant/system 用 data.message；user/message 直接是 data.content + data.role
    const m = d.message || (d.content ? d : null) || e.message
    if (!m) continue
    const text = textOfContent(m.content)
    if (!text) continue
    msgs.push({
      seq: Number(e.seq ?? 0),
      at: Number(e.time ?? 0) || Date.now(),
      turn: Number(e.data?.turn ?? 0) || 0,
      role: m.role || (t === 'user/message' ? 'user' : t === 'assistant/message' ? 'assistant' : 'system'),
      text,
      kind: t,
    })
  }
  msgs.sort((a, b) => (a.seq || a.at) - (b.seq || b.at))
  return msgs
}

export function readSessionMessages(file) {
  const buf = fs.readFileSync(file)
  const { lines, failed } = decodeZstdJsonl(buf)
  const events = []
  for (const line of lines) {
    try { events.push(JSON.parse(line)) } catch {}
  }
  const msgs = extractMessages(events)
  const header = events.find((e) => e && e.type === 'session') || {}
  return { messages: msgs, failed, header }
}

// 扫描事件流里的图片附件（只收 user/message，即用户发的图）
export function extractImageAttachments(events) {
  const out = []
  for (const e of events) {
    if (!e || typeof e !== 'object') continue
    if (String(e.type || '') !== 'user/message') continue   // 只存用户发的图
    const d = e.data || {}
    const m = d.message || (d.content ? d : null) || e.message
    if (!m) continue
    const c = m.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      if (!b || typeof b !== 'object' || b.type !== 'image') continue
      if (b.attachment && typeof b.attachment.attachmentId === 'string') {
        out.push({ attachmentId: b.attachment.attachmentId, mimeType: b.attachment.mediaType || 'image/jpeg', name: b.attachment.name || '', attachment: b.attachment })
      } else if (typeof b.data === 'string' && b.data) {
        out.push({ data: b.data, mimeType: b.mimeType || 'image/png', name: '' })
      }
    }
  }
  return out
}

// 从会话日志文件读图片附件（存档时兜底：实时消息取不到图时用）
export function readSessionImageAttachments(file) {
  try {
    const buf = fs.readFileSync(file)
    const { lines } = decodeZstdJsonl(buf)
    const events = []
    for (const line of lines) { try { events.push(JSON.parse(line)) } catch {} }
    return extractImageAttachments(events)
  } catch { return [] }
}

/** 会话元信息：给"选择会话"用可读标题，而不是让用户看文件名 */
export function readSessionMeta(file) {
  try {
    const buf = fs.readFileSync(file)
    const { lines } = decodeZstdJsonl(buf)
    const events = []
    for (const line of lines) {
      try { events.push(JSON.parse(line)) } catch {}
    }
    const header = events.find((e) => e && e.type === 'session') || {}
    const titles = events.filter((e) => e && e.type === 'session/title')
    // 优先级：用户手动改名(user) > 模型生成(provider) > 兜底(fallback)
    const user = titles.filter((t) => t.data?.source?.kind === 'user')
    const provider = titles.filter((t) => t.data?.source?.kind === 'provider')
    const pick = (user.length ? user : (provider.length ? provider : titles)).pop()
    let title = pick?.data?.title || ''
    let source = pick?.data?.source?.kind || 'none'
    // 还没有标题事件时，用第一条用户消息当名字，别让用户对着目录名猜
    if (!title) {
      const firstUser = events.find((e) => e && e.type === 'user/message')
      const d = firstUser?.data || {}
      const m = d.message || (d.content ? d : null)
      const text = m ? textOfContent(m.content).replace(/\s+/g, ' ').trim() : ''
      if (text) { title = text.slice(0, 28) + (text.length > 28 ? '…' : ''); source = 'first-message' }
    }
    return {
      id: header.id || null,
      cwd: header.cwd || '',
      createdAt: header.createdAt || 0,
      title,
      titleSource: source,
    }
  } catch {
    return { id: null, cwd: '', createdAt: 0, title: '', titleSource: 'none' }
  }
}
