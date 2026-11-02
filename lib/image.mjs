// 图片记忆（v2 图片保存，最小可用版）
// 原则（来自与智能体的讨论）：存图 ≠ "看见"图。纯文本接口只认两样：
//   一句能核对的文字描述 + 一个能打开的位置。
// 所以：存原图（哈希去重）+ 一行描述 + 来源/日期 + 私密标记；注入只给文字，需要时按编号取文件。
// 采集 = 保存时处理一次：存图 + 剥 EXIF + 哈希 + 描述向量索引（之后不重读图，只靠向量+文字）。
// 不做：图像语义检索、以图搜图、自动打标。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ensureDir, readJsonl, appendLine, writeTextAtomic, nowIso } from './util.mjs'
import * as V from './vector.mjs'

// index.jsonl 是 JSONL，用 readJsonl 读、用行写回
function writeIndex(p, rows) {
  writeTextAtomic(p.index, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
}

export function hashBytes(buf) {
  try { return crypto.createHash('sha256').update(buf).digest('hex') } catch { return '' }
}

// 剥 EXIF（JPEG）：去掉 APP1(EXIF/XMP)、APP2(ICC) 段，避免设备名/路径/账号痕迹泄漏
export function stripExif(buf) {
  try {
    if (!buf || buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return buf || Buffer.alloc(0)
    const out = [buf.subarray(0, 2)]   // SOI
    let i = 2
    while (i < buf.length - 1) {
      if (buf[i] !== 0xFF) { out.push(buf.subarray(i)); break }
      const marker = buf[i + 1]
      if (marker === 0xDA) { out.push(buf.subarray(i)); break }          // SOS：图像数据
      if (marker === 0xD9) { out.push(buf.subarray(i, i + 2)); break }    // EOI
      if (i + 3 >= buf.length) { out.push(buf.subarray(i)); break }
      const len = (buf[i + 2] << 8) | buf[i + 3]
      if (marker === 0xE1 || marker === 0xE2) { i += 2 + len; continue }  // 剥 EXIF/ICC
      out.push(buf.subarray(i, i + 2 + len))
      i += 2 + len
    }
    return Buffer.concat(out)
  } catch { return buf || Buffer.alloc(0) }
}

export function imagePaths(root) {
  return {
    dir: path.join(root, 'pics'),
    index: path.join(root, 'pics', 'index.jsonl'),
    tomb: path.join(root, 'pics', 'tombstones.jsonl'),
  }
}

// 按年/月分区 + 编号 + 内容哈希短码命名：v-<hash8>-01.jpg（多图后缀补零）
function fileFor(p, hash8, ext, seq) {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dir = path.join(p.dir, String(y), String(m))
  ensureDir(dir)
  const n = String(seq || 1).padStart(2, '0')
  const ext2 = String(ext || 'jpg').replace(/^\./, '').toLowerCase()
  return path.join(dir, `v-${hash8}-${n}.${ext2}`)
}

/**
 * 存图：按内容哈希去重。同图只存一份，多条记忆指向它（引用计数）。
 * @returns {id, hash, hash8, file, dup, refs}
 */
export function saveImage(root, { bytes, ext = 'jpg', desc = '', source = '', date = nowIso(), privateFlag = false, verified = 'suspect', by = '' }) {
  try {
    const p = imagePaths(root)
    ensureDir(p.dir)
    const clean = stripExif(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []))
    const hash = hashBytes(clean)
    if (!hash) return { ok: false, error: '空图' }
    const hash8 = hash.slice(0, 8)
    const rows = readJsonl(p.index)
    const existing = rows.find((r) => r.hash === hash)
    if (existing) {
      existing.refs = (Number(existing.refs) || 0) + 1
      writeIndex(p, rows)
      return { ok: true, id: existing.id, hash, hash8, file: existing.file, dup: true, refs: existing.refs }
    }
    const file = fileFor(p, hash8, ext, rows.length + 1)
    fs.writeFileSync(file, clean)
    const id = `img-${hash8}`
    rows.push({
      id, hash, hash8, file: path.relative(p.dir, file),
      desc, source, date, private: !!privateFlag, verified, by,
      refs: 1, savedAt: nowIso(),
      // 描述向量索引：保存时算一次，之后检索不再重读图
      vec: Array.from(V.embed(`${desc} ${source}`)),
    })
    writeIndex(p, rows)
    return { ok: true, id, hash, hash8, file, dup: false, refs: 1 }
  } catch (e) {
    return { ok: false, error: String(e && e.message) }
  }
}

export function listImages(root) {
  try {
    return readJsonl(imagePaths(root).index).filter((r) => !r.tombstonedAt)
  } catch { return [] }
}

// 标记描述可信度：verified（核对过）/ suspect（存疑，允许反驳）
export function markImage(root, id, verified) {
  try {
    const p = imagePaths(root)
    const rows = readJsonl(p.index)
    const it = rows.find((r) => r.id === id)
    if (!it) return { ok: false, error: '找不到' }
    it.verified = verified === true ? 'verified' : 'suspect'
    writeIndex(p, rows)
    return { ok: true, verified: it.verified }
  } catch (e) { return { ok: false, error: String(e && e.message) } }
}

// 墓碑：条目删了图不立刻删，标墓碑 30 天后回收
export function tombstoneImage(root, id) {
  try {
    const p = imagePaths(root)
    const rows = readJsonl(p.index)
    const it = rows.find((r) => r.id === id)
    if (!it) return { ok: false, error: '找不到' }
    it.tombstonedAt = nowIso()
    writeIndex(p, rows)
    appendLine(p.tomb, { id, at: nowIso(), file: it.file })
    return { ok: true }
  } catch (e) { return { ok: false, error: String(e && e.message) } }
}

// 彻底删除一张图：删文件 + 删索引条目
export function deleteImage(root, id) {
  try {
    const p = imagePaths(root)
    const rows = readJsonl(p.index)
    const idx = rows.findIndex((r) => r.id === id)
    if (idx < 0) return { ok: false, error: '找不到' }
    const it = rows[idx]
    try { fs.rmSync(path.join(p.dir, String(it.file || '')), { force: true }) } catch {}
    rows.splice(idx, 1)
    writeIndex(p, rows)
    return { ok: true }
  } catch (e) { return { ok: false, error: String(e && e.message) } }
}

// 更新已有图片的描述（并重算向量）：用于给占位描述的旧图补上真/弱描述
export function updateImageDesc(root, id, desc, verified) {
  try {
    const p = imagePaths(root)
    const rows = readJsonl(p.index)
    const it = rows.find((r) => r.id === id)
    if (!it) return { ok: false, error: '找不到' }
    it.desc = String(desc || '').slice(0, 120)
    if (verified) it.verified = verified
    it.vec = Array.from(V.embed(`${it.desc} ${it.source || ''}`))
    writeIndex(p, rows)
    return { ok: true }
  } catch (e) { return { ok: false, error: String(e && e.message) } }
}

// 注入标签：只给文字 + 编号，不塞路径
export function imageLabel(img) {
  const title = String(img.source || '图').slice(0, 20)
  const ver = img.verified === 'verified' ? '✓' : (img.verified === 'suspect' ? '?' : '')
  return `[图·${String(img.date || '').slice(0, 10)}｜${title}｜${img.hash8 || ''}${ver}] ${String(img.desc || '').slice(0, 60)}`
}

// 从消息内容里提取图片块（只收用户发的图，不收助手/工具产出）：
//   ① 内联 base64：{type:'image', data, mimeType}
//   ② 附件引用：{type:'image', attachment:{attachmentId:'sha256:..', mediaType, name}}
export function extractImagesFromMessages(messages) {
  const out = []
  for (const msg of messages || []) {
    const m = msg?.message || msg
    if (String(m?.role || msg?.role || '') !== 'user') continue   // 只存用户发的图
    const c = m?.content
    if (typeof c === 'string' || !Array.isArray(c)) continue
    const textParts = []
    for (const b of c) {
      if (b && typeof b === 'object' && typeof b.text === 'string') textParts.push(b.text)
    }
    const caption = textParts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 120)
    for (const b of c) {
      if (!b || typeof b !== 'object') continue
      if (b.type !== 'image') continue
      if (typeof b.data === 'string' && b.data) {
        out.push({ data: b.data, mimeType: b.mimeType || 'image/png', caption })
        continue
      }
      const att = b.attachment
      if (att && typeof att.attachmentId === 'string') {
        out.push({ attachmentId: att.attachmentId, mimeType: att.mediaType || 'image/jpeg', name: att.name || '', caption, attachment: att })
      }
    }
  }
  return out
}
