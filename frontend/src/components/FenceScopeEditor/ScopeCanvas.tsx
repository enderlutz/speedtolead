import { Fragment, useCallback, useRef, useState } from "react";
import { Stage, Layer, Rect, Image as KonvaImage, Line, Circle, Text as KonvaText } from "react-konva";
import type Konva from "konva";
import type { FenceScopeSegment } from "@/lib/api";
import type { ScopeStateApi } from "./use-scope-state";
import { placeArrowsAlongPath, arrowheadPoints, type Pt } from "./arrows";
import {
  BLUE, RED, LINE_HALO, NODE_FILL, NODE_STROKE, LINE_WIDTH_INNER, LINE_WIDTH_HALO,
  NODE_RADIUS, ARROW_SPACING_PX, ARROW_LENGTH, ARROW_WIDTH,
  LEGEND_WIDTH_FRAC, LEGEND_HEIGHT_FRAC, LEGEND_MARGIN_FRAC,
  HEADER_BG, GOLD, HEADER_TEXT,
} from "./constants";

export interface BodyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Props {
  scope: ScopeStateApi;
  stageWidth: number;
  stageHeight: number;
  zoom: number;
  panOffset: { x: number; y: number };
  sourceImage: HTMLImageElement | null;
  logoImage: HTMLImageElement | null;
  address: string;
  bodyRect: BodyRect;
  activePointIndex: number | null;
  onActivePointChange: (i: number | null) => void;
  onWheel: (e: { evt: WheelEvent }) => void;
  stageRef?: React.RefObject<Konva.Stage | null>;
}

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
  scope, stageWidth, stageHeight, zoom, panOffset, sourceImage, logoImage, address, bodyRect,
  activePointIndex, onActivePointChange, onWheel, stageRef,
}: Props) {
  const internalStageRef = useRef<Konva.Stage>(null);
  const ref = stageRef || internalStageRef;
  const [dragPreview, setDragPreview] = useState<{ segId: string; index: number; x: number; y: number } | null>(null);

  const stageToBody = useCallback(
    (stage: Konva.Stage) => {
      const pos = stage.getRelativePointerPosition();
      if (!pos) return null;
      return toNormalized(pos.x, pos.y, bodyRect);
    },
    [bodyRect]
  );

  const handleStageClick = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      const stage = ref.current;
      if (!stage) return;
      if (scope.mode === "blue" || scope.mode === "red") {
        const p = stageToBody(stage);
        if (p) scope.addDrawingPoint(p);
        return;
      }
      if (e.target === e.currentTarget || e.target.getClassName() === "Image" || e.target.getClassName() === "Rect") {
        scope.selectSegment(null);
        onActivePointChange(null);
      }
    },
    [scope, stageToBody, onActivePointChange, ref]
  );

  const handleStageDblClick = useCallback(() => {
    if (scope.mode === "blue" || scope.mode === "red") scope.finishDrawing();
  }, [scope]);

  return (
    <Stage
      ref={ref}
      width={stageWidth}
      height={stageHeight}
      scaleX={zoom}
      scaleY={zoom}
      x={panOffset.x}
      y={panOffset.y}
      onWheel={onWheel}
      onClick={handleStageClick}
      onDblClick={handleStageDblClick}
      onTap={handleStageClick as unknown as (e: Konva.KonvaEventObject<TouchEvent>) => void}
    >
      {/* Background */}
      <Layer>
        <Rect x={0} y={0} width={stageWidth / zoom} height={stageHeight / zoom} fill="#111" />
        {sourceImage && (
          <KonvaImage image={sourceImage} x={bodyRect.x} y={bodyRect.y} width={bodyRect.width} height={bodyRect.height} />
        )}
      </Layer>

      {/* Locked branding — header, logo, legend. Nothing here is VA-editable. */}
      <Layer listening={false}>
        <Rect x={0} y={0} width={stageWidth / zoom} height={bodyRect.y} fill={HEADER_BG} />
        <Rect x={0} y={0} width={stageWidth / zoom} height={2} fill={GOLD} />
        {logoImage ? (
          <KonvaImage
            image={logoImage}
            x={bodyRect.x} y={bodyRect.y * 0.18}
            height={bodyRect.y * 0.64}
            width={(bodyRect.y * 0.64 * logoImage.width) / logoImage.height}
          />
        ) : (
          <KonvaText
            x={bodyRect.x} y={bodyRect.y * 0.35}
            text="STERLING FENCE STAINING"
            fontSize={bodyRect.y * 0.16}
            fontFamily="Georgia, serif" fontStyle="bold" fill={GOLD}
          />
        )}
        <KonvaText
          x={bodyRect.x} y={bodyRect.y * 0.16} width={bodyRect.width} align="right"
          text="Fence Staining Scope"
          fontSize={bodyRect.y * 0.24} fontFamily="Georgia, serif" fontStyle="bold" fill={HEADER_TEXT}
        />
        <KonvaText
          x={bodyRect.x} y={bodyRect.y * 0.52} width={bodyRect.width} align="right"
          text={`Prepared for: ${address || "—"}`}
          fontSize={bodyRect.y * 0.14} fontFamily="Arial, sans-serif" fill={HEADER_TEXT}
        />

        {/* Legend — auto-updates on which colors are present. Never mentions
            unmarked sections (spec Section 6/32). */}
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
            e.cancelBubble = true;
            scope.setMode("select");
            scope.selectSegment(seg.id);
          };

          return (
            <Fragment key={seg.id}>
              <Line points={flatten(pxPoints)} stroke={LINE_HALO} strokeWidth={LINE_WIDTH_HALO} lineCap="round" lineJoin="round" opacity={0.9} onClick={selectLine} />
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
                    onClick={(e) => { e.cancelBubble = true; scope.setMode("select"); scope.selectSegment(seg.id); onActivePointChange(i); }}
                    onDragStart={(e) => { e.cancelBubble = true; scope.selectSegment(seg.id); onActivePointChange(i); }}
                    onDragMove={(e) => setDragPreview({ segId: seg.id, index: i, x: e.target.x(), y: e.target.y() })}
                    onDragEnd={(e) => {
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
