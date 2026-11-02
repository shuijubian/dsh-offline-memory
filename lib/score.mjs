// 内置评分器（v1：确定性启发式，不依赖任何外部模型/插件）
// 接口对齐规格：rate(text) → 0-10；mood(text) → {delta}；trait(text) → 命中轴观测值
// 失败一律 fail-open：任何异常都返回中性结果，绝不阻塞对话
import * as V from './vector.mjs'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// 只保留"真会被长期记住"的强标记；我是/我在/我的 这类口头高频词会把 pinned 灌爆
const MEMORY_MARKERS = /(记住|记下|约定|我叫|我的名字|以后|今后|决定|规则|务必|请记住|永远|从不|不许|只能)/g
// 重要三类（约定 / 身份陈述 / 结论）：宁空不可错，这类内容评分要够得上"重要"
const CONVENTION = /(答应|约定|以后|今后|从此|不许|不能|不准|规则|必须|务必|记得|记住|永远|只走私信|只在|边界|底线)/
const SELF_STATEMENT = /(我是|我叫|我姓|我的名字|我的生日|我喜欢|我讨厌|我不喜欢|我住在|我家在|我的家|我的车|我的猫|我的狗|我养|身份|人格|性格|偏好)/
const CONCLUSION = /(结论|搞定|完成|解决了|通过了|做完了|成功了|最终|就这么定)/
const QUESTION_MARKERS = /(为什么|怎么|如何|是否|要不要|能不能|可不可以|选择|方案|计划|问题|区别|对比|建议)/g
const GREETING = /^(在吗|在不在|你好|您好|hi|hello|嗯|哦|噢|好的|ok|okay|谢谢|多谢|哈哈|收到|明白)[\s!！。.]*$/i
const POSITIVE = /(喜欢|开心|高兴|谢谢|太好了|棒|厉害|温柔|可爱|爱|舒服|满意|赞|不错|好耶|成功|完成)/g
const NEGATIVE = /(讨厌|难过|烦|累|生气|失望|糟糕|失败|焦虑|害怕|痛|崩溃|无语|生气|不想)/g

export function rate(text, role = 'user') {
  try {
    const s = String(text || '')
    if (!s.trim()) return { score: 0, band: 'empty' }
    // 校准原则：>=mid(7) 必须是"真值得长期记"的少数，否则 pinned 膨胀、容量淘汰失效
    let score = 3.5
    const mem = (s.match(MEMORY_MARKERS) || []).length
    if (mem) score += Math.min(2.5, mem * 1.25)
    const q = (s.match(QUESTION_MARKERS) || []).length
    if (q) score += Math.min(2, q)
    if (s.length >= 120) score += 0.5
    if (s.length >= 400) score += 0.5
    if (/[?？]$/.test(s.trim())) score += 0.5
    if (/\d{2,}|[A-Za-z_]{4,}|\d{4}-\d{2}-\d{2}/.test(s)) score += 0.5
    // 重要三类（约定/身份/结论）直接抬到 8，保证能进重要会话（否则约定只拿 6 分，永远进不了永久档）
    if (role === 'user' && (CONVENTION.test(s) || SELF_STATEMENT.test(s) || CONCLUSION.test(s))) score = Math.max(score, 8)
    if (GREETING.test(s.trim())) score -= 3
    // 短不等于没价值：一问一答里的「答：炸了」只有两个字，却正是要记的东西
    else if (s.trim().length < 8) score -= role === 'assistant' ? 0.5 : 2
    if (role === 'assistant' && s.trim().length <= 12) score += 1.5
    if (role === 'assistant' && s.length < 20) score -= 1
    // 长篇助手回复里"关键词恰好出现"不算记忆价值，扣掉长度红利
    if (role === 'assistant' && s.length > 800) score -= 0.5
    score = clamp(score, 0, 10)
    return { score: Math.round(score * 10) / 10, band: bandOf(score) }
  } catch {
    return { score: 5, band: 'mid', failOpen: true }
  }
}

export function bandOf(score, low = 4, mid = 7) {
  if (score >= mid) return 'important'
  if (score >= low) return 'mid'
  return 'low'
}

export function mood(text) {
  try {
    const s = String(text || '')
    const pos = (s.match(POSITIVE) || []).length
    const neg = (s.match(NEGATIVE) || []).length
    const delta = clamp((pos - neg) * 2, -8, 8)
    return { delta, dims: { pos, neg } }
  } catch {
    return { delta: 0, dims: {} }
  }
}

// 轴名与初版 45 轴一致；这里只覆盖能被文本稳定触发的子集，其余轴保持静默
const TRAIT_RULES = [
  ['傲', /(哼|才不|不要你管|本小姐|当然|理所当然|自大|骄傲)/g],
  ['娇', /(害羞|脸红|才不是|别、别|不好意思|羞|人家)/g],
  ['冰', /(冷静|冷淡|无所谓|沉默|随便|不想说|淡淡)/g],
  ['柔', /(温柔|轻轻|没关系|慢慢来|别着急|照顾)/g],
  ['热', /(太棒了|冲|兴奋|热情|好耶|冲鸭|！！)/g],
  ['酷', /(帅|有个性|风格|酷|利落)/g],
  ['黑', /(呵呵|有趣|原来如此|可惜|倒是|阴谋)/g],
  ['纯', /(真的吗|好可爱|天真|纯洁|相信)/g],
  ['疯', /(哈哈哈+|疯了|离谱|哈哈|笑死)/g],
  ['呆', /(诶\?|欸|啊\?|什么\?|懵|不懂|发呆)/g],
  ['毒', /(愚蠢|可笑|无聊|废话|啧|幼稚)/g],
  ['慵', /(好累|懒|不想动|躺|睡了|困)/g],
  ['中二', /(命运|黑暗|封印|觉醒|世界|诅咒)/g],
  ['醋缸', /(谁|别人|她|他|吃醋|在意)/g],
  ['急', /(快点|赶紧|马上|立刻|急)/g],
  ['好奇', /(为什么|怎么会|好奇|想知道|\?)/g],
  ['认真', /(确认|准确|严谨|核对|确保)/g],
  ['怕麻烦', /(麻烦|懒得|算了|不想管)/g],
  ['正义', /(公平|正义|不应该|对错|原则)/g],
  ['羞', /(别说了|不要|害羞|尴尬)/g],
]

// 45 轴释义（v2：萌属性向量运算的比对基准，关键词即向量特征）
export const TRAIT_DEFS = {
  傲: '高傲 冷淡 趾高气昂 傲娇',
  娇: '娇羞 害羞 娇俏 脸红 不好意思',
  弱: '气势弱 没主见 不自信 弱气',
  柔: '温柔 温和 柔顺 友善 照顾',
  冰: '高冷 冷淡 生人勿近 冰美人 沉默',
  热: '热情 热血 充满干劲 兴奋 好耶',
  酷: '冷傲 外冷内热 酷 冷娇 利落',
  八卦: '八卦 爱打听 小道消息',
  直率: '直率 直接 不藏情绪 直言',
  疯: '疯癫 天然疯 活泼 脱线 哈哈',
  自主: '自主 有主见 强气 独立',
  黑: '腹黑 表面和善 内心算计 呵呵',
  病: '病态 病娇 病态爱意 占有',
  慵: '慵懒 慢性子 没干劲 好累 躺',
  急: '急性子 急躁 效率 快点 马上',
  静: '安静 文静 文雅 乖巧',
  无邪: '天真无邪 没心机 纯洁',
  幸灾乐祸: '幸灾乐祸 见别人遭殃高兴',
  呆: '天然呆 呆萌 迟钝 纯真 懵',
  醋缸: '爱吃醋 独占欲强 在意 谁',
  爆: '脾气火爆 暴力 暴娇 生气',
  电: '电波系 三观异 听不懂 奇怪',
  中二: '中二病 自我中心 幻想 命运 黑暗',
  纯: '纯情 清纯 不懂糟糕 天真',
  毒: '毒舌 挑毛病 打击自信 骂人不带脏字 啧',
  迷: '迷糊 冒失 笨手笨脚 出错',
  好奇: '好奇心强 爱追问 为什么 想知道',
  无感情: '莫得感情 没情绪波动 冷淡',
  三无: '三无 无口 无心 无表情',
  正义: '正义感 打抱不平 公平 原则',
  狂: '狂气 狂妄 自傲 狂放',
  羞: '害羞 怕羞 羞怯 逃避 别说了',
  认真: '认真 较真 做到最好 严谨 核对',
  怕麻烦: '怕麻烦 逃避 烦心 懒得 算了',
  自来熟: '自来熟 初次见面像老熟人',
  笨: '笨蛋 蠢萌 直率 无心机',
  吃货: '贪吃 爱吃美食 好吃',
  恋爱脑: '恋爱脑 只有恋爱 过度付出',
  固执: '固执 坚持己见 不易动摇',
  雌小鬼: '雌小鬼 嚣张挑衅 被教训服软',
  脱线: '脱线 突然说莫名其妙的话',
  混乱: '逻辑混乱 思维跳跃',
  完美主义: '完美主义 尽善尽美 不容瑕疵',
  吝啬: '拮据 吝啬 小气 舍不得花钱',
  贪婪: '贪得无厌 无法满足 想要更多',
}

const _axisVecCache = new Map()
function axisVector(axis) {
  if (!_axisVecCache.has(axis)) _axisVecCache.set(axis, V.embed(TRAIT_DEFS[axis] || axis))
  return _axisVecCache.get(axis)
}

// 返回命中的轴观测值（0-100），未命中的轴不出现，交给 EMA 保持不变
// v2：正则精确命中（高权重）+ 向量语义命中（45 轴释义余弦，补漏）
export function trait(text) {
  try {
    const s = String(text || '')
    const obs = {}
    for (const [axis, re] of TRAIT_RULES) {
      const hits = (s.match(re) || []).length
      if (hits) obs[axis] = clamp(50 + hits * 12, 0, 100)
    }
    const tv = V.embed(s)
    for (const [axis, def] of Object.entries(TRAIT_DEFS)) {
      if (obs[axis] != null) continue
      const sim = V.cosine(tv, axisVector(axis))
      if (sim > 0.08) obs[axis] = clamp(Math.round(sim * 120), 0, 100)
    }
    return obs
  } catch {
    return {}
  }
}

// 纯向量萌属性（v2）：只用 45 轴释义余弦，供 Q&A 样本向量运算调用
export function traitVector(text) {
  try {
    const tv = V.embed(String(text || ''))
    const out = {}
    for (const [axis, def] of Object.entries(TRAIT_DEFS)) {
      const sim = V.cosine(tv, axisVector(axis))
      if (sim > 0.08) out[axis] = clamp(Math.round(sim * 120), 0, 100)
    }
    return out
  } catch { return {} }
}

// 阵营双轴：order 守序(+) / 混乱(-)；moral 善良(+) / 邪恶(-)，取值 -100..100
export function alignment(text) {
  try {
    const s = String(text || '')
    let order = 0
    let moral = 0
    if (/(规则|秩序|法律|传统|流程|制度|按规矩)/.test(s)) order += 30
    if (/(自由|随便|反抗|打破|不管|随性|逃)/.test(s)) order -= 30
    if (/(帮助|善良|温柔|照顾|善意|原谅)/.test(s)) moral += 30
    if (/(欺骗|恶意|伤害|利用|报复|算计)/.test(s)) moral -= 30
    return { order: clamp(order, -100, 100), moral: clamp(moral, -100, 100) }
  } catch {
    return { order: 0, moral: 0 }
  }
}

const PRAISE = /(喜欢你|好棒|太厉害|真厉害|谢谢你|爱你|做得好|辛苦了|靠谱|太强了)/
const DONE = /(完成|搞定|成功|解决了|跑通了|通过了)/

// 好感度只能由可核验事件推动，且必须有 evidence（quote + offsets + hash）
export function affectionEvent(text, role = 'user') {
  try {
    const s = String(text || '')
    if (!s.trim()) return null
    if (role === 'user' && PRAISE.test(s)) return { type: 'user_praise_explicit', cap: 3, quote: s.slice(0, 120) }
    if (DONE.test(s)) return { type: 'task_completed', cap: 2, quote: s.slice(0, 120) }
    return null
  } catch {
    return null
  }
}

// Q&A 问答样本：萌属性与阵营的数据依据（娱乐性质）。
// 按句切，只取"短且有个人色彩"的那一句，避免整段长文被当成样本。
const FLAVOR = /(你|我|喜欢|讨厌|觉得|想要|绝不|永远|可爱|烦|才不|哼)/
// v2：纯聊天判定（偏闲聊是娱乐项本意；只为过滤"明显不是聊天"的内容）
const TASK_KEY = /(帮我|请做|查一下|改一下|写|删|编译|部署|运行|测试|调试|修复|打包|代码|路径|http|token|函数|类)/
const CHAT_CUE = /(你|我|主人|喜欢|讨厌|开心|烦|啦|嘛|呢|呀|哼|才不|觉得|想)/

export function isPureChat(text, role = 'assistant') {
  try {
    const s = String(text || '')
    if (!s.trim()) return false
    if (TASK_KEY.test(s)) return false            // 命令/任务/代码 → 不是纯聊天
    if (role === 'assistant' && s.length > 200) return false   // 答太长，多为工作内容
    if (role === 'user' && s.length > 80) return false
    return CHAT_CUE.test(s)                        // 含人称/情感/语气词
  } catch { return false }
}

export function qaSample(text, role = 'assistant') {
  try {
    const parts = String(text || '').split(/[。！？!?\n；;]/).map((x) => x.trim()).filter(Boolean)
    for (const p of parts) {
      if (p.length < 6 || p.length > 60) continue
      if (!FLAVOR.test(p)) continue
      // 排除代码/命令片段，别把 `const PROMPT = ...` 记成"问答样本"
      if (/[`{}()=;<>|]|^\s*(const|let|var|import|export|function|class)\b/.test(p)) continue
      if (!isPureChat(p, role)) continue
      const { score } = rate(p, role)
      if (score < 3) continue
      return { at: new Date().toISOString(), role, text: p, score, kind: 'qa', axesHint: trait(p) }
    }
    return null
  } catch {
    return null
  }
}

// 「重要会话」收窄：只收三类，且只认 user 原文（assistant 的转述/推理不进永久档）
export function isImportant(text, role = 'user') {
  try {
    const s = String(text || '')
    if (role !== 'user') return false   // 重要会话只从 user 原文产生
    return CONVENTION.test(s) || SELF_STATEMENT.test(s) || CONCLUSION.test(s)
  } catch { return false }
}
