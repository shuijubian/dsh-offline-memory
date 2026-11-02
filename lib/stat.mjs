#!/usr/bin/env node
// 打印当前存档统计：node lib/stat.mjs [sessionId]
import path from 'node:path'
import * as C from './config.mjs'
import * as S from './store.mjs'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const DSH = process.env.DSH_HOME || path.join(HOME, '.dsh')
const ROOT = path.join(DSH, 'offline-memory')

const cfg = C.loadConfig(ROOT)
const reg = C.loadRegistry(ROOT)
const want = process.argv[2]

const kb = (n) => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + 'MB' : (n / 1024).toFixed(0) + 'KB')

console.log('外置记忆 dsh-offline-memory')
console.log('  数据目录   ' + ROOT)
console.log('  总开关     ' + (cfg.enabled ? '已启用' : '已关闭'))
console.log('  挂载会话   ' + reg.sessions.filter((s) => s.status === 'attached').length + ' / 共 ' + reg.sessions.length)
console.log('  衰变期     ' + cfg.minDecayDays + '–' + cfg.maxDecayDays + ' 天（评分 ≥' + cfg.scoreMid + ' 永久）')
console.log('  唤醒       ' + cfg.wakeEveryDays + ' 天一次，时段 ' + cfg.wakeStart + '–' + cfg.wakeEnd +
  (cfg.wakeOnStartup ? '，开机唤醒' : '') + (cfg.autoSave ? '，自动存档' : ''))
console.log('  评分器     ' + (cfg.scorerSubject === 'session' ? '会话智能体接管' : '托管') +
  ' · ' + (cfg.scorerMode === 'onSave' ? '存档时打分' : '即时打分'))
console.log('')

const rows = reg.sessions.filter((s) => !want || s.sessionId === want)
if (!rows.length) { console.log('  （没有挂载的会话）'); process.exit(0) }

for (const entry of rows) {
  const root = C.sessionRoot(ROOT, entry.key)
  let st
  try { st = S.stats(root) } catch { st = { error: true } }
  const bs = st.bootstrap || entry.bootstrap || {}
  console.log(`▶ ${entry.title || entry.sessionId}`)
  console.log(`  id=${entry.sessionId}  capture=${entry.capture ? 'on' : 'off'}  inject=${entry.inject ? 'on' : 'off'}  status=${entry.status}`)
  console.log(`  底层原文 ${st.baseItems ?? 0} 条 ｜ 优化存储 ${st.optimizedItems ?? 0} 条 ｜ 虚拟上下文 ${st.vctxItems ?? 0} 条 / ${st.vctxTokens ?? 0} token`)
  console.log(`  今日到期 ${st.expiringToday ?? 0} ｜ 打捞中 ${st.salvaged ?? 0} ｜ 待回填 ${st.pendingWarm ?? 0}`)
  if (st.usage) {
    console.log(`  占用 底层 ${kb(st.usage.base.bytes)} / 优化 ${kb(st.usage.optimized.bytes)} / 虚拟 ${kb(st.usage.vctx.bytes)}`)
  }
  console.log(`  bootstrap ${bs.status || 'pending'}${bs.turns ? ' (' + bs.turns + ' 条)' : ''} ｜ 快照 ${st.snapshots ?? 0} 份`)
  console.log(`  心情 ${st.mood?.value ?? 70} ｜ 好感 ${st.affection?.value ?? 0} ｜ 问答样本 ${st.qaSamples ?? 0}`)
  console.log('')
}
