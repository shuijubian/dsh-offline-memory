// 回归测试：`agent/pre-step` 是 waterfall 事件，监听器必须把链路交回给 DSH。
// 不调用 next() 会被当成「否掉整条链路」，DSH 拿到的 decision 是 undefined，
// 随后 `decision.kind` 抛 TypeError → 每一轮都「本轮运行失败」。
//
// 这里按 cordis 的真实语义实现 waterfall：
//   waterfall(payload, inner) → 把监听器按注册顺序串起来，最外层先跑，
//   监听器返回什么就是整条链的结果；没调 next() 就等于吞掉内置决策。
//
// 跑法：node test/pre-step-waterfall.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   → ' + extra : '')) }
}

// 隔离数据目录，绝不碰真实存档
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'om-pre-step-'))
process.env.DSH_HOME = tmp

const listeners = new Map()
const disposers = []

const noopDisposer = () => {}
const ctx = new Proxy({
  on(name, cb) {
    const list = listeners.get(name) ?? []
    list.push(cb)
    listeners.set(name, list)
    return noopDisposer
  },
  effect(fn) {
    const out = fn()
    const dispose = typeof out === 'function' ? out : noopDisposer
    disposers.push(dispose)
    return dispose
  },
  get() { return undefined },
  agents: { list: () => [], get: () => undefined, requireInitiator: () => undefined, withInitiator: (_a, fn) => fn() },
  systemPrompt: { context: () => noopDisposer, section: () => noopDisposer },
  webServer: { register: () => noopDisposer },
}, {
  get(target, prop) {
    if (prop in target) return target[prop]
    // 未知服务：给一个「什么都不做」的函数，避免插件因为缺服务而直接抛
    return () => noopDisposer
  },
})

const mod = await import('../lib/host.js')
mod.apply(ctx)

const preStep = (listeners.get('agent/pre-step') ?? [])[0]
ok('插件注册了 agent/pre-step 监听器', typeof preStep === 'function')

// 按 cordis 的 waterfall 语义跑：内置决策是最后一环
const innerDecision = { kind: 'enter', messages: [] }
const runWaterfall = (payload) => {
  const chain = [preStep]
  const next = () => {
    const cb = chain.shift()
    return cb === undefined ? innerDecision : cb(payload, next)
  }
  return next()
}

let result
let threw = null
try {
  result = runWaterfall({
    agent: { sessionId: 'sess-test', session: { id: 'sess-test', messages: [] } },
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    turn: 1,
    step: 1,
  })
} catch (e) { threw = e }

ok('监听器不抛异常', threw === null, threw && threw.message)
ok('waterfall 返回了内置决策（没被吞掉）', result === innerDecision, JSON.stringify(result))
ok('返回对象有 kind 字段（DSH 会读 decision.kind）', result != null && typeof result.kind === 'string')
ok('空 payload 也不会吞掉链路', runWaterfall(undefined) === innerDecision)

// 清理
for (const d of disposers) { try { d() } catch {} }
fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
