"use client";

import { BaseEdge, getBezierPath } from "@xyflow/react";

// Intentionally separate from ProviderTopology: this edge never represents live
// requests. Decorative particles are removed entirely when motion is disabled.
export default function RoutingPreviewEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  style, data, label, labelStyle, labelBgStyle, labelBgPadding, labelBgBorderRadius,
  markerEnd, markerStart, interactionWidth,
}) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const active = !!data?.demoActive;
  const cyan = "var(--color-cyan-400, var(--color-info))";

  return (
    <g data-demo-edge={active ? "active" : "idle"}>
      {active && (
        <path d={path} fill="none" stroke={cyan} strokeWidth={9} strokeOpacity={0.2} strokeLinecap="round" pointerEvents="none" aria-hidden="true" />
      )}
      <BaseEdge
        id={id} path={path} labelX={labelX} labelY={labelY}
        label={label} labelStyle={labelStyle} labelBgStyle={labelBgStyle}
        labelBgPadding={labelBgPadding} labelBgBorderRadius={labelBgBorderRadius}
        markerStart={markerStart} markerEnd={markerEnd} interactionWidth={interactionWidth}
        style={{ ...style, ...(active ? { stroke: cyan, strokeWidth: 3 } : {}) }}
      />
      {active && data.demoMotion && (
        <g pointerEvents="none" aria-hidden="true">
          {[0, 1, 2].map((particle) => (
            <circle key={particle} r={particle === 0 ? 3 : 2} fill={cyan} style={{ filter: `drop-shadow(0 0 4px ${cyan})` }}>
              <animateMotion path={path} dur="1.5s" begin={`${particle * -0.5}s`} repeatCount="indefinite" />
            </circle>
          ))}
        </g>
      )}
    </g>
  );
}
