import { fitGptImage2OutputSize } from './imageSizing'

export const STANDARD_SIZE_OPTIONS = [
  { value: '1024x1024', name: '正方形', ratio: '1:1' },
  { value: '1152x1536', name: '竖图', ratio: '3:4' },
  { value: '864x1536', name: '手机竖图', ratio: '9:16' },
  { value: '1536x1152', name: '横图', ratio: '4:3' },
  { value: '1536x864', name: '宽屏横图', ratio: '16:9' },
]

const SOURCE_SIZE_OPTION = { value: 'source', name: '默认：保持原图比例', ratio: '自动', special: 'source' }
export const CUSTOM_SIZE_OPTION = { value: 'custom', name: '自定义比例', ratio: '自定义', special: 'custom' }

export const EDIT_SIZE_OPTIONS = [SOURCE_SIZE_OPTION, ...STANDARD_SIZE_OPTIONS]

export const DETAIL_SIZE_OPTIONS = [
  { value: '1024x1024', name: '方形详情图', ratio: '1:1' },
  { value: '1536x1024', name: '横向详情图', ratio: '3:2' },
  { value: '1024x1536', name: '标准竖图', ratio: '2:3' },
  { value: '1024x1792', name: '长竖图', ratio: '4:7', note: '需模型支持' },
  { value: '1024x2048', name: '长竖图', ratio: '1:2', note: '需模型支持' },
  { value: '1024x2560', name: '超长竖图', ratio: '2:5', note: '需模型支持' },
  CUSTOM_SIZE_OPTION,
]

export function normalizeStandardSize(value) {
  if (STANDARD_SIZE_OPTIONS.some(option => option.value === value)) return value
  return {
    '512x512': '1024x1024',
    '1024x1536': '1152x1536',
    '1536x1024': '1536x1152',
  }[value] || '1024x1024'
}

export function normalizeEditSize(value) {
  return EDIT_SIZE_OPTIONS.some(option => option.value === value) ? value : 'source'
}

function greatestCommonDivisor(a, b) {
  let x = Math.max(1, Math.round(Number(a) || 1))
  let y = Math.max(1, Math.round(Number(b) || 1))
  while (y) [x, y] = [y, x % y]
  return x
}

function ratioText(width, height) {
  const divisor = greatestCommonDivisor(width, height)
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`
}

function sizeInfo(value, options, sourceSize, customSize) {
  const selected = options.find(option => option.value === value) || options[0] || { value: '1024x1024', name: '正方形', ratio: '1:1' }
  let width
  let height
  let detail

  if (selected.special === 'source') {
    const sourceWidth = Number(sourceSize?.width)
    const sourceHeight = Number(sourceSize?.height)
    const fitted = fitGptImage2OutputSize(sourceWidth, sourceHeight)
    width = sourceWidth || 4
    height = sourceHeight || 3
    detail = sourceSize?.width && sourceSize?.height
      ? `原图 ${sourceSize.width}×${sourceSize.height} · 输出 ${fitted.width}×${fitted.height} px${fitted.ratioLimited ? ' · 已按模型最大 3:1 比例适配' : ''}`
      : '上传主图后识别比例，并自动适配模型输出尺寸'
  } else if (selected.special === 'custom') {
    width = Math.max(1, Number(customSize?.width) || 1024)
    height = Math.max(1, Number(customSize?.height) || 1024)
    detail = `${width}×${height} px · ${ratioText(width, height)}`
  } else {
    [width = 1, height = 1] = selected.value.split('x').map(Number)
    detail = `${width}×${height} px · ${selected.ratio}`
  }

  const scale = Math.min(28 / width, 28 / height)
  return {
    ...selected,
    width,
    height,
    detail,
    previewWidth: Math.max(5, Math.round(width * scale)),
    previewHeight: Math.max(5, Math.round(height * scale)),
  }
}

export default function SizeSelector({ label, value, onChange, options = STANDARD_SIZE_OPTIONS, sourceSize, customSize, onCustomSizeChange }) {
  const selected = sizeInfo(value, options, sourceSize, customSize)
  const selectedText = `${selected.name} · ${selected.detail}`

  return <div className="size-selector">
    <span className="size-selector-label">{label}</span>
    <div className="size-choice" title={`当前画布：${selectedText}`}>
      <div className="size-selected">
        <span className="size-example" aria-hidden="true">
          <i style={{ width: `${selected.previewWidth}px`, height: `${selected.previewHeight}px` }} />
        </span>
        <div className="size-selected-info"><b>{selected.name}</b>{selected.special !== 'source' && <small>{selected.detail}</small>}</div>
      </div>
      <select value={value} onChange={onChange} aria-label={`${label}，宽乘高`}>
        {options.map(option => {
          if (option.special === 'source') return <option value={option.value} key={option.value}>默认：保持上传原图比例（自动适配模型尺寸）</option>
          if (option.special === 'custom') return <option value={option.value} key={option.value}>自定义宽高比例</option>
          const [width, height] = option.value.split('x')
          return <option value={option.value} key={option.value}>
            {option.name} {width}×{height}（{option.ratio}）
          </option>
        })}
      </select>
      {selected.special === 'custom' && <div className="custom-size-inputs">
        <label><span>宽</span><input type="number" min="64" max="8192" step="1" value={customSize?.width ?? 1024} onChange={e => onCustomSizeChange?.({ ...customSize, width: e.target.value })} /></label>
        <i>×</i>
        <label><span>高</span><input type="number" min="64" max="8192" step="1" value={customSize?.height ?? 1024} onChange={e => onCustomSizeChange?.({ ...customSize, height: e.target.value })} /></label>
        <small>像素</small>
      </div>}
    </div>
  </div>
}
