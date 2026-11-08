// 实体图：节点（实体）+ 边（关系）+ 别名
// 四件事一次做完：
//   1. 别名      —— 「狗 / 多宝 / 那只狗」归到同一个实体
//   2. 节点带向量 —— 实体级语义检索（不是"像不像"，是"是不是同一个东西"）
//   3. 边带出处 + 置信度 —— 可回溯原文、可人工复核
//   4. 边带时间范围 —— validFrom / validTo，处理「事实会变」
//
// 存储：sessions/<key>/graph/nodes.jsonl + edges.jsonl（追加写，按 id 去重）
// 兜底原则：任何异常都不阻塞检索——图用不上就当没有。
import fs from 'node:fs'
import path from 'node:path'
import * as V from './vector.mjs'
import { sha256, nowIso } from './util.mjs'

const DIM = 128

export function graphPaths(root) {
  const dir = path.join(root, 'graph')
  return { dir, nodes: path.join(dir, 'nodes.jsonl'), edges: path.join(dir, 'edges.jsonl') }
}

function readJsonl(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const map = new Map()
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const o = JSON.parse(t)
        if (o && o.id) map.set(o.id, o)
      } catch {}
    }
    return [...map.values()]
  } catch { return [] }
}

function appendLine(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8')
    return true
  } catch { return false }
}

export function loadGraph(root) {
  try {
    const p = graphPaths(root)
    return { nodes: readJsonl(p.nodes), edges: readJsonl(p.edges) }
  } catch { return { nodes: [], edges: [] } }
}

/** 归一化：去空白/标点、转小写——用于「同一个名字」的比对 */
export function normalizeName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[\s,，。.!！?？、;；:：'"“”‘’()（）【】\[\]<>《》]/g, '')
    .slice(0, 60)
}

const nodeIdOf = (name) => 'n-' + sha256('node|' + normalizeName(name)).slice(0, 12)
const edgeIdOf = (from, to, type, validFrom) => 'e-' + sha256('edge|' + from + '|' + to + '|' + type + '|' + (validFrom || '')).slice(0, 12)

/** 按名字或别名找节点（忽略已删除） */
export function findNodes(root, name) {
  const norm = normalizeName(name)
  if (!norm) return []
  const { nodes } = loadGraph(root)
  return nodes.filter((n) => {
    if (n.deletedAt) return false
    if (normalizeName(n.name) === norm) return true
    return (n.aliases || []).some((a) => normalizeName(a) === norm)
  })
}

export function findNode(root, name) {
  return findNodes(root, name)[0] || null
}

/** 新增/更新一个实体节点（按名字去重，别名合并） */
export function upsertNode(root, input) {
  try {
    const name = String((input && input.name) || '').trim()
    if (!name) return null
    const p = graphPaths(root)
    const { nodes } = loadGraph(root)
    const norm = normalizeName(name)
    const id = nodeIdOf(name)
    const old = nodes.find((n) => n.id === id)
    const aliases = new Set([...(old && old.aliases) || [], ...((input && input.aliases) || [])].map((a) => String(a || '').trim()).filter(Boolean))
    aliases.delete(name)
    const at = nowIso()
    const summary = String((input && input.summary) || (old && old.summary) || '').slice(0, 400)
    const node = {
      id,
      name,
      nameNormalized: norm,
      type: String((input && input.type) || (old && old.type) || 'entity'),
      aliases: [...aliases],
      summary,
      embedding: V.embed(name + ' ' + summary, DIM),
      mentionCount: Number((old && old.mentionCount) || 0) + (input && input.mention ? 1 : 0),
      firstSeenAt: (old && old.firstSeenAt) || at,
      lastSeenAt: at,
      confidence: Number((input && input.confidence) != null ? input.confidence : (old && old.confidence) || 90),
      reviewStatus: String((input && input.reviewStatus) || (old && old.reviewStatus) || 'approved'),
      origin: String((input && input.origin) || (old && old.origin) || 'agent'),
      createdAt: (old && old.createdAt) || at,
      updatedAt: at,
      deletedAt: (old && old.deletedAt) || null,
    }
    appendLine(p.nodes, node)
    return node
  } catch { return null }
}

/** 给节点加一个别名 */
export function addAlias(root, nodeNameOrId, alias) {
  try {
    const a = String(alias || '').trim()
    if (!a) return false
    const { nodes } = loadGraph(root)
    const node = nodes.find((n) => n.id === nodeNameOrId) || findNode(root, nodeNameOrId)
    if (!node) return false
    if (normalizeName(node.name) === normalizeName(a) || (node.aliases || []).some((x) => normalizeName(x) === normalizeName(a))) return true
    return !!upsertNode(root, { name: node.name, aliases: [a] })
  } catch { return false }
}

/** 新增/更新一条关系边 */
export function upsertEdge(root, input) {
  try {
    const fromName = String((input && (input.fromName || input.from)) || '').trim()
    const toName = String((input && (input.toName || input.to)) || '').trim()
    const type = String((input && input.type) || '关联').trim()
    if (!fromName || !toName) return null
    const from = findNode(root, fromName) || upsertNode(root, { name: fromName })
    const to = findNode(root, toName) || upsertNode(root, { name: toName })
    if (!from || !to) return null
    const p = graphPaths(root)
    const validFrom = (input && input.validFrom) ? String(input.validFrom) : nowIso()
    const id = edgeIdOf(from.id, to.id, type, validFrom)
    const at = nowIso()
    const edge = {
      id,
      fromId: from.id,
      toId: to.id,
      fromName: from.name,
      toName: to.name,
      type,
      props: (input && input.props) || {},
      validFrom,
      validTo: (input && input.validTo) ? String(input.validTo) : null,
      isCurrent: !(input && input.validTo),
      sourceRef: String((input && input.sourceRef) || '').slice(0, 200),
      sourceExcerpt: String((input && input.sourceExcerpt) || '').slice(0, 300),
      sourceHash: String((input && input.sourceHash) || '').slice(0, 40),
      confidence: Number((input && input.confidence) != null ? input.confidence : 90),
      reviewStatus: String((input && input.reviewStatus) || 'approved'),
      origin: String((input && input.origin) || 'agent'),
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    }
    appendLine(p.edges, edge)
    return edge
  } catch { return null }
}

/** 多跳邻居：从某个节点出发，走 depth 跳能碰到谁 */
export function neighbors(root, nodeNameOrId, depth = 1) {
  try {
    const { nodes, edges } = loadGraph(root)
    const start = nodes.find((n) => n.id === nodeNameOrId) || findNode(root, nodeNameOrId)
    if (!start) return { nodes: [], edges: [] }
    const maxHop = Math.min(3, Math.max(1, Number(depth) || 1))
    const seen = new Set([start.id])
    const hitEdges = []
    let frontier = new Set([start.id])
    for (let hop = 0; hop < maxHop; hop++) {
      const next = new Set()
      for (const e of edges) {
        if (e.deletedAt) continue
        if (e.reviewStatus === 'rejected') continue
        if (e.isCurrent === false) continue
        if (!frontier.has(e.fromId) && !frontier.has(e.toId)) continue
        if (!hitEdges.some((x) => x.id === e.id)) hitEdges.push(e)
        const other = frontier.has(e.fromId) ? e.toId : e.fromId
        if (!seen.has(other)) { seen.add(other); next.add(other) }
      }
      frontier = next
      if (!frontier.size) break
    }
    return { nodes: nodes.filter((n) => seen.has(n.id) && !n.deletedAt), edges: hitEdges }
  } catch { return { nodes: [], edges: [] } }
}

/** 实体时间线：跟这个节点有关的所有边，按 validFrom 排序 */
export function timeline(root, nodeNameOrId) {
  try {
    const { nodes, edges } = loadGraph(root)
    const node = nodes.find((n) => n.id === nodeNameOrId) || findNode(root, nodeNameOrId)
    if (!node) return []
    return edges
      .filter((e) => !e.deletedAt && (e.fromId === node.id || e.toId === node.id))
      .sort((a, b) => String(a.validFrom || '').localeCompare(String(b.validFrom || '')))
  } catch { return [] }
}

/**
 * 查询扩展：问句里提到「狗」，而图里 狗↔多宝 有关联 → 把「多宝」这些词也带出来。
 * 返回 { names: [...], nodes: [...], terms: [...] }
 */
export function expandQuery(root, query) {
  try {
    const q = String(query || '')
    if (!q.trim()) return { names: [], nodes: [], terms: [] }
    const { nodes, edges } = loadGraph(root)
    if (!nodes.length) return { names: [], nodes: [], terms: [] }
    const qNorm = normalizeName(q)
    // 1) 问句里直接出现的实体
    const hit = nodes.filter((n) => {
      if (n.deletedAt) return false
      const names = [n.name, ...(n.aliases || [])]
      return names.some((x) => { const nx = normalizeName(x); return nx && qNorm.includes(nx) })
    })
    if (!hit.length) return { names: [], nodes: [], terms: [] }
    // 2) 一跳邻居也带出来（"狗" → "多宝"，"多宝" → "狗"）
    const ids = new Set(hit.map((n) => n.id))
    const related = []
    for (const e of edges) {
      if (e.deletedAt || e.isCurrent === false || e.reviewStatus === 'rejected') continue
      if (!ids.has(e.fromId) && !ids.has(e.toId)) continue
      const ids2 = [e.fromId, e.toId]
      for (const id of ids2) if (!ids.has(id)) { ids.add(id) }
    }
    for (const n of nodes) if (ids.has(n.id) && !n.deletedAt) related.push(n)
    const terms = []
    const hitIds = new Set(hit.map((n) => n.id))
    for (const n of related) {
      // 命中的实体带全别名；一跳邻居只带名字——否则「水聚」的别名「主人」会把泛词扩散出去
      const list = hitIds.has(n.id) ? [n.name, ...(n.aliases || [])] : [n.name]
      for (const x of list) {
        const t = String(x || '').trim()
        if (t && !terms.includes(t)) terms.push(t)
      }
    }
    return { names: [...new Set(related.flatMap((n) => [n.name, ...(n.aliases || [])]))], nodes: related, terms: terms.slice(0, 12) }
  } catch { return { names: [], nodes: [], terms: [] } }
}

/** 统计，给 UI 用 */
export function stats(root) {
  try {
    const { nodes, edges } = loadGraph(root)
    const live = nodes.filter((n) => !n.deletedAt)
    const liveEdges = edges.filter((e) => !e.deletedAt)
    return {
      nodes: live.length,
      edges: liveEdges.length,
      pending: liveEdges.filter((e) => e.reviewStatus === 'pending').length,
      byType: live.reduce((m, n) => { m[n.type] = (m[n.type] || 0) + 1; return m }, {}),
    }
  } catch { return { nodes: 0, edges: 0, pending: 0, byType: {} } }
}
