// 评分器主体：托管（内置规则） 或 会话智能体接管（调当前模型）
// 两者输出同一个 0-10 重要度分数，下游（衰变期、分流）完全一致。
import * as SC from './score.mjs'

export const SCORER_PROMPT = [
  '你是记忆权重评分器。给下面这条对话打 0 到 10 分，表示它作为"长期记忆"的价值。',
  '打分参考：包含身份/约定/决定/偏好/规则/关键事实 → 高分；寒暄、确认、无信息量的应答 → 低分。',
  '只输出一个数字（可带一位小数），不要任何解释、标点或多余文字。',
].join('\n')

export function hostedScore(text, role) {
  try { return SC.rate(text, role).score } catch { return 5 }
}

/** 用会话所属模型打分；失败返回 {score:null, error}，由调用方回退托管 */
export async function sessionScore(text, role, { llm, provider, model, timeoutMs = 8000 } = {}) {
  if (!llm) return { score: null, error: '宿主没有 llm 服务' }
  if (!provider || !model) return { score: null, error: '未解析到可用模型' }
  try {
    const ac = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { ac.abort() } catch {} }, timeoutMs)
    let out = ''
    const types = {}
    const payload = `【${role}】${String(text || '').slice(0, 600)}`
    try {
      for await (const ch of llm.stream({
        provider,
        model,
        system: SCORER_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: payload }] }],
        temperature: 0,
        // 推理型模型会先花 token 思考：预算太小会导致只有 reasoning、没有正文
        maxTokens: 160,
        signal: ac.signal,
      })) {
        const t = ch && ch.type
        types[t] = (types[t] || 0) + 1
        if (t === 'text-delta') out += ch.text || ''
        else if (t === 'block-end' && ch.block && ch.block.text) out += ch.block.text
        // reasoning-delta 只用于诊断，不参与取分（那里会出现"0 到 10 分"这类区间数字）
        else if (t === 'error') return { score: null, error: 'error chunk: ' + (ch.failure?.message || '?') }
        else if (t === 'finish') {
          if (ch.reason?.kind === 'error' || ch.reason?.kind === 'aborted') {
            return { score: null, error: 'finish=' + ch.reason.kind + ' ' + (ch.reason.failure?.message || '') }
          }
          break
        }
      }
    } finally {
      clearTimeout(timer)
    }
    if (timedOut) return { score: null, error: `超时 ${timeoutMs}ms` }
    const m = String(out).match(/(\d+(?:\.\d+)?)/)
    if (!m) return { score: null, error: `输出里没有数字（len=${out.length} chunks=${JSON.stringify(types)}）` }
    let v = Number(m[1])
    if (!isFinite(v)) return { score: null, error: '分数非数字：' + m[1] }
    if (v > 10 && v <= 100) v = v / 10
    return { score: Math.max(0, Math.min(10, Math.round(v * 10) / 10)), error: null }
  } catch (e) {
    return { score: null, error: String(e && (e.message || e)) }
  }
}

/**
 * 统一入口。返回 {score, subject, error?}
 * subject: hosted | session | hosted-fallback
 */
export async function scoreText(text, role, cfg, env = {}) {
  if (cfg.scorerSubject === 'session') {
    const r = await sessionScore(text, role, {
      llm: env.llm,
      provider: env.provider,
      model: env.model,
      timeoutMs: cfg.scorerTimeoutMs,
    })
    if (r.score !== null) return { score: r.score, subject: 'session' }
    return { score: hostedScore(text, role), subject: 'hosted-fallback', error: r.error }
  }
  return { score: hostedScore(text, role), subject: 'hosted' }
}

/** 从配置或宿主默认模型解析出可用的 provider/model */
export function resolveModel(cfg, env = {}) {
  const raw = String(cfg.scorerModel || '').trim()
  if (raw.includes('/')) {
    const i = raw.indexOf('/')
    return { provider: raw.slice(0, i), model: raw.slice(i + 1) }
  }
  try {
    const sel = env.defaultModel && env.defaultModel()
    const provider = sel?.provider || sel?.route?.provider || sel?.model?.provider
    const model = sel?.model || sel?.route?.model || sel?.model?.model
    if (provider && model && typeof model === 'string') return { provider, model }
  } catch {}
  return { provider: '', model: '' }
}

export const DESCRIBE_PROMPT = '描述这张图里"能区分它和其他同风格图"的差异点：具体形状、颜色、位置、破损、不对称处、可辨认的文字/水印等。不要写"一个少女""一张设计图"这种放在别的图上也成立的话。一句话，不超过80字。'

// 描述质量闸：太短 / 像元描述（关于任务/文字/编号而非画面内容）→ 判失败
export function descQuality(desc) {
  const s = String(desc || '').trim()
  if (s.length < 8) return { ok: false, reason: '描述太短(<8字)' }
  if (/(字符|指令|编号)/.test(s)) return { ok: false, reason: '像元描述(字符/指令/编号)' }
  return { ok: true, reason: null }
}

/** 用视觉模型给图片生成描述；失败返回 {desc:null, error}，由调用方回退弱描述 */
export async function describeImage({ llm, provider, model, base64, mimeType, attachment, timeoutMs = 15000 } = {}) {
  if (!llm) return { desc: null, error: '宿主没有 llm 服务' }
  if (!provider || !model) return { desc: null, error: '未解析到可用模型' }
  if (!base64 && !attachment) return { desc: null, error: '没有图片数据' }
  try {
    const ac = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { ac.abort() } catch {} }, timeoutMs)
    let out = ''
    // 优先用附件引用（DeepSeek 走 Files API，内联 base64 可能被拒）；无附件再用内联
    const imgBlock = attachment
      ? { type: 'image', attachment }
      : { type: 'image', data: base64, mimeType: mimeType || 'image/png' }
    try {
      for await (const ch of llm.stream({
        provider, model,
        system: '',
        messages: [{ role: 'user', content: [imgBlock, { type: 'text', text: DESCRIBE_PROMPT }] }],
        temperature: 0,
        maxTokens: 500,
        reasoningEffort: 'off',   // 关掉思考，避免输出被"分析/自检"污染
        signal: ac.signal,
      })) {
        const t = ch && ch.type
        if (t === 'text-delta') out += ch.text || ''
        else if (t === 'block-end' && ch.block && ch.block.text) out += ch.block.text
        else if (t === 'error') return { desc: null, error: 'error chunk: ' + (ch.failure?.message || '?') }
        else if (t === 'finish') {
          if (ch.reason?.kind === 'error' || ch.reason?.kind === 'aborted') {
            const fm = ch.reason?.failure?.message || JSON.stringify(ch.reason?.failure || '')
            return { desc: null, error: 'finish=' + ch.reason.kind + ' ' + fm }
          }
          break
        }
      }
    } finally {
      clearTimeout(timer)
    }
    if (timedOut) return { desc: null, error: '超时 ' + timeoutMs + 'ms' }
    let desc = String(out).replace(/\s+/g, ' ').trim()
    // 去掉"回答：""方案："这类元前缀
    desc = desc.replace(/^[^：:]{0,12}(方案|回答|回复|描述|检查|确认|要求)[^：:]{0,12}[：:]\s*/, '').trim()
    desc = desc.replace(/\*/g, '').trim()
    // 去重重复句（模型有时把同一句说两遍）
    const segs = desc.split(/[。！？]/).map((s) => s.trim()).filter(Boolean)
    if (segs.length > 1) {
      const uniq = [...new Set(segs)]
      if (uniq.length < segs.length) desc = uniq.join('。') + '。'
    }
    desc = desc.slice(0, 120)
    return desc ? { desc, error: null } : { desc: null, error: '空输出' }
  } catch (e) {
    return { desc: null, error: String(e && (e.message || e)) }
  }
}
