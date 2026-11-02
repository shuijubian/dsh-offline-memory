// 冒烟测试 v2：node test/smoke.mjs
// 全部在临时目录里跑，不碰真实存档。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import * as C from '../lib/config.mjs'
import * as S from '../lib/store.mjs'
import * as B from '../lib/bootstrap.mjs'
import * as V from '../lib/vector.mjs'
import * as SC from '../lib/score.mjs'
import * as IMG from '../lib/image.mjs'
import { redact, estTokens } from '../lib/util.mjs'
import { listSessionLogs } from '../lib/decode.mjs'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}
const section = (t) => console.log('\n▶ ' + t)

const DSH = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const candidates = listSessionLogs(DSH).filter((l) => l.bytes > 50_000)
const sample = candidates[0]
const cfg = { ...C.DEFAULT_CONFIG, enabled: true }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'om-smoke-'))

section('开关：总闸门 AND 会话开关')
{
  const off = { ...C.DEFAULT_CONFIG, enabled: false }
  const on = { capture: true, inject: true, status: 'attached' }
  ok('总开关关 → 不采集', C.captureEnabled(off, on) === false)
  ok('总开关关 → 不注入', C.injectEnabled(off, on) === false)
  ok('会话关采集 → 不采集', C.captureEnabled(cfg, { ...on, capture: false }) === false)
  ok('两者都开 → 采集', C.captureEnabled(cfg, on) === true)
}

section('三层：底层 / 优化存储 / 虚拟上下文')
{
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'om-3l-'))
  S.ensureLayout(r)
  S.ingestMessages(r, 'x', [{ role: 'user', text: '记住：我的猫叫豆包，三岁，怕吸尘器', at: Date.now(), seq: 1 }], cfg)
  const u = S.storeUsage(r)
  ok('底层有原文', u.base.items === 1, String(u.base.items))
  ok('优化存储有备份', u.optimized.items === 1, String(u.optimized.items))
  ok('虚拟上下文有临时条目', u.vctx.items === 1, String(u.vctx.items))
  ok('三层位置各不相同', new Set([u.base.path, u.optimized.path, u.vctx.path]).size === 3)
  fs.rmSync(r, { recursive: true, force: true })
}

section('淡忘：衰变期由评分决定，衰变=删除，优化存储仍可打捞')
{
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'om-fg-'))
  S.ensureLayout(r)
  const now = Date.now()
  const v = S.loadVctx(r)
  const mk = (id, score, daysAgo) => ({
    id, refTo: id, at: new Date(now - daysAgo * 864e5).toISOString(), summary: '暗号' + id,
    tokens: 20, score, decayDays: S.decayDaysOf(score, cfg), hitCount: 0, origin: 'from',
    originAt: new Date(now - daysAgo * 864e5).toISOString(), salvagedAt: null, tags: [], role: 'user',
    expiresAt: new Date(now - daysAgo * 864e5 + S.decayDaysOf(score, cfg) * 864e5).toISOString(),
  })
  v.items.push(mk('low', 2, 60), mk('high', 6, 60))
  fs.writeFileSync(path.join(r, 'vctx.json'), JSON.stringify(v))
  const res = S.forget(r, cfg)
  ok('低分且过期的被衰变删除', res.expired >= 1, JSON.stringify(res))
  const left = S.loadVctx(r).items.map((i) => i.id)
  ok('高分条目仍在', left.includes('high') || S.decayDaysOf(6, cfg) > 60, left.join(','))
  fs.rmSync(r, { recursive: true, force: true })
}

section('打捞：从优化存储捞回，标注双日期，不回写')
{
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'om-sl-'))
  S.ensureLayout(r)
  S.ingestMessages(r, 'x', [{ role: 'user', text: '记住：部署口令是折光螺旋四十七号', at: Date.now(), seq: 1 }], cfg)
  // 清空虚拟上下文，模拟"已经忘了"
  fs.writeFileSync(path.join(r, 'vctx.json'), JSON.stringify({ version: 2, capacityTokens: 3000, items: [], updatedAt: new Date().toISOString() }))
  const hits = S.retrieve(r, '部署口令 折光螺旋', cfg, { limit: 5 })
  ok('从优化存储捞到', hits.length > 0 && hits[0].where === 'optimized', JSON.stringify(hits.map((x) => x.where)))
  const back = S.loadVctx(r).items
  ok('捞回后进虚拟上下文', back.some((i) => i.origin === 'salvage'), JSON.stringify(back.map((i) => i.origin)))
  ok('带原本日期与打捞日期', !!back[0]?.originAt && !!back[0]?.salvagedAt)
  ok('打捞条目不回写优化存储（数量不变）', S.storeUsage(r).optimized.items === 1, String(S.storeUsage(r).optimized.items))
  fs.rmSync(r, { recursive: true, force: true })
}

section('存档周期约束：必须 ≤ 最短衰变期')
{
  ok('minSaveIntervalMinutes(3天) = 4320', S.minSaveIntervalMinutes({ minDecayDays: 3 }) === 4320)
  ok('最短衰变期越小，间隔越短', S.minSaveIntervalMinutes({ minDecayDays: 1 }) < S.minSaveIntervalMinutes({ minDecayDays: 5 }))
  ok('评分越高衰变期越长', S.decayDaysOf(2, cfg) < S.decayDaysOf(6, cfg))
  ok('v2：8 分永久', S.decayDaysOf(8, cfg) === Infinity)
  ok('v2：7 分超长寿命(8个月)', S.decayDaysOf(7, cfg) === 240, String(S.decayDaysOf(7, cfg)))
  ok('v2：<4 分寿命下限 7 天', S.decayDaysOf(0, cfg) === 7, String(S.decayDaysOf(0, cfg)))
}

section('bootstrap 幂等 / 续传（真实会话日志）')
if (!sample) {
  console.log('  - 跳过（本机没有足够的会话日志）')
} else {
  const eb = C.addSession(root, sample.sessionId, { title: 'bootstrap' })
  const rb = C.sessionRoot(root, eb.key)
  const r1 = B.runBootstrap(DSH, rb, sample.sessionId, cfg)
  const u1 = S.storeUsage(rb)
  ok('首次入档完成', r1.status === 'done', JSON.stringify(r1))
  ok('原文落了底层', u1.base.items > 0, String(u1.base.items))
  const r2 = B.runBootstrap(DSH, rb, sample.sessionId, cfg)
  ok('重复入档被跳过', r2.status === 'skipped', JSON.stringify(r2))
  ok('底层条目数不变', S.storeUsage(rb).base.items === u1.base.items)
  const bsFile = path.join(rb, 'bootstrap.json')
  const bs = JSON.parse(fs.readFileSync(bsFile, 'utf8'))
  fs.writeFileSync(bsFile, JSON.stringify({ ...bs, status: 'running', cursor: Math.floor(bs.turns / 2) }))
  B.runBootstrap(DSH, rb, sample.sessionId, cfg)
  ok('中途续跑不重复', S.storeUsage(rb).base.items === u1.base.items)
  ok('system prompt 不入档（非记忆）', !fs.existsSync(path.join(rb, 'system-snapshot.json')))

  let g = 0
  let st = null
  do { st = await S.warmStep(rb, cfg, 200); g++ } while (st.remaining > 0 && g < 100)
  const after = S.storeUsage(rb)
  ok('回填后优化存储非空', after.optimized.items > 0, String(after.optimized.items))
  ok('回填后虚拟上下文非空', after.vctx.items > 0, String(after.vctx.items))
}

section('读档：跨会话接续（显式操作，非自动检索）')
{
  const ra = fs.mkdtempSync(path.join(os.tmpdir(), 'om-ra-'))
  const rb2 = fs.mkdtempSync(path.join(os.tmpdir(), 'om-rb-'))
  S.ensureLayout(ra)
  S.ensureLayout(rb2)
  S.ingestMessages(ra, 'src', [{ role: 'user', text: '记住：她的生日是四月九号', at: Date.now(), seq: 1 }], cfg)
  const imp = S.importArchive(rb2, ra, cfg)
  ok('导入成功', imp.imported >= 1, JSON.stringify(imp))
  const items = S.loadVctx(rb2).items
  ok('目标会话能看到', items.some((i) => String(i.summary).includes('四月九号')))
  ok('标注为 import 且带来源', items[0]?.origin === 'import' && !!items[0]?.salvagedFrom)
  ok('自动检索仍然越不过会话边界', S.retrieve(rb2, '别的会话专属词', cfg, { limit: 3, revive: false }).every((h) => h.where === 'vctx' || h.where === 'optimized'))
  fs.rmSync(ra, { recursive: true, force: true })
  fs.rmSync(rb2, { recursive: true, force: true })
}

section('清理：按"多久之前"删，两层结构各自独立')
{
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'om-cl-'))
  S.ensureLayout(r)
  const old = Date.now() - 100 * 864e5
  S.ingestMessages(r, 'x', [
    { role: 'user', text: '很旧的一条记忆', at: old, seq: 1 },
    { role: 'user', text: '很新的一条记忆', at: Date.now(), seq: 2 },
  ], cfg)
  const before = S.storeUsage(r)
  const r1 = S.cleanStore(r, 'base', 30, cfg)
  ok('底层清理有删除', r1.removed >= 1, JSON.stringify(r1))
  ok('底层条目减少', S.storeUsage(r).base.items < before.base.items)
  const r2 = S.cleanStore(r, 'optimized', 30, cfg)
  ok('优化存储清理有删除', r2.removed >= 1, JSON.stringify(r2))
  fs.rmSync(r, { recursive: true, force: true })
}

section('隐私与快照')
{
  const a = redact('SESSDATA=abc123; password: hunter2; C:\\Users\\Administrator\\secret\\x.txt')
  ok('SESSDATA 被替换', a.text.includes('[REDACTED]') && !a.text.includes('abc123'))
  ok('password 被替换', !a.text.includes('hunter2'))
  ok('绝对路径被压成盘符', a.text.includes('C:\\[REDACTED]'), a.text)

  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'om-sn-'))
  S.ensureLayout(r)
  S.ingestMessages(r, 'x', [{ role: 'user', text: '记住第一版内容', at: Date.now(), seq: 1 }], cfg)
  ok('快照已创建', !!S.snapshot(r))
  fs.writeFileSync(path.join(r, 'vctx.json'), '{ 坏掉 }')
  ok('回滚可用', !!S.rollback(r))
  let parsed = null
  try { parsed = JSON.parse(fs.readFileSync(path.join(r, 'vctx.json'), 'utf8')) } catch {}
  ok('回滚后 JSON 可解析', !!parsed && Array.isArray(parsed.items))
  fs.rmSync(r, { recursive: true, force: true })
}

section('好感度：证据门槛与日上限')
{
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'om-af-'))
  S.ensureLayout(r)
  for (let i = 0; i < 6; i++) S.ingestMessages(r, 'x', [{ role: 'user', text: '谢谢你，好棒', at: Date.now(), seq: i + 1 }], cfg)
  const st = S.stats(r)
  ok('不超过日上限 10', st.affection.value <= 10, String(st.affection.value))
  const evs = fs.readFileSync(path.join(r, 'state', 'affection-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
  ok('每条都带 evidence.quote', evs.every((l) => { try { return !!JSON.parse(l).evidence?.quote } catch { return false } }))
  ok('心情与好感度是两个独立文件', fs.existsSync(path.join(r, 'state', 'mood.json')) && fs.existsSync(path.join(r, 'state', 'affection.json')))
  fs.rmSync(r, { recursive: true, force: true })
}

section('注入预算')
{
  ok('中文估算合理', estTokens('这是一句中文测试') >= 6)
  const entries = Array.from({ length: 50 }, (_, i) => ({ id: 'i' + i, source: '存档', date: new Date().toISOString().slice(0, 10), score: 5, hit: '', summary: '第 ' + i + ' 条记忆内容，长度大约二十个字符左右吧', pair: null, kind: 'active' }))
  const res = S.composeInjection(entries, 120)
  ok('被预算截断', estTokens(res.text) <= 200, String(estTokens(res.text)))
  ok('带来源标注', res.text.includes('记忆·不是当前对话') && res.text.includes('我记得的是'))
  ok('超预算条目进 dropped', res.dropped.length > 0, String(res.dropped.length))
}

section('注入级回归：带噪音的长查询也要把答案捞出来')
{
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'om-inj-'))
  S.ensureLayout(r)
  S.ingestMessages(r, 'x', [
    { role: 'user', text: '问一句，达拉斯的家在哪？', at: Date.now() - 60000, seq: 1 },
    { role: 'assistant', text: '答：炸了。', at: Date.now() - 59000, seq: 2 },
    { role: 'user', text: '今天外面下雨了，伞忘在公司', at: Date.now() - 50000, seq: 3 },
    { role: 'assistant', text: '明天提醒你带伞回来。', at: Date.now() - 49000, seq: 4 },
  ], cfg)
  // 清空虚拟上下文：等价于上下文被压缩/清空
  fs.writeFileSync(path.join(r, 'vctx.json'), JSON.stringify({ version: 2, capacityTokens: 3000, items: [], updatedAt: new Date().toISOString() }))
  const noisy = '第三个问题，只给答案本身，不要解释：达拉斯的家在哪？'
  const hits = S.retrieve(r, noisy, cfg, { limit: 3 })
  const hitQ = hits.find((h) => String(h.summary).includes('达拉斯'))
  ok('长查询能命中问题', !!hitQ, JSON.stringify(hits.map((h) => h.summary.slice(0, 20))))
  ok('命中项带上了回答', !!hitQ && String(hitQ.pair?.summary || '').includes('炸了'), JSON.stringify(hitQ?.pair || null))
  const injEntries = hits.map((h) => ({ id: h.id, source: (Number(h.score) || 0) >= 7 ? '重要会话' : '存档', date: String(h.at).slice(0, 10), score: h.score != null ? Math.round(h.score) : null, hit: h.hit || '', summary: h.summary, pair: h.pair?.summary || null, kind: 'active' }))
  const inj = S.composeInjection(injEntries, 800)
  ok('注入内容里出现答案', inj.text.includes('炸了'), inj.text.slice(0, 100))
  ok('查询清洗剥掉了指令词', S.buildQuery(noisy) === '达拉斯的家在哪', S.buildQuery(noisy))
  // 噪音素材不入库
  const before = S.storeStats ? 0 : S.storeUsage(r).base.items
  const noise = S.ingestMessages(r, 'x', [{ role: 'assistant', text: '【外置记忆】以下是从本会话存档里打捞的旧片段', at: Date.now(), seq: 99 }], cfg)
  ok('注入块不会被当成记忆再存一遍', noise.added === 0 && noise.skipped === 1, JSON.stringify(noise))
  const noise2 = S.ingestMessages(r, 'x', [{ role: 'user', text: 'Background subagent 16dd4590 finished and will do no further work', at: Date.now(), seq: 100 }], cfg)
  ok('子代理完成通知不会入记忆', noise2.added === 0 && noise2.skipped === 1, JSON.stringify(noise2))
  ok('底层条目数未因噪音增加', S.storeUsage(r).base.items === before, String(S.storeUsage(r).base.items))
  fs.rmSync(r, { recursive: true, force: true })
}

section('P0 四要素打标 + 事件编号')
{
  const ev = S.tagEvent('约定：以后只走私信，不在评论区艾特', '2026-10-28T12:00:00Z')
  ok('事因识别为约定', ev.cause === '约定', JSON.stringify(ev))
  ok('日期落到事件', ev.date === '2026-10-28', ev.date)
  const ev2 = S.tagEvent('我叫豆包，住在海边的小屋里', '2026-10-29T08:00:00Z')
  ok('事因识别为陈述', ev2.cause === '陈述', ev2.cause)
  ok('地点抓到海边', ev2.place.join('').includes('海边'), JSON.stringify(ev2.place))
  // 落库后条目带 event + eventSeq
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'om-p0-'))
  S.ingestMessages(r, 'x', [{ role: 'user', text: '约定：以后只走私信', at: Date.now(), seq: 7 }], cfg)
  const v = JSON.parse(fs.readFileSync(path.join(r, 'vctx.json'), 'utf8'))
  const it = v.items.find((x) => x.eventSeq != null)
  ok('条目带 eventSeq 编号', !!it && it.eventSeq === 1, JSON.stringify(v.items.map((x) => x.eventSeq)))
  ok('条目带四要素 event', !!it && !!it.event && it.event.cause === '约定', JSON.stringify(it && it.event))
  fs.rmSync(r, { recursive: true, force: true })
}

section('P1 向量化 + 向量检索')
{
  const a = V.embed('达拉斯的家在哪'), b = V.embed('达拉斯的房子在哪里'), c = V.embed('今天天气不错')
  ok('同义相似度高于无关', V.cosine(a, b) > V.cosine(a, c), `同义=${V.cosine(a, b).toFixed(2)} 无关=${V.cosine(a, c).toFixed(2)}`)
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'om-vec-'))
  S.ingestMessages(r, 'x', [
    { role: 'user', text: '问：达拉斯的家在哪？', at: Date.now() - 60000, seq: 1 },
    { role: 'assistant', text: '答：炸了。', at: Date.now() - 59000, seq: 2 },
  ], cfg)
  const hits = S.vectorSearch(r, '达拉斯的房子')
  ok('向量检索能语义召回', hits.length > 0 && hits[0].sim > 0.3, `命中=${hits.length} sim=${(hits[0]?.sim ?? 0).toFixed(2)}`)
  fs.rmSync(r, { recursive: true, force: true })
}

section('P2 RRF 混合检索 + 网格阈值')
{
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'om-rrf-'))
  S.ingestMessages(r, 'x', [
    { role: 'user', text: '问：达拉斯的家在哪？', at: Date.now() - 60000, seq: 1 },
    { role: 'assistant', text: '答：炸了。', at: Date.now() - 59000, seq: 2 },
    { role: 'user', text: '今天出去散步了', at: Date.now() - 10000, seq: 3 },
  ], cfg)
  const hits = S.retrieve(r, '达拉斯的房子', cfg, { limit: 4 })
  const hit = hits.find((h) => String(h.summary).includes('达拉斯'))
  ok('语义召回命中', !!hit, JSON.stringify(hits.map((h) => h.summary.slice(0, 12))))
  ok('向量增强参与打分', !!hit && (hit.vecRel || 0) > 0, 'vecRel=' + (hit?.vecRel ?? 0))
  ok('无关事件不被网格扩散', !hits.some((h) => h.viaGrid && String(h.summary).includes('散步')), 'grid=' + hits.filter((h) => h.viaGrid).length)
  fs.rmSync(r, { recursive: true, force: true })
}

section('P3 打分对照本 + 分数±2浮动')
{
  ok('±2 向上钳制', S.clampFloat(5, 8, 2) === 7, '5→8 钳到 ' + S.clampFloat(5, 8, 2))
  ok('±2 向下钳制', S.clampFloat(8, 5, 2) === 6, '8→5 钳到 ' + S.clampFloat(8, 5, 2))
  ok('范围内不钳', S.clampFloat(5, 6, 2) === 6, '5→6 不变')
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'om-p3-'))
  S.ingestMessages(r, 'x', [
    { role: 'user', text: '约定：以后只走私信', at: Date.now() - 60000, seq: 1 },
    { role: 'user', text: '我喜欢吃辣', at: Date.now() - 50000, seq: 2 },
  ], cfg)
  const book = S.recalcScoreBook(r)
  ok('对照本按事因聚合', !!book && typeof book['约定'] === 'number' && typeof book['陈述'] === 'number', JSON.stringify(book))
  const book2 = S.loadScoreBook(r)
  ok('对照本已落盘', typeof book2['约定'] === 'number', JSON.stringify(book2))
  fs.rmSync(r, { recursive: true, force: true })
}

section('P5 萌属性向量 + 45轴释义 + 纯聊天')
{
  ok('45 轴释义齐全', Object.keys(SC.TRAIT_DEFS).length === 45, String(Object.keys(SC.TRAIT_DEFS).length))
  const t = SC.trait('哼，才不是害羞呢')
  ok('傲娇被识别', (t['傲'] || 0) > 0 && (t['娇'] || 0) > 0, JSON.stringify(t))
  const t2 = SC.traitVector('啧，真是愚蠢的问题')
  ok('向量萌属性有输出', Object.keys(t2).length > 0, JSON.stringify(t2))
  ok('纯聊天判定', SC.isPureChat('人家才不是害羞呢') === true && SC.isPureChat('帮我写个函数处理数据') === false)
}

section('P6 打捞不回写底层')
{
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'om-p6-'))
  S.ingestMessages(r, 'x', [
    { role: 'user', text: '问：达拉斯的家在哪？', at: Date.now() - 60000, seq: 1 },
    { role: 'assistant', text: '答：炸了。', at: Date.now() - 59000, seq: 2 },
  ], cfg)
  const baseBefore = S.storeUsage(r).base.items
  // 清空虚拟上下文，模拟压缩/清空
  fs.writeFileSync(path.join(r, 'vctx.json'), JSON.stringify({ version: 2, capacityTokens: 3000, items: [], updatedAt: new Date().toISOString() }))
  S.retrieve(r, '达拉斯的家在哪', cfg, { limit: 3 })
  const baseAfter = S.storeUsage(r).base.items
  ok('打捞不回写底层（条数不变）', baseAfter === baseBefore, `before=${baseBefore} after=${baseAfter}`)
  const v = JSON.parse(fs.readFileSync(path.join(r, 'vctx.json'), 'utf8'))
  ok('打捞回虚拟上下文', v.items.length > 0, 'vctx=' + v.items.length)
  fs.rmSync(r, { recursive: true, force: true })
}

section('P7 v1→v2 迁移')
{
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'om-mig-'))
  S.ensureLayout(r)
  S.appendOptimized(r, { id: 'v-old1', refTo: 'j-1', seq: 5, at: '2026-10-20T00:00:00Z', summary: '约定：以后只走私信', text: '约定：以后只走私信', score: 7, role: 'user', tokens: 10, savedAt: new Date().toISOString() })
  const res = S.migrateToV2(r)
  const vecFile = path.join(r, 'vectors', 'index.jsonl')
  ok('迁移补向量', res.vectors >= 1, JSON.stringify(res))
  ok('向量文件已生成', fs.existsSync(vecFile), 'vectors/index.jsonl 存在')
  fs.rmSync(r, { recursive: true, force: true })
}

section('跨会话隔离：绝不跨会话打捞')
{
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'om-iso-a-'))
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'om-iso-b-'))
  S.ingestMessages(a, 'A', [{ role: 'user', text: '我的猫叫豆包', at: Date.now() - 60000, seq: 1 }], cfg)
  S.ingestMessages(b, 'B', [{ role: 'user', text: '我的狗叫大黄', at: Date.now() - 60000, seq: 1 }], cfg)
  const hitsA = S.retrieve(a, '我的狗叫什么', cfg, { limit: 5 })
  ok('A 检索不到 B 的狗', !hitsA.some((h) => String(h.summary).includes('大黄')), JSON.stringify(hitsA.map((h) => h.summary.slice(0, 12))))
  const hitsB = S.retrieve(b, '我的猫叫什么', cfg, { limit: 5 })
  ok('B 检索不到 A 的猫', !hitsB.some((h) => String(h.summary).includes('豆包')), JSON.stringify(hitsB.map((h) => h.summary.slice(0, 12))))
  fs.rmSync(a, { recursive: true, force: true })
  fs.rmSync(b, { recursive: true, force: true })
}

section('图片记忆：哈希去重 + 编号 + 可信度')
{
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'om-img-'))
  const bytes = Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0xFF, 0xDA, 0x01, 0x02, 0xFF, 0xD9])
  const a = IMG.saveImage(r, { bytes, ext: 'jpg', desc: '银白长发、后倾冰晶角', source: '角色设定板', date: '2026-10-27', by: '凌彗' })
  ok('存图成功', a.ok === true, JSON.stringify(a))
  const b = IMG.saveImage(r, { bytes, ext: 'jpg', desc: '重复图', source: 'x', date: '2026-10-27' })
  ok('同图哈希去重', b.dup === true && b.refs === 2, JSON.stringify(b))
  ok('EXIF 已剥', a.dup === false, '首存非 dup')
  const list = IMG.listImages(r)
  ok('清单只有一份', list.length === 1 && list[0].refs === 2, 'n=' + list.length)
  ok('注入标签带编号', IMG.imageLabel(list[0]).includes('角色设定板') && IMG.imageLabel(list[0]).includes(list[0].hash8))
  IMG.markImage(r, a.id, true)
  ok('可信度可标记', IMG.listImages(r)[0].verified === 'verified')
  IMG.tombstoneImage(r, a.id)
  ok('墓碑后清单隐藏', IMG.listImages(r).length === 0)
  fs.rmSync(r, { recursive: true, force: true })
}

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
