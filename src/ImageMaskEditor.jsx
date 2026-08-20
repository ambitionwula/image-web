import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { formatImageBytes } from './imageProcessing'

const MAX_ZOOM_PERCENT = 500
const MAX_ZOOM = MAX_ZOOM_PERCENT / 100

const ImageMaskEditor = forwardRef(function ImageMaskEditor({ item }, ref) {
  const stageRef = useRef(null)
  const canvasRef = useRef(null)
  const imageRef = useRef(null)
  const [brushSize, setBrushSize] = useState(42)
  const [zoom, setZoom] = useState(1)
  const [imageSize, setImageSize] = useState(null)
  const [strokes, setStrokes] = useState([])
  const [drawing, setDrawing] = useState(false)
  const [tool, setTool] = useState('brush')
  const [panning, setPanning] = useState(false)
  const currentStroke = useRef(null)
  const panStart = useRef(null)
  const strokesRef = useRef([])
  const strokesByItemRef = useRef(new Map())
  const activeItemIdRef = useRef(null)
  const safeZoom = Math.min(zoom, MAX_ZOOM)

  useEffect(() => {
    const savedStrokes = item?.id ? strokesByItemRef.current.get(item.id) || [] : []
    activeItemIdRef.current = item?.id || null
    strokesRef.current = savedStrokes
    setStrokes(savedStrokes)
    setZoom(1)
    setImageSize(null)
    imageRef.current = null
    if (!item) return
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled || activeItemIdRef.current !== item.id) return
      imageRef.current = img
      setImageSize({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.src = item.url
    return () => { cancelled = true }
  }, [item?.id])

  useEffect(() => {
    if (zoom > MAX_ZOOM) setZoom(MAX_ZOOM)
    draw()
  }, [strokes, zoom, imageSize])

  function dimensions() {
    const img = imageRef.current
    if (!img) return null
    const maxWidth = 1040
    const maxHeight = 560
    const fitScale = Math.min(maxWidth / img.naturalWidth, maxHeight / img.naturalHeight, 1)
    const displayScale = fitScale * safeZoom
    return {
      displayWidth: Math.max(1, Math.round(img.naturalWidth * displayScale)),
      displayHeight: Math.max(1, Math.round(img.naturalHeight * displayScale)),
      // 始终以原图像素绘制画布，只通过 CSS 改变显示尺寸，避免预览降采样。
      renderWidth: img.naturalWidth,
      renderHeight: img.naturalHeight,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
    }
  }

  function draw(extraStroke = null, savedStrokes = strokes) {
    const canvas = canvasRef.current
    const img = imageRef.current
    const dims = dimensions()
    if (!canvas || !img || !dims) return
    canvas.width = dims.renderWidth
    canvas.height = dims.renderHeight
    canvas.style.width = `${dims.displayWidth}px`
    canvas.style.height = `${dims.displayHeight}px`
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, dims.renderWidth, dims.renderHeight)
    const scaleX = dims.renderWidth / dims.naturalWidth
    const scaleY = dims.renderHeight / dims.naturalHeight
    const strokeScale = Math.max(scaleX, scaleY)
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    for (const stroke of [...savedStrokes, ...(extraStroke ? [extraStroke] : [])]) {
      if (!stroke?.points?.length) continue
      ctx.strokeStyle = 'rgba(221, 67, 45, .58)'
      ctx.fillStyle = 'rgba(221, 67, 45, .58)'
      ctx.lineWidth = stroke.size * strokeScale
      ctx.beginPath()
      ctx.arc(stroke.points[0].x * scaleX, stroke.points[0].y * scaleY, stroke.size * strokeScale / 2, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath(); ctx.moveTo(stroke.points[0].x * scaleX, stroke.points[0].y * scaleY)
      stroke.points.slice(1).forEach(p => ctx.lineTo(p.x * scaleX, p.y * scaleY))
      ctx.stroke()
    }
  }

  function point(e) {
    const rect = canvasRef.current.getBoundingClientRect()
    const img = imageRef.current
    return { x: (e.clientX - rect.left) * img.naturalWidth / rect.width, y: (e.clientY - rect.top) * img.naturalHeight / rect.height }
  }

  function startStroke(e) {
    if (tool !== 'brush' || e.button !== 0 || e.target !== canvasRef.current) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const rect = canvasRef.current.getBoundingClientRect()
    currentStroke.current = { size: brushSize * imageRef.current.naturalWidth / rect.width, points: [point(e)] }
    setDrawing(true); draw(currentStroke.current)
  }

  function startPan(e) {
    if (tool !== 'move' || e.button !== 0) return false
    const stage = stageRef.current
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    panStart.current = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: stage.scrollLeft,
      top: stage.scrollTop,
    }
    setPanning(true)
    return true
  }

  function startInteraction(e) {
    if (!startPan(e)) startStroke(e)
  }

  function moveInteraction(e) {
    if (panStart.current?.pointerId === e.pointerId) {
      const stage = stageRef.current
      stage.scrollLeft = panStart.current.left - (e.clientX - panStart.current.x)
      stage.scrollTop = panStart.current.top - (e.clientY - panStart.current.y)
      return
    }
    if (!drawing || !currentStroke.current) return
    currentStroke.current.points.push(point(e)); draw(currentStroke.current)
  }

  function endInteraction(e) {
    if (panStart.current?.pointerId === e.pointerId) {
      panStart.current = null
      setPanning(false)
      return
    }
    if (!currentStroke.current) return
    const completedStroke = currentStroke.current
    updateStrokes(old => [...old, completedStroke])
    currentStroke.current = null; setDrawing(false)
  }

  function updateStrokes(value) {
    const nextStrokes = typeof value === 'function' ? value(strokesRef.current) : value
    strokesRef.current = nextStrokes
    if (activeItemIdRef.current) strokesByItemRef.current.set(activeItemIdRef.current, nextStrokes)
    setStrokes(nextStrokes)
  }

  useImperativeHandle(ref, () => ({
    hasMask: () => strokes.length > 0,
    async getMask() {
      if (!strokes.length || !imageRef.current) return null
      const img = imageRef.current
      const mask = document.createElement('canvas')
      mask.width = img.naturalWidth; mask.height = img.naturalHeight
      const ctx = mask.getContext('2d')
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, mask.width, mask.height)
      ctx.globalCompositeOperation = 'destination-out'
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'
      for (const stroke of strokes) {
        if (!stroke?.points?.length) continue
        ctx.lineWidth = stroke.size
        const first = stroke.points[0]
        ctx.beginPath(); ctx.arc(first.x, first.y, stroke.size / 2, 0, Math.PI * 2); ctx.fill()
        ctx.beginPath(); ctx.moveTo(first.x, first.y)
        stroke.points.slice(1).forEach(p => ctx.lineTo(p.x, p.y)); ctx.stroke()
      }
      return new Promise(resolve => mask.toBlob(resolve, 'image/png'))
    },
  }), [strokes])

  if (!item) return null
  return <div className="mask-editor">
    <div className="editor-toolbar">
      <div className="editor-heading"><b>局部编辑画笔</b><span>涂红需要修改的区域；不涂抹则编辑整张图片{imageSize ? item.optimized
        ? ` · 已优化 ${item.originalWidth}×${item.originalHeight} / ${formatImageBytes(item.originalBytes)} → ${imageSize.width}×${imageSize.height} / ${formatImageBytes(item.processedBytes)}`
        : ` · 输入图片 ${imageSize.width}×${imageSize.height} / ${formatImageBytes(item.processedBytes || item.file?.size)}` : ''}</span></div>
      <div className="editor-tool-switch" aria-label="编辑工具">
        <button className={tool === 'brush' ? 'active' : ''} onClick={() => setTool('brush')} title="画笔工具：按住鼠标左键涂抹">✎ 画笔</button>
        <button className={tool === 'move' ? 'active' : ''} onClick={() => setTool('move')} title="移动工具：按住鼠标左键拖动画布">✥ 移动</button>
      </div>
      <label>画笔大小 <input type="range" min="1" max="140" step="1" value={brushSize} onChange={e => setBrushSize(Number(e.target.value))} /><strong>{brushSize}</strong></label>
      <label title={`最高支持 ${MAX_ZOOM_PERCENT}% 显示缩放`}>显示缩放 <input type="range" min="50" max={MAX_ZOOM_PERCENT} step="10" value={Math.round(safeZoom * 100)} onChange={e => setZoom(Math.min(MAX_ZOOM, Number(e.target.value) / 100))} /><strong>{Math.round(safeZoom * 100)}%</strong></label>
      <button disabled={!strokes.length} onClick={() => updateStrokes(s => s.slice(0, -1))}>撤销</button>
      <button disabled={!strokes.length} onClick={() => updateStrokes([])}>清空</button>
    </div>
    <div
      ref={stageRef}
      className={`canvas-stage ${tool === 'move' ? 'move-tool' : 'brush-tool'}${panning ? ' is-panning' : ''}`}
      onPointerDown={startInteraction}
      onPointerMove={moveInteraction}
      onPointerUp={endInteraction}
      onPointerCancel={endInteraction}
    ><canvas ref={canvasRef} /></div>
  </div>
})

export default ImageMaskEditor
