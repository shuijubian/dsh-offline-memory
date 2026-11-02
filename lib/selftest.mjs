// 自测核心：200 条样本 + 10 组问答，验证"清空上下文后能恢复记忆"
// 纯函数/纯存储，模型依赖由宿主注入。
import fs from 'node:fs'
import path from 'node:path'
import * as C from './config.mjs'
import * as S from './store.mjs'

export const QA_PAIRS = [
  ['达拉斯的家在哪？', '炸了'],
  ['我最喜欢的颜色是什么？', '深蓝'],
  ['我养的猫叫什么名字？', '豆包'],
  ['我的生日是几月几号？', '四月九号'],
  ['公司楼下的咖啡店叫什么？', '三点水'],
  ['我每天早上几点起床？', '六点四十'],
  ['我的备用钥匙放在哪里？', '花盆底下'],
  ['我最讨厌吃什么？', '香菜'],
  ['家里的WiFi密码是多少？', '折光螺旋四十七'],
  ['我的车是什么牌子？', '老捷达'],
]

// 日常填充，刻意避开上面 10 组答案的关键词，避免假阳性
const FILLER = [
  ['今天外面下雨了，伞忘在公司', '我记下了，明天提醒你带伞回来。'],
  ['中午吃的那家面馆叫什么', '巷口那家「三两面」，你点了牛肉面。'],
  ['帮我看看这个报错是什么意思', '这行是空指针，第八十三行那个对象还没初始化。'],
  ['下午三点要开会，提醒我', '好，三点前十分钟我会提醒你。'],
  ['这个月的电费好像涨了', '比上月多三成，可能空调开得多。'],
  ['我想把书桌换个位置', '靠窗光线更好，但要先挪插排。'],
  ['昨天那部电影结局什么意思', '开放结局，最后那个镜头是回放不是续集。'],
  ['周末想去爬山，推荐个地方', '西山步道，来回四小时，坡度缓。'],
  ['我的快递到哪了', '昨天到驿站了，取件码 8823。'],
  ['番茄炒蛋先炒哪个', '先炒蛋盛出，再炒番茄，最后回锅。'],
  ['记得我上次说的那个 bug 吗', '缓存没失效导致旧数据回填。'],
  ['这周有点累', '那就早点睡，明天的事明天再说。'],
  ['讲个你喜欢的故事', '我喜欢「等风来」，主角在山顶等一场风。'],
  ['冰箱里的牛奶过期了吗', '上周三买的，今天到期。'],
  ['为什么风扇一直响', '后台在跑编译，tsc 占了两核。'],
  ['今天想喝点甜的', '红糖姜茶，正好下雨。'],
  ['给一只橘猫起个名字', '叫「年糕」，又软又糯。'],
  ['你记得我生日吗', '四月九号——不对，这个明天再说。'],
  ['阳台改成小书房怎么样', '先量尺寸，注意承重和插座。'],
  ['这个句子语法对吗', '对的，删掉第二个「的」更干净。'],
  ['晚上吃什么好', '剩饭做个蛋炒饭，配紫菜汤。'],
  ['我想学做饭从哪开始', '番茄炒蛋、青椒肉丝、紫菜蛋花汤。'],
  ['这首歌副歌是风从海上来', '《海上的风》，原唱陈屿。'],
  ['明天要交的写完了吗', '大纲完了，正文还差两节。'],
  ['说话能不能别这么冷', '好，我试试说软一点。'],
  ['周四给妈妈打电话提醒我', '记下了，周四上午十点提示你。'],
  ['耳机左耳没声音了', '先换设备试试，八成是线材接触问题。'],
  ['地铁今天人特别多', '早高峰都这样，下次提前一班。'],
  ['我该换工作吗', '先把手头项目收尾，别在半山腰跳车。'],
  ['推荐本睡前书', '《小径分岔的花园》，一篇十分钟。'],
]

export function buildSample(n = 200) {
  const pairs = []
  const half = Math.floor(n / 2)
  const step = Math.max(1, Math.floor(half / 10))
  const qaByPos = new Map()
  for (let k = 0; k < 10; k++) qaByPos.set(Math.min(half - 1, k * step + Math.floor(step / 2)), QA_PAIRS[k])
  for (let k = 0; k < half; k++) {
    if (qaByPos.has(k)) {
      const [q, a] = qaByPos.get(k)
      pairs.push([q, '答：' + a + '。'])
    } else {
      pairs.push(FILLER[k % FILLER.length])
    }
  }
  const msgs = []
  let seq = 0
  const now = Date.now()
  for (const [u, a] of pairs) {
    msgs.push({ role: 'user', text: u, at: now - (n - seq) * 60000, seq: ++seq })
    msgs.push({ role: 'assistant', text: a, at: now - (n - seq) * 60000 + 400, seq: ++seq })
  }
  return msgs
}

/**
 * 跑一轮：入库 → 清空虚拟上下文 → 逐个检索 10 个问题 → 判断答案是否恢复 → 清理会话
 * scorer: async (text, role) => number
 */
export async function runRound(root, cfg, scorer, { purge = true } = {}) {
  const sid = cfg.sessionId
  const entry = C.addSession(root, sid, { title: cfg.title, capture: false, inject: false })
  const sroot = C.sessionRoot(root, entry.key)
  S.ensureLayout(sroot)

  const t0 = Date.now()
  if (cfg.scorerSubject === 'session') {
    // 会话接管：先只落底层，再批量打分
    S.ingestMessages(sroot, sid, cfg.messages, cfg, { defer: true })
    for (let i = 0; i < 80; i++) {
      const r = await S.processPending(sroot, cfg, 25, scorer)
      if (!r.remaining) break
    }
  } else {
    S.ingestMessages(sroot, sid, cfg.messages, cfg, { defer: false })
  }
  const ingestMs = Date.now() - t0

  const before = S.storeUsage(sroot)
  // 模拟上下文被压缩/清空：只清虚拟上下文，优化存储仍在
  const v = S.loadVctx(sroot)
  fs.writeFileSync(S.paths(sroot).vctx, JSON.stringify({ version: 2, capacityTokens: cfg.capacityTokens, items: [], updatedAt: new Date().toISOString() }))

  const results = QA_PAIRS.map(([q, a]) => {
    const hits = S.retrieve(sroot, q, cfg, { limit: 3, revive: false })
    const recovered = hits.some((h) => String(h.summary || '').includes(a) || String(h.pair?.summary || '').includes(a))
    const top = hits[0]
    return {
      q, a,
      recovered,
      rank: recovered ? 1 : 0,
      topSummary: top ? String(top.summary).slice(0, 28) : '',
      pairSummary: top && top.pair ? String(top.pair.summary).slice(0, 28) : '',
      hits: hits.length,
    }
  })

  if (purge) {
    try {
      C.removeSession(root, sid, { purge: true })
      fs.rmSync(sroot, { recursive: true, force: true })
    } catch {}
  }

  return {
    correct: results.filter((r) => r.recovered).length,
    total: results.length,
    results,
    ingestMs,
    storeBefore: { base: before.base.items, optimized: before.optimized.items, vctx: v.items.length },
  }
}

// 100 条随机 Q&A：答案带唯一编号（3 位补零），可精确核验无歧义
export function genQA100() {
  const pairs = []
  for (let i = 1; i <= 100; i++) {
    const n = String(i).padStart(3, '0')
    pairs.push([`第${i}号暗号是什么？`, `第${i}号暗号是「暗号${n}」`])
  }
  return pairs
}

// 矩阵测试：入库 → 清空虚拟上下文 → 用 bm25 / vector / hybrid 三种索引各捞一遍
export async function runRecoveryMatrix(root, cfg, scorer) {
  const sid = cfg.sessionId
  const entry = C.addSession(root, sid, { title: cfg.title, capture: false, inject: false })
  const sroot = C.sessionRoot(root, entry.key)
  S.ensureLayout(sroot)
  const pairs = genQA100()
  const msgs = []
  let seq = 0
  const now = Date.now()
  for (const [q, a] of pairs) {
    msgs.push({ role: 'user', text: q, at: now - (200 - seq) * 60000, seq: ++seq })
    msgs.push({ role: 'assistant', text: '答：' + a + '。', at: now - (200 - seq) * 60000 + 400, seq: ++seq })
  }
  const t0 = Date.now()
  if (cfg.scorerSubject === 'session') {
    S.ingestMessages(sroot, sid, msgs, cfg, { defer: true })
    for (let i = 0; i < 200; i++) { const r = await S.processPending(sroot, cfg, 25, scorer); if (!r.remaining) break }
  } else {
    S.ingestMessages(sroot, sid, msgs, cfg, { defer: false })
  }
  const ingestMs = Date.now() - t0
  fs.writeFileSync(S.paths(sroot).vctx, JSON.stringify({ version: 2, capacityTokens: cfg.capacityTokens, items: [], updatedAt: new Date().toISOString() }))

  const byMode = {}
  for (const mode of ['bm25', 'vector', 'hybrid']) {
    const cfg2 = { ...cfg, indexMode: mode }
    let correct = 0
    for (const [q, a] of pairs) {
      const hits = S.retrieve(sroot, q, cfg2, { limit: 3, revive: false })
      const recovered = hits.some((h) => String(h.summary || '').includes(a) || String(h.pair?.summary || '').includes(a))
      if (recovered) correct++
    }
    byMode[mode] = { correct, total: pairs.length, rate: Math.round((correct / pairs.length) * 100) }
  }
  try { C.removeSession(root, sid, { purge: true }); fs.rmSync(sroot, { recursive: true, force: true }) } catch {}
  return { subject: cfg.scorerSubject, ingestMs, byMode }
}
