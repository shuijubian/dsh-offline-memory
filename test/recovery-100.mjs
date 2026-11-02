// 记忆恢复矩阵测试：100 条 Q&A × 3 种索引模式（bm25 / vector / hybrid）
// 用法: node test/recovery-100.mjs hosted    （托管打分，秒级）
//        node test/recovery-100.mjs session   （会话接管，需宿主 llm，走 /recovery-test 端点）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import * as C from '../lib/config.mjs'
import * as SC from '../lib/scoring.mjs'
import * as ST from '../lib/selftest.mjs'

const subject = process.argv[2] === 'session' ? 'session' : 'hosted'
if (subject === 'session') {
  console.error('会话接管打分需要在宿主内跑，请用 POST /dsh-offline-memory/recovery-test')
  process.exit(2)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'om-recovery-'))
const cfg = { ...C.DEFAULT_CONFIG, enabled: true, scorerSubject: 'hosted', sessionId: 'recovery-' + Date.now(), title: 'recovery-100', capacityTokens: 30000 }
const scorer = async (text, role) => SC.hostedScore(text, role)

ST.runRecoveryMatrix(root, cfg, scorer).then((r) => {
  console.log('=== 托管打分 · 100 条 Q&A · 3 种索引捞取成功率 ===')
  console.log('入库耗时: ' + r.ingestMs + 'ms')
  for (const [mode, m] of Object.entries(r.byMode)) {
    console.log(`  ${mode.padEnd(8)}: ${m.correct}/100  (${m.rate}%)`)
  }
  fs.rmSync(root, { recursive: true, force: true })
}).catch((e) => { console.error('失败: ' + e.message); fs.rmSync(root, { recursive: true, force: true }); process.exit(1) })
