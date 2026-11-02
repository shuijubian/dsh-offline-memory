// 配置与会话注册表
import path from 'node:path'
import { ensureDir, readJson, writeJsonAtomic, nowIso, sessionKey } from './util.mjs'

export const DEFAULT_CONFIG = {
  schemaVersion: 2,
  enabled: false,                 // R1 总开关：默认关闭
  testMode: false,                // 测试模式：只写独立沙箱，不碰真实会话内容；关闭即清空沙箱
  capacityTokens: 3000,           // 虚拟上下文容量，按 token 不按条数
  minDecayDays: 7,                // 寿命下限（可调）；唤醒间隔必须 ≤ 它
  maxDecayDays: 180,              // 兼容保留：v2 已用 lmaxDays 取代
  pinForever: true,               // score ≥ 8 的条目不衰变（v2：8 分永久）
  lmaxDays: 90,                   // v2：Lmax（满分 7 的参考寿命，固定，不随 N 缩放）
  decay7Months: 8,                // v2：7 分事件寿命（月），默认 8；衰变掉有打捞兜底
  scoreFloatRange: 2,             // v2：打捞重打分相对旧分允许的浮动（±）
  indexMode: 'hybrid',            // v2：索引模式 hybrid=混合增强 | vector=向量 | bm25=关键词
  gridDepth: 3,                   // v2：网格扩展深度（"三子级"=3）
  gridLevel0: 3,                  // v2：第 0 级（直接命中）最多几条
  gridPerLevel: 5,                // v2：第 1–3 级每级最多几条
  gridTotal: 15,                  // v2：单次打捞硬总量
  gridBudgetRatio: 0.6,           // v2：总 token 上限（占 injectBudget 比例）
  gridClusterThreshold: 0.3,     // v2：同类事件聚类余弦阈值（特征哈希下 0.3；换稠密模型后调 0.75）
  windowDays: 90,                 // 兼容保留：不再作为淘汰触发
  halfLifeDays: 30,
  reserveRatio: 0.2,              // 近端保留区比例
  hitCap: 5,                      // hitCount 权重封顶
  injectBudget: 1500,             // 单轮注入总预算（上限不是目标，只注入需要的）
  personaInjectDays: 0,           // 人设周期注入（天），0=仅更新或上下文缺失时注入
  imageSaveEnabled: true,         // 启用图片存储：关闭时不保存会话里的图
  updateRepo: '',                 // GitHub 仓库（owner/repo），用于"从 GitHub 更新"
  snapshotKeep: 5,
  bootstrapChunk: 200,            // 每块条数
  maxBootstrapItems: 200000,
  captureByDefault: true,
  injectByDefault: true,
  scoreLow: 4,
  scoreMid: 7,
  reviveMinRel: 0.35,
  reviveMinFinal: 6,
  reviveCooldownHours: 24,
  warmPerTick: 50,
  includeSystemPrompt: false,     // system 提示（人设/指令）不是"记忆"，不入档（每轮本就携带）

  // —— 唤醒机制（取代"存档周期"）——
  wakeEveryDays: 1,               // 每几天唤醒一次
  wakeStart: '20:00',             // 唤醒时段开始
  wakeEnd: '23:00',               // 唤醒时段结束
  wakeOnStartup: true,            // 软件开启时自动唤醒一次
  autoSave: true,                 // 唤醒时自动存档（补齐日志 + 快照）

  // —— 评分器 ——
  scorerSubject: 'hosted',        // hosted=托管（内置规则，零成本） | session=会话智能体接管（调模型）
  scorerMode: 'instant',          // instant=即时打分 | onSave=存档/唤醒时统一打分
  scorerModel: '',                // 留空用默认模型；格式 provider/model
  scorerTimeoutMs: 8000,

  // —— 外部记忆源（文件级来源，永远排最前；日记只是其中一个例子）——
  // 用于「传递记忆时支持外部组件」：别的智能体/插件写的笔记、日记、备忘录都能接进来。
  // 每个源：{ id, kind(标签前缀), label(备注，说明这本能干嘛), path(相对 DSH_HOME 或绝对),
  //          enabled, private, recentDays, maxChars }
  externalSources: [
    { id: 'diary-public', kind: '日记', label: '给主人那本', path: 'whale-diary.md', enabled: true, private: false, recentDays: 3, maxChars: 400 },
    { id: 'diary-private', kind: '日记', label: '私密', path: 'whale-diary-private.md', enabled: false, private: true, recentDays: 3, maxChars: 400 },
  ],
}

export const DEFAULT_SESSION = {
  capture: true,
  inject: true,
  profileId: 'default',
  status: 'attached',
}

export function configPath(root) { return path.join(root, 'config.json') }
export function registryPath(root) { return path.join(root, 'sessions.json') }

export function loadConfig(root) {
  const raw = readJson(configPath(root), null)
  const merged = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) }
  delete merged.archiveIntervalMinutes   // v1.1 的"存档周期"已被唤醒机制取代
  // 迁移旧 diary* 字段 → externalSources（只在用户没配过 sources 时）
  const hasLegacyDiary = raw && (raw.diaryPublicPath !== undefined || raw.diaryPrivatePath !== undefined || raw.diaryEnabled !== undefined)
  const hasSources = Array.isArray(merged.externalSources) && merged.externalSources.length > 0
  if (hasLegacyDiary && !hasSources) {
    merged.externalSources = [
      { id: 'diary-public', kind: '日记', label: '给主人那本', path: raw.diaryPublicPath || 'whale-diary.md', enabled: raw.diaryEnabled !== false, private: false, recentDays: raw.diaryRecentDays ?? 3, maxChars: raw.diaryMaxCharsPerDay ?? 400 },
      { id: 'diary-private', kind: '日记', label: '私密', path: raw.diaryPrivatePath || 'whale-diary-private.md', enabled: raw.diaryPrivateEnabled === true, private: true, recentDays: raw.diaryRecentDays ?? 3, maxChars: raw.diaryMaxCharsPerDay ?? 400 },
    ]
  }
  return merged
}

export function saveConfig(root, cfg) {
  ensureDir(root)
  return writeJsonAtomic(configPath(root), { ...DEFAULT_CONFIG, ...cfg, updatedAt: nowIso() })
}

export function loadRegistry(root) {
  const raw = readJson(registryPath(root), null)
  if (raw && Array.isArray(raw.sessions)) return { schemaVersion: 1, ...raw }
  return { schemaVersion: 1, sessions: [] }
}

export function saveRegistry(root, reg) {
  ensureDir(root)
  return writeJsonAtomic(registryPath(root), { schemaVersion: 1, ...reg, updatedAt: nowIso() })
}

export function findSession(reg, sessionId) {
  return reg.sessions.find((s) => s.sessionId === sessionId) || null
}

// 添加会话：已存在则只更新标题；不存在则建条目 + 目录，bootstrap 置 pending
export function addSession(root, sessionId, patch = {}) {
  const reg = loadRegistry(root)
  const key = sessionKey(sessionId)
  let entry = findSession(reg, sessionId)
  if (!entry) {
    entry = {
      sessionId,
      key,
      title: patch.title || sessionId,
      addedAt: nowIso(),
      capture: patch.capture ?? DEFAULT_SESSION.capture,
      inject: patch.inject ?? DEFAULT_SESSION.inject,
      profileId: patch.profileId || DEFAULT_SESSION.profileId,
      status: 'attached',
      lastActivityAt: nowIso(),
      bootstrap: { status: 'pending', turns: 0, cursor: 0, bytes: 0, attempts: 0 },
    }
    reg.sessions.push(entry)
  } else {
    // 重新添加已移除的会话：恢复 attached 状态
    Object.assign(entry, { ...patch, sessionId, key: entry.key, status: 'attached' })
  }
  saveRegistry(root, reg)
  ensureDir(path.join(root, 'sessions', entry.key))
  return entry
}

export function updateSession(root, sessionId, patch) {
  const reg = loadRegistry(root)
  const e = findSession(reg, sessionId)
  if (!e) return null
  Object.assign(e, patch)
  saveRegistry(root, reg)
  return e
}

// 上移/下移：直接交换注册表数组位置（显示顺序 = 数组顺序）
export function moveSession(root, sessionId, dir) {
  const reg = loadRegistry(root)
  const i = reg.sessions.findIndex((s) => s.sessionId === sessionId)
  if (i < 0) return false
  const j = dir === 'up' ? i - 1 : i + 1
  if (j < 0 || j >= reg.sessions.length) return false
  const tmp = reg.sessions[i]
  reg.sessions[i] = reg.sessions[j]
  reg.sessions[j] = tmp
  saveRegistry(root, reg)
  return true
}

export function removeSession(root, sessionId, { purge = false } = {}) {
  const reg = loadRegistry(root)
  const i = reg.sessions.findIndex((s) => s.sessionId === sessionId)
  if (i < 0) return false
  if (purge) {
    reg.sessions.splice(i, 1)
  } else {
    reg.sessions[i].status = 'detached'
    reg.sessions[i].capture = false
    reg.sessions[i].inject = false
  }
  saveRegistry(root, reg)
  return true
}

// 生效判定：总开关 AND 会话开关（AND，不是覆盖）
export function captureEnabled(cfg, entry) {
  return !!(cfg.enabled && entry && entry.status === 'attached' && entry.capture)
}
export function injectEnabled(cfg, entry) {
  return !!(cfg.enabled && entry && entry.status === 'attached' && entry.inject)
}

export function sessionRoot(root, key) {
  return path.join(root, 'sessions', key)
}
