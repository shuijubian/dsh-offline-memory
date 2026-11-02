// 旧档 → 新档 迁移命令
// 从原始会话日志重建底层存储：跳过 reasoning/tool（英文转述），得到纯净原始数据（user 原文 + assistant 最终回复）。
// 不碰原始会话日志；只清空并重建"派生存储"（journal/optimized/vctx/vectors）。
//
// 用法: node lib/rebuild.mjs <sessionId> [dshHome]
//   dshHome 默认取环境变量 DSH_HOME，否则 ~/.dsh
import fs from 'node:fs'
import path from 'node:path'
import * as C from './config.mjs'
import * as S from './store.mjs'
import * as B from './bootstrap.mjs'

const sid = process.argv[2]
const dshHome = process.argv[3] || (process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'))
const DATA_ROOT = path.join(dshHome, 'offline-memory')

if (!sid) {
  console.error('用法: node lib/rebuild.mjs <sessionId> [dshHome]')
  process.exit(1)
}

const cfg = C.loadConfig(DATA_ROOT)
const reg = C.loadRegistry(DATA_ROOT)
const entry = C.findSession(reg, sid)
if (!entry) {
  console.error('未找到会话: ' + sid + '（请先在设置页「启用会话」里添加该会话）')
  process.exit(1)
}
const root = C.sessionRoot(DATA_ROOT, entry.key)

// 统计旧档污染
const countPollution = () => {
  try {
    const rows = S.readJournal(root)
    const en = rows.filter((r) => r.role === 'assistant' && /^(The user|He |She |The task|So:|I can see|He says|He asks|He wants|Response:|Plan \(|Need:|Deliverable:)/.test((r.text || '').trim()))
    return { total: rows.length, enTrans: en.length }
  } catch { return { total: 0, enTrans: 0 } }
}

console.log('会话:', entry.title || sid, '(' + sid + ')')
const before = countPollution()
console.log('重建前: 底层 ' + before.total + ' 条，其中英文转述 ' + before.enTrans + ' 条')

console.log('清空派生存储（不碰原始日志）...')
const cleared = S.clearStore(root)
console.log('  清空:', JSON.stringify(cleared))

console.log('从原始会话日志重建...')
const r = B.runBootstrap(dshHome, root, sid, cfg, (m) => console.log('  ' + m))
console.log('  重建:', JSON.stringify(r))

const after = countPollution()
console.log('重建后: 底层 ' + after.total + ' 条，其中英文转述 ' + after.enTrans + ' 条')
console.log(after.enTrans === 0 ? '✓ 污染已清除' : '⚠️ 仍有 ' + after.enTrans + ' 条英文转述（可能原始日志本身含这类正文）')
