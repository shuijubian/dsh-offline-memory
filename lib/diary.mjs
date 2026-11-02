// 日记注入：文件级来源，直接读文件，不进 vctx / 优化存储
// 按 ^## YYYY-MM-DD 切段，取最近 N 天，每天最多 maxCharsPerDay 字
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

/** 读一本日记，返回 [{ date, text }]，已按最近 N 天过滤 */
export function readDiary(file, recentDays, maxCharsPerDay) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const re = /^## (\d{4}-\d{2}-\d{2})(?:[ \t]*[·•].*)?$/gm
    // 用 matchAll，不手动碰 lastIndex（手动回退会在最后一个匹配后把 lastIndex 重置为 0，死循环 OOM）
    const matches = [...raw.matchAll(re)]
    const sections = []
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index + matches[i][0].length
      const end = i + 1 < matches.length ? matches[i + 1].index : raw.length
      const line = raw.slice(0, matches[i].index).split('\n').length   // 1-based 行号，定位用
      sections.push({ date: matches[i][1], body: raw.slice(start, end), line })
    }
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - (Number(recentDays) || 3))
    const out = []
    for (const s of sections) {
      const d = new Date(s.date + 'T00:00:00')
      if (isNaN(d.getTime()) || d.getTime() < cutoff.getTime()) continue
      const text = pickPriority(s.body, maxCharsPerDay)
      if (text) out.push({ date: s.date, text, line: s.line })
    }
    return out
  } catch {
    return []
  }
}
