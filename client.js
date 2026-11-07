/**
 * dsh-offline-memory · 浏览器半端（v1.2）
 * 标签：总览 / 启用会话 / 存档设置 / 人设属性 / 评分器设置
 */
window.__ModuleLoader__.load({
  id: 'dsh-offline-memory',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React
    let pickDir = null   // 由 apply(ctx) 注入：原生目录选择器
    const API = '/dsh-offline-memory'

    const get = (p) => fetch(API + p, { headers: { accept: 'application/json' } }).then((r) => r.json())
    const post = (p, body) =>
      fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then((r) => r.json())
        .catch((e) => ({ ok: false, why: String(e) }))

    const CSS = `
      .om { font-size: 13px; line-height: 1.6; }
      .om-tabs { display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
      .om-tab { padding:6px 14px; border-radius:8px; cursor:pointer; border:1px solid rgba(128,128,128,.35); background:transparent; color:inherit; font-size:13px; }
      .om-tab[data-on="1"] { border-color:#7FB6D9; color:#7FB6D9; }
      .om-card { border:1px solid rgba(128,128,128,.28); border-radius:10px; padding:12px 14px; margin-bottom:12px; }
      .om-card h4 { margin:0 0 10px; font-size:13px; font-weight:600; opacity:.85; }
      .om-row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:8px; }
      .om-k { opacity:.66; min-width:112px; }
      .om-num { width:90px; padding:4px 6px; border-radius:6px; border:1px solid rgba(128,128,128,.35); background:transparent; color:inherit; }
      .om-btn { padding:5px 12px; border-radius:8px; cursor:pointer; border:1px solid rgba(128,128,128,.4); background:transparent; color:inherit; font-size:12px; }
      .om-btn:hover { border-color:#7FB6D9; color:#7FB6D9; }
      .om-btn[data-danger="1"]:hover { border-color:#d06a5a; color:#d06a5a; }
      .om-btn:disabled { opacity:.45; cursor:default; }
      .om-sw { display:inline-flex; align-items:center; gap:6px; cursor:pointer; user-select:none; }
      .om-sw input { width:15px; height:15px; }
      .om-table { width:100%; border-collapse:collapse; }
      .om-table th { text-align:left; font-weight:500; opacity:.6; font-size:12px; padding:6px 8px; border-bottom:1px solid rgba(128,128,128,.25); }
      .om-table td { padding:7px 8px; border-bottom:1px dashed rgba(128,128,128,.2); vertical-align:middle; }
      .om-tag { font-size:11px; padding:1px 6px; border-radius:999px; border:1px solid rgba(128,128,128,.35); opacity:.85; margin-right:4px; }
      .om-bar { height:7px; border-radius:4px; background:rgba(128,128,128,.2); overflow:hidden; }
      .om-bar > i { display:block; height:100%; background:#7FB6D9; }
      .om-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:5px; }
      .om-cell { text-align:center; padding:9px 2px; border-radius:7px; border:1px solid rgba(128,128,128,.25); font-size:11px; opacity:.5; }
      .om-cell[data-on="1"] { opacity:1; border-color:#c9a227; color:#c9a227; background:rgba(201,162,39,.1); }
      .om-dim { opacity:.6; }
      .om-hint { opacity:.55; font-size:11.5px; margin:-2px 0 10px 0; }
      .om-warn { color:#d08a3a; }
      .om-mono { font-variant-numeric:tabular-nums; }
      .om-pre { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11px; max-height:220px; overflow:auto; background:rgba(128,128,128,.08); padding:8px; border-radius:8px; white-space:pre-wrap; word-break:break-all; }
      .om-path { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11px; opacity:.75; word-break:break-all; }
      .om-sub { display:flex; gap:8px; align-items:center; margin-bottom:10px; }
      .om-pick { padding:5px 8px; border-radius:6px; border:1px solid rgba(128,128,128,.35); background:transparent; color:inherit; font-size:12px; }
      .om-ta { width:100%; min-height:150px; padding:9px; border-radius:8px; border:1px solid rgba(128,128,128,.35); background:transparent; color:inherit; font-family:inherit; font-size:12.5px; line-height:1.6; }
      .om-mask { position:fixed; inset:0; background:rgba(0,0,0,.5); display:flex; align-items:center; justify-content:center; z-index:50; }
      .om-modal { background:var(--dsh-surface,#1e1e1e); border:1px solid rgba(128,128,128,.4); border-radius:12px; padding:16px 18px; width:min(620px,92vw); max-height:82vh; overflow:auto; }
      .om-radio { display:flex; gap:8px; align-items:flex-start; padding:7px 9px; border:1px solid rgba(128,128,128,.25); border-radius:8px; margin-bottom:8px; cursor:pointer; }
      .om-radio[data-on="1"] { border-color:#7FB6D9; background:rgba(127,182,217,.06); }
      .om-radio input { margin-top:3px; }
    `

    const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : ((n || 0) / 1024).toFixed(0) + ' KB')
    const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '—')
    const when = (s) => (s ? String(s).slice(0, 16).replace('T', ' ') : '—')

    const MAIN14 = ['傲', '娇', '冰', '柔', '热', '酷', '黑', '纯', '疯', '呆', '毒', '慵', '中二', '醋缸']
    const ALL45 = ['傲', '娇', '弱', '柔', '冰', '热', '酷', '八卦', '直率', '疯', '自主', '黑', '病', '慵', '急', '静', '无邪', '幸灾乐祸', '呆', '醋缸', '爆', '电', '中二', '纯', '毒', '迷', '好奇', '无感情', '三无', '正义', '狂', '羞', '认真', '怕麻烦', '自来熟', '笨', '吃货', '恋爱脑', '固执', '雌小鬼', '脱线', '混乱', '完美主义', '吝啬', '贪婪']
    const CELLS = ['守序善良', '中立善良', '混乱善良', '守序中立', '绝对中立', '混乱中立', '守序邪恶', '中立邪恶', '混乱邪恶']
    const cellOf = (o, m) => (o > 33 ? 0 : o < -33 ? 2 : 1) * 3 + (m > 33 ? 0 : m < -33 ? 2 : 1)

    function summarizeAxes(axes) {
      const list = Object.entries(axes || {}).filter(([, v]) => v >= 55).sort((a, b) => b[1] - a[1])
      if (!list.length) return '还看不出明显属性'
      const names = { 冰: '清冷', 傲: '傲气', 娇: '娇气', 柔: '温柔', 黑: '腹黑', 呆: '天然呆', 毒: '毒舌', 疯: '疯癫', 纯: '纯情', 慵: '慵懒', 中二: '中二', 醋缸: '爱吃醋' }
      const top = list.slice(0, 2).map(([k, v]) => k + Math.round(v) + '%')
      const a = names[list[0][0]] || list[0][0]
      const b = list[1] && list[1][1] >= 50 ? '偏' + (names[list[1][0]] || list[1][0]) : ''
      return a + b + '型（' + top.join('，') + '）'
    }

    // 一行「标签 + 控件」，下面紧跟这参数是干什么的
    function Field({ label, hint, children }) {
      const out = [h('div', { className: 'om-row', key: 'r' }, h('span', { className: 'om-k' }, label), children)]
      if (hint) out.push(h('div', { className: 'om-hint', key: 'h' }, hint))
      return h('div', { key: label }, out)
    }

    function Modal({ title, onClose, children, wide }) {
      return h('div', { className: 'om-mask', onClick: onClose },
        h('div', { className: 'om-modal', style: wide ? { width: 'min(760px,94vw)' } : null, onClick: (e) => e.stopPropagation() },
          h('h4', null, title),
          children,
          h('div', { style: { marginTop: 12, textAlign: 'right' } },
            h('button', { className: 'om-btn', onClick: onClose }, '关闭'))))
    }

    function Tabs({ tab, setTab }) {
      const items = [['overview', '总览'], ['sessions', '启用会话'], ['archive', '存档设置'], ['scorer', '评分器设置'], ['inject', '注入记录'], ['attrs', '人设属性']]
      return h('div', { className: 'om-tabs' },
        items.map(([k, label]) => h('button', {
          key: k, className: 'om-tab', 'data-on': tab === k ? '1' : '0', onClick: () => setTab(k),
        }, label)))
    }

    // ---------- 总览 ----------
    function Overview({ ov, reload, busy }) {
      const cfg = ov?.config || {}
      const [repoInput, setRepoInput] = useState('')
      useEffect(() => { setRepoInput((ov?.config || {}).updateRepo || '') }, [ov?.config?.updateRepo])
      const flip = async (on) => { await post('/config', { config: { enabled: on } }); reload() }
      const setCfg = async (patch) => { const r = await post('/config', { config: patch }); if (r?.warnings?.length) window.alert(r.warnings.join('\n')); reload() }
      const sw = h('div', { className: 'om-card', key: 'sw' },
        h('div', { className: 'om-row' },
          h('label', { className: 'om-sw' },
            h('input', { type: 'checkbox', checked: !!cfg.enabled, disabled: busy, onChange: (e) => flip(e.target.checked) }),
            h('b', null, cfg.enabled ? '已启用外置记忆' : '已关闭外置记忆'))),
        h('div', { className: 'om-dim' },
          cfg.enabled ? '开启后按会话开关采集与注入；关闭立即停止写入与注入，已存档内容保留。'
            : '关闭时插件不写任何字节、不注入、不评分。首次开启会对已启用会话做一次全量入档。'),
        h('div', { className: 'om-row', style: { marginTop: 10, borderTop: '1px dashed rgba(128,128,128,.25)', paddingTop: 10 } },
          h('label', { className: 'om-sw' },
            h('input', { type: 'checkbox', checked: !!cfg.testMode, disabled: busy, onChange: (e) => setCfg({ testMode: e.target.checked }) }),
            h('b', null, '测试模式')),
          h('span', { className: 'om-dim' }, '只写虚拟沙箱，不碰真实会话；关闭即清空沙箱')))
      const st = h('div', { className: 'om-card', key: 'st' },
        h('h4', null, '状态'),
        h('div', { className: 'om-row' }, h('span', { className: 'om-k' }, '版本'), h('span', { className: 'om-mono' }, 'v' + (ov?.version || '?')), h('span', { className: 'om-dim', style: { marginLeft: 8 } }, 'dsh-offline-memory')),
        h('div', { className: 'om-row' }, h('span', { className: 'om-k' }, '已启用会话'), h('span', null, (ov?.attached ?? 0) + ' / ' + (ov?.sessions ?? 0))),
        h('div', { className: 'om-row' }, h('span', { className: 'om-k' }, '占用空间'), h('span', { className: 'om-mono' }, kb(ov?.bytes))),
        h('div', { className: 'om-row' }, h('span', { className: 'om-k' }, '上次唤醒'), h('span', null, when(ov?.lastWakeAt))),
        h('div', { className: 'om-row' }, h('span', { className: 'om-k' }, '评分器'), h('span', null,
          (ov?.scorer?.subject === 'session' ? '会话智能体接管' : '托管（内置规则）') + ' · ' + (ov?.scorer?.mode === 'onSave' ? '存档时打分' : '即时打分'))),
        h('div', { className: 'om-row' }, h('span', { className: 'om-k' }, '数据目录'), h('span', { className: 'om-path' }, ov?.dataRoot || '')))
      const doUpdate = () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.zip'
        input.onchange = (e) => {
          const file = e.target.files && e.target.files[0]
          if (!file) return
          if (!window.confirm('用「' + file.name + '」更新插件？\n会覆盖插件代码文件，记忆数据不受影响。更新后需重载插件（关闭再开启）生效。')) return
          const fr = new FileReader()
          fr.onload = async () => {
            const r = await post('/update', { zipBase64: String(fr.result) })
            if (!r.ok) window.alert(r.why || r.error || '更新失败')
            else window.alert(r.note || ('已更新到 ' + r.dir))
            reload()
          }
          fr.readAsDataURL(file)
        }
        input.click()
      }
      const doGithubUpdate = async () => {
        const repo = String(repoInput || '').trim()
        if (!repo) { window.alert('先填 GitHub 仓库（owner/repo）'); return }
        if (!window.confirm('从「' + repo + '」下载最新代码覆盖插件？\n记忆数据不受影响，更新后需重载插件（关闭再开启）生效。')) return
        const r = await post('/update/github', { repo })
        if (!r.ok) window.alert(r.why || r.error || '更新失败')
        else window.alert(r.note || '已更新')
        reload()
      }
      const up = h('div', { className: 'om-card', key: 'up' },
        h('h4', null, '更新'),
        h('div', { className: 'om-row' },
          h('button', { className: 'om-btn', onClick: doUpdate }, '选择更新包更新'),
          h('span', { className: 'om-dim' }, '从磁盘选 zip，覆盖插件代码；记忆数据不受影响，更新后重载生效')),
        h('div', { className: 'om-row', style: { marginTop: 8 } },
          h('input', {
            className: 'om-num', style: { flex: 1, minWidth: 200 }, value: repoInput, disabled: busy,
            placeholder: 'GitHub 仓库（owner/repo）', onChange: (e) => setRepoInput(e.target.value),
          }),
          h('button', { className: 'om-btn', disabled: busy, onClick: doGithubUpdate }, '从 GitHub 更新')))
      return h('div', null, [sw, st, up])
    }

    // ---------- 启用会话 ----------
    function Sessions({ list, cands, reload, busy }) {
      const [showAdd, setShowAdd] = useState(false)
      const toggle = async (s, k) => { await post('/sessions/update', { sessionId: s.sessionId, [k]: !s[k] }); reload() }
      const addOne = async (c) => { const r = await post('/sessions/add', { sessionId: c.sessionId, title: c.title }); if (!r.ok) window.alert(r.why || '添加失败'); reload() }
      const removeOne = async (s) => {
        if (!window.confirm('移除「' + (s.title || s.sessionId) + '」？存档数据会保留。')) return
        await post('/sessions/remove', { sessionId: s.sessionId })
        reload()
      }

      const pickerRows = (cands || []).map((c) => h('tr', { key: c.sessionId },
        h('td', null, h('div', null, c.title || '未命名会话'), h('div', { className: 'om-dim', style: { fontSize: 11 } }, String(c.sessionId).slice(0, 22))),
        h('td', { className: 'om-dim' }, c.workspace || '—'),
        h('td', { className: 'om-dim' }, when(c.createdAt ? new Date(c.createdAt).toISOString() : c.mtime)),
        h('td', { className: 'om-mono' }, kb(c.bytes)),
        h('td', null, c.added ? h('span', { className: 'om-dim' }, '已添加')
          : h('button', { className: 'om-btn', disabled: busy, onClick: () => addOne(c) }, '添加'))))

      const moveOne = async (s, dir) => { await post('/sessions/move', { sessionId: s.sessionId, dir }); reload() }
      const activeList = (list || []).filter((s) => s.status === 'attached')
      const detachedCount = (list || []).length - activeList.length

      const listRows = activeList.map((s) => {
        const bs = s.stats?.bootstrap || {}
        const stt = bs.status === 'done' ? '已完成' : bs.status === 'running' ? '入档中' : bs.status === 'failed' ? '失败' : '未入档'
        return h('tr', { key: s.sessionId },
          h('td', null, h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'center' } },
            h('button', { className: 'om-btn', disabled: busy, onClick: () => moveOne(s, 'up') }, '↑'),
            h('button', { className: 'om-btn', disabled: busy, onClick: () => moveOne(s, 'down') }, '↓'))),
          h('td', null, s.title || s.sessionId),
          h('td', null, h('input', { type: 'checkbox', checked: !!s.capture, disabled: busy, onChange: () => toggle(s, 'capture') })),
          h('td', null, h('input', { type: 'checkbox', checked: !!s.inject, disabled: busy, onChange: () => toggle(s, 'inject') })),
          h('td', null, h('span', { className: bs.status === 'failed' ? 'om-warn' : 'om-dim' }, stt)),
          h('td', { className: 'om-mono' }, String(s.stats?.baseItems ?? 0)),
          h('td', { className: 'om-mono' }, String(s.stats?.optimizedItems ?? 0)),
          h('td', { className: 'om-mono' }, String(s.stats?.vctxItems ?? 0)),
          h('td', null, h('button', { className: 'om-btn', 'data-danger': '1', disabled: busy, onClick: () => removeOne(s) }, '移除')))
      })

      const addCard = h('div', { className: 'om-card', key: 'add' },
        h('div', { className: 'om-row' },
          h('button', { className: 'om-btn', disabled: busy, onClick: () => setShowAdd(!showAdd) }, showAdd ? '收起' : '＋ 添加会话'),
          h('span', { className: 'om-dim' }, '只有这里启用的会话才会被采集/注入；↑↓ 调整优先级，把常用会话移到上边。')),
        showAdd ? h('table', { className: 'om-table' },
          h('thead', null, h('tr', null, ['会话标题', '工作区', '创建时间', '大小', ''].map((t, i) => h('th', { key: i }, t)))),
          h('tbody', null, pickerRows)) : null)

      const listCard = h('div', { className: 'om-card', key: 'list' },
        h('table', { className: 'om-table' },
          h('thead', null, h('tr', null, ['', '会话', '采集', '注入', '入档', '底层', '优化', '虚拟', ''].map((t, i) => h('th', { key: i }, t)))),
          h('tbody', null, listRows.length ? listRows : h('tr', null, h('td', { colSpan: 9, className: 'om-dim' }, '还没有启用任何会话。')))),
        detachedCount > 0 ? h('div', { className: 'om-dim', style: { fontSize: 11.5, marginTop: 6 } }, '已移除 ' + detachedCount + ' 个会话（数据保留，可重新添加）。') : null)

      return h('div', null, [addCard, listCard])
    }

    // ---------- 存档设置 ----------
    function ArchiveTab({ list, ov, reload, busy }) {
      const [cfg, setCfg] = useState(ov?.config || {})
      const [view, setView] = useState('main')
      const [sid, setSid] = useState('')
      const [manage, setManage] = useState(null)
      const [previewInfo, setPreviewInfo] = useState(null)
      const [readOpen, setReadOpen] = useState(false)
      const [cands, setCands] = useState([])
      const [important, setImportant] = useState([])
      const [images, setImages] = useState([])
      const [impOpen, setImpOpen] = useState(false)
      const [imgOpen, setImgOpen] = useState(false)
      const [saveBusy, setSaveBusy] = useState(false)
      const [saveResult, setSaveResult] = useState(null)
      const [saveProg, setSaveProg] = useState(null)
      const [bfState, setBfState] = useState(null)
      const [prefs, setPrefs] = useState([])
      const [srcs, setSrcs] = useState([])
      const MIGRATE_ITEMS = [
        ['journal', '底层原文'], ['optimized', '优化存储'], ['vctx', '虚拟上下文'],
        ['important', '重要会话'], ['persona', '人设'], ['pics', '图片记忆'],
        ['prefs', '偏好库'], ['sources', '外部源（日记等）'],
      ]
      const [migOpen, setMigOpen] = useState(false)
      const [migItems, setMigItems] = useState(['journal', 'optimized', 'vctx', 'important', 'persona', 'prefs', 'sources'])

      const loadPrefs = async () => {
        if (!sid) return
        const r = await get('/prefs?session=' + encodeURIComponent(sid))
        setPrefs(r.items || [])
      }
      const loadSrcs = async () => {
        if (!sid) return
        const r = await get('/sources?session=' + encodeURIComponent(sid))
        setSrcs(r.items || [])
      }
      useEffect(() => { loadPrefs(); loadSrcs() }, [sid])
      const addPref = async () => {
        const t = window.prompt('添加偏好（如「喜欢猫」「讨厌加班」）')
        if (!t || !t.trim()) return
        const r = await post('/prefs', { action: 'add', session: sid, text: t.trim() })
        if (r && r.why) window.alert(r.why)
        loadPrefs()
      }
      const delPref = async (id) => {
        await post('/prefs', { action: 'remove', session: sid, id })
        loadPrefs()
      }
      const addSrc = async () => {
        const p = window.prompt('外部源路径（绝对路径，或相对 .dsh 目录，如 whale-diary.md）')
        if (!p || !p.trim()) return
        const label = window.prompt('给这个源起个名字（如「给主人那本」）') || ''
        await post('/sources', { action: 'add', session: sid, path: p.trim(), label, kind: '日记' })
        loadSrcs()
      }
      const toggleSrc = async (s) => {
        await post('/sources', { action: 'toggle', session: sid, id: s.id, enabled: !s.enabled })
        loadSrcs()
      }
      const delSrc = async (id) => {
        await post('/sources', { action: 'remove', session: sid, id })
        loadSrcs()
      }

      useEffect(() => { if (ov?.config) setCfg(ov.config) }, [ov])
      useEffect(() => { if (!sid && list && list.length) setSid(list[0].sessionId) }, [list])
      useEffect(() => {
        if (view !== 'manage' || !sid) return
        let alive = true
        get('/manage?session=' + encodeURIComponent(sid)).then((r) => { if (alive) setManage(r) })
        return () => { alive = false }
      }, [view, sid])
  useEffect(() => { if (sid) { loadImportant(); loadImages() } }, [sid])

      const saveCfg = async (patch) => {
        const r = await post('/config', { config: patch })
        if (r?.warnings?.length) window.alert(r.warnings.join('\n'))
        reload()
      }
      const loadImportant = async () => {
        if (!sid) return
        const r = await get('/important/list?session=' + encodeURIComponent(sid))
        setImportant(r.items || [])
      }
      const loadImages = async () => {
        if (!sid) return
        const r = await get('/images?session=' + encodeURIComponent(sid))
        setImages(r.items || [])
      }
      const markImg = async (id, verified) => {
        const r = await post('/images/mark', { session: sid, id, verified })
        if (!r.ok) window.alert(r.error || r.why || '失败')
        loadImages()
      }
      const doDeleteImage = async (id, hash8) => {
        if (!window.confirm('删除图片 #' + (hash8 || id) + '？\n会同时删掉图文件和索引条目，不可撤销。')) return
        const r = await post('/images/delete', { session: sid, id, confirm: true })
        if (!r.ok) window.alert(r.error || r.why || '删除失败')
        loadImages()
      }
      const doSaveImage = () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*'
        input.onchange = (e) => {
          const file = e.target.files && e.target.files[0]
          if (!file) return
          const desc = window.prompt('给这张图写一句能核对的描述（如"银白长发、后倾冰晶角、三视图"）：', '')
          if (desc === null) return
          const source = window.prompt('来源/标题（可空，默认文件名）：', file.name) || file.name
          const fr = new FileReader()
          fr.onload = async () => {
            const b64 = String(fr.result || '').replace(/^data:[^;]+;base64,/, '')
            const ext = (file.type && file.type.split('/')[1]) || (file.name.includes('.') ? file.name.split('.').pop() : 'jpg')
            const r = await post('/images/save', { session: sid, base64: b64, ext, desc, source, by: 'human' })
            if (!r.ok) window.alert(r.error || r.why || '存图失败')
            else window.alert(r.dup ? '已存在同图（去重）#' + r.hash8 : '已存图 #' + r.hash8)
            loadImages()
          }
          fr.readAsDataURL(file)
        }
        input.click()
      }
      const demote = async (id) => {
        if (!window.confirm('把这条从「重要会话」降级为普通存档？降级后会开始正常衰变。')) return
        const r = await post('/important/demote', { session: sid, id })
        if (!r.ok) window.alert(r.error || r.why || '失败')
        loadImportant()
      }
      const delItem = async (id) => {
        if (!window.confirm('彻底删除这条记忆？（虚拟上下文 + 优化存储都删，不可恢复）')) return
        const r = await post('/important/delete', { session: sid, id })
        if (!r.ok) window.alert(r.error || r.why || '失败')
        loadImportant()
      }
      const act = async (p, body, okText) => {
        const r = await post(p, body)
        if (!r.ok) window.alert(r.why || '操作失败')
        else if (okText) window.alert(okText)
        reload()
      }
      const doSave = async () => {
        setSaveResult(null); setSaveBusy(true); setSaveProg({ done: 0, total: 0 })
        const r = await post('/save', { sessionId: sid })
        if (!r.ok) { setSaveBusy(false); setSaveProg(null); setSaveResult({ err: r.why || '存档失败' }); return }
        if (r.started === false) { setSaveBusy(false); setSaveProg(null); window.alert(r.why || '已在存档'); return }
        const poll = async () => {
          const st = (await get('/save/status?sessionId=' + encodeURIComponent(sid))).state
          if (!st) { setSaveBusy(false); setSaveProg(null); return }
          setSaveProg({ done: st.done || 0, total: st.total || 0 })
          if (st.running) { setTimeout(poll, 400) }
          else {
            setSaveBusy(false); setSaveProg(null)
            if (st.result && !st.result.ok) setSaveResult({ err: st.result.error || '存档失败' })
            else setSaveResult(st.result || {})
            reload()
          }
        }
        poll()
      }
      const openRead = async () => {
        const r = await get('/candidates')
        setCands((r.candidates || []).filter((c) => c.sessionId !== sid))
        setReadOpen(true)
      }
      const doRead = async (c) => {
        if (!window.confirm('用「' + (c.title || c.sessionId) + '」的档接续当前会话？\n将覆盖当前会话的底层存储和优化存储（不只是虚拟上下文）。')) return
        if (!window.confirm('再次确认：这会把「' + (c.title || c.sessionId) + '」的底层 + 优化 + 虚拟上下文写入当前会话。确定吗？')) return
        const r = await post('/read', { targetSession: sid, sourceSession: c.sessionId })
        setReadOpen(false)
        if (!r.ok) window.alert(r.why || '读档失败')
        else window.alert('读档完成：底层 ' + (r.deepJournal ?? 0) + ' 条，优化 ' + (r.deepOptimized ?? 0) + ' 条，虚拟上下文 ' + r.imported + ' 条')
        reload()
      }
      const openPreview = async (store) => {
        setPreviewInfo(await get('/preview?session=' + encodeURIComponent(sid) + '&store=' + store))
      }
      const cleanOne = async (scope, days) => {
        if (!window.confirm('第一层确认：清理「' + (scope === 'base' ? '底层存储' : '优化存储') + '」中 ' + days + ' 天之前的数据。继续？')) return
        if (!window.confirm('第二层确认：此操作不可撤销（会先自动拍快照）。真的清理吗？')) return
        const r = await post('/clean', { session: sid, scope, beforeDays: days, confirm: true })
        if (!r.ok) window.alert(r.error || r.why || '清理失败')
        else window.alert('清理完成：删除 ' + (r.removed || 0) + ' 条，释放 ' + kb(r.bytes || 0))
        setManage(await get('/manage?session=' + encodeURIComponent(sid)))
        reload()
      }
      const doBackfill = async () => {
        if (!window.confirm('比对底层存储，把还没进优化存储的条目补齐？（会重新评分）')) return
        const r = await post('/backfill', { sessionId: sid })
        if (!r.ok) { window.alert(r.why || r.error || '失败'); return }
        if (r.started === false) { window.alert(r.why || '已在运行'); return }
        setBfState({ running: true, done: 0, total: 0, added: 0, skipped: 0 })
        // 轮询进度
        const poll = async () => {
          const st = (await get('/backfill/status?sessionId=' + encodeURIComponent(sid))).state
          if (!st) { setBfState(null); return }
          setBfState({ running: st.running, done: st.done, total: st.total, added: st.added, skipped: st.skipped })
          if (st.running) { setTimeout(poll, 400) }
          else {
            setBfState({ running: false, done: st.done, total: st.total, added: st.added, skipped: st.skipped, result: st.result })
            setManage(await get('/manage?session=' + encodeURIComponent(sid)))
            reload()
          }
        }
        poll()
      }
      const doRebuildBase = async () => {
        if (!window.confirm('从原始日志提取数据，覆盖当前底层存储？\n上下文被压缩的情况下，会直接从原始日志提取原始数据覆盖底层。')) return
        const r = await post('/rebuild-base', { sessionId: sid })
        if (!r.ok) { window.alert(r.why || r.error || '失败'); return }
        if (r.started === false) { window.alert(r.why || '已在运行'); return }
        setBfState({ running: true, done: 0, total: 0, added: 0, skipped: 0, kind: 'rebuild' })
        const poll = async () => {
          const st = (await get('/backfill/status?sessionId=' + encodeURIComponent(sid))).state
          if (!st) { setBfState(null); return }
          setBfState({ running: st.running, done: st.done, total: st.total, added: st.added, skipped: st.skipped, kind: 'rebuild' })
          if (st.running) { setTimeout(poll, 400) }
          else {
            setBfState({ running: false, done: st.done, total: st.total, added: st.added, skipped: st.skipped, result: st.result, kind: 'rebuild' })
            setManage(await get('/manage?session=' + encodeURIComponent(sid)))
            reload()
          }
        }
        poll()
      }
      const doImportQA = () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.txt,.json,.jsonl,.md,.csv,.log,.text'
        input.onchange = async (e) => {
          const file = e.target.files && e.target.files[0]
          if (!file) return
          const text = await file.text()
          if (!window.confirm('用「' + file.name + '」里的 Q&A 覆盖当前底层存储？\n会分析文件内容，解析成 Q&A 对后写底层（覆盖）。')) return
          const r = await post('/import-qa', { sessionId: sid, text })
          if (!r.ok) window.alert(r.error || r.why || '建档失败')
          else window.alert('建档完成：解析 ' + r.pairs + ' 组 Q&A，写入底层 ' + r.added + ' 条')
          setManage(await get('/manage?session=' + encodeURIComponent(sid)))
          reload()
        }
        input.click()
      }
      const doMigrate = () => setMigOpen(true)
      const runMigrate = async () => {
        if (!migItems.length) { window.alert('至少选一项要带走的内容'); return }
        let dir = ''
        if (typeof pickDir === 'function') {
          try { dir = (await pickDir()) || '' } catch { dir = '' }
        }
        if (!dir) dir = window.prompt('输出目录（磁盘绝对路径）', '')
        if (!dir) return
        const r = await post('/migrate', { sessionId: sid, targetDir: dir, items: migItems })
        if (!r.ok) window.alert(r.why || r.error || '失败')
        else {
          const labels = MIGRATE_ITEMS.filter(([k]) => migItems.includes(k)).map(([, label]) => label).join('、')
          window.alert('已迁移到：' + r.targetDir + '\n携带：' + labels + '\n智能体下一轮会补写「迁移说明.md」。')
          setMigOpen(false)
        }
      }

      const migModal = migOpen ? h(Modal, { title: '存档迁移：选择携带内容', onClose: () => setMigOpen(false) },
        h('div', { className: 'om-dim', style: { marginBottom: 8 } }, '勾选要带走的项；表情包和图片默认不勾（避免版权/隐私跟着走）。'),
        MIGRATE_ITEMS.map(([k, label]) => h('label', { key: k, className: 'om-radio', style: { marginBottom: 4 } },
          h('input', {
            type: 'checkbox', checked: migItems.includes(k),
            onChange: (e) => setMigItems(e.target.checked ? [...migItems, k] : migItems.filter((x) => x !== k)),
          }),
          h('span', null, label))),
        h('div', { style: { marginTop: 10, textAlign: 'right' } },
          h('button', { className: 'om-btn', disabled: busy, onClick: runMigrate }, '选择目录并迁移'))) : null

      const bfPct = bfState && bfState.total > 0 ? Math.round((bfState.done / bfState.total) * 100) : 0
      const bfModal = bfState ? h(Modal, { title: bfState.kind === 'rebuild' ? '原始日志提取' : '比对底层补齐', onClose: () => { if (!bfState.running) setBfState(null) } },
        bfState.running
          ? h('div', null,
              h('div', { className: 'om-dim', style: { marginBottom: 8 } }, '正在比对底层存储，补齐未保存条数… ' + bfState.done + ' / ' + bfState.total + ' 条'),
              h('div', { style: { background: '#2a2f3a', borderRadius: 6, height: 14, overflow: 'hidden' } },
                h('div', { style: { width: bfPct + '%', background: '#4ea1ff', height: '100%', transition: 'width .2s' } })),
              h('div', { className: 'om-dim', style: { fontSize: 11.5, marginTop: 6 } }, '已新增 ' + bfState.added + ' 条，跳过 ' + bfState.skipped + ' 条'))
          : h('div', null, '补齐完成：新增 ', h('b', null, bfState.added + ' 条'), '，跳过 ', bfState.skipped, ' 条（系统/噪音），共扫描底层 ', bfState.total, ' 条。')) : null

      if (view === 'clean') return h(CleanView, { usage: manage?.usage, onBack: () => setView('manage'), cleanOne, busy })

      if (view === 'manage') {
        const u = manage?.usage
        const block = (title, s, store) => h('div', { className: 'om-card', key: store },
          h('h4', null, title),
          h('div', { className: 'om-row' }, h('span', { className: 'om-k' }, '使用量'), h('span', { className: 'om-mono' }, kb(s?.bytes)), h('span', { className: 'om-dim' }, (s?.items ?? 0) + ' 条')),
          h('div', { className: 'om-row' }, h('span', { className: 'om-k' }, '文件位置'), h('span', { className: 'om-path' }, s?.path || '—')),
          h('div', { className: 'om-row' },
            h('button', { className: 'om-btn', onClick: () => openPreview(store) }, '打开文件'),
            h('button', { className: 'om-btn', onClick: () => { try { navigator.clipboard.writeText(s?.path || '') } catch (e) {} } }, '复制路径'),
            store === 'optimized' ? h('button', { className: 'om-btn', onClick: doBackfill }, '比对底层补齐未保存条数')
              : store === 'base' ? h('span', null,
                  h('button', { className: 'om-btn', onClick: doRebuildBase }, '原始日志提取'), ' ',
                  h('button', { className: 'om-btn', onClick: doImportQA }, '跨平台建档')) : null),
          store === 'base' ? h('div', { className: 'om-dim', style: { fontSize: 11.5, marginTop: 4 } }, '原始日志提取：上下文被压缩的情况下，直接从原始日志提取数据覆盖底层。') : null)
        const previewCard = previewInfo ? h('div', { className: 'om-card', key: 'pv' },
          h('h4', null, '预览：' + (previewInfo.path || '')),
          previewInfo.ok ? h('div', { className: 'om-pre' }, (previewInfo.lines || []).join('\n'))
            : h('div', { className: 'om-warn' }, previewInfo.why || '无法预览'),
          h('button', { className: 'om-btn', onClick: () => setPreviewInfo(null) }, '关闭预览')) : null
        return h('div', null, [
          h('div', { className: 'om-sub', key: 'bar' },
            h('button', { className: 'om-btn', onClick: () => setView('main') }, '← 返回存档设置'),
            h('button', { className: 'om-btn', onClick: doMigrate }, '存档迁移'),
            h('button', { className: 'om-btn', 'data-danger': '1', onClick: () => setView('clean') }, '清理存储')),
          h('div', { className: 'om-dim', key: 'cur', style: { marginBottom: 10 } }, '当前会话：' + (manage?.session?.title || sid || '—')),
          block('底层存储（全部原文／接续用）', u?.base, 'base'),
          block('优化存储（评分压缩后的长期备份／打捞来源）', u?.optimized, 'optimized'),
          block('虚拟上下文（临时记忆／会淡忘）', u?.vctx, 'vctx'),
          previewCard,
          bfModal,
        ])
      }

      const numFields = [
        ['capacityTokens', '虚拟上下文容量 (token)', '虚拟上下文最多占多少 token。超了会按重要度把最不重要的记忆挤掉（它仍在优化存储里）。约等于 ' + Math.round((cfg.capacityTokens || 3000) / 15) + ' 条记忆。'],
        ['injectBudget', '单轮注入预算 (token)', '每轮最多把多少 token 的旧记忆塞回给智能体。太大会挤占当前对话的空间。约等于 ' + Math.round((cfg.injectBudget || 1500) / 15) + ' 条。'],
        ['minDecayDays', '寿命下限 (天)', '低分记忆最少活几天（v2 默认 7）。衰变 = 从虚拟上下文删除；优化存储里还有备份，仍可打捞。'],
        ['maxDecayDays', '最长衰变期 (天)', 'v2 已用 lmaxDays 取代，此值仅兼容保留。'],
        ['halfLifeDays', '半衰期 (天)', '排序用的衰减常数：越旧权重越低，影响淘汰与打捞排序。'],
        ['snapshotKeep', '快照保留 (份)', '回滚点最多留几份，超出自动删最旧的。'],
      ]
      const globalCard = h('div', { className: 'om-card', key: 'g' },
        h('h4', null, '全局设置'),
        numFields.map(([k, label, hint]) => Field({
          key: k, label, hint,
          children: h('input', {
            className: 'om-num', type: 'number', value: cfg[k] ?? '', disabled: busy,
            onChange: (e) => setCfg({ ...cfg, [k]: Number(e.target.value) }),
            onBlur: () => saveCfg({ [k]: cfg[k] }),
          }),
        })))

      const gridFields = [
        ['gridDepth', '网格扩展深度（"三子级"=3）', '从命中项沿向量邻居扩散几级。想收敛设 2，想扩大设 4。'],
        ['gridLevel0', '第 0 级（直接命中）最多几条', '直接命中的候选上限。'],
        ['gridPerLevel', '第 1–3 级每级最多几条', '每级网格邻居上限，防饱和。'],
        ['gridTotal', '单次打捞硬总量（条）', '网格扩展总共最多补几条，超了按分数截断。'],
        ['gridBudgetRatio', '总 token 上限（占注入预算比例）', '0.6 = 网格扩展最多吃掉 60% 注入预算。'],
        ['gridClusterThreshold', '同类事件聚类阈值', '余弦相似度低于这个不算同类。特征哈希下 0.3，换稠密模型后调 0.75。'],
        ['lmaxDays', 'Lmax（7 分参考寿命，天）', '4~6 分寿命 = Lmax × 0.85^(7−分)，固定不随对话量缩放。'],
        ['decay7Months', '7 分事件寿命（月）', '默认 8，弥合 7↔8 断层；衰变掉有打捞兜底。'],
        ['scoreFloatRange', '打捞重打分浮动（±）', '重打分相对原分最多变多少，避免大起大落。'],
      ]
      const gridCard = h('div', { className: 'om-card', key: 'v2' },
        h('h4', null, '检索与网格（v2）'),
        Field({
          label: '索引模式',
          hint: '混合增强：BM25 关键词打底 + 向量语义增强（推荐）。向量索引：纯语义。BM25 索引：纯关键词（最稳、零依赖）。',
          children: h('select', {
            className: 'om-pick', value: cfg.indexMode || 'hybrid', disabled: busy,
            onChange: (e) => { setCfg({ ...cfg, indexMode: e.target.value }); saveCfg({ indexMode: e.target.value }) },
          },
            h('option', { value: 'hybrid' }, '混合增强'),
            h('option', { value: 'bm25' }, 'BM25 索引'),
            h('option', { value: 'vector' }, '向量索引')),
        }),
        gridFields.map(([k, label, hint]) => Field({
          key: k, label, hint,
          children: h('input', {
            className: 'om-num', type: 'number',
            step: (k === 'gridBudgetRatio' || k === 'gridClusterThreshold') ? '0.05' : '1',
            value: cfg[k] ?? '', disabled: busy,
            onChange: (e) => setCfg({ ...cfg, [k]: Number(e.target.value) }),
            onBlur: () => saveCfg({ [k]: cfg[k] }),
          }),
        })))

      const wakeCard = h('div', { className: 'om-card', key: 'w' },
        h('h4', null, '唤醒机制'),
        Field({
          label: '每几天唤醒一次',
          hint: '唤醒时统一做延迟打分、淡忘清理与自动存档。必须 ≤ 最短衰变期（当前上限 ' + (ov?.maxWakeIntervalDays ?? '—') + ' 天）。',
          children: h('input', {
            className: 'om-num', type: 'number', step: '0.5', value: cfg.wakeEveryDays ?? 1, disabled: busy,
            onChange: (e) => setCfg({ ...cfg, wakeEveryDays: Number(e.target.value) }),
            onBlur: () => saveCfg({ wakeEveryDays: cfg.wakeEveryDays }),
          }),
        }),
        Field({
          label: '唤醒时段',
          hint: '只有落在这个时段内才会唤醒，支持跨零点（如 22:00 到 02:00）。',
          children: h('span', { className: 'om-row', style: { margin: 0 } },
            h('input', { className: 'om-num', style: { width: 78 }, value: cfg.wakeStart || '', disabled: busy, onChange: (e) => setCfg({ ...cfg, wakeStart: e.target.value }), onBlur: () => saveCfg({ wakeStart: cfg.wakeStart }) }),
            h('span', { className: 'om-dim' }, '到'),
            h('input', { className: 'om-num', style: { width: 78 }, value: cfg.wakeEnd || '', disabled: busy, onChange: (e) => setCfg({ ...cfg, wakeEnd: e.target.value }), onBlur: () => saveCfg({ wakeEnd: cfg.wakeEnd }) })),
        }),
        Field({
          label: '软件开启时自动唤醒一次',
          hint: '启动约 15 秒后做一次唤醒，用来补上关机期间错过的唤醒。',
          children: h('label', { className: 'om-sw' },
            h('input', { type: 'checkbox', checked: !!cfg.wakeOnStartup, disabled: busy, onChange: (e) => saveCfg({ wakeOnStartup: e.target.checked }) }),
            h('span', null, cfg.wakeOnStartup ? '已开启' : '已关闭')),
        }),
        Field({
          label: '自动存档',
          hint: '唤醒时顺便把日志里没入库的内容补齐并拍快照；关掉后只能手动点「存档」。',
          children: h('label', { className: 'om-sw' },
            h('input', { type: 'checkbox', checked: !!cfg.autoSave, disabled: busy, onChange: (e) => saveCfg({ autoSave: e.target.checked }) }),
            h('span', null, cfg.autoSave ? '已开启' : '已关闭')),
        }),
        Field({
          label: '启用图片存储',
          hint: '关闭时不保存会话里的图（已存的图保留，仅停止新增）。',
          children: h('label', { className: 'om-sw' },
            h('input', { type: 'checkbox', checked: cfg.imageSaveEnabled !== false, disabled: busy, onChange: (e) => saveCfg({ imageSaveEnabled: e.target.checked }) }),
            h('span', null, cfg.imageSaveEnabled !== false ? '已开启' : '已关闭')),
        }),
        h('div', { className: 'om-row' },
          h('button', { className: 'om-btn', disabled: busy || !sid, onClick: () => act('/wake', { sessionId: sid }, '已唤醒一次') }, '现在唤醒一次'),
          h('span', { className: 'om-dim' }, '上次唤醒：' + when(ov?.lastWakeAt))))

      const opsCard = h('div', { className: 'om-card', key: 'o' },
        h('h4', null, '会话存档操作'),
        h('div', { className: 'om-row' },
          h('span', { className: 'om-k' }, '当前会话'),
          h('select', { className: 'om-pick', value: sid, onChange: (e) => setSid(e.target.value) },
            (list || []).map((s) => h('option', { key: s.sessionId, value: s.sessionId }, s.title || s.sessionId)))),
        h('table', { className: 'om-table' },
          h('thead', null, h('tr', null, ['功能', '作用', ''].map((t, i) => h('th', { key: i }, t)))),
          h('tbody', null, [
            row('读档', '把另一个会话（智能体）的档接到当前会话，用于记忆接续。只导入，不合并回去。',
              h('button', { className: 'om-btn', disabled: busy || !sid, onClick: openRead }, '选择存档')),
            row('存档', '把日志里还没入库的内容补进来，把待打分的条目算完，最后拍一份快照。',
              h('button', { className: 'om-btn', disabled: busy || !sid || saveBusy, onClick: doSave }, '立即存档')),
            row('回滚', '恢复到最近一次快照（含虚拟上下文与优化存储的状态）。',
              h('button', { className: 'om-btn', disabled: busy || !sid, onClick: () => act('/rollback', { sessionId: sid }, '已回滚到上一快照') }, '回滚')),
            row('管理存档', '查看三层存储的用量与文件位置，并从这里进入清理。',
              h('button', { className: 'om-btn', disabled: busy || !sid, onClick: () => setView('manage') }, '进入')),
          ])))

      const readModal = readOpen ? h(Modal, { title: '读档：选择要接续的档', onClose: () => setReadOpen(false), wide: true },
        h('div', { className: 'om-dim', style: { marginBottom: 8 } }, '选一个会话的档导入当前会话。没建档的会先只读入档（不采集、不注入）。'),
        h('table', { className: 'om-table' },
          h('thead', null, h('tr', null, ['会话', '工作区', '状态', ''].map((t, i) => h('th', { key: i }, t)))),
          h('tbody', null, (cands || []).length ? cands.map((c) => h('tr', { key: c.sessionId },
            h('td', null, h('div', null, c.title || c.sessionId), h('div', { className: 'om-dim', style: { fontSize: 11 } }, String(c.sessionId).slice(0, 22))),
            h('td', { className: 'om-dim' }, c.workspace || '—'),
            h('td', null, c.added ? h('span', { className: 'om-tag' }, '已建档') : h('span', { className: 'om-dim' }, '未建档')),
            h('td', null, h('button', { className: 'om-btn', onClick: () => doRead(c) }, '读这份'))))
            : h('tr', null, h('td', { colSpan: 4, className: 'om-dim' }, '没有别的会话可读。先去「启用会话」添加一个。'))))) : null

      const impRows = important.map((i) => h('tr', { key: i.id },
        h('td', { className: 'om-dim', style: { whiteSpace: 'nowrap' } }, String(i.at).slice(0, 10)),
        h('td', null, h('span', { className: 'om-tag' }, '分' + Math.round(i.score || 0)), ' ', String(i.summary || '').slice(0, 44)),
        h('td', null, h('button', { className: 'om-btn', 'data-danger': '1', onClick: () => demote(i.id) }, '降级'), ' ',
          h('button', { className: 'om-btn', 'data-danger': '1', onClick: () => delItem(i.id) }, '删除'))))

      const impCard = h('div', { className: 'om-card', key: 'imp' },
        h('div', { className: 'om-row' },
          h('h4', { style: { margin: 0 } }, '重要会话（永久档）'),
          h('span', { className: 'om-dim', style: { marginLeft: 8 } }, important.length + ' 条'),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'om-btn', onClick: () => { loadImportant(); setImpOpen(true) } }, '打开')))

      const impModal = impOpen ? h(Modal, { title: '重要会话（永久档）', onClose: () => setImpOpen(false), wide: true },
        h('div', { style: { maxHeight: '60vh', overflowY: 'auto' } },
          important.length
            ? h('table', { className: 'om-table' },
              h('thead', null, h('tr', null, ['日期', '内容', '操作'].map((t, i) => h('th', { key: i }, t)))),
              h('tbody', null, impRows))
            : h('div', { className: 'om-dim' }, '还没有重要会话。'))) : null

      const imgRows = images.map((img) => h('tr', { key: img.id },
        h('td', null, h('img', {
          src: '/dsh-offline-memory/images/file?session=' + encodeURIComponent(sid) + '&id=' + encodeURIComponent(img.id),
          style: { width: 56, height: 56, objectFit: 'cover', borderRadius: 4, display: 'block' },
          loading: 'lazy',
        })),
        h('td', { className: 'om-dim', style: { whiteSpace: 'nowrap' } }, String(img.date).slice(0, 10)),
        h('td', null, h('span', { className: 'om-tag' }, '#' + img.hash8), ' ', img.source || '图'),
        h('td', null, String(img.desc || '').slice(0, 60)),
        h('td', null, img.verified === 'verified' ? h('span', { className: 'om-tag' }, '已核对')
          : h('button', { className: 'om-btn', onClick: () => markImg(img.id, true) }, '标为已核对'),
          ' ', img.verified === 'suspect' ? h('span', { className: 'om-warn' }, '存疑') : null),
        h('td', null, h('button', { className: 'om-btn', 'data-danger': '1', onClick: () => doDeleteImage(img.id, img.hash8) }, '删除'))))
      const imgCard = h('div', { className: 'om-card', key: 'img' },
        h('div', { className: 'om-row' },
          h('h4', { style: { margin: 0 } }, '图片记忆'),
          h('span', { className: 'om-dim', style: { marginLeft: 8 } }, images.length + ' 张'),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'om-btn', onClick: () => { loadImages(); setImgOpen(true) } }, '打开')))

      const imgModal = imgOpen ? h(Modal, { title: '图片记忆', onClose: () => setImgOpen(false), wide: true },
        h('div', { className: 'om-row', style: { marginBottom: 6 } },
          h('span', { className: 'om-dim', style: { fontSize: 12 } }, '存原图 + 描述文字；注入只给文字，需要细节按编号取图。'),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'om-btn', onClick: doSaveImage }, '手动存图')),
        h('div', { style: { maxHeight: '60vh', overflowY: 'auto' } },
          images.length
            ? h('table', { className: 'om-table' },
              h('thead', null, h('tr', null, ['图', '日期', '编号', '描述', '可信度', '操作'].map((t, i) => h('th', { key: i }, t)))),
              h('tbody', null, imgRows))
            : h('div', { className: 'om-dim' }, '还没有图片。由看得见图的那一端在保存时写入。'))) : null

      const savePct = saveProg && saveProg.total > 0 ? Math.round((saveProg.done / saveProg.total) * 100) : 0
      const saveModal = (saveBusy || saveResult) ? h(Modal, { title: '立即存档', onClose: () => { setSaveBusy(false); setSaveResult(null); setSaveProg(null) } },
        saveBusy ? h('div', null,
          saveProg && saveProg.total > 0
            ? h('div', null,
                h('div', { className: 'om-dim', style: { marginBottom: 8 } }, '正在打分入库… ' + saveProg.done + ' / ' + saveProg.total + ' 条'),
                h('div', { style: { background: '#2a2f3a', borderRadius: 6, height: 14, overflow: 'hidden' } },
                  h('div', { style: { width: savePct + '%', background: '#4ea1ff', height: '100%', transition: 'width .2s' } })))
            : h('div', { className: 'om-dim' }, '正在保存，请稍后…'))
          : saveResult?.err ? h('div', { className: 'om-warn' }, saveResult.err)
            : h('div', null, '存档已更新。本次存档消耗 ', h('b', null, (saveResult.costTokens ?? 0) + ' token'), (saveResult.savedImages ? '，存图 ' + saveResult.savedImages + ' 张' : ''), '（托管打分 0，会话接管为估算值）。')) : null

      const injectCard = h('div', { className: 'om-card', key: 'inj' },
        h('h4', null, '注入与偏好'),
        Field({
          key: 'repeatInject', label: '允许重复注入',
          hint: '关（默认）：同一条内容只注入一次（v2.1.0 行为）。开：允许同一条反复出现在注入块里。',
          children: h('input', {
            type: 'checkbox', checked: !!cfg.repeatInject, disabled: busy,
            onChange: (e) => { setCfg({ ...cfg, repeatInject: e.target.checked }); saveCfg({ repeatInject: e.target.checked }) },
          }),
        }),
        Field({
          key: 'prefInject', label: '注入偏好块',
          hint: '把「偏好库」稳定注入上下文（不参与内容去重，可校准）。',
          children: h('input', {
            type: 'checkbox', checked: cfg.prefInject !== false, disabled: busy,
            onChange: (e) => { setCfg({ ...cfg, prefInject: e.target.checked }); saveCfg({ prefInject: e.target.checked }) },
          }),
        }),
        Field({
          key: 'prefCount', label: '偏好块最多几条',
          hint: '超出按最近添加截断。',
          children: h('input', {
            className: 'om-num', type: 'number', value: cfg.prefCount ?? 12, disabled: busy,
            onChange: (e) => setCfg({ ...cfg, prefCount: Number(e.target.value) }),
            onBlur: () => saveCfg({ prefCount: cfg.prefCount }),
          }),
        }))

      const prefsCard = h('div', { className: 'om-card', key: 'prefs' },
        h('h4', null, '偏好库'),
        h('div', { className: 'om-row' },
          h('button', { className: 'om-btn', disabled: busy, onClick: addPref }, '＋ 添加偏好'),
          h('span', { className: 'om-dim' }, '智能体也能用 prefs 工具自己增删；这份清单会稳定注入')),
        prefs.length ? h('table', { className: 'om-table' },
          h('thead', null, h('tr', null, ['偏好内容', '添加时间', ''].map((t, i) => h('th', { key: i }, t)))),
          h('tbody', null, prefs.map((p) => h('tr', { key: p.id },
            h('td', null, p.text),
            h('td', { className: 'om-dim' }, when(p.at)),
            h('td', null, h('button', { className: 'om-btn', disabled: busy, onClick: () => delPref(p.id) }, '删除'))))))
          : h('div', { className: 'om-dim' }, '还没有偏好记录'))

      const sourcesCard = h('div', { className: 'om-card', key: 'srcs' },
        h('h4', null, '外部源（本会话独立）'),
        h('div', { className: 'om-row' },
          h('button', { className: 'om-btn', disabled: busy, onClick: addSrc }, '＋ 添加外部源'),
          h('span', { className: 'om-dim' }, '日记等文件级来源；每个会话各自维护，互不影响')),
        srcs.length ? h('table', { className: 'om-table' },
          h('thead', null, h('tr', null, ['名称', '路径', '启用', ''].map((t, i) => h('th', { key: i }, t)))),
          h('tbody', null, srcs.map((s) => h('tr', { key: s.id },
            h('td', null, (s.label || s.kind || '外部源') + (s.private ? '（私密）' : '')),
            h('td', { className: 'om-mono', style: { fontSize: 11.5 } }, s.path),
            h('td', null, h('input', { type: 'checkbox', checked: s.enabled !== false, disabled: busy, onChange: () => toggleSrc(s) })),
            h('td', null, h('button', { className: 'om-btn', disabled: busy, onClick: () => delSrc(s.id) }, '删除'))))))
          : h('div', { className: 'om-dim' }, '本会话没有外部源'))

      return h('div', null, [globalCard, wakeCard, gridCard, injectCard, opsCard, prefsCard, sourcesCard, impCard, imgCard, impModal, imgModal, saveModal, bfModal, readModal, migModal])
    }

    function row(name, desc, action) {
      return h('tr', { key: name },
        h('td', { style: { whiteSpace: 'nowrap' } }, h('b', null, name)),
        h('td', { className: 'om-dim' }, desc),
        h('td', null, action))
    }

    function CleanView({ usage, onBack, cleanOne, busy }) {
      const [baseDays, setBaseDays] = useState(7)
      const [optDays, setOptDays] = useState(30)
      return h('div', null, [
        h('div', { className: 'om-sub', key: 'bar' }, h('button', { className: 'om-btn', onClick: onBack }, '← 返回管理存档')),
        h('div', { className: 'om-card', key: 'b' },
          h('h4', null, '清理底层数据'),
          h('div', { className: 'om-row' }, h('span', { className: 'om-k' }, '当前大小'), h('span', { className: 'om-mono' }, kb(usage?.base?.bytes))),
          h('div', { className: 'om-row' },
            h('span', { className: 'om-k' }, '清理多久之前'),
            h('input', { className: 'om-num', type: 'number', value: baseDays, onChange: (e) => setBaseDays(Number(e.target.value)) }),
            h('span', { className: 'om-dim' }, '天'),
            h('button', { className: 'om-btn', 'data-danger': '1', disabled: busy, onClick: () => cleanOne('base', baseDays) }, '清理底层'))),
        h('div', { className: 'om-card', key: 'o' },
          h('h4', null, '清理优化存储'),
          h('div', { className: 'om-row' }, h('span', { className: 'om-k' }, '当前大小'), h('span', { className: 'om-mono' }, kb(usage?.optimized?.bytes))),
          h('div', { className: 'om-row' },
            h('span', { className: 'om-k' }, '清理多久之前'),
            h('input', { className: 'om-num', type: 'number', value: optDays, onChange: (e) => setOptDays(Number(e.target.value)) }),
            h('span', { className: 'om-dim' }, '天'),
            h('button', { className: 'om-btn', 'data-danger': '1', disabled: busy, onClick: () => cleanOne('optimized', optDays) }, '清理优化'))),
        h('div', { className: 'om-warn', key: 'note', style: { fontSize: 12 } },
          '清理前要两次确认；清理优化存储会连带删掉虚拟上下文里指向它的条目（之后无法再打捞）。'),
      ])
    }

    // ---------- 人设属性 ----------
    function Attrs({ list, busy }) {
      const [sid, setSid] = useState('')
      const [st, setSt] = useState(null)
      const [expand, setExpand] = useState(false)
      const [personaOpen, setPersonaOpen] = useState(false)
      const [personaText, setPersonaText] = useState('')
      const [personaMeta, setPersonaMeta] = useState(null)
      const [qaOpen, setQaOpen] = useState(false)
      const [qa, setQa] = useState({ total: 0, samples: [] })

      useEffect(() => { if (!sid && list && list.length) setSid(list[0].sessionId) }, [list])
      useEffect(() => {
        if (!sid) return
        let alive = true
        get('/state?session=' + encodeURIComponent(sid)).then((r) => { if (alive) setSt(r) })
        return () => { alive = false }
      }, [sid])

      const openPersona = async () => {
        const r = await get('/persona?session=' + encodeURIComponent(sid))
        setPersonaText(r.text || '')
        setPersonaMeta(r)
        setPersonaOpen(true)
      }
      const savePersona = async () => {
        const r = await post('/persona', { session: sid, text: personaText, by: 'human' })
        if (!r.ok) window.alert(r.why || '保存失败')
        else window.alert('人设已保存（' + r.bytes + ' 字节）')
        setPersonaOpen(false)
      }
      const openQa = async () => {
        setQa(await get('/qa?session=' + encodeURIComponent(sid) + '&limit=200'))
        setQaOpen(true)
      }
      const [stickerOpen, setStickerOpen] = useState(false)
      const [stickers, setStickers] = useState([])
      const [stStats, setStStats] = useState(null)
      const [scfg, setScfg] = useState(null)
      const loadStickers = async () => {
        if (!sid) return
        const r = await get('/stickers?session=' + encodeURIComponent(sid))
        setStickers(r.items || [])
        setStStats(r.stats || null)
      }
      const openStickers = async () => {
        await loadStickers()
        const c = await get('/config')
        setScfg(c.config || null)
        setStickerOpen(true)
      }
      const scfgSave = async (patch) => {
        const next = { ...(scfg || {}), ...patch }
        setScfg(next)
        await post('/config', { config: patch })
      }
      const addSticker = () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.gif,.webp,.png,.jpg,.jpeg,image/*'
        input.onchange = async (e) => {
          const file = e.target.files && e.target.files[0]
          if (!file) return
          const meaning = window.prompt('这张表情包表达什么？（一句话）') || ''
          const emo = window.prompt('情绪标签（如 无语 / 开心）') || ''
          const scene = window.prompt('场景标签（如 被吐槽）') || ''
          const fr = new FileReader()
          fr.onload = async () => {
            const r = await post('/stickers', { action: 'add', session: sid, base64: String(fr.result), meaning, tags: { 情绪: emo, 场景: scene }, source: 'human' })
            if (!r.ok) window.alert(r.why || '添加失败')
            else window.alert('已添加 ' + r.id + (r.dup ? '（同图去重）' : ''))
            loadStickers()
          }
          fr.readAsDataURL(file)
        }
        input.click()
      }
      const stickerStatus = async (id, status) => {
        await post('/stickers', { action: 'update', session: sid, id, status })
        loadStickers()
      }
      const delSticker = async (id) => {
        if (!window.confirm('删除这张表情包？文件会一起删掉。')) return
        await post('/stickers', { action: 'remove', session: sid, id })
        loadStickers()
      }
      const recalc = async () => {
        if (!window.confirm('清空萌属性与阵营的累计值，并按 Q&A 样本重新计算？（不会删样本）')) return
        const r = await post('/traits-recalc', { sessionId: sid })
        if (!r.ok) { window.alert(r.why || r.error || '失败'); return }
        window.alert('已重算：基于 ' + r.samples + ' 条样本')
        const fresh = await get('/state?session=' + encodeURIComponent(sid))
        if (fresh) setSt(fresh)
      }

      if (!st || st.empty) return h('div', { className: 'om-card om-dim' }, '还没有启用会话。')

      const s = st.session?.stats || {}
      const axes = s.axes || {}
      const al = s.alignment || { order: 0, moral: 0 }
      const ev = st.affectionEvents || []
      const moodEv = st.moodEvents || []
      const aff = s.affection ?? 0
      const mood = s.mood ?? 70
      const moodBand = mood >= 80 ? '非常开心' : mood >= 70 ? '开心' : mood >= 55 ? '平静' : mood >= 40 ? '难过' : '沮丧'
      const affBand = aff >= 90 ? '爱' : aff >= 80 ? '挚友' : aff >= 60 ? '非常喜欢' : aff >= 30 ? '喜欢' : aff > 0 ? '略有好感' : aff === 0 ? '中性' : '讨厌'
      const observed = Object.keys(axes).sort((a, b) => (axes[b] || 0) - (axes[a] || 0))
      const collapsed = ALL45.filter((k) => !observed.includes(k))
      const axisRow = (k) => {
        const v = axes[k]
        const has = typeof v === 'number'
        return h('div', { className: 'om-row', key: k, style: { marginBottom: 5 } },
          h('span', { className: 'om-k', style: { minWidth: 46 } }, k),
          h('div', { className: 'om-bar', style: { flex: 1 } }, h('i', { style: { width: (has ? v : 0) + '%' } })),
          h('span', { className: 'om-mono', style: { width: 44, textAlign: 'right' } }, has ? Math.round(v) + '%' : '—'))
      }

      const head = h('div', { className: 'om-card', key: 'h' },
        h('div', { className: 'om-row' },
          h('span', { className: 'om-k' }, '会话'),
          h('select', { className: 'om-pick', value: sid, onChange: (e) => setSid(e.target.value) },
            (list || []).map((x) => h('option', { key: x.sessionId, value: x.sessionId }, x.title || x.sessionId)))),
        h('div', { className: 'om-row' },
          h('button', { className: 'om-btn', disabled: busy || !sid, onClick: openPersona }, '人设属性'),
          h('button', { className: 'om-btn', disabled: busy || !sid, onClick: openQa }, 'Q&A 样本记录本'),
          h('button', { className: 'om-btn', disabled: busy || !sid, onClick: openStickers }, '表情包收录使用'),
          h('span', { className: 'om-dim' }, '人设是独立模块：人和智能体都能编辑同一份。')))

      const moodCard = h('div', { className: 'om-card', key: 'm' },
        h('h4', null, '心情'),
        h('div', { className: 'om-row' }, h('span', { className: 'om-mono', style: { fontSize: 20 } }, num(mood, 1)), h('span', { className: 'om-tag' }, moodBand)),
        h('div', { className: 'om-bar' }, h('i', { style: { width: Math.round(mood) + '%' } })),
        h('div', { className: 'om-dim', style: { marginTop: 6 } }, '基准 70，随时间回归；给人看的状态读数。'),
        moodEv.length ? h('div', { style: { marginTop: 8 } },
          h('div', { className: 'om-dim' }, '最近变动：'),
          moodEv.map((e, i) => h('div', { key: i, style: { marginBottom: 5 } },
            h('div', { className: 'om-row', style: { margin: 0 } },
              h('span', { className: 'om-mono' }, (e.delta > 0 ? '+' : '') + e.delta),
              h('span', { className: 'om-dim' }, '→ ' + num(e.value, 1)),
              h('span', { className: 'om-dim' }, (e.reason || ''))),
            e.quote ? h('div', { className: 'om-dim', style: { fontSize: 11.5, marginLeft: 24, opacity: .72, wordBreak: 'break-all' } }, '「' + e.quote + '」') : null))) : null)

      const affCard = h('div', { className: 'om-card', key: 'a' },
        h('h4', null, '好感度'),
        h('div', { className: 'om-row' }, h('span', { className: 'om-mono', style: { fontSize: 20 } }, num(aff, 0)), h('span', { className: 'om-tag' }, affBand)),
        h('div', { className: 'om-bar' }, h('i', { style: { width: Math.max(0, Math.min(100, (aff + 100) / 2)) + '%' } })),
        h('div', { className: 'om-dim', style: { marginTop: 6 } }, '0 为基准；只由带原文证据的事件推动，与心情互不换算。'),
        ev.length ? h('div', { style: { marginTop: 8 } },
          h('div', { className: 'om-dim' }, '最近变动：'),
          ev.map((e, i) => h('div', { key: i, className: 'om-row', style: { marginBottom: 3 } },
            h('span', { className: 'om-tag' }, e.type),
            h('span', { className: 'om-mono' }, (e.delta > 0 ? '+' : '') + e.delta),
            h('span', { className: 'om-dim' }, '「' + String(e.evidence?.quote || '').slice(0, 42) + '」')))) : null)

      const traitRows = observed.map(axisRow)
      const collapsedRows = collapsed.map(axisRow)

      const traitCard = h('div', { className: 'om-card', key: 't' },
        h('div', { className: 'om-row' },
          h('h4', { style: { margin: 0 } }, '萌属性'),
          h('span', { className: 'om-tag' }, '娱乐性质 · 依据问答'),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'om-btn', onClick: () => setExpand(!expand) }, expand ? '收起' : '展开其余 ' + collapsed.length + ' 轴'),
          h('button', { className: 'om-btn', disabled: busy || !sid, onClick: recalc }, '清空数据重新计算')),
        h('div', { style: { margin: '8px 0 12px' } }, '综合判定：' + summarizeAxes(axes)),
        observed.length ? traitRows : h('div', { className: 'om-dim' }, '还没有足够对话推断属性，先聊几句。'),
        expand ? h('div', null, [h('div', { className: 'om-dim', key: 'l', style: { margin: '10px 0 6px' } }, '其余轴（无数据，显示为 —）：'), collapsedRows]) : null)

      const alignCard = h('div', { className: 'om-card', key: 'g' },
        h('div', { className: 'om-row' },
          h('h4', { style: { margin: 0 } }, '阵营九宫格'),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'om-btn', disabled: busy || !sid, onClick: recalc }, '清空数据重新计算')),
        h('div', { className: 'om-grid' }, CELLS.map((c, i) => h('div', { key: c, className: 'om-cell', 'data-on': i === cellOf(al.order, al.moral) ? '1' : '0' }, c))),
        h('div', { className: 'om-dim', style: { marginTop: 6 } },
          '守序↔混乱 ' + num(al.order, 0) + '　善良↔邪恶 ' + num(al.moral, 0) + '　（娱乐性质，依据问答样本）'))

      const personaModal = personaOpen ? h(Modal, { key: 'pm', title: '人设属性（独立模块）', onClose: () => setPersonaOpen(false), wide: true },
        h('div', { className: 'om-dim', style: { marginBottom: 8 } },
          '写智能体的性格设定。人和智能体都能编辑这同一份文件；本次由「人」保存。' + (personaMeta?.path ? '  文件：' + personaMeta.path : '')),
        h('textarea', { className: 'om-ta', value: personaText, onChange: (e) => setPersonaText(e.target.value) }),
        h('div', { style: { marginTop: 10, textAlign: 'right' } },
          h('button', { className: 'om-btn', onClick: savePersona }, '保存'))) : null

      const qaRows = (qa.samples || []).map((x, i) => h('tr', { key: i },
        h('td', { className: 'om-dim', style: { whiteSpace: 'nowrap' } }, when(x.at)),
        h('td', { className: 'om-dim' }, x.role === 'user' ? '人' : '智能体'),
        h('td', { className: 'om-mono' }, num(x.score, 1)),
        h('td', null, x.text)))

      const qaModal = qaOpen ? h(Modal, { key: 'qm', title: 'Q&A 样本记录本', onClose: () => setQaOpen(false), wide: true },
        h('div', { className: 'om-dim', style: { marginBottom: 8 } },
          '共 ' + (qa.total ?? 0) + ' 条；萌属性与阵营的判断依据就是这些短句。'),
        h('table', { className: 'om-table' },
          h('thead', null, h('tr', null, ['时间', '来源', '分数', '样本'].map((t, i) => h('th', { key: i }, t)))),
          h('tbody', null, qaRows.length ? qaRows : h('tr', null, h('td', { colSpan: 4, className: 'om-dim' }, '还没有样本：多聊几句，或把评分器设成即时打分。'))))) : null

      const stickerRows = (stickers || []).map((it) => h('tr', { key: it.id },
        h('td', null, h('img', {
          src: '/dsh-offline-memory/sticker-file?session=' + encodeURIComponent(sid) + '&id=' + encodeURIComponent(it.id),
          style: { maxWidth: 56, maxHeight: 44, borderRadius: 4, display: 'block' }, alt: it.id,
        })),
        h('td', null, Object.values(it.tags || {}).filter(Boolean).slice(0, 3).map((v, i) => h('span', { className: 'om-tag', key: i }, v)), h('div', { className: 'om-dim', style: { fontSize: 11 } }, it.id)),
        h('td', null, it.meaning || '—'),
        h('td', null, it.status === 'ready' ? '可用' : it.status === 'retired' ? '已下架' : '待确认'),
        h('td', null,
          it.status !== 'ready' ? h('button', { className: 'om-btn', disabled: busy, onClick: () => stickerStatus(it.id, 'ready') }, '确认可用') : null, ' ',
          h('button', { className: 'om-btn', 'data-danger': '1', disabled: busy, onClick: () => delSticker(it.id) }, '删除'))))

      const stickerModal = stickerOpen ? h(Modal, { key: 'sm', title: '表情包收录使用', onClose: () => setStickerOpen(false), wide: true },
        Field({
          label: '启用表情包',
          hint: '关掉后不注册表情包工具、不注入速查表（避免和其它插件撞名）；切换后需重载插件生效。',
          children: h('input', {
            type: 'checkbox', checked: scfg?.stickerEnabled !== false, disabled: busy,
            onChange: (e) => scfgSave({ stickerEnabled: e.target.checked }),
          }),
        }),
        h('div', { className: 'om-dim', style: { marginBottom: 8 } },
          '存在本会话的 stickers/（和图片记忆 pics/ 分开）。共 ' + (stStats?.total ?? 0) + ' 张，可用 ' + (stStats?.ready ?? 0) + '，待确认 ' + (stStats?.pending ?? 0)),
        h('div', { className: 'om-row' },
          h('span', { className: 'om-k' }, '收录模式'),
          h('select', {
            className: 'om-pick', value: scfg?.stickerCollect || 'manual', disabled: busy,
            onChange: (e) => scfgSave({ stickerCollect: e.target.value }),
          },
            h('option', { value: 'manual' }, '手动（只有主人能加）'),
            h('option', { value: 'semi' }, '半自动（智能体提议，待确认）'),
            h('option', { value: 'auto' }, '自主（智能体自己加）'))),
        h('div', { className: 'om-row' },
          h('span', { className: 'om-k' }, '单轮/间隔/每日'),
          h('input', { className: 'om-num', type: 'number', value: scfg?.stickerMaxPerTurn ?? 1, disabled: busy, onChange: (e) => setScfg({ ...scfg, stickerMaxPerTurn: Number(e.target.value) }), onBlur: () => scfgSave({ stickerMaxPerTurn: scfg?.stickerMaxPerTurn }) }),
          h('input', { className: 'om-num', type: 'number', value: scfg?.stickerMinTurns ?? 3, disabled: busy, onChange: (e) => setScfg({ ...scfg, stickerMinTurns: Number(e.target.value) }), onBlur: () => scfgSave({ stickerMinTurns: scfg?.stickerMinTurns }) }),
          h('input', { className: 'om-num', type: 'number', value: scfg?.stickerDailyCap ?? 30, disabled: busy, onChange: (e) => setScfg({ ...scfg, stickerDailyCap: Number(e.target.value) }), onBlur: () => scfgSave({ stickerDailyCap: scfg?.stickerDailyCap }) })),
        h('div', { className: 'om-row' },
          h('button', { className: 'om-btn', disabled: busy, onClick: addSticker }, '＋ 添加表情包'),
          h('span', { className: 'om-dim' }, '选图 → 填含义和标签；智能体也能用 sticker_add 按收录模式添加')),
        h('table', { className: 'om-table' },
          h('thead', null, h('tr', null, ['图', '标签', '含义', '状态', ''].map((t, i) => h('th', { key: i }, t)))),
          h('tbody', null, stickerRows.length ? stickerRows : h('tr', null, h('td', { colSpan: 5, className: 'om-dim' }, '还没有表情包。'))))) : null

      return h('div', null, [head, moodCard, affCard, traitCard, alignCard, personaModal, qaModal, stickerModal])
    }

    // ---------- 评分器设置 ----------
    // ---------- 注入记录（可复核入口） ----------
    function InjectTab({ list, busy }) {
      const [sid, setSid] = useState('')
      const [rows, setRows] = useState([])
      const [query, setQuery] = useState('')
      const [preview, setPreview] = useState(null)
      const [open, setOpen] = useState(null)
      useEffect(() => { if (!sid && list && list.length) setSid(list[0].sessionId) }, [list])
      const load = async () => setRows((await get('/inject/recent?n=20')).rows || [])
      useEffect(() => { load() }, [])
      const view = async (hash) => setOpen(await get('/inject/block?hash=' + encodeURIComponent(hash)))
      const replay = async (hash) => {
        if (!window.confirm('把这一次的块原样再注入到当前会话？（只注入，不写记忆）')) return
        await post('/inject/replay', { session: sid, hash })
        window.alert('已排队，下一次组装提示词时注入')
      }
      const dryRun = async () => {
        if (!query.trim() || !sid) return
        setPreview(await post('/inject/preview', { session: sid, query }))
      }
      return h('div', null, [
        h('div', { className: 'om-card', key: 'h' },
          h('div', { className: 'om-dim', style: { marginBottom: 8 } }, '这是它每次被塞进去的东西，不是它自己说的。'),
          h('div', { className: 'om-row' },
            h('span', { className: 'om-k' }, '当前会话'),
            h('select', { className: 'om-pick', value: sid, onChange: (e) => setSid(e.target.value) },
              (list || []).map((s) => h('option', { key: s.sessionId, value: s.sessionId }, s.title || s.sessionId))),
            h('input', { className: 'om-num', style: { flex: 1, minWidth: 160 }, placeholder: '输入一句话，预览会注入什么', value: query, onChange: (e) => setQuery(e.target.value), onKeyDown: (e) => e.key === 'Enter' && dryRun() }),
            h('button', { className: 'om-btn', disabled: busy || !sid, onClick: dryRun }, '预览')),
          preview !== null ? h('div', { className: 'om-pre', style: { marginTop: 8 } }, preview.text || '（空，没有可注入的条目）') : null),
        h('div', { className: 'om-card', key: 'l' },
          h('table', { className: 'om-table' },
            h('thead', null, h('tr', null, ['时间', '会话', '触发', '条数', 'token', ''].map((t, i) => h('th', { key: i }, t)))),
            h('tbody', null, rows.length ? rows.map((r) => h('tr', { key: r.blockHash + r.at },
              h('td', { className: 'om-dim', style: { whiteSpace: 'nowrap' } }, when(r.at)),
              h('td', { title: r.session || '' }, (() => {
                const s = (list || []).find((x) => x.sessionId === r.session)
                return s ? (s.title || s.sessionId) : (r.session ? String(r.session).slice(0, 18) + '…' : '—')
              })()),
              h('td', null, r.trigger === 'auto' ? '自动' : r.trigger),
              h('td', { className: 'om-mono' }, r.items + (r.dropped ? '（砍 ' + r.dropped + '）' : '')),
              h('td', { className: 'om-mono' }, (r.used || 0) + '/' + r.budget),
              h('td', null, h('button', { className: 'om-btn', onClick: () => view(r.blockHash) }, '看原文'), ' ',
                h('button', { className: 'om-btn', disabled: busy, onClick: () => replay(r.blockHash) }, '重放'))))
              : h('tr', null, h('td', { colSpan: 6, className: 'om-dim' }, '还没有注入记录。'))))),
        open ? h(Modal, { key: 'm', title: '这一次注入的完整原文', onClose: () => setOpen(null), wide: true },
          h('div', { className: 'om-pre' }, (open.block?.text || '')),
          h('div', { className: 'om-dim', style: { fontSize: 11.5, marginTop: 8 } },
            '预算 ' + (open.block?.budget ?? '—') + '｜已用 ' + (open.block?.used ?? '—') + '｜hash ' + (open.block?.blockHash || ''))) : null,
      ])
    }

    function Scorer({ ov, reload, busy }) {
      const [cfg, setCfg] = useState(ov?.config || {})
      useEffect(() => { if (ov?.config) setCfg(ov.config) }, [ov])
      const save = async (patch) => { const r = await post('/config', { config: patch }); if (r?.warnings?.length) window.alert(r.warnings.join('\n')); reload() }
      const scorer = ov?.scorer || {}

      const subjectOptions = [
        ['hosted', '托管（内置规则）', '插件用关键词、长度、提问等规则自己打分。零成本、零延迟、完全离线；代价是读不懂反讽与上下文，只能算"大致正确"。'],
        ['session', '会话智能体接管', '用当前会话的模型给每条对话打分。更懂上下文与语气；代价是每条多一次模型调用，慢且费 token；失败或超时会自动回退托管。'],
      ]
      const modeOptions = [
        ['instant', '即时打分', '消息一进来就打。虚拟上下文立刻最新、马上能打捞；若同时选了"接管"，会频繁调模型，可能拖慢对话。'],
        ['onSave', '存档 / 唤醒时一起打分', '消息先只落底层存储，等存档或唤醒时批量补分。省调用、不打扰对话；代价是那之前这些新记忆打捞不到。'],
      ]

      const radio = (opts, key) => opts.map(([v, label, desc]) => h('label', {
        key: v, className: 'om-radio', 'data-on': cfg[key] === v ? '1' : '0',
      },
        h('input', { type: 'radio', name: key, checked: cfg[key] === v, disabled: busy, onChange: () => save({ [key]: v }) }),
        h('div', null, h('div', null, h('b', null, label)), h('div', { className: 'om-dim', style: { fontSize: 12 } }, desc))))

      const applyPreset = (subject, mode) => save({ scorerSubject: subject, scorerMode: mode })
      const presetCard = h('div', { className: 'om-card', key: 'p' },
        h('h4', null, '推荐预设'),
        h('div', { className: 'om-row' },
          h('button', {
            className: 'om-btn', 'data-on': cfg.scorerSubject === 'hosted' && cfg.scorerMode === 'instant' ? '1' : '0',
            disabled: busy, onClick: () => applyPreset('hosted', 'instant'),
          }, '日常推荐：托管 + 即时'),
          h('button', {
            className: 'om-btn', 'data-on': cfg.scorerSubject === 'session' && cfg.scorerMode === 'onSave' ? '1' : '0',
            disabled: busy, onClick: () => applyPreset('session', 'onSave'),
          }, '精准打分：接管 + 存档/唤醒时')),
        h('div', { className: 'om-dim', style: { fontSize: 12 } }, [
          '日常推荐：内置规则零延迟、零成本、完全离线，长对话不卡，适合绝大多数场景。',
          '精准打分：模型更懂上下文与语气，但逐条调模型较慢（200 条约十几分钟），所以延迟到存档/唤醒时批量打分，不拖慢对话。',
        ].join('')),
        cfg.scorerSubject === 'session' && cfg.scorerMode === 'instant'
          ? h('div', { className: 'om-warn', style: { fontSize: 12, marginTop: 6 } }, '⚠ 当前是「接管 + 即时」，每条都调模型，长对话会明显变慢；建议用「精准打分」预设（接管 + 存档/唤醒时）。')
          : null)

      const subjectCard = h('div', { className: 'om-card', key: 's' },
        h('h4', null, '评分器主体'),
        radio(subjectOptions, 'scorerSubject'),
        h('div', { className: 'om-dim', style: { fontSize: 12 } },
          '当前模型：' + (scorer.provider ? scorer.provider + '/' + scorer.model : '未探测到') +
          '　LLM 服务：' + (scorer.llmAvailable ? '可用' : '不可用（接管模式会自动回退托管）')))

      const modeCard = h('div', { className: 'om-card', key: 'm' },
        h('h4', null, '评分器运作模式'),
        radio(modeOptions, 'scorerMode'))

      const extraCard = h('div', { className: 'om-card', key: 'e' },
        h('h4', null, '其他'),
        Field({
          label: '评分用模型',
          hint: '留空则用当前默认模型。格式 provider/model，例如 deepseek-account/deepseek-flash。',
          children: h('input', {
            className: 'om-num', style: { width: 260 }, value: cfg.scorerModel || '', disabled: busy,
            onChange: (e) => setCfg({ ...cfg, scorerModel: e.target.value }),
            onBlur: () => save({ scorerModel: cfg.scorerModel }),
          }),
        }),
        Field({
          label: '打分阈值',
          hint: '低分线以下几乎不被记住；重要线以上永不下沉、不参与衰变。',
          children: h('span', { className: 'om-row', style: { margin: 0 } },
            h('span', { className: 'om-dim' }, '低分线'),
            h('input', { className: 'om-num', style: { width: 62 }, type: 'number', value: cfg.scoreLow ?? 4, disabled: busy, onChange: (e) => setCfg({ ...cfg, scoreLow: Number(e.target.value) }), onBlur: () => save({ scoreLow: cfg.scoreLow }) }),
            h('span', { className: 'om-dim' }, '重要线'),
            h('input', { className: 'om-num', style: { width: 62 }, type: 'number', value: cfg.scoreMid ?? 7, disabled: busy, onChange: (e) => setCfg({ ...cfg, scoreMid: Number(e.target.value) }), onBlur: () => save({ scoreMid: cfg.scoreMid }) })),
        }),
        Field({
          label: '单次打分超时',
          hint: '接管模式下超时就回退内置规则，不会卡住采集。',
          children: h('span', { className: 'om-row', style: { margin: 0 } },
            h('input', { className: 'om-num', type: 'number', value: cfg.scorerTimeoutMs ?? 8000, disabled: busy, onChange: (e) => setCfg({ ...cfg, scorerTimeoutMs: Number(e.target.value) }), onBlur: () => save({ scorerTimeoutMs: cfg.scorerTimeoutMs }) }),
            h('span', { className: 'om-dim' }, '毫秒')),
        }))

      return h('div', null, [presetCard, subjectCard, modeCard, extraCard])
    }

    function Panel() {
      const [tab, setTab] = useState('overview')
      const [ov, setOv] = useState(null)
      const [list, setList] = useState([])
      const [cands, setCands] = useState([])
      const [busy, setBusy] = useState(false)

      const reload = useCallback(async () => {
        setBusy(true)
        try {
          const [o, s, c] = await Promise.all([get('/overview'), get('/sessions'), get('/candidates')])
          setOv(o || null)
          setList(s?.sessions || [])
          setCands(c?.candidates || [])
        } finally { setBusy(false) }
      }, [])

      useEffect(() => { reload() }, [reload])

      const body = tab === 'overview' ? h(Overview, { ov, reload, busy })
        : tab === 'sessions' ? h(Sessions, { list, cands, reload, busy })
          : tab === 'archive' ? h(ArchiveTab, { list, ov, reload, busy })
            : tab === 'inject' ? h(InjectTab, { list, busy })
              : tab === 'attrs' ? h(Attrs, { list, busy })
                : h(Scorer, { ov, reload, busy })

      return h('div', { className: 'om' }, [h(Tabs, { key: 't', tab, setTab }), h('div', { key: 'b' }, body)])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 原生目录选择器：返回绝对路径（DSH 客户端 uiWorkspace 服务）
        try { const uw = ctx.get('uiWorkspace'); if (uw && typeof uw.pickDirectory === 'function') pickDir = () => uw.pickDirectory() } catch {}
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-offline-memory')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-offline-memory: styles')
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'offline-memory', order: 41, label: '外置记忆' },
          () => h(Panel),
        ))
      },
    }
  },
})
