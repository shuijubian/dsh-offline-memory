// 只存底层：从原始会话日志重建 journal（跳过 reasoning/system/空文本），
// 不写 optimized / vctx / vectors / pending。原始会话日志不碰。
//
// 用法: node lib/rebuild-base.mjs <sessionId> [dshHome]
import fs from 'node:fs'
import path from 'node:path'
import * as C from './config.mjs'
import * as S from './store.mjs'
import * as D from './decode.mjs'

const sid = process.argv[2]
const dshHome = process.argv[3] || (process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'))
const DATA_ROOT = path.join(dshHome, 'offline-memory')

if (!sid) { console.error('用法: node lib/rebuild-base.mjs <sessionId> [dshHome]'); process.exit(1) }

const reg = C.loadRegistry(DATA_ROOT)
const entry = C.findSession(reg, sid)
if (!entry) { console.error('未找到会话: ' + sid); process.exit(1) }
const root = C.sessionRoot(DATA_ROOT, entry.key)

// 定位原始会话日志
let file = null
if (fs.existsSync(path.join(dshHome, 'sessions'))) {
  for (const w of fs.readdirSync(path.join(dshHome, 'sessions'))) {
    const f = path.join(dshHome, 'sessions', w, sid, 'session.v4.jsonl.zstd')
    if (fs.existsSync(f)) { file = f; break }
  }
}
if (!file) { console.error('找不到原始日志: ' + sid); process.exit(1) }
console.log('原始日志: ' + file)

console.log('清空派生存储（不碰原始日志）...')
const cleared = S.clearStore(root)
console.log('  ' + JSON.stringify(cleared))

const { messages, failed } = D.readSessionMessages(file)
console.log('原始消息=' + messages.length + ' 解码失败=' + failed)

// 只写底层 journal（保留 Q&A 配对 replyTo）
let added = 0
let skipped = 0
let lastUserId = null
for (const m of messages) {
  if (m.role === 'system') { skipped++; continue }
  const text = String(m.text || '').trim()
  if (!text) { skipped++; continue }
  const r = S.appendJournal(root, {
    sessionId: sid, role: m.role, text, at: new Date(m.at).toISOString(),
    turnIndex: m.turn ?? 0, origin: 'bootstrap', seq: m.seq,
    refs: m.role === 'assistant' && lastUserId ? { replyTo: lastUserId } : null,
  })
  if (r.ok && !r.dup) { added++; if (m.role === 'user') lastUserId = r.item.id }
  else skipped++
}
console.log('底层写入=' + added + ' 条，跳过=' + skipped + ' 条')

const rows = S.readJournal(root)
const byRole = {}
for (const r of rows) byRole[r.role] = (byRole[r.role] || 0) + 1
const en = rows.filter((r) => r.role === 'assistant' && /^(The user|He |She |So:|I can see|He says|He asks|He wants)/.test(String(r.text).trim()))
console.log('底层=' + rows.length + ' 条，角色=' + JSON.stringify(byRole) + '，英文转述=' + en.length + ' 条')
