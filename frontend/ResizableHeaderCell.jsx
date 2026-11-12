import React, { useEffect, useRef, useState } from 'react';
import { clampColumnWidth, columnWidthBounds, elementInlineScale, resizeColumnWidth } from './column-widths.mjs';

export default function ResizableHeaderCell({
  width, minWidth, maxWidth, onResize, onReset, resizeLabel = '调整此列列宽',
  children, className, style, ...thProps
}) {
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const bounds = columnWidthBounds(minWidth, maxWidth);
  const canResize = Number.isFinite(width) && typeof onResize === 'function';
  const currentWidth = clampColumnWidth(width, bounds.min, bounds.max);

  function finishDrag(restore = false, updateState = true) {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    drag.cleanup();
    if (updateState) setDragging(false);
    if (restore && drag.lastWidth !== drag.startWidth) drag.onResize(drag.startWidth);
  }

  useEffect(() => () => finishDrag(false, false), []);

  function startDrag(event) {
    event.stopPropagation();
    if (event.button !== 0 || !canResize || dragRef.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const header = handle.closest('th');
    const ownerWindow = handle.ownerDocument.defaultView;
    if (!ownerWindow) return;
    handle.focus({ preventScroll: true });
    const drag = {
      startX: event.clientX,
      startWidth: currentWidth,
      lastWidth: currentWidth,
      pointerId: event.pointerId,
      scale: elementInlineScale(header),
      onResize,
    };
    const move = pointerEvent => {
      if (pointerEvent.pointerId !== drag.pointerId) return;
      pointerEvent.preventDefault();
      const nextWidth = resizeColumnWidth(drag.startWidth, pointerEvent.clientX - drag.startX,
        drag.scale, bounds.min, bounds.max);
      if (nextWidth !== drag.lastWidth) {
        drag.lastWidth = nextWidth;
        drag.onResize(nextWidth);
      }
    };
    const end = pointerEvent => {
      if (pointerEvent.pointerId !== drag.pointerId) return;
      move(pointerEvent);
      finishDrag();
    };
    const cancel = pointerEvent => {
      if (pointerEvent.pointerId === drag.pointerId) finishDrag(true);
    };
    const escape = keyEvent => {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      finishDrag(true);
    };
    const blur = () => finishDrag(true);
    const lostCapture = pointerEvent => {
      if (pointerEvent.pointerId === drag.pointerId) finishDrag(true);
    };
    drag.cleanup = () => {
      ownerWindow.removeEventListener('pointermove', move, true);
      ownerWindow.removeEventListener('pointerup', end, true);
      ownerWindow.removeEventListener('pointercancel', cancel, true);
      ownerWindow.removeEventListener('keydown', escape, true);
      ownerWindow.removeEventListener('blur', blur);
      handle.removeEventListener('lostpointercapture', lostCapture);
      try {
        if (handle.hasPointerCapture?.(drag.pointerId)) handle.releasePointerCapture(drag.pointerId);
      } catch { /* A cancelled pointer may already have released capture. */ }
    };
    dragRef.current = drag;
    ownerWindow.addEventListener('pointermove', move, { capture: true, passive: false });
    ownerWindow.addEventListener('pointerup', end, true);
    ownerWindow.addEventListener('pointercancel', cancel, true);
    ownerWindow.addEventListener('keydown', escape, true);
    ownerWindow.addEventListener('blur', blur);
    handle.addEventListener('lostpointercapture', lostCapture);
    try { handle.setPointerCapture(event.pointerId); } catch { /* Window listeners also cover capture failure. */ }
    setDragging(true);
  }

  function resizeWithKeyboard(event) {
    // A focused resize handle must not activate Ant Table's header sorter.
    event.stopPropagation();
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      if (dragRef.current) return;
      onResize(clampColumnWidth(currentWidth + (event.key === 'ArrowRight' ? 10 : -10), bounds.min, bounds.max));
    } else if (event.key === 'Home' && typeof onReset === 'function') {
      event.preventDefault();
      finishDrag(true);
      onReset();
    }
  }

  return <th {...thProps}
    className={[className, canResize && 'candidate-resizable-header', dragging && 'is-resizing'].filter(Boolean).join(' ')}
    style={canResize ? { ...style, width: currentWidth } : style}>
    {children}
    {canResize && <span className="candidate-column-resize-handle" role="separator" tabIndex={0}
      aria-orientation="vertical" aria-label={resizeLabel}
      aria-valuemin={bounds.min} aria-valuemax={bounds.max} aria-valuenow={currentWidth}
      title={`拖动调整列宽；左右方向键每次调整 10 像素${onReset ? '；Home 恢复默认列宽' : ''}`}
      style={{ touchAction: 'none' }}
      onPointerDown={startDrag} onKeyDown={resizeWithKeyboard}
      onBlur={() => finishDrag(true)}
      onClick={event => { event.preventDefault(); event.stopPropagation(); }}
      onDoubleClick={event => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof onReset === 'function') onReset();
      }} />}
  </th>;
}
