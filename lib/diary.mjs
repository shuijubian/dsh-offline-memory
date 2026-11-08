// 日记注入：文件级来源，直接读文件，不进 vctx / 优化存储
// 切段规则：任何 `## ` 标题；标题里**任意位置**出现 YYYY-MM-DD 就归到那天；
//           没有日期的二级标题（如 `## 看过` / `## 05:20 · 某段`）挂到**上一条**有日期的段上。
// 读不到会通过 onWarn 出声，不再静默返回空数组。
import fs from 'node:fs'
import path from 'node:path'

export function resolveSourcePath(dshHome, src) {
  const p = String((src && src.path) || '')
  if (!p) return ''
  return path.isAbsolute(p) ? p : path.join(dshHome, p)
}

const cap = (s, max) => {
  const t = String(s || '').replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

const stripTable = (s) => String(s || '').split('\n').filter((l) => !l.trim().startsWith('|')).join('\n')

// 段落内按优先级取内容：**给他的信** > **收藏/发出去** > 表格行前 3 行 > 正文
function pickPriority(body, max) {
  let m = body.match(/\*\*给他的信\*\*([\s\S]*?)(?=\n\*\*|\n##|\n---|$)/)
  if (m && m[1].trim()) return cap(m[1], max)
  m = body.match(/\*\*(?:收藏|发出去[^*]*)\*\*([\s\S]*?)(?=\n\*\*|\n##|\n---|$)/)
  if (m && m[1].trim()) { const t = cap(stripTable(m[1]), max); if (t) return t }
  const rows = body.split('\n').filter((l) => l.trim().startsWith('|') && !l.includes('---'))
  if (rows.length) return cap(rows.slice(0, 3).join(' / '), max)
  const plain = body.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('>') && !l.trim().startsWith('|') && !l.trim().startsWith('*')).join(' ')
  return cap(plain, max)
}

const DATE_RE = /(\d{4}-\d{2}-\d{2})/

/**
 * 读一本日记，返回 [{ date, text, line }]，按最近 N 天过滤。
 * @param onWarn 可选：(info) => void，读不到/全过期时回调，用于告警（不再静默）
 */
export function readDiary(file, recentDays, maxCharsPerDay, onWarn) {
  const warn = (info) => { try { if (typeof onWarn === 'function') onWarn(info) } catch {} }
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    warn({ why: 'read-failed', file, error: String(e && e.message) })
    return []
  }
  try {
    const heads = [...raw.matchAll(/^## .*$/gm)]
    if (!heads.length) { warn({ why: 'no-headings', file }); return [] }
    const sections = []
    let undated = 0
    for (let i = 0; i < heads.length; i++) {
      const head = heads[i][0]
      const m = head.match(DATE_RE)
      // 只认标题里带日期的段。无日期的直接跳过——不猜日期、也不挂靠到上一条
      // （挂靠没有边界：文件里第一条有日期、后面全无日期时，会把整本一次拖进窗口）
      if (!m) { undated += 1; continue }
      const start = heads[i].index + head.length
      const end = i + 1 < heads.length ? heads[i + 1].index : raw.length
      sections.push({ date: m[1], body: raw.slice(start, end), line: raw.slice(0, heads[i].index).split('\n').length })
    }
    if (!sections.length) { warn({ why: 'no-dates', file, headings: heads.length, undated }); return [] }
    if (undated) warn({ why: 'skipped-undated', file, undated, used: sections.length })
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - (Number(recentDays) || 3))
    const out = []
    for (const s of sections) {
      const d = new Date(s.date + 'T00:00:00')
      if (isNaN(d.getTime()) || d.getTime() < cutoff.getTime()) continue
      const text = pickPriority(s.body, maxCharsPerDay)
      if (text) out.push({ date: s.date, text, line: s.line })
    }
    if (!out.length) {
      warn({
        why: 'out-of-window', file, days: Number(recentDays) || 3,
        sections: sections.length, newest: sections[sections.length - 1].date,
      })
      return []
    }
    return out
  } catch (e) {
    warn({ why: 'parse-failed', file, error: String(e && e.message) })
    return []
  }
}

/** 只统计标题格式，给排查/预览用：不读正文 */
export function diaryShape(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const heads = [...raw.matchAll(/^## .*$/gm)].map((m) => m[0])
    const withDate = heads.filter((h) => DATE_RE.test(h))
    return { exists: true, headings: heads.length, withDate: withDate.length, sample: heads.slice(0, 5) }
  } catch {
    return { exists: false, headings: 0, withDate: 0, sample: [] }
  }
}
