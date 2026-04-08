import { useRef, useEffect, useCallback } from "react";
import { Stage, Layer, Rect, Text as KonvaText, Image as KonvaImage, Line, Group, Label, Tag } from "react-konva";
import type Konva from "konva";
import type { EditorField } from "./use-editor-state";
import type { SnapLine } from "./use-snap-guides";
import { EXAMPLE_TEXT } from "./constants";
import { PRESET_FIELD_LABELS } from "@/lib/pdf-types";

interface Props {
  pageFields: EditorField[];
  selectedId: string | null;
  stageWidth: number;
  stageHeight: number;
  scaleX: number;
  scaleY: number;
  zoom: number;
  panOffset: { x: number; y: number };
  pageImage: HTMLImageElement | null;
  snapLines: SnapLine[];
  previewMode: boolean;
  onFieldSelect: (id: string | null) => void;
  onFieldDragStart: (id: string) => void;
  onFieldDragMove: (id: string, screenX: number, screenY: number) => void;
  onFieldDragEnd: (id: string, screenX: number, screenY: number) => void;
  onWheel: (e: { evt: WheelEvent }) => void;
}

export default function PdfTemplateCanvas({
  pageFields, selectedId, stageWidth, stageHeight, scaleX, scaleY,
  zoom, panOffset, pageImage, snapLines, previewMode,
  onFieldSelect, onFieldDragStart, onFieldDragMove, onFieldDragEnd, onWheel,
}: Props) {
  const stageRef = useRef<Konva.Stage>(null);

  const handleStageClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.target === e.currentTarget || e.target.getClassName() === "Image" || e.target.getClassName() === "Rect") {
      const parent = e.target.getParent();
      if (!parent || parent.getClassName() === "Layer") {
        onFieldSelect(null);
      }
    }
  }, [onFieldSelect]);

  return (
    <Stage
      ref={stageRef}
      width={stageWidth}
      height={stageHeight}
      scaleX={zoom}
      scaleY={zoom}
      x={panOffset.x}
      y={panOffset.y}
      onWheel={onWheel}
      onClick={handleStageClick}
      onTap={handleStageClick}
    >
      {/* Background layer */}
      <Layer>
        <Rect x={0} y={0} width={stageWidth / zoom} height={stageHeight / zoom} fill="#e5e7eb" />
        {pageImage && (
          <KonvaImage
            image={pageImage}
            x={0} y={0}
            width={stageWidth / zoom}
            height={stageHeight / zoom}
          />
        )}
      </Layer>

      {/* Fields layer */}
      <Layer>
        {pageFields.map((field) => {
          const fx = field.x * scaleX;
          const fy = field.y * scaleY;
          const fontSize = field.font_size * scaleX;
          const boxW = field.width > 0 ? field.width * scaleX : 0;
          const boxH = fontSize * 1.4;
          const isSelected = field.id === selectedId;
          const displayText = EXAMPLE_TEXT[field.id] || PRESET_FIELD_LABELS[field.id] || field.label;

          return (
            <Group
              key={field.id}
              x={fx}
              y={fy}
              draggable={!field.locked}
              onClick={(e) => { e.cancelBubble = true; onFieldSelect(field.id); }}
              onTap={(e) => { e.cancelBubble = true; onFieldSelect(field.id); }}
              onDragStart={() => onFieldDragStart(field.id)}
              onDragMove={(e) => onFieldDragMove(field.id, e.target.x(), e.target.y())}
              onDragEnd={(e) => onFieldDragEnd(field.id, e.target.x(), e.target.y())}
            >
              {/* Bounding box */}
              {boxW > 0 && (
                <Rect
                  x={0} y={0}
                  width={boxW} height={boxH}
                  stroke={isSelected ? "#3b82f6" : "rgba(100,100,100,0.3)"}
                  strokeWidth={isSelected ? 2 : 1}
                  dash={isSelected ? undefined : [4, 3]}
                  fill={isSelected ? "rgba(59,130,246,0.05)" : "transparent"}
                  cornerRadius={2}
                />
              )}

              {/* Text content */}
              {previewMode ? (
                <KonvaText
                  x={0} y={boxW > 0 ? (boxH - fontSize) / 2 : 0}
                  text={displayText}
                  fontSize={fontSize}
                  fontFamily="Montserrat, 'Libre Baskerville', Georgia, serif"
                  fontStyle={["customer_name", "essential_price", "signature_price", "legacy_price"].includes(field.id) ? "bold" : "normal"}
                  fill={field.color}
                  width={boxW > 0 ? boxW : undefined}
                  align={boxW > 0 ? "center" : "left"}
                  listening={false}
                />
              ) : (
                <KonvaText
                  x={0} y={boxW > 0 ? (boxH - fontSize * 0.8) / 2 : 0}
                  text={field.label}
                  fontSize={fontSize * 0.8}
                  fontFamily="Arial, sans-serif"
                  fill="rgba(100,100,100,0.5)"
                  width={boxW > 0 ? boxW : undefined}
                  align={boxW > 0 ? "center" : "left"}
                  listening={false}
                />
              )}

              {/* Label badge (small tag above field) */}
              <Label x={0} y={-18} opacity={previewMode && !isSelected ? 0.3 : 0.85}>
                <Tag
                  fill={isSelected ? "#3b82f6" : field.color}
                  cornerRadius={3}
                  pointerDirection="down"
                  pointerWidth={6}
                  pointerHeight={4}
                />
                <KonvaText
                  text={field.label}
                  fontSize={9}
                  fontFamily="Arial, sans-serif"
                  fill="white"
                  padding={3}
                />
              </Label>

              {/* Lock icon */}
              {field.locked && (
                <KonvaText
                  x={boxW > 0 ? boxW - 14 : -14}
                  y={-16}
                  text="🔒"
                  fontSize={10}
                  listening={false}
                />
              )}

              {/* Selection highlight */}
              {isSelected && !boxW && (
                <Rect
                  x={-3} y={-3}
                  width={fontSize * 8 + 6}
                  height={fontSize * 1.4 + 6}
                  stroke="#3b82f6"
                  strokeWidth={1.5}
                  dash={[4, 2]}
                  fill="transparent"
                  cornerRadius={3}
                  listening={false}
                />
              )}
            </Group>
          );
        })}
      </Layer>

      {/* Snap guides layer */}
      <Layer>
        {snapLines.map((line, i) => (
          <Line
            key={i}
            points={
              line.orientation === "vertical"
                ? [line.position, 0, line.position, stageHeight / zoom]
                : [0, line.position, stageWidth / zoom, line.position]
            }
            stroke="#3b82f6"
            strokeWidth={1}
            dash={[6, 3]}
          />
        ))}
      </Layer>
    </Stage>
  );
}
