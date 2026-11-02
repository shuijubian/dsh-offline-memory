// 语义同义改写测试：入库用原句，检索用改写句（换词/换说法），对比 3 种索引
// 托管打分，秒级跑完。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import * as C from '../lib/config.mjs'
import * as S from '../lib/store.mjs'

// [存储的问, 答案, 检索时用的改写问]
const SEMANTIC = [
  ['达拉斯的家在哪？', '炸了', '达拉斯的房子在什么地方'],
  ['我养的猫叫什么名字？', '豆包', '我家猫咪的称呼是啥'],
  ['我最讨厌吃什么？', '香菜', '我最反感哪种食材'],
  ['我的备用钥匙放在哪里？', '花盆底下', '我的应急钥匙搁哪儿了'],
  ['家里的WiFi密码是多少？', '折光螺旋四十七', '我家无线上网的密码'],
  ['我的车是什么牌子？', '老捷达', '我开的车是哪个牌子的'],
  ['公司楼下的咖啡店叫什么？', '三点水', '单位底下的咖啡厅名字'],
  ['我每天早上几点起床？', '六点四十', '我清晨一般几点起来'],
  ['我的生日是几月几号？', '四月九号', '我出生在几月几号'],
  ['我最喜欢的颜色是什么？', '深蓝', '我偏爱哪种颜色'],
  ['我的快递到哪了？', '昨天到驿站了', '我的包裹现在在哪儿'],
  ['冰箱里的牛奶过期了吗？', '上周三买的', '冰箱那盒奶还能不能喝'],
  ['周末想去爬山推荐个地方？', '西山步道', '周末爬山去哪儿好'],
  ['耳机左耳没声音了？', '线材接触问题', '耳机左边不响了是什么毛病'],
  ['番茄炒蛋先炒哪个？', '先炒蛋', '番茄炒蛋应该先下哪个'],
  ['这首歌副歌是风从海上来？', '海上的风', '这首歌高潮那句风从海上来的歌名'],
  ['阳台改成小书房怎么样？', '注意承重', '阳台改书房要注意啥'],
  ['地铁今天人特别多？', '早高峰', '今天地铁怎么那么挤'],
  ['这个月的电费好像涨了？', '空调开得多', '电费怎么比上月贵了'],
  ['说话能不能别这么冷？', '我试试说软一点', '你说话能温柔点吗'],
]

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'om-sem-'))
const sid = 'semantic-' + Date.now()
const cfg = { ...C.DEFAULT_CONFIG, enabled: true, scorerSubject: 'hosted', sessionId: sid, title: 'semantic-test', capacityTokens: 10000 }

const entry = C.addSession(root, sid, { title: 'semantic', capture: false, inject: false })
const sroot = C.sessionRoot(root, entry.key)
S.ensureLayout(sroot)

// 入库：原句 Q + 答
const msgs = []
let seq = 0
const now = Date.now()
for (const [q, a] of SEMANTIC) {
  msgs.push({ role: 'user', text: q, at: now - (40 - seq) * 60000, seq: ++seq })
  msgs.push({ role: 'assistant', text: '答：' + a + '。', at: now - (40 - seq) * 60000 + 400, seq: ++seq })
}
S.ingestMessages(sroot, sid, msgs, cfg, { defer: false })
// 清空 vctx
fs.writeFileSync(S.paths(sroot).vctx, JSON.stringify({ version: 2, capacityTokens: 10000, items: [], updatedAt: new Date().toISOString() }))

const byMode = {}
for (const mode of ['bm25', 'vector', 'hybrid']) {
  const cfg2 = { ...cfg, indexMode: mode }
  let correct = 0
  const detail = []
  for (const [, a, rewritten] of SEMANTIC) {
    const hits = S.retrieve(sroot, rewritten, cfg2, { limit: 3, revive: false })
    const recovered = hits.some((h) => String(h.summary || '').includes(a) || String(h.pair?.summary || '').includes(a))
    if (recovered) correct++
    else detail.push(rewritten + ' → ' + a)
  }
  byMode[mode] = { correct, total: SEMANTIC.length, rate: Math.round((correct / SEMANTIC.length) * 100), missed: detail }
}

console.log('=== 语义同义改写 · 20 组 · 托管打分 ===')
for (const [mode, m] of Object.entries(byMode)) {
  console.log(`  ${mode.padEnd(8)}: ${m.correct}/${m.total}  (${m.rate}%)`)
  if (m.missed.length) console.log('      未捞到: ' + m.missed.join(' | '))
}
fs.rmSync(root, { recursive: true, force: true })
