import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DependencyGraph } from "../../core/contracts.js";
import { createSphereModel } from "../sphere-layout.js";
import { drawSphere, findHitNode, type ProjectedSphereNode, type SphereCamera } from "../sphere-renderer.js";
import { SphereFocusPicker } from "./SphereFocusPicker.js";

interface GraphSphereProps {
  graph: DependencyGraph | null;
  executionLayers: string[][] | null;
  issueCount: number;
  error: string | null;
}

interface ActiveDrag {
  pointerId: number;
  x: number;
  y: number;
  totalDistance: number;
  initialCamera: SphereCamera;
}

const INITIAL_CAMERA: SphereCamera = { yaw: -0.42, pitch: -0.16, zoom: 1 };
const MIN_ZOOM = 0.62;
const MAX_ZOOM = 1.55;

function copyCamera(camera: SphereCamera): SphereCamera {
  return { yaw: camera.yaw, pitch: camera.pitch, zoom: camera.zoom };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function GraphSphere({ graph, executionLayers, issueCount, error }: GraphSphereProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number | null>(null);
  const projectedRef = useRef<ProjectedSphereNode[]>([]);
  const cameraRef = useRef<SphereCamera>(copyCamera(INITIAL_CAMERA));
  const dragRef = useRef<ActiveDrag | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const model = useMemo(() => graph === null ? null : createSphereModel(graph, executionLayers), [executionLayers, graph]);
  const modelRef = useRef(model);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [dragging, setDragging] = useState(false);
  const [canvasAvailable, setCanvasAvailable] = useState(true);

  selectedRef.current = selectedId;
  modelRef.current = model;

  const renderNow = useCallback(() => {
    frameRef.current = null;
    const canvas = canvasRef.current;
    const currentModel = modelRef.current;
    if (canvas === null || currentModel === null) return;
    const context = canvas.getContext("2d");
    if (context === null) {
      setCanvasAvailable(false);
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(bounds.width * pixelRatio));
    const pixelHeight = Math.max(1, Math.round(bounds.height * pixelRatio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    projectedRef.current = drawSphere(
      context,
      currentModel,
      bounds.width,
      bounds.height,
      cameraRef.current,
      { selectedId: selectedRef.current, hoveredId: hoveredRef.current },
    );
  }, []);

  const requestRender = useCallback(() => {
    if (frameRef.current === null) frameRef.current = window.requestAnimationFrame(renderNow);
  }, [renderNow]);

  const cancelDrag = useCallback((restore: boolean) => {
    const active = dragRef.current;
    if (active === null) return;
    if (restore) cameraRef.current = copyCamera(active.initialCamera);
    dragRef.current = null;
    const canvas = canvasRef.current;
    if (canvas?.hasPointerCapture(active.pointerId)) canvas.releasePointerCapture(active.pointerId);
    setDragging(false);
    requestRender();
  }, [requestRender]);

  const setZoom = useCallback((zoom: number) => {
    cameraRef.current.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    setZoomPercent(Math.round(cameraRef.current.zoom * 100));
    requestRender();
  }, [requestRender]);

  const resetView = useCallback(() => {
    cancelDrag(false);
    cameraRef.current = copyCamera(INITIAL_CAMERA);
    hoveredRef.current = null;
    setSelectedId(null);
    setZoomPercent(100);
    requestRender();
    canvasRef.current?.focus();
  }, [cancelDrag, requestRender]);

  useEffect(() => {
    if (selectedId !== null && !model?.nodeById.has(selectedId)) setSelectedId(null);
    requestRender();
  }, [model, requestRender, selectedId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const observer = new ResizeObserver(requestRender);
    observer.observe(canvas);
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom(cameraRef.current.zoom * Math.exp(-event.deltaY * 0.0012));
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    requestRender();
    return () => {
      observer.disconnect();
      canvas.removeEventListener("wheel", handleWheel);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [requestRender, setZoom]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") cancelDrag(true);
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [cancelDrag]);

  if (graph === null || model === null) {
    return (
      <div className="sphere-empty" role="status">
        <strong>Sphere unavailable</strong>
        <span>{error ?? "Enter a valid dependency graph to open the sphere."}</span>
      </div>
    );
  }

  const selectedNode = selectedId === null ? null : model.nodeById.get(selectedId) ?? null;
  const selectedRelations = selectedId === null ? [] : model.relationsByNode.get(selectedId) ?? [];
  const prerequisiteCount = selectedId === null ? 0 : selectedRelations.filter((relation) => relation.dependent === selectedId).length;
  const dependentCount = selectedId === null ? 0 : selectedRelations.filter((relation) => relation.prerequisite === selectedId).length;
  const warning = issueCount > 0
    ? `${issueCount} graph ${issueCount === 1 ? "issue" : "issues"}; spatial placement is a deterministic fallback.`
    : !model.showOverviewRelations
      ? `${model.relationCount.toLocaleString()} relations; choose a node to reveal its direct links.`
      : null;
  const nodeTerm = model.nodes.length === 1 ? "node" : "nodes";
  const relationTerm = model.relationCount === 1 ? "relation" : "relations";

  const hitNode = (event: React.PointerEvent<HTMLCanvasElement>): ProjectedSphereNode | null => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    return findHitNode(projectedRef.current, x, y);
  };

  return (
    <div className="sphere-view">
      <div className="sphere-toolbar">
        <SphereFocusPicker nodes={model.nodes} selectedId={selectedId} onSelect={setSelectedId} />
        <div className="sphere-zoom" aria-label="Sphere zoom controls">
          <button type="button" aria-label="Zoom out" onClick={() => setZoom(cameraRef.current.zoom - 0.1)}>−</button>
          <output aria-live="polite">{zoomPercent}%</output>
          <button type="button" aria-label="Zoom in" onClick={() => setZoom(cameraRef.current.zoom + 0.1)}>+</button>
        </div>
        <button className="sphere-reset" type="button" onClick={resetView}>Reset</button>
      </div>
      <div className="sphere-stage">
        {canvasAvailable ? (
          <canvas
            ref={canvasRef}
            className={dragging ? "sphere-canvas dragging" : "sphere-canvas"}
            tabIndex={0}
            role="img"
            aria-describedby="sphere-controls"
            title="Drag to rotate · scroll to zoom · select a point to inspect"
            aria-label={`Interactive 3D dependency sphere with ${model.nodes.length} ${nodeTerm} and ${model.relationCount} ${relationTerm}. Drag to rotate, scroll to zoom, or use the focus control.`}
            onBlur={() => cancelDrag(true)}
            onKeyDown={(event) => {
              const rotationStep = event.shiftKey ? 0.2 : 0.1;
              if (event.key === "Escape") {
                event.preventDefault();
                if (dragRef.current !== null) cancelDrag(true);
                else setSelectedId(null);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                cameraRef.current.yaw += event.key === "ArrowLeft" ? -rotationStep : rotationStep;
                requestRender();
              } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                cameraRef.current.pitch = clamp(cameraRef.current.pitch + (event.key === "ArrowUp" ? -rotationStep : rotationStep), -1.35, 1.35);
                requestRender();
              } else if (event.key === "+" || event.key === "=") {
                event.preventDefault();
                setZoom(cameraRef.current.zoom + 0.1);
              } else if (event.key === "-" || event.key === "_") {
                event.preventDefault();
                setZoom(cameraRef.current.zoom - 0.1);
              } else if (event.key === "0") {
                event.preventDefault();
                resetView();
              }
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              dragRef.current = {
                pointerId: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                totalDistance: 0,
                initialCamera: copyCamera(cameraRef.current),
              };
              setDragging(true);
            }}
            onPointerMove={(event) => {
              const active = dragRef.current;
              if (active === null || active.pointerId !== event.pointerId) {
                const hovered = hitNode(event)?.id ?? null;
                if (hovered !== hoveredRef.current) {
                  hoveredRef.current = hovered;
                  requestRender();
                }
                return;
              }
              const deltaX = event.clientX - active.x;
              const deltaY = event.clientY - active.y;
              active.x = event.clientX;
              active.y = event.clientY;
              active.totalDistance += Math.hypot(deltaX, deltaY);
              cameraRef.current.yaw += deltaX * 0.008;
              cameraRef.current.pitch = clamp(cameraRef.current.pitch + deltaY * 0.008, -1.35, 1.35);
              requestRender();
            }}
            onPointerUp={(event) => {
              const active = dragRef.current;
              if (active === null || active.pointerId !== event.pointerId) return;
              const wasClick = active.totalDistance < 5;
              dragRef.current = null;
              setDragging(false);
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              if (wasClick) setSelectedId(hitNode(event)?.id ?? null);
            }}
            onPointerCancel={() => cancelDrag(true)}
            onLostPointerCapture={() => cancelDrag(true)}
            onPointerLeave={() => {
              if (dragRef.current === null && hoveredRef.current !== null) {
                hoveredRef.current = null;
                requestRender();
              }
            }}
          />
        ) : (
          <div className="sphere-empty" role="status">
            <strong>Canvas unavailable</strong>
            <span>Use the focus control to inspect declared dependency counts.</span>
          </div>
        )}
        <p id="sphere-controls" className="visually-hidden">Use arrow keys to rotate, plus and minus to zoom, zero to reset, and Escape to cancel a drag or clear focus.</p>
        {warning !== null && <p className="sphere-warning">{warning}</p>}
      </div>
      {selectedNode !== null && (
        <div className="sphere-detail" aria-live="polite">
          <strong>{selectedNode.label}</strong>
          {selectedNode.label !== selectedNode.id && <code>{selectedNode.id}</code>}
          <span>{prerequisiteCount} prerequisites · {dependentCount} dependents</span>
        </div>
      )}
    </div>
  );
}
