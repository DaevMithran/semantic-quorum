// Pan + zoom over the world, and a camera that follows the deal (glides to the building where things happen).
// Wheel / pinch to zoom, drag to pan. Touching the map hands control to you; "Follow the deal" takes it back.

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { WORLD_H, WORLD_W } from './companies'

type Cam = { x: number; y: number; w: number }
type Box = { x: number; y: number; w: number; h: number }
const MIN_W = 480
// The screen's height / width; the camera keeps this ratio so the map always fills the page.
let ASPECT = 0.6

const maxW = () => Math.max(WORLD_W, WORLD_H / ASPECT) * 1.45
const clamp = (c: Cam): Cam => {
	const w = Math.min(maxW(), Math.max(MIN_W, c.w))
	const h = w * ASPECT
	const mx = 200
	return {
		w,
		x: w >= WORLD_W ? (WORLD_W - w) / 2 : Math.min(WORLD_W - w + mx, Math.max(-mx, c.x)),
		y: h >= WORLD_H ? (WORLD_H - h) / 2 : Math.min(WORLD_H - h + mx, Math.max(-mx, c.y)),
	}
}
/** Camera that shows a rect (world units), with room for the floating panels (`inset` = fraction of the screen they cover on each side). */
export const camFor = (r: Box | undefined, inset = { left: 0, right: 0 }): Cam => {
	const box = r ?? { x: 0, y: 0, w: WORLD_W, h: WORLD_H }
	// the whole-town view only leaves room for the left panel (the scores panel can be hidden)
	const ins = r ? inset : { left: inset.left, right: 0 }
	const usable = 1 - ins.left - ins.right
	const w = Math.max(box.w / usable, box.h / ASPECT)
	const cx = box.x + box.w / 2 - (w * (ins.left - ins.right)) / 2
	return clamp({ w, x: cx - w / 2, y: box.y + box.h / 2 - (w * ASPECT) / 2 })
}


export const Viewport = ({ target, follow, onFollowChange, label, inset, children }: { target?: Box; follow: boolean; onFollowChange: (f: boolean) => void; label: string; inset: { left: number; right: number }; children: ReactNode }) => {
	const svg = useRef<SVGSVGElement>(null)
	const [cam, setCam] = useState<Cam>({ x: 0, y: 0, w: WORLD_W })
	const [aspect, setAspect] = useState(0.6)
	const camRef = useRef(cam)
	camRef.current = cam
	const anim = useRef<number>()
	const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

	const glide = useCallback(
		(to: Cam) => {
			if (anim.current) cancelAnimationFrame(anim.current)
			if (reduce) return setCam(to)
			const from = camRef.current
			const t0 = performance.now()
			const D = 1100
			const step = (t: number) => {
				const k = Math.min(1, (t - t0) / D)
				const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2
				setCam({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, w: from.w + (to.w - from.w) * e })
				if (k < 1) anim.current = requestAnimationFrame(step)
			}
			anim.current = requestAnimationFrame(step)
		},
		[reduce],
	)

	// keep the camera's ratio equal to the screen's
	useEffect(() => {
		const el = svg.current
		if (!el) return
		const ro = new ResizeObserver(() => {
			const r = el.getBoundingClientRect()
			if (r.width > 0 && r.height > 0) {
				ASPECT = r.height / r.width
				setAspect(ASPECT)
			}
		})
		ro.observe(el)
		return () => ro.disconnect()
	}, [])

	useEffect(() => {
		if (follow) glide(camFor(target, inset))
		else setCam((c) => clamp(c))
	}, [follow, target?.x, target?.y, target?.w, target?.h, aspect, glide]) // eslint-disable-line react-hooks/exhaustive-deps

	// world point under a screen point
	const toWorld = (px: number, py: number) => {
		const r = svg.current!.getBoundingClientRect()
		const c = camRef.current
		return { x: c.x + ((px - r.left) / r.width) * c.w, y: c.y + ((py - r.top) / r.height) * c.w * ASPECT, r }
	}
	const zoomAt = (px: number, py: number, factor: number) => {
		const { x, y, r } = toWorld(px, py)
		const c = camRef.current
		const w = Math.min(maxW(), Math.max(MIN_W, c.w * factor))
		setCam(clamp({ w, x: x - ((px - r.left) / r.width) * w, y: y - ((py - r.top) / r.height) * w * ASPECT }))
	}
	const takeControl = () => {
		if (anim.current) cancelAnimationFrame(anim.current)
		onFollowChange(false)
	}

	// wheel (non-passive so the page doesn't scroll)
	useEffect(() => {
		const el = svg.current
		if (!el) return
		const onWheel = (e: WheelEvent) => {
			e.preventDefault()
			takeControl()
			zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * 0.0015))
		}
		el.addEventListener('wheel', onWheel, { passive: false })
		return () => el.removeEventListener('wheel', onWheel)
	}) // re-binds each render with fresh closures; cheap

	// drag + pinch
	const pointers = useRef(new Map<number, { x: number; y: number }>())
	const pinch = useRef<number>()
	const onPointerDown = (e: React.PointerEvent) => {
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
		;(e.target as Element).setPointerCapture?.(e.pointerId)
	}
	const onPointerMove = (e: React.PointerEvent) => {
		const prev = pointers.current.get(e.pointerId)
		if (!prev) return
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
		const pts = [...pointers.current.values()]
		if (pts.length === 2) {
			const d = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y)
			if (pinch.current) {
				takeControl()
				zoomAt((pts[0]!.x + pts[1]!.x) / 2, (pts[0]!.y + pts[1]!.y) / 2, pinch.current / d)
			}
			pinch.current = d
			return
		}
		const dx = e.clientX - prev.x
		const dy = e.clientY - prev.y
		if (Math.abs(dx) + Math.abs(dy) < 1) return
		takeControl()
		const r = svg.current!.getBoundingClientRect()
		const c = camRef.current
		setCam(clamp({ ...c, x: c.x - (dx / r.width) * c.w, y: c.y - (dy / r.height) * c.w * ASPECT }))
	}
	const onPointerUp = (e: React.PointerEvent) => {
		pointers.current.delete(e.pointerId)
		if (pointers.current.size < 2) pinch.current = undefined
	}

	const zoomBy = (f: number) => {
		takeControl()
		const r = svg.current!.getBoundingClientRect()
		zoomAt(r.left + r.width / 2, r.top + r.height / 2, f)
	}

	return (
		<div className="viewport">
			<svg
				ref={svg}
				className="world"
				viewBox={`${cam.x} ${cam.y} ${cam.w} ${cam.w * aspect}`}
				preserveAspectRatio="xMidYMid slice"
				role="img"
				aria-label={label}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerUp}
			>
				{children}
			</svg>
			<div className="cam-controls">
				<button type="button" onClick={() => zoomBy(0.75)} aria-label="Zoom in">
					+
				</button>
				<button type="button" onClick={() => zoomBy(1.33)} aria-label="Zoom out">
					−
				</button>
				<button
					type="button"
					onClick={() => {
						onFollowChange(false)
						glide(camFor(undefined, inset))
					}}
				>
					Whole town
				</button>
				<button type="button" className={follow ? 'on' : undefined} aria-pressed={follow} onClick={() => onFollowChange(!follow)}>
					Follow the deal
				</button>
			</div>
		</div>
	)
}
