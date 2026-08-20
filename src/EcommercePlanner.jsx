import { useEffect, useRef, useState } from 'react'
import SizeSelector, { DETAIL_SIZE_OPTIONS, normalizeStandardSize, STANDARD_SIZE_OPTIONS } from './SizeSelector'
import { optimizeImageForGpt } from './imageProcessing'

const emptyResult = {
  productSummary: '',
  targetAudience: '',
  sellingPoints: [],
  titles: [],
  mainImageCopy: [],
  mainImagePrompt: '',
  sceneImagePrompts: [],
  detailSections: [],
  mainImagePrompts: [],
  skuImagePrompts: [],
  detailImagePrompts: [],
  uncertainties: [],
  analyzedBy: '',
}

const languages = [
  ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'],
  ['ja', '日本語'], ['ko', '한국어'], ['es', 'Español'], ['pt-BR', 'Português (Brasil)'],
  ['fr', 'Français'], ['de', 'Deutsch'], ['it', 'Italiano'], ['nl', 'Nederlands'],
  ['pl', 'Polski'], ['ru', 'Русский'], ['uk', 'Українська'], ['tr', 'Türkçe'],
  ['ar', 'العربية'], ['he', 'עברית'], ['hi', 'हिन्दी'], ['th', 'ไทย'],
  ['vi', 'Tiếng Việt'], ['id', 'Bahasa Indonesia'], ['ms', 'Bahasa Melayu'],
  ['fil', 'Filipino'], ['sv', 'Svenska'], ['da', 'Dansk'], ['no', 'Norsk'],
]

const qualityOptions = [
  ['auto', '自动（推荐）'],
  ['low', '低 · 快速草稿'],
  ['medium', '中 · 标准创作'],
  ['high', '高 · 精细成图'],
]

const maxCommerceReferenceImages = 4
const primaryCommerceReferenceTargetPixels = 8_294_400
const primaryCommerceReferenceMaxBytes = 5_000_000
const primaryCommerceReferenceKeepOriginalBytes = 6_000_000
const secondaryCommerceReferenceTargetPixels = 600 * 600
const secondaryCommerceReferenceMaxBytes = 300_000

function clampImageCount(value, max) {
  const count = Number(value)
  return Number.isFinite(count) ? Math.max(0, Math.min(max, Math.round(count))) : 0
}

async function readJson(response) {
  const text = await response.text()
  if (!text) throw new Error(`本地服务没有返回内容（HTTP ${response.status}）`)
  try { return JSON.parse(text) } catch { throw new Error(`接口返回内容无法识别（HTTP ${response.status}）`) }
}

export default function EcommercePlanner({ headers, settings, configured, onEditPrompt, onGenerateSet, onPause, generating, progress, onOpenSettings, onCopyGenerated, onUserUpdate }) {
  const [files, setFiles] = useState([])
  const [productDescription, setProductDescription] = useState('')
  const filesRef = useRef([])
  const [result, setResult] = useState(emptyResult)
  const [counts, setCounts] = useState({ main: 0, sku: 0, detail: 0 })
  const [sizes, setSizes] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('image-studio-commerce-sizes') || '{}')
      return {
        main: normalizeStandardSize(saved.main),
        sku: normalizeStandardSize(saved.sku),
        detail: saved.detail || '1024x1536',
        detailCustomWidth: saved.detailCustomWidth || 1024,
        detailCustomHeight: saved.detailCustomHeight || 1536,
      }
    }
    catch { return { main: '1024x1024', sku: '1024x1024', detail: '1024x1536', detailCustomWidth: 1024, detailCustomHeight: 1536 } }
  })
  const [language, setLanguage] = useState(() => localStorage.getItem('image-studio-commerce-language') || 'zh-CN')
  const [quality, setQuality] = useState(() => {
    const saved = localStorage.getItem('image-studio-commerce-quality') || 'auto'
    if (localStorage.getItem('image-studio-commerce-quality-version') !== '2') return 'auto'
    return qualityOptions.some(([value]) => value === saved) ? saved : 'auto'
  })
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [draggingImages, setDraggingImages] = useState(false)
  const [preparingImages, setPreparingImages] = useState({ running: false, done: 0, total: 0, message: '' })
  const analyzeAbortRef = useRef(null)
  const dragDepthRef = useRef(0)
  const detailCustomWidth = Math.round(Number(sizes.detailCustomWidth))
  const detailCustomHeight = Math.round(Number(sizes.detailCustomHeight))
  const detailCustomValid = detailCustomWidth >= 64 && detailCustomWidth <= 8192 && detailCustomHeight >= 64 && detailCustomHeight <= 8192
  const resolvedDetailSize = sizes.detail === 'custom' && detailCustomValid ? `${detailCustomWidth}x${detailCustomHeight}` : sizes.detail

  useEffect(() => { filesRef.current = files }, [files])
  useEffect(() => () => {
    analyzeAbortRef.current?.abort()
    filesRef.current.forEach(item => URL.revokeObjectURL(item.url))
  }, [])
  useEffect(() => localStorage.setItem('image-studio-commerce-language', language), [language])
  useEffect(() => localStorage.setItem('image-studio-commerce-sizes', JSON.stringify(sizes)), [sizes])
  useEffect(() => {
    localStorage.setItem('image-studio-commerce-quality', quality)
    localStorage.setItem('image-studio-commerce-quality-version', '2')
  }, [quality])

  async function addFiles(fileList) {
    if (preparingImages.running) return setError('商品图片正在自动优化，请稍候')
    const incoming = Array.from(fileList || [])
    const imageFiles = incoming.filter(file => file?.type?.startsWith('image/') || /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i.test(file?.name || ''))
    if (!imageFiles.length) {
      setError('请拖入图片文件，支持 JPG、PNG、WebP 等常见格式')
      return
    }
    const available = Math.max(0, maxCommerceReferenceImages - filesRef.current.length)
    if (!available) {
      setError(`商品参考图最多上传 ${maxCommerceReferenceImages} 张`)
      return
    }
    const additions = imageFiles.slice(0, available)
    setPreparingImages({ running: true, done: 0, total: additions.length, message: '' })
    setError('')
    const prepared = []
    const failures = []
    const existingCount = filesRef.current.length
    for (let index = 0; index < additions.length; index++) {
      const originalFile = additions[index]
      try {
        const isPrimaryReference = existingCount + index === 0
        const optimized = await optimizeImageForGpt(originalFile, {
          targetPixels: isPrimaryReference ? primaryCommerceReferenceTargetPixels : secondaryCommerceReferenceTargetPixels,
          maxBytes: isPrimaryReference ? primaryCommerceReferenceMaxBytes : secondaryCommerceReferenceMaxBytes,
          skipIfUnderBytes: isPrimaryReference ? primaryCommerceReferenceKeepOriginalBytes : 0,
          compact: !isPrimaryReference,
          forceReencode: !isPrimaryReference,
        })
        prepared.push({ ...optimized, isPrimaryReference, url: URL.createObjectURL(optimized.file), id: crypto.randomUUID(), originalName: originalFile.name })
      } catch (error) {
        failures.push(`${originalFile.name}：${error.message}`)
      }
      setPreparingImages(current => ({ ...current, done: index + 1 }))
    }
    if (prepared.length) setFiles(old => {
      const next = [...old, ...prepared]
      filesRef.current = next
      return next
    })
    const optimizedCount = prepared.filter(item => item.optimized).length
    const limitMessage = imageFiles.length > available ? `；商品参考图最多 ${maxCommerceReferenceImages} 张，本次添加 ${available} 张` : ''
    const failureMessage = failures.length ? `；${failures.length} 张失败：${failures.join('；')}` : ''
    const message = prepared.length
      ? `请将细节最好、最清晰且最能体现商品外观的图片放在第一位，可获得更好的生成效果。已准备 ${prepared.length} 张，其中 ${optimizedCount} 张已自动优化${limitMessage}${failureMessage}`
      : failureMessage.replace(/^；/, '')
    setPreparingImages({ running: false, done: additions.length, total: additions.length, message })
    if (!prepared.length || failures.length) setError(message || '商品图片优化失败')
  }

  function dragEnter(event) {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current += 1
    setDraggingImages(true)
  }

  function dragOver(event) {
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }

  function dragLeave(event) {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDraggingImages(false)
  }

  function dropImages(event) {
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = 0
    setDraggingImages(false)
    const itemFiles = Array.from(event.dataTransfer?.items || [])
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter(Boolean)
    addFiles(itemFiles.length ? itemFiles : event.dataTransfer?.files)
  }

  function pasteImages(event) {
    const pastedFiles = Array.from(event.clipboardData?.files || [])
    if (!pastedFiles.length) return
    event.preventDefault()
    addFiles(pastedFiles)
  }

  function removeFile(id) {
    setFiles(old => {
      const item = old.find(file => file.id === id)
      if (item) URL.revokeObjectURL(item.url)
      return old.filter(file => file.id !== id)
    })
  }

  async function analyze() {
    if (!configured) {
      setError(onOpenSettings ? '请先完成接口设置' : '管理员尚未完成接口设置，请联系管理员')
      onOpenSettings?.()
      return
    }
    if (!files.length) return setError('请至少上传一张清晰的商品图片')
    if (preparingImages.running) return setError('商品图片正在自动优化，请稍候再开始分析')
    if (sizes.detail === 'custom' && !detailCustomValid) return setError('详情图自定义宽高需要填写 64–8192 之间的整数')
    const controller = new AbortController()
    analyzeAbortRef.current = controller
    setRunning(true); setError('')
    try {
      const form = new FormData()
      files.forEach(item => form.append('image', item.file))
      form.append('model', settings.copyModel || 'gpt-5.6')
      form.append('mainCount', String(counts.main))
      form.append('skuCount', String(counts.sku))
      form.append('detailCount', String(counts.detail))
      form.append('mainSize', sizes.main)
      form.append('skuSize', sizes.sku)
      form.append('detailSize', resolvedDetailSize)
      form.append('language', language)
      form.append('productDescription', productDescription.trim())
      const response = await fetch('/api/ecommerce-analyze', { method: 'POST', headers, body: form, signal: controller.signal })
      const data = await readJson(response)
      if (!response.ok) throw new Error(data?.error?.message || '商品分析失败')
      setResult({ ...emptyResult, ...data })
      onUserUpdate?.(data.user)
      onCopyGenerated?.()
    } catch (e) {
      setError(e.name === 'AbortError' ? '分析已暂停。再次点击“开始爆款分析”将重新分析，本次不计入模拟费用。' : e.message)
    } finally {
      analyzeAbortRef.current = null
      setRunning(false)
    }
  }

  function pauseAnalysis() {
    analyzeAbortRef.current?.abort()
  }

  function update(key, value) { setResult(old => ({ ...old, [key]: value })) }
  const listText = key => (result[key] || []).join('\n')
  const updateList = (key, value) => update(key, value.split('\n').map(item => item.trim()).filter(Boolean))
  const enrichPrompt = prompt => productDescription.trim()
    ? `【人工确认的商品描述】${productDescription.trim()}。必须保持该商品身份和用途，不得识别或生成成其他品类。\n\n${prompt}`
    : prompt
  const jobs = [
    ...(result.mainImagePrompts || []).map((prompt, index) => ({ category: 'main', label: `商品主图 ${index + 1}`, prompt: enrichPrompt(prompt), language, size: sizes.main, quality })),
    ...(result.skuImagePrompts || []).map((prompt, index) => ({ category: 'sku', label: `SKU 图 ${index + 1}`, prompt: enrichPrompt(prompt), language, size: sizes.sku, quality })),
    ...(result.detailImagePrompts || []).map((prompt, index) => ({
      category: 'detail', label: `详情图 ${index + 1}`, prompt: enrichPrompt(prompt), language, size: resolvedDetailSize, quality,
      includeProduct: !/^\s*【关联元素】/.test(prompt),
    })),
  ].filter(job => job.prompt)

  function generateJobs() {
    if (preparingImages.running) return setError('商品图片正在自动优化，请稍候再开始生成')
    if (sizes.detail === 'custom' && !detailCustomValid) return setError('详情图自定义宽高需要填写 64–8192 之间的整数')
    setError('')
    onGenerateSet(files.map(item => item.file), jobs)
  }

  return <div className="commerce-planner">
    <div className="commerce-intro">
      <div><span>ECOMMERCE COPILOT</span><h2>AI 爆款商品策划</h2><p>只需上传商品图，AI 自动识别品类、人群和消费热点，直接输出卖点、文案与生图方案。</p></div>
      <div className="commerce-intro-actions"><label><span>内容语言</span><select value={language} disabled={running} onChange={e => setLanguage(e.target.value)}>{languages.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><div className="analyze-action">{running ? <button className="pause-analysis" onClick={pauseAnalysis}>Ⅱ 暂停分析</button> : <button className="analyze-button" disabled={preparingImages.running} onClick={analyze}>{preparingImages.running ? `正在优化 ${preparingImages.done}/${preparingImages.total}` : '✦ 开始爆款分析'}</button>}{running && <div className="analyze-thinking"><span className="ai-thinking"><i />AI 正在思考中</span><small>暂停会取消本次请求，不计入模拟费用</small></div>}</div></div>
    </div>

    <div className="commerce-grid">
      <div className="commerce-inputs">
        <label className={`commerce-upload${draggingImages ? ' is-dragging' : ''}${preparingImages.running ? ' is-processing' : ''}`} tabIndex="0" onDragEnter={dragEnter} onDragOver={dragOver} onDragLeave={dragLeave} onDrop={dropImages} onPaste={pasteImages}><input type="file" accept="image/*" multiple disabled={preparingImages.running} onChange={e => { addFiles(e.target.files); e.target.value = '' }} /><b>{preparingImages.running ? '◌' : draggingImages ? '⇩' : '＋'}</b><span>{preparingImages.running ? `正在优化 ${preparingImages.done}/${preparingImages.total}` : draggingImages ? '松开即可添加图片' : '上传商品图'}</span><small>{preparingImages.running ? '降采样后再用于分析和生图' : `上传后自动降采样，可拖入或粘贴，最多 ${maxCommerceReferenceImages} 张`}</small></label>
        {files.length > 0 && <div className="commerce-images">{files.map(item => <div key={item.id}><img src={item.url} alt="商品参考" /><button onClick={() => removeFile(item.id)}>×</button></div>)}</div>}
        {preparingImages.message && <div className="source-optimization-note">{preparingImages.message}</div>}
        <label className="product-description"><span>请补充商品信息</span><textarea value={productDescription} onChange={e => setProductDescription(e.target.value)} maxLength={1000} placeholder="请告诉 AI：这是什么商品？有什么用途、材质或核心特点？如果外观容易被误认，也请特别说明。" /><small>填写商品名称、用途和关键特征，可以帮助 AI 更准确地识别并策划图片。</small></label>
        <div className="image-counts">
          <b>套图数量</b><p>AI 会根据数量规划不同用途和构图，不会简单重复提示词。</p>
          <div>
            <label><span>商品主图</span><input type="number" min="0" max="10" value={counts.main} onChange={e => setCounts(old => ({ ...old, main: clampImageCount(e.target.value, 10) }))} /><small>0–10 张</small></label>
            <label><span>SKU 图</span><input type="number" min="0" max="10" value={counts.sku} onChange={e => setCounts(old => ({ ...old, sku: Math.max(0, Math.min(10, Number(e.target.value) || 0)) }))} /><small>0–10 张</small></label>
            <label><span>详情图</span><input type="number" min="0" max="30" value={counts.detail} onChange={e => setCounts(old => ({ ...old, detail: clampImageCount(e.target.value, 30) }))} /><small>0–30 张</small></label>
          </div>
          <strong>计划生成 {counts.main + counts.sku + counts.detail} 张图片</strong>
        </div>
        <div className="image-sizes">
          <b>套图尺寸</b><p>三类图片可以分别设置，生成和展示会使用对应尺寸。</p>
          <div>{[['main', '商品主图'], ['sku', 'SKU 图'], ['detail', '详情图']].map(([key, label]) => <SizeSelector
            key={key}
            label={`${label}（宽 × 高）`}
            value={sizes[key]}
            options={key === 'detail' ? DETAIL_SIZE_OPTIONS : STANDARD_SIZE_OPTIONS}
            customSize={key === 'detail' ? { width: sizes.detailCustomWidth, height: sizes.detailCustomHeight } : null}
            onCustomSizeChange={key === 'detail' ? size => setSizes(old => ({ ...old, detailCustomWidth: size.width, detailCustomHeight: size.height })) : undefined}
            onChange={e => setSizes(old => ({ ...old, [key]: e.target.value }))}
          />)}</div>
          <small className="size-warning">详情图超过 1024×1536 的规格需要当前图片模型支持；系统会按所选尺寸原样提交，不会拉伸生成结果。</small>
        </div>
        <div className="image-quality">
          <b>生成质量</b>
          <select value={quality} onChange={e => setQuality(e.target.value)}>{qualityOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
        </div>
        <div className="auto-analysis-note"><b>AI 将自动完成</b><p>识别商品与品类 · 推断核心人群 · 挖掘情绪价值与消费热点 · 提炼差异化卖点 · 生成爆款标题 · 规划主图与详情页</p><small>图片中无法确认的材质、参数、功效和认证不会被当作事实。</small></div>
        {error && <div className="commerce-error">{error}</div>}
      </div>

      <div className="commerce-output">
        {!result.productSummary && !running ? <div className="commerce-empty"><b>◇</b><p>分析结果会显示在这里</p><span>建议上传正面、侧面、包装和细节图片</span></div> : <>
          <label><span>商品视觉分析</span><textarea value={result.productSummary} onChange={e => update('productSummary', e.target.value)} /></label>
          <label><span>热点人群与购买动机</span><textarea value={result.targetAudience} onChange={e => update('targetAudience', e.target.value)} /></label>
          <label><span>爆款核心卖点（每行一条）</span><textarea value={listText('sellingPoints')} onChange={e => updateList('sellingPoints', e.target.value)} /></label>
          <label><span>高点击标题建议（每行一条）</span><textarea value={listText('titles')} onChange={e => updateList('titles', e.target.value)} /></label>
          <label><span>主图钩子文案（每行一条）</span><textarea value={listText('mainImageCopy')} onChange={e => updateList('mainImageCopy', e.target.value)} /></label>
          <div className="prompt-category main"><div><b>商品主图方案</b><span>{result.mainImagePrompts?.length || 0} 张</span></div><textarea className="detail-editor" value={listText('mainImagePrompts')} onChange={e => updateList('mainImagePrompts', e.target.value)} /></div>
          <div className="prompt-category sku"><div><b>SKU 图方案</b><span>{result.skuImagePrompts?.length || 0} 张</span></div><textarea className="detail-editor" value={listText('skuImagePrompts')} onChange={e => updateList('skuImagePrompts', e.target.value)} /></div>
          <div className="prompt-category detail"><div><b>商品详情图方案</b><span>{result.detailImagePrompts?.length || 0} 张</span></div><textarea className="detail-editor" value={listText('detailImagePrompts')} onChange={e => updateList('detailImagePrompts', e.target.value)} /></div>
          {jobs[0] && <button className="edit-first-prompt" onClick={() => onEditPrompt(files.map(item => item.file), jobs[0].prompt)}>先送第 1 张到图片编辑 →</button>}
          <div className="commerce-workflow">
            <div><b>一键生成并分类归档</b><p>{result.mainImagePrompts?.length || 0} 张主图 · {result.skuImagePrompts?.length || 0} 张 SKU 图 · {result.detailImagePrompts?.length || 0} 张详情图，生成后自动放入对应区域。</p></div>
            <div className="generation-actions">{generating ? <><div className="batch-thinking"><span className="ai-thinking"><i />AI 正在并行生成</span><small>已完成 {progress.done}/{progress.total} 张 · 请求错开 20 秒 · 失败图片最后自动补生</small></div><button className="pause-generation" onClick={onPause}>Ⅱ 暂停生成</button></> : <button disabled={!jobs.length || preparingImages.running} onClick={generateJobs}>✦ 生成 / 继续剩余（{jobs.length} 张）</button>}</div>
          </div>
          {result.uncertainties?.length > 0 && <div className="uncertainties"><b>需要人工确认</b>{result.uncertainties.map((item, index) => <p key={index}>· {item}</p>)}</div>}
        </>}
      </div>
    </div>
  </div>
}
