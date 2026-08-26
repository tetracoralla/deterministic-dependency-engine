import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { DependencyGraph } from "../../core/contracts.js";
import { createSphereModel } from "../sphere-layout.js";
import {
  SphereMotionController,
  type SpherePointerSample,
} from "../sphere-motion.js";
import { drawSphere, findHitNode, type ProjectedSphereNode } from "../sphere-renderer.js";
import { useMediaQuery } from "../use-media-query.js";
import { SphereFocusPicker } from "./SphereFocusPicker.js";

interface GraphSphereProps {
  graph: DependencyGraph | null;
  executionLayers: string[][] | null;
  issueCount: number;
  error: string | null;
  motionEnabled?: boolean;
}

function pointerSample(event: PointerEvent): SpherePointerSample {
  return { x: event.clientX, y: event.clientY, time: event.timeStamp };
}

function coalescedSamples(event: ReactPointerEvent<HTMLCanvasElement>): SpherePointerSample[] {
  const nativeEvent = event.nativeEvent;
  const samples = typeof nativeEvent.getCoalescedEvents === "function"
    ? nativeEvent.getCoalescedEvents()
    : [];
  return (samples.length > 0 ? samples : [nativeEvent]).map(pointerSample);
}

export function GraphSphere({ graph, executionLayers, issueCount, error, motionEnabled = true }: GraphSphereProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number | null>(null);
  const projectedRef = useRef<ProjectedSphereNode[]>([]);
  const motionRef = useRef<SphereMotionController>(null!);
  if (motionRef.current === null) motionRef.current = new SphereMotionController();
  const hoveredRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const visibleRef = useRef(typeof document === "undefined" || document.visibilityState !== "hidden");
  const windowFocusedRef = useRef(typeof document === "undefined" || document.hasFocus());
  const model = useMemo(() => graph === null ? null : createSphereModel(graph, executionLayers), [executionLayers, graph]);
  const modelRef = useRef(model);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [dragging, setDragging] = useState(false);
  const [canvasAvailable, setCanvasAvailable] = useState(true);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const motionAllowedRef = useRef(motionEnabled && !reducedMotion);

  selectedRef.current = selectedId;
  modelRef.current = model;
  motionAllowedRef.current = motionEnabled && !reducedMotion;

  const renderFrame = useCallback((timestamp: number) => {
    frameRef.current = null;
    const canvas = canvasRef.current;
    const currentModel = modelRef.current;
    if (canvas === null || currentModel === null) {
      lastFrameTimeRef.current = null;
      return;
    }
    const context = canvas.getContext("2d");
    if (context === null) {
      setCanvasAvailable(false);
      lastFrameTimeRef.current = null;
      return;
    }

    const motion = motionRef.current;
    const canAnimate = motionAllowedRef.current && visibleRef.current && windowFocusedRef.current;
    const idlePaused = selectedRef.current !== null || hoveredRef.current !== null;
    const previousFrame = lastFrameTimeRef.current;
    if (canAnimate && previousFrame !== null) {
      motion.advance((timestamp - previousFrame) / 1_000, idlePaused);
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
      motion.camera,
      { selectedId: selectedRef.current, hoveredId: hoveredRef.current },
    );

    if (canAnimate && motion.wantsAnimation(idlePaused)) {
      lastFrameTimeRef.current = timestamp;
      frameRef.current = window.requestAnimationFrame(renderFrame);
    } else {
      lastFrameTimeRef.current = null;
    }
  }, []);

  const requestRender = useCallback(() => {
    if (frameRef.current === null) frameRef.current = window.requestAnimationFrame(renderFrame);
  }, [renderFrame]);

  const cancelDrag = useCallback(() => {
    const motion = motionRef.current;
    const pointerId = motion.activePointerId;
    if (!motion.cancelDrag()) return;
    const canvas = canvasRef.current;
    if (pointerId !== null && canvas?.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    setDragging(false);
    requestRender();
  }, [requestRender]);

  const setZoom = useCallback((zoom: number) => {
    const appliedZoom = motionRef.current.setZoom(zoom);
    setZoomPercent(Math.round(appliedZoom * 100));
    requestRender();
  }, [requestRender]);

  const resetView = useCallback(() => {
    cancelDrag();
    motionRef.current.reset();
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
    if (!motionEnabled || reducedMotion) motionRef.current.stopMotion();
    requestRender();
  }, [motionEnabled, reducedMotion, requestRender]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const observer = new ResizeObserver(requestRender);
    observer.observe(canvas);
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom(motionRef.current.camera.zoom * Math.exp(-event.deltaY * 0.0012));
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    requestRender();
    return () => {
      observer.disconnect();
      canvas.removeEventListener("wheel", handleWheel);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      lastFrameTimeRef.current = null;
    };
  }, [requestRender, setZoom]);

  useEffect(() => {
    const handleVisibility = () => {
      visibleRef.current = document.visibilityState !== "hidden";
      if (!visibleRef.current) {
        cancelDrag();
        motionRef.current.stopMotion();
      }
      requestRender();
    };
    const handleWindowBlur = () => {
      windowFocusedRef.current = false;
      cancelDrag();
      motionRef.current.stopMotion();
      requestRender();
    };
    const handleWindowFocus = () => {
      windowFocusedRef.current = true;
      requestRender();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("focus", handleWindowFocus);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [cancelDrag, requestRender]);

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

  const hitNode = (event: ReactPointerEvent<HTMLCanvasElement>): ProjectedSphereNode | null => {
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
          <button type="button" aria-label="Zoom out" onClick={() => setZoom(motionRef.current.camera.zoom - 0.1)}>−</button>
          <output aria-live="polite">{zoomPercent}%</output>
          <button type="button" aria-label="Zoom in" onClick={() => setZoom(motionRef.current.camera.zoom + 0.1)}>+</button>
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
            title="Drag to rotate · release to glide · scroll to zoom · select a point to inspect"
            aria-label={`Interactive 3D dependency sphere with ${model.nodes.length} ${nodeTerm} and ${model.relationCount} ${relationTerm}. Drag to rotate, release to glide, scroll to zoom, or use the focus control.`}
            onKeyDown={(event) => {
              const rotationStep = event.shiftKey ? 0.2 : 0.1;
              if (event.key === "Escape") {
                event.preventDefault();
                if (motionRef.current.dragging) cancelDrag();
                else {
                  motionRef.current.stopMotion();
                  setSelectedId(null);
                }
              } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                motionRef.current.rotate(event.key === "ArrowLeft" ? -rotationStep : rotationStep, 0);
                requestRender();
              } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                motionRef.current.rotate(0, event.key === "ArrowUp" ? -rotationStep : rotationStep);
                requestRender();
              } else if (event.key === "+" || event.key === "=") {
                event.preventDefault();
                setZoom(motionRef.current.camera.zoom + 0.1);
              } else if (event.key === "-" || event.key === "_") {
                event.preventDefault();
                setZoom(motionRef.current.camera.zoom - 0.1);
              } else if (event.key === "0") {
                event.preventDefault();
                resetView();
              }
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.focus({ preventScroll: true });
              event.currentTarget.setPointerCapture(event.pointerId);
              hoveredRef.current = null;
              motionRef.current.beginDrag(event.pointerId, pointerSample(event.nativeEvent));
              setDragging(true);
              requestRender();
            }}
            onPointerMove={(event) => {
              const motion = motionRef.current;
              if (motion.dragging) {
                let changed = false;
                for (const sample of coalescedSamples(event)) {
                  if (motion.updateDrag(event.pointerId, sample)) changed = true;
                }
                if (changed) requestRender();
                return;
              }
              const hovered = hitNode(event)?.id ?? null;
              if (hovered !== hoveredRef.current) {
                hoveredRef.current = hovered;
                requestRender();
              }
            }}
            onPointerUp={(event) => {
              const motion = motionRef.current;
              const finalSample = coalescedSamples(event).at(-1) ?? pointerSample(event.nativeEvent);
              const completion = motion.endDrag(event.pointerId, finalSample);
              if (completion === "none") return;
              setDragging(false);
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              if (completion === "click") setSelectedId(hitNode(event)?.id ?? null);
              else {
                hoveredRef.current = null;
                requestRender();
              }
            }}
            onPointerCancel={cancelDrag}
            onLostPointerCapture={cancelDrag}
            onPointerLeave={() => {
              if (!motionRef.current.dragging && hoveredRef.current !== null) {
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
        <p id="sphere-controls" className="visually-hidden">Use arrow keys to rotate, plus and minus to zoom, zero to reset, and Escape to stop a drag or clear focus. Releasing a drag continues with gentle momentum. Automatic motion is disabled when reduced motion is requested.</p>
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
