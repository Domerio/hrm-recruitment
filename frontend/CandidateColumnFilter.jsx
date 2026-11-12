import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button, Flex, Input, InputNumber, Select, Typography, theme } from 'antd';

const isEmpty = value => value === undefined || value === null || value === '';
const fieldValues = (fields, values) => Object.fromEntries(fields.map(field => [field.key, values?.[field.key]]));

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function validationError(fields, values, ranges) {
  for (const field of fields) {
    const value = values[field.key];
    if (isEmpty(value)) continue;
    if (field.type === 'number') {
      if (!Number.isFinite(Number(value))) return `${field.label}请输入有效数字。`;
      if (field.min !== undefined && Number(value) < field.min) return `${field.label}不能小于 ${field.min}。`;
      if (field.max !== undefined && Number(value) > field.max) return `${field.label}不能大于 ${field.max}。`;
    }
    if (field.type === 'date' && !validDate(value)) return `${field.label}请输入有效日期。`;
  }
  for (const range of ranges) {
    const from = values[range.from];
    const to = values[range.to];
    if (isEmpty(from) || isEmpty(to)) continue;
    const fromField = fields.find(field => field.key === range.from);
    const toField = fields.find(field => field.key === range.to);
    if (!fromField || !toField) continue;
    const reversed = fromField.type === 'number' ? Number(from) > Number(to) : from > to;
    if (reversed) return `${fromField.label}不能${fromField.type === 'number' ? '大于' : '晚于'}${toField.label}。`;
  }
  return '';
}

/** Draft changes stay local until Apply; Reset clears only this column's fields. */
export default function CandidateColumnFilter({
  title, fields = [], values = {}, ranges = [], onApply, onReset, close, open,
}) {
  const { token } = theme.useToken();
  const instanceId = useId();
  const [draft, setDraft] = useState(() => fieldValues(fields, values));
  const [error, setError] = useState('');
  const panel = useRef(null);
  const [viewportStyle, setViewportStyle] = useState({});
  const sourceSignature = JSON.stringify(fields.map(field => [field.key, values?.[field.key] ?? null]));

  useEffect(() => {
    setDraft(fieldValues(fields, values));
    setError('');
  }, [sourceSignature, open]);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const ownerWindow = element.ownerDocument.defaultView;
    const measure = () => {
      const scale = element.offsetWidth > 0 ? element.getBoundingClientRect().width / element.offsetWidth : 1;
      const ratio = Number.isFinite(scale) && scale > 0 ? Math.round(scale * 1000) / 1000 : 1;
      const next = { width:Math.floor(Math.max(160,Math.min(280,ownerWindow.innerWidth / ratio - 32))),
        maxHeight:Math.floor(Math.max(120,Math.min(680,ownerWindow.innerHeight / ratio - 40))) };
      setViewportStyle(previous => previous.width === next.width && previous.maxHeight === next.maxHeight ? previous : next);
    };
    measure();
    ownerWindow.addEventListener('resize',measure);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => { ownerWindow.removeEventListener('resize',measure); observer?.disconnect(); };
  }, []);

  function change(key, value) {
    setDraft(previous => ({ ...previous, [key]: value }));
    setError('');
  }

  function apply() {
    const message = validationError(fields, draft, ranges);
    if (message) {
      setError(message);
      return;
    }
    const next = Object.fromEntries(fields.map(field => {
      let value = draft[field.key];
      if (typeof value === 'string') value = value.trim();
      if (isEmpty(value)) value = undefined;
      else if (field.type === 'number') value = Number(value);
      return [field.key, value];
    }));
    onApply(next);
    close?.();
  }

  function reset() {
    const keys = fields.map(field => field.key);
    setDraft(Object.fromEntries(keys.map(key => [key, undefined])));
    setError('');
    onReset(keys);
    close?.();
  }

  function keyDown(event) {
    event.stopPropagation();
    if (event.key === 'Enter' && !event.nativeEvent?.isComposing && event.keyCode !== 229) {
      // Select needs its first Enter to choose an option while its menu is open.
      const expandedSelect = event.target.closest?.('.ant-select')?.querySelector('[aria-expanded="true"]');
      if (expandedSelect || event.target.closest?.('button')) return;
      event.preventDefault();
      apply();
    }
  }

  return <form ref={panel} className="candidate-column-filter" aria-label={`${title}筛选`} noValidate
    style={{ width: 280, maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box', padding: 16, overflowY:'auto', ...viewportStyle }}
    onSubmit={event => { event.preventDefault(); event.stopPropagation(); apply(); }}
    onKeyDownCapture={event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close?.();
      }
    }}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onKeyDown={keyDown}>
    <Typography.Text strong>{title}筛选</Typography.Text>
    <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
      {fields.map(field => {
        const inputId = `${instanceId}-${field.key}`;
        const common = { id: inputId, 'aria-label': field.label, placeholder: field.placeholder,
          style: { width: '100%' } };
        return <div className="candidate-column-filter-field" key={field.key} style={{ display: 'grid', gap: 6 }}>
          <label htmlFor={inputId} style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>{field.label}</label>
          {field.type === 'select'
            ? <Select {...common} allowClear options={field.options || []} value={draft[field.key] ?? undefined}
              showSearch={{ optionFilterProp: 'label' }} getPopupContainer={trigger => trigger.parentElement}
              onChange={value => change(field.key, value)} />
            : field.type === 'number'
              ? <InputNumber {...common} min={field.min} max={field.max} value={draft[field.key] ?? null}
                changeOnBlur={false} onInput={value => change(field.key, value)}
                onChange={value => change(field.key, value)} />
              : <Input {...common} type={field.type === 'date' ? 'date' : 'text'} allowClear
                value={draft[field.key] ?? ''} onChange={event => change(field.key, event.target.value)} />}
        </div>;
      })}
    </div>
    {error && <div role="alert" style={{ color: token.colorError, marginTop: 12, fontSize: token.fontSizeSM }}>{error}</div>}
    <Flex justify="space-between" gap={8} style={{ marginTop: 16 }}>
      <Button htmlType="button" onClick={reset}>重置本列</Button>
      <Button type="primary" htmlType="submit">应用筛选</Button>
    </Flex>
  </form>;
}
