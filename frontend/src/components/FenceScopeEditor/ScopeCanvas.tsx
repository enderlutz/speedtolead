import { Fragment, useEffect, useRef, useState } from "react";
import { Stage, Layer, Rect, Image as KonvaImage, Line, Circle, Text as KonvaText } from "react-konva";
import type Konva from "konva";
import type { FenceScopeSegment } from "@/lib/api";
import type { ScopeStateApi } from "./use-scope-state";
import type { CanvasView } from "./use-canvas-view";
import type { HeaderTheme } from "./header-theme";
import { placeArrowsAlongPath, arrowheadPoints, type Pt } from "./arrows";
import {
  BLUE, RED, LINE_HALO, NODE_FILL, NODE_STROKE, LINE_WIDTH_INNER, LINE_WIDTH_HALO,
  NODE_RADIUS, ARROW_SPACING_PX, ARROW_LENGTH, ARROW_WIDTH,
  LEGEND_WIDTH_FRAC, LEGEND_HEIGHT_FRAC, LEGEND_MARGIN_FRAC,
  PAGE_MARGIN_FRAC, LOGO_MAX_WIDTH_FRAC, LOGO_HEIGHT_FRAC,
  GOLD, HEADER_TEXT,
} from "./constants";

export interface BodyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Props {
  scope: ScopeStateApi;
  /** Visible area — the whole frame, which is larger than the page. */
  stageWidth: number;
  stageHeight: number;
  /** The document itself, drawn at (0,0) and moved around by the view. */
  pageWidth: number;
  pageHeight: number;
  view: CanvasView;
  sourceImage: HTMLImageElement | HTMLCanvasElement | null;
  logoImage: HTMLImageElement | null;
  headerTheme: HeaderTheme;
  address: string;
  bodyRect: BodyRect;
  activePointIndex: number | null;
  onActivePointChange: (i: number | null) => void;
  stageRef?: React.RefObject<Konva.Stage | null>;
}

/** Pointer travel, in px, before a press counts as a pan rather than a click. */
const PAN_THRESHOLD = 4;

function toPixel(p: { x: number; y: number }, body: BodyRect) {
  return { x: body.x + p.x * body.width, y: body.y + p.y * body.height };
}
function toNormalized(x: number, y: number, body: BodyRect) {
  const nx = Math.min(1, Math.max(0, (x - body.x) / body.width));
  const ny = Math.min(1, Math.max(0, (y - body.y) / body.height));
  return { x: nx, y: ny };
}
function colorHex(c: "blue" | "red") {
  return c === "blue" ? BLUE : RED;
}
function flatten(pts: Pt[]) {
  return pts.flatMap((p) => [p.x, p.y]);
}
function presentColors(segments: FenceScopeSegment[]) {
  return { blue: segments.some((s) => s.color === "blue"), red: segments.some((s) => s.color === "red") };
}

export default function ScopeCanvas({
  scope, stageWidth, stageHeight, pageWidth, pageHeight, view, sourceImage, logoImage,
  headerTheme, address, bodyRect, activePointIndex, onActivePointChange, stageRef,
}: Props) {
  const internalStageRef = useRef<Konva.Stage>(null);
  const ref = stageRef || internalStageRef;
  const [dragPreview, setDragPreview] = useState<{ segId: string; index: number; x: number; y: number } | null>(null);

  // Panning is driven straight off the pointer rather than through Konva's
  // own stage dragging: the stage is moved imperatively during the gesture
  // (no React render per frame) and the result is handed back to the view on
  // release. A press that turns into a pan must not also register as a click,
  // or it drops a stray fence point wherever the drag ended.
  const panStart = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const pannedRef = useRef(false);

  const drawing = scope.mode === "blue" || scope.mode === "red";
  const idleCursor = drawing ? "crosshair" : "grab";

  // Plain functions, not useCallback: they all read a ref, which defeats
  // memoization anyway, and Konva re-binds its handlers each render regardless.
  const setCursor = (c: string) => {
    const stage = ref.current;
    if (stage) stage.container().style.cursor = c;
  };

  useEffect(() => {
    const stage = ref.current;
    if (stage) stage.container().style.cursor = idleCursor;
  }, [idleCursor, ref]);

  const endPan = () => {
    const start = panStart.current;
    const stage = ref.current;
    panStart.current = null;
    if (!start || !stage || !pannedRef.current) return;
    setCursor(idleCursor);
    view.commitPan(stage.position());
  };

  const beginPan = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    pannedRef.current = false;
    const stage = ref.current;
    if (!stage) return;
    // An endpoint node owns its own drag — don't pan out from under it.
    const target = e.target;
    if (target !== stage && typeof target.draggable === "function" && target.draggable()) return;
    const pos = stage.getPointerPosition();
    if (!pos) return;
    panStart.current = { px: pos.x, py: pos.y, x: stage.x(), y: stage.y() };
    // Releasing outside the canvas still has to finish the gesture, or the
    // next React render snaps the page back to where the drag started.
    window.addEventListener("mouseup", endPan, { once: true });
    window.addEventListener("touchend", endPan, { once: true });
  };

  const movePan = () => {
    const start = panStart.current;
    const stage = ref.current;
    if (!start || !stage) return;
    const pos = stage.getPointerPosition();
    if (!pos) return;
    const dx = pos.x - start.px;
    const dy = pos.y - start.py;
    if (!pannedRef.current) {
      if (Math.abs(dx) < PAN_THRESHOLD && Math.abs(dy) < PAN_THRESHOLD) return;
      pannedRef.current = true;
      setCursor("grabbing");
    }
    stage.position(view.boundPan({ x: start.x + dx, y: start.y + dy }));
    stage.batchDraw();
  };

  const handleStageClick = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = ref.current;
    if (!stage) return;
    if (pannedRef.current) return; // that was a pan, not a click
    if (drawing) {
      const pos = stage.getRelativePointerPosition();
      if (pos) scope.addDrawingPoint(toNormalized(pos.x, pos.y, bodyRect));
      return;
    }
    if (e.target === e.currentTarget || e.target.getClassName() === "Image" || e.target.getClassName() === "Rect") {
      scope.selectSegment(null);
      onActivePointChange(null);
    }
  };

  const handleStageDblClick = () => {
    if (drawing) scope.finishDrawing();
  };

  const handleWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    view.wheel(e.evt, ref.current?.getPointerPosition() ?? null);
  };

  // ---- header geometry ----
  // Everything below is laid out off the page, not the frame, so the export
  // is identical to what's on screen at any zoom.
  const margin = pageWidth * PAGE_MARGIN_FRAC;
  const headerH = bodyRect.y;
  let logoW = 0;
  let logoH = 0;
  if (logoImage && logoImage.naturalWidth && logoImage.naturalHeight) {
    logoH = headerH * LOGO_HEIGHT_FRAC;
    logoW = (logoH * logoImage.naturalWidth) / logoImage.naturalHeight;
    const maxW = pageWidth * LOGO_MAX_WIDTH_FRAC;
    if (logoW > maxW) {
      logoW = maxW;
      logoH = (logoW * logoImage.naturalHeight) / logoImage.naturalWidth;
    }
  }
  // The wordmark fallback needs the same reservation as a real logo would.
  const brandW = logoImage ? logoW : pageWidth * 0.34;
  const textX = margin + brandW + pageWidth * 0.02;
  const textW = Math.max(pageWidth * 0.2, pageWidth - margin - textX);

  return (
    <Stage
      ref={ref}
      width={stageWidth}
      height={stageHeight}
      scaleX={view.zoom}
      scaleY={view.zoom}
      x={view.pan.x}
      y={view.pan.y}
      onWheel={handleWheel}
      onMouseDown={beginPan}
      onMouseMove={movePan}
      onMouseUp={endPan}
      onTouchStart={beginPan}
      onTouchMove={movePan}
      onTouchEnd={endPan}
      onClick={handleStageClick}
      onDblClick={handleStageDblClick}
      onTap={handleStageClick as unknown as (e: Konva.KonvaEventObject<TouchEvent>) => void}
    >
      {/* The page */}
      <Layer>
        <Rect x={0} y={0} width={pageWidth} height={pageHeight} fill="#111" />
        {sourceImage && (
          <KonvaImage image={sourceImage} x={bodyRect.x} y={bodyRect.y} width={bodyRect.width} height={bodyRect.height} />
        )}
      </Layer>

      {/* Locked branding — header, logo, legend. Nothing here is VA-editable. */}
      <Layer listening={false}>
        <Rect x={0} y={0} width={pageWidth} height={headerH} fill={headerTheme.bg} />
        <Rect x={0} y={0} width={pageWidth} height={2} fill={headerTheme.accent} />
        {logoImage ? (
          <KonvaImage image={logoImage} x={margin} y={(headerH - logoH) / 2} width={logoW} height={logoH} />
        ) : (
          <KonvaText
            x={margin} y={headerH * 0.36}
            width={brandW}
            text="STERLING FENCE STAINING"
            fontSize={headerH * 0.15}
            fontFamily="Georgia, serif" fontStyle="bold" fill={headerTheme.accent}
          />
        )}
        <KonvaText
          x={textX} y={headerH * 0.2} width={textW} align="right"
          text="Fence Staining Scope"
          fontSize={headerH * 0.24} fontFamily="Georgia, serif" fontStyle="bold" fill={headerTheme.ink}
        />
        <KonvaText
          x={textX} y={headerH * 0.56} width={textW} align="right"
          text={`Prepared for: ${address || "—"}`}
          fontSize={headerH * 0.13} fontFamily="Arial, sans-serif" fill={headerTheme.ink}
          wrap="word" lineHeight={1.15}
        />

        {/* Legend — auto-updates on which colors are present. Never mentions
            unmarked sections (spec Section 6/32). Sits on the photo, so it
            keeps its own dark plate regardless of the header colour. */}
        {(() => {
          const { blue, red } = presentColors(scope.segments);
          if (!blue && !red) return null;
          const lx = bodyRect.x + bodyRect.width * LEGEND_MARGIN_FRAC;
          const ly = bodyRect.y + bodyRect.height - bodyRect.height * (LEGEND_HEIGHT_FRAC + LEGEND_MARGIN_FRAC);
          const lw = bodyRect.width * LEGEND_WIDTH_FRAC;
          const lh = bodyRect.height * LEGEND_HEIGHT_FRAC;
          const rowH = lh / (blue && red ? 3 : 2);
          let row = 0;
          return (
            <Fragment>
              <Rect x={lx} y={ly} width={lw} height={lh} fill="#0d0d0dee" stroke={GOLD} strokeWidth={1.5} cornerRadius={4} />
              <KonvaText x={lx + 10} y={ly + rowH * row++ + 6} text="FENCE STAINING LEGEND" fontSize={rowH * 0.32} fontStyle="bold" fill={GOLD} />
              {blue && (
                <KonvaText x={lx + 10} y={ly + rowH * row++ + 4} text="Blue sections: Inside face only" fontSize={rowH * 0.3} fill={HEADER_TEXT} />
              )}
              {red && (
                <KonvaText
                  x={lx + 10} y={ly + rowH * row++ + 4}
                  text="Red sections: Both faces stained (inside and outside)"
                  fontSize={rowH * 0.28} fill={HEADER_TEXT} width={lw - 20} wrap="word"
                />
              )}
            </Fragment>
          );
        })()}
      </Layer>

      {/* Segments — lines, arrows, endpoint nodes */}
      <Layer>
        {scope.segments.map((seg) => {
          const pxPoints = seg.points.map((p) => toPixel(p, bodyRect));
          const isSelected = seg.id === scope.selectedId;
          const color = colorHex(seg.color);
          const placements = placeArrowsAlongPath(pxPoints, ARROW_SPACING_PX);
          const selectLine = (e: Konva.KonvaEventObject<Event>) => {
            if (pannedRef.current) return;
            e.cancelBubble = true;
            scope.setMode("select");
            scope.selectSegment(seg.id);
          };

          return (
            <Fragment key={seg.id}>
              <Line
                points={flatten(pxPoints)} stroke={LINE_HALO} strokeWidth={LINE_WIDTH_HALO}
                lineCap="round" lineJoin="round" opacity={0.9} onClick={selectLine}
                onMouseEnter={() => { if (!drawing) setCursor("pointer"); }}
                onMouseLeave={() => setCursor(idleCursor)}
              />
              <Line
                points={flatten(pxPoints)} stroke={color} strokeWidth={LINE_WIDTH_INNER} lineCap="round" lineJoin="round"
                shadowColor={color} shadowBlur={isSelected ? 10 : 4} shadowOpacity={0.6} onClick={selectLine}
              />

              {placements.map((pl, i) => {
                if (seg.color === "blue") {
                  const dx = pl.px * seg.arrowDirection;
                  const dy = pl.py * seg.arrowDirection;
                  return (
                    <Line
                      key={i}
                      points={arrowheadPoints(pl.cx + dx * 6, pl.cy + dy * 6, dx, dy, ARROW_LENGTH, ARROW_WIDTH)}
                      closed fill={color} stroke={LINE_HALO} strokeWidth={1.5} listening={false}
                    />
                  );
                }
                // Red = both sides — one arrowhead pointing away from the
                // fence on each perpendicular side (spec Section 9/16).
                return (
                  <Fragment key={i}>
                    <Line points={arrowheadPoints(pl.cx + pl.px * 6, pl.cy + pl.py * 6, pl.px, pl.py, ARROW_LENGTH, ARROW_WIDTH)} closed fill={color} stroke={LINE_HALO} strokeWidth={1.5} listening={false} />
                    <Line points={arrowheadPoints(pl.cx - pl.px * 6, pl.cy - pl.py * 6, -pl.px, -pl.py, ARROW_LENGTH, ARROW_WIDTH)} closed fill={color} stroke={LINE_HALO} strokeWidth={1.5} listening={false} />
                  </Fragment>
                );
              })}

              {pxPoints.map((p, i) => {
                const dragging = dragPreview && dragPreview.segId === seg.id && dragPreview.index === i;
                const cx = dragging ? dragPreview!.x : p.x;
                const cy = dragging ? dragPreview!.y : p.y;
                const active = isSelected && activePointIndex === i;
                return (
                  <Circle
                    key={i}
                    x={cx} y={cy}
                    radius={active ? NODE_RADIUS + 1.5 : NODE_RADIUS}
                    fill={NODE_FILL}
                    stroke={active ? color : NODE_STROKE}
                    strokeWidth={active ? 2.5 : 1.5}
                    shadowColor="#000" shadowBlur={3} shadowOpacity={0.4}
                    draggable
                    onMouseEnter={() => setCursor("move")}
                    onMouseLeave={() => setCursor(idleCursor)}
                    onClick={(e) => { e.cancelBubble = true; scope.setMode("select"); scope.selectSegment(seg.id); onActivePointChange(i); }}
                    onDragStart={(e) => { e.cancelBubble = true; scope.selectSegment(seg.id); onActivePointChange(i); }}
                    onDragMove={(e) => { e.cancelBubble = true; setDragPreview({ segId: seg.id, index: i, x: e.target.x(), y: e.target.y() }); }}
                    onDragEnd={(e) => {
                      e.cancelBubble = true;
                      setDragPreview(null);
                      const n = toNormalized(e.target.x(), e.target.y(), bodyRect);
                      scope.updatePoint(seg.id, i, n);
                    }}
                  />
                );
              })}
            </Fragment>
          );
        })}

        {/* In-progress trace preview */}
        {scope.drawingPoints.length > 0 && (
          <Fragment>
            <Line
              points={flatten(scope.drawingPoints.map((p) => toPixel(p, bodyRect)))}
              stroke={colorHex(scope.mode === "red" ? "red" : "blue")}
              strokeWidth={LINE_WIDTH_INNER}
              dash={[8, 6]}
              lineCap="round"
              listening={false}
            />
            {scope.drawingPoints.map((p, i) => {
              const px = toPixel(p, bodyRect);
              return <Circle key={i} x={px.x} y={px.y} radius={NODE_RADIUS} fill={NODE_FILL} stroke={NODE_STROKE} strokeWidth={1.5} listening={false} />;
            })}
          </Fragment>
        )}
      </Layer>
    </Stage>
  );
}
