import { Fragment, useEffect, useRef, useState } from "react";
import { Stage, Layer, Rect, Image as KonvaImage, Line, Circle, Text as KonvaText } from "react-konva";
import type Konva from "konva";
import type { ScopeStateApi } from "./use-scope-state";
import type { CanvasView, PinchStart } from "./use-canvas-view";
import type { HeaderTheme } from "./header-theme";
import { placeArrowsAlongPath, arrowheadPoints, type Pt } from "./arrows";
import { fitFontSize, titleLetterSpacing, type PageLayout, type Rect as RectBox } from "./layout";
import { snapToVertex, SNAP_RADIUS_SCREEN } from "./snap";
import Legend from "./Legend";
import {
  BLUE, RED, LINE_HALO, NODE_FILL, NODE_STROKE, LINE_WIDTH_INNER, LINE_WIDTH_HALO,
  NODE_RADIUS, ARROW_SPACING_PX, ARROW_LENGTH, ARROW_WIDTH,
  PAGE_MARGIN_FRAC, TEXT_RIGHT_MARGIN_FRAC, LOGO_MAX_WIDTH_FRAC, LOGO_HEIGHT_FRAC,
  TITLE_FONT, BODY_FONT, TITLE_SIZE_MAX, TITLE_SIZE_MIN, ADDRESS_SIZE_MAX, ADDRESS_SIZE_MIN,
} from "./constants";

const TITLE_TEXT = "Fence Staining Scope";

interface Props {
  scope: ScopeStateApi;
  /** The document, drawn at (0,0) and moved around by the view. */
  page: PageLayout;
  view: CanvasView;
  sourceImage: HTMLImageElement | HTMLCanvasElement | null;
  logoImage: HTMLImageElement | null;
  headerTheme: HeaderTheme;
  address: string;
  activePointIndex: number | null;
  onActivePointChange: (i: number | null) => void;
  stageRef?: React.RefObject<Konva.Stage | null>;
}

type BodyRect = RectBox;

/** Pointer travel, in px, before a press counts as a pan rather than a click. */
const PAN_THRESHOLD = 4;
/** How close two clicks must land, in px, for a double-click to mean "done". */
const DBLCLICK_SLOP = 8;
/** Tapping this close to the run's last point closes the run. */
const CLOSE_RUN_SLOP = 14;

// A fingertip is far less precise than a cursor, so hit targets grow on touch
// devices. The drawn size is unchanged — only what counts as "on" it.
const COARSE_POINTER =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false;
const NODE_HIT_PAD = COARSE_POINTER ? 30 : 10;
const LINE_HIT_PAD = COARSE_POINTER ? 28 : 8;

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
export default function ScopeCanvas({
  scope, page, view, sourceImage, logoImage,
  headerTheme, address, activePointIndex, onActivePointChange, stageRef,
}: Props) {
  const { width: pageWidth, height: pageHeight, body: bodyRect } = page;
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
  const pinchStart = useRef<PinchStart | null>(null);

  const drawing = scope.mode === "blue" || scope.mode === "red";
  // A plain arrow while the whole page is visible: there is genuinely nowhere
  // to drag to, and an open hand that does nothing reads as a broken hand.
  const idleCursor = drawing ? "crosshair" : view.pannable ? "grab" : "default";

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

  // Hand every touch to the canvas. Without this, Safari scrolls and zooms the
  // whole page instead, which is why the editor was unusable on a phone.
  useEffect(() => {
    const stage = ref.current;
    if (!stage) return;
    const el = stage.container();
    el.style.touchAction = "none";
    el.style.userSelect = "none";
    (el.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = "none";
    (el.style as CSSStyleDeclaration & { webkitTouchCallout?: string }).webkitTouchCallout = "none";
  }, [ref]);

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

  /** Midpoint and spread of a two-finger touch, in stage coordinates. */
  const twoFinger = (evt: TouchEvent) => {
    const stage = ref.current;
    if (!stage || evt.touches.length < 2) return null;
    const box = stage.container().getBoundingClientRect();
    const a = { x: evt.touches[0].clientX - box.left, y: evt.touches[0].clientY - box.top };
    const b = { x: evt.touches[1].clientX - box.left, y: evt.touches[1].clientY - box.top };
    return {
      distance: Math.hypot(b.x - a.x, b.y - a.y),
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  };

  const handleTouchStart = (e: Konva.KonvaEventObject<TouchEvent>) => {
    const gesture = twoFinger(e.evt);
    if (!gesture) {
      pinchStart.current = null;
      beginPan(e);
      return;
    }
    e.evt.preventDefault();
    panStart.current = null;
    // A pinch must never also register as a tap that drops a fence point.
    pannedRef.current = true;
    pinchStart.current = {
      zoom: view.zoom, pan: { ...view.pan },
      center: gesture.center, distance: gesture.distance,
    };
  };

  const handleTouchMove = (e: Konva.KonvaEventObject<TouchEvent>) => {
    const start = pinchStart.current;
    const gesture = twoFinger(e.evt);
    if (start && gesture && start.distance > 0) {
      e.evt.preventDefault();
      view.pinch(start, gesture.distance / start.distance, gesture.center);
      return;
    }
    // Mid-pinch with a finger lifted: wait for a clean restart rather than
    // lurching into a one-finger pan from wherever the remaining finger is.
    if (start) return;
    movePan();
  };

  const handleTouchEnd = () => {
    if (pinchStart.current) {
      pinchStart.current = null;
      panStart.current = null;
      pannedRef.current = true;
      return;
    }
    endPan();
  };

  const handleStageClick = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = ref.current;
    if (!stage) return;
    if (pannedRef.current) return; // that was a pan, not a click
    if (drawing) {
      const pos = stage.getRelativePointerPosition();
      if (!pos) return;
      // Tapping the last point again ends the run. Double-click works too, but
      // a phone has no Enter key and no reliable double-tap, and "tap the end
      // again" is the one gesture that works everywhere.
      const points = scope.drawingPoints;
      if (points.length >= 2) {
        const last = toPixel(points[points.length - 1], bodyRect);
        if (Math.hypot(last.x - pos.x, last.y - pos.y) <= CLOSE_RUN_SLOP / view.zoom) {
          scope.finishDrawing();
          return;
        }
      }
      // Clicking near the end of an existing run welds to it exactly, so an
      // L-shaped fence closes at the corner instead of nearly closing.
      const corner = snapToVertex(pos.x, pos.y, scope.segments, bodyRect, SNAP_RADIUS_SCREEN / view.zoom);
      scope.addDrawingPoint(corner ?? toNormalized(pos.x, pos.y, bodyRect));
      return;
    }
    if (e.target === e.currentTarget || e.target.getClassName() === "Image" || e.target.getClassName() === "Rect") {
      scope.selectSegment(null);
      onActivePointChange(null);
    }
  };

  const handleStageDblClick = () => {
    if (!drawing) return;
    const points = scope.drawingPoints;
    if (points.length < 2) return;
    // Konva calls any two clicks inside 400ms a double-click, wherever they
    // landed. Tracing a fence quickly does exactly that, and finishing there
    // cuts the run short — so only treat it as "done" when both clicks landed
    // in the same spot, which is what a deliberate double-click looks like.
    const last = toPixel(points[points.length - 1], bodyRect);
    const previous = toPixel(points[points.length - 2], bodyRect);
    if (Math.hypot(last.x - previous.x, last.y - previous.y) <= DBLCLICK_SLOP / view.zoom) {
      scope.finishDrawing();
    }
  };

  const handleWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    view.wheel(e.evt, ref.current?.getPointerPosition() ?? null);
  };

  // ---- header geometry ----
  // Everything below is laid out off the page, not the frame, so the export is
  // identical to what's on screen at any zoom.
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
  const brandW = logoImage ? logoW : pageWidth * LOGO_MAX_WIDTH_FRAC;
  const textX = margin + brandW + pageWidth * 0.02;
  const textRight = pageWidth * TEXT_RIGHT_MARGIN_FRAC;
  const textW = Math.max(pageWidth * 0.2, pageWidth - textRight - textX);

  // Measured, not guessed: the address is a customer's, so it can be any
  // length, and the logo beside it can be any width.
  const addressText = `Prepared for: ${address || "—"}`;
  const titleSize = fitFontSize(
    TITLE_TEXT, textW, headerH * TITLE_SIZE_MAX, headerH * TITLE_SIZE_MIN, TITLE_FONT, true, 0.02
  );
  const addressSize = fitFontSize(
    addressText, textW, headerH * ADDRESS_SIZE_MAX, headerH * ADDRESS_SIZE_MIN, BODY_FONT, false
  );
  // Centre the two lines as a block in the band.
  const textBlockH = titleSize * 1.2 + headerH * 0.04 + addressSize * 1.2;
  const titleY = (headerH - textBlockH) / 2;
  const addressY = titleY + titleSize * 1.2 + headerH * 0.04;

  return (
    <Stage
      ref={ref}
      width={pageWidth}
      height={pageHeight}
      scaleX={view.zoom}
      scaleY={view.zoom}
      x={view.pan.x}
      y={view.pan.y}
      onWheel={handleWheel}
      onMouseDown={beginPan}
      onMouseMove={movePan}
      onMouseUp={endPan}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onClick={handleStageClick}
      onDblClick={handleStageDblClick}
      onDblTap={handleStageDblClick}
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
            x={margin} y={headerH * 0.4} width={brandW}
            text="STERLING FENCE STAINING"
            fontSize={headerH * 0.15}
            fontFamily={TITLE_FONT} fontStyle="bold" fill={headerTheme.accent}
          />
        )}
        <KonvaText
          x={textX} y={titleY} width={textW} align="right"
          text={TITLE_TEXT}
          fontSize={titleSize} lineHeight={1.2} letterSpacing={titleLetterSpacing(titleSize)}
          fontFamily={TITLE_FONT} fontStyle="bold" fill={headerTheme.ink}
          wrap="none" ellipsis
        />
        <KonvaText
          x={textX} y={addressY} width={textW} align="right"
          text={addressText}
          fontSize={addressSize} lineHeight={1.2}
          fontFamily={BODY_FONT} fill={headerTheme.ink}
          wrap="none" ellipsis
        />

      </Layer>

      <Legend pageWidth={pageWidth} band={page.legend} segments={scope.segments} theme={headerTheme} />

      {/* Segments — lines, arrows, endpoint nodes.
          While a new run is being traced this layer stops listening entirely:
          otherwise clicking the corner of an existing line selects that line
          instead of placing a point, which makes it impossible to join a red
          run to the end of a blue one. */}
      <Layer listening={!drawing}>
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
                hitStrokeWidth={LINE_WIDTH_HALO + LINE_HIT_PAD}
                lineCap="round" lineJoin="round" opacity={0.9} onClick={selectLine} onTap={selectLine}
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
                    hitStrokeWidth={NODE_HIT_PAD}
                    draggable
                    onMouseEnter={() => setCursor("move")}
                    onMouseLeave={() => setCursor(idleCursor)}
                    onClick={(e) => { e.cancelBubble = true; scope.setMode("select"); scope.selectSegment(seg.id); onActivePointChange(i); }}
                    onTap={(e) => { e.cancelBubble = true; scope.setMode("select"); scope.selectSegment(seg.id); onActivePointChange(i); }}
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
