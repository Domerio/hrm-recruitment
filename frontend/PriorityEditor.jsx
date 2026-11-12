import React, { useEffect, useId, useRef } from 'react';
import { ArrowDownOutlined, ArrowUpOutlined, HolderOutlined, MoreOutlined } from '@ant-design/icons';
import { Button, Card, Checkbox, Dropdown, Empty, Flex, Tag, Typography } from 'antd';

const { Text } = Typography;
const listPrefix = /^(?:(?:\d+\.(?!\d)|\d+[、)]|\(\d+\))\s*|-(?!-)\s*|\*\s+|[•●▪◦‣·–—]\s*)/u;
const labels = new Set(['必备条件', '必须满足', '一般条件', '筛选条件', '加分条件']);
const dragType = 'application/x-hrm-priority';

export function normalizeRequirement(value) {
  if (typeof value !== 'string') return '';
  let text = value.normalize('NFKC').trim();
  for (let prefix = text.match(listPrefix); prefix; prefix = text.match(listPrefix)) {
    text = text.slice(prefix[0].length).trim();
  }
  return text.replace(/\s+/gu, ' ').toLowerCase().replaceAll('ß', 'ss').replaceAll('ς', 'σ');
}

function requirementLines(value) {
  return String(value || '').split(/\r?\n/).map(line => line.trim())
    .filter(text => text && !labels.has(text.normalize('NFKC').replace(/[:：]+$/, '')));
}

export function jobRequirements(criteria, mustHave = '') {
  const selected = new Set(requirementLines(mustHave).map(normalizeRequirement));
  const requirements = new Map();
  for (const text of requirementLines(criteria)) {
    const key = normalizeRequirement(text);
    if (key && !requirements.has(key)) requirements.set(key, { key, text, required: selected.has(key) });
  }
  return [...requirements.values()];
}

export function defaultPriorityGroups(requirements) {
  return requirements.map((item, index) => {
    const match = item.text.normalize('NFKC').trim().match(/^(?:\((\d+)\)|(\d+)(?:\.(?!\d)|[、)]))/);
    return { item, index, number: match ? Number(match[1] || match[2]) : Infinity };
  }).sort((a, b) => a.number - b.number || a.index - b.index).map(({ item }) => [item.text]);
}

export function reconcilePriorityGroups(value, requirements) {
  if (!requirements.length) return [];
  if (!Array.isArray(value) || !value.length) return defaultPriorityGroups(requirements);
  const current = new Map(requirements.map(item => [item.key, item.text]));
  const seen = new Set();
  const groups = [];
  for (const group of value) {
    const result = [];
    for (const text of Array.isArray(group) ? group : []) {
      const key = normalizeRequirement(text);
      if (current.has(key) && !seen.has(key)) {
        result.push(current.get(key));
        seen.add(key);
      }
    }
    if (result.length) groups.push(result);
  }
  groups.push(...defaultPriorityGroups(requirements.filter(item => !seen.has(item.key))));
  return groups;
}

const migrationKey = text => normalizeRequirement(text).replace(/[;；.。]+$/u, '').trim();

export function prepareJobRequirements(job) {
  let criteria = job.criteria || '';
  const available = jobRequirements(criteria);
  const selected = new Set();
  const find = text => available.find(item => item.key === normalizeRequirement(text)) ||
    available.find(item => migrationKey(item.text) === migrationKey(text));
  for (const text of requirementLines(job.must_have)) {
    if (!normalizeRequirement(text)) continue;
    let item = find(text);
    if (!item) {
      item = { key: normalizeRequirement(text), text };
      available.push(item);
      criteria = criteria.trimEnd() + (criteria.trim() ? '\n' : '') + text;
    }
    selected.add(item.key);
  }
  const mustHave = available.filter(item => selected.has(item.key)).map(item => item.text).join('\n');
  const requirements = jobRequirements(criteria, mustHave);
  const mappedGroups = Array.isArray(job.priority_groups) ? job.priority_groups.map(group =>
    (Array.isArray(group) ? group : []).map(text => find(text)?.text).filter(Boolean)) : [];
  return {
    criteria, must_have: mustHave,
    priority_groups: job.priority_configured
      ? reconcilePriorityGroups(mappedGroups, requirements) : defaultPriorityGroups(requirements),
  };
}

export function PrioritySummary({ job }) {
  const prepared = prepareJobRequirements(job);
  const requirements = jobRequirements(prepared.criteria, prepared.must_have);
  const byKey = new Map(requirements.map(item => [item.key, item]));
  return (
    <Flex vertical gap={10}>
      {!prepared.priority_groups.length && <Text type="secondary">未配置有效岗位要求</Text>}
      {prepared.priority_groups.map((group, index) => (
        <div key={index}>
          <Tag color="cyan">优先级 {index + 1}</Tag>
          <ul style={{ margin: '6px 0 0', paddingInlineStart: 20 }}>
            {group.map(text => {
              const item = byKey.get(normalizeRequirement(text));
              return <li key={item.key} style={{ marginBottom: 5, overflowWrap: 'anywhere' }}>
                <Text>{item.text}</Text>{' '}
                <Tag color={item.required ? 'red' : 'default'}>{item.required ? '必备' : '一般'}</Tag>
              </li>;
            })}
          </ul>
        </div>
      ))}
    </Flex>
  );
}

export default function PriorityEditor({ value, onChange, requirements, onRequiredChange, configured = false, disabled = false }) {
  const scope = useId();
  const dragging = useRef(null);
  const manual = useRef(configured);
  const groups = manual.current ? reconcilePriorityGroups(value, requirements) : defaultPriorityGroups(requirements);
  const byKey = new Map(requirements.map(item => [item.key, item]));

  useEffect(() => {
    if (JSON.stringify(value ?? []) !== JSON.stringify(groups)) onChange?.(groups);
  }, [value, groups, onChange]);

  function emit(next) {
    if (disabled) return;
    manual.current = true;
    onChange?.(next.filter(group => group.length));
  }

  function moveGroup(from, to) {
    if (disabled || from === to || from < 0 || to < 0 || from >= groups.length || to >= groups.length) return;
    const next = groups.map(group => [...group]);
    const [group] = next.splice(from, 1);
    next.splice(to, 0, group);
    emit(next);
  }

  function moveRequirement(key, targetGroup, targetIndex = groups[targetGroup]?.length) {
    if (disabled || !byKey.has(key) || !groups[targetGroup]) return;
    const sourceGroup = groups.findIndex(group => group.some(text => normalizeRequirement(text) === key));
    if (sourceGroup < 0) return;
    const sourceIndex = groups[sourceGroup].findIndex(text => normalizeRequirement(text) === key);
    if (sourceGroup === targetGroup && sourceIndex === targetIndex) return;
    const next = groups.map(group => [...group]);
    const [text] = next[sourceGroup].splice(sourceIndex, 1);
    next[targetGroup].splice(Math.min(targetIndex, next[targetGroup].length), 0, text);
    emit(next);
  }

  function splitRequirement(key, boundary) {
    if (disabled || !byKey.has(key)) return;
    const sourceGroup = groups.findIndex(group => group.some(text => normalizeRequirement(text) === key));
    if (sourceGroup < 0) return;
    const next = groups.map(group => group.filter(text => normalizeRequirement(text) !== key));
    const empty = next[sourceGroup].length === 0;
    const target = boundary - (empty && sourceGroup < boundary ? 1 : 0);
    if (empty) next.splice(sourceGroup, 1);
    next.splice(Math.max(0, Math.min(target, next.length)), 0, [byKey.get(key).text]);
    emit(next);
  }

  function beginDrag(event, payload) {
    if (disabled) return event.preventDefault();
    event.stopPropagation();
    dragging.current = { scope, ...payload };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(dragType, JSON.stringify(dragging.current));
  }

  function allowDrop(event) {
    if (!disabled && dragging.current?.scope === scope) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
  }

  function drop(event, groupIndex, rowIndex = groups[groupIndex]?.length, boundary = false) {
    event.stopPropagation();
    if (disabled) return;
    let payload = dragging.current;
    try { payload ||= JSON.parse(event.dataTransfer.getData(dragType)); }
    catch { return; }
    if (payload?.scope !== scope) return;
    event.preventDefault();
    if (payload.kind === 'group') {
      const target = boundary && payload.index < groupIndex ? groupIndex - 1 : groupIndex;
      moveGroup(payload.index, Math.min(target, groups.length - 1));
    } else if (payload.kind === 'requirement') {
      if (boundary) splitRequirement(payload.key, groupIndex);
      else moveRequirement(payload.key, groupIndex, rowIndex);
    }
    dragging.current = null;
  }

  function boundary(index) {
    return <div data-priority-boundary={index} role="separator" aria-label={'在位置 ' + (index + 1) + ' 独立成级'}
      title="拖到此处独立优先级" onDragOver={allowDrop} onDrop={event => drop(event, index, 0, true)}
      style={{ height: 14, borderBlockStart: '1px dashed #d4dedb', marginBlockStart: 6 }} />;
  }

  return (
    <Flex vertical gap={8} data-priority-editor>
      <Text type="secondary">{requirements.length} 条要求 · {groups.length} 个优先级 · {requirements.filter(item => item.required).length} 条必备</Text>
      <Text type="secondary">默认按编号排序，未编号按输入顺序。拖入同组可合并，拖到组间虚线可独立成级。勾选每条要求后的「必备」。</Text>
      {!requirements.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先填写岗位要求，再调整优先级" />}
      <div>
        {groups.map((group, groupIndex) => (
          <React.Fragment key={groupIndex}>
            {boundary(groupIndex)}
            <div data-priority-group={groupIndex} onDragOver={allowDrop} onDrop={event => drop(event, groupIndex)}>
              <Card size="small" title={(
                <Flex align="center" gap={6} draggable={!disabled} data-priority-group-handle={groupIndex}
                  onDragStart={event => beginDrag(event, { kind: 'group', index: groupIndex })}
                  onDragEnd={() => { dragging.current = null; }}
                  style={{ cursor: disabled ? 'default' : 'grab' }}>
                  <HolderOutlined aria-hidden="true" /><span>优先级 {groupIndex + 1}</span>
                  <Text type="secondary">· {group.length} 条</Text>
                </Flex>
              )} extra={(
                <Dropdown trigger={['click']} disabled={disabled} menu={{ items: [
                  { key:'up', label:'上移优先级', icon:<ArrowUpOutlined aria-hidden="true" />, disabled:groupIndex===0, onClick:()=>moveGroup(groupIndex,groupIndex-1) },
                  { key:'down', label:'下移优先级', icon:<ArrowDownOutlined aria-hidden="true" />, disabled:groupIndex===groups.length-1, onClick:()=>moveGroup(groupIndex,groupIndex+1) },
                ] }}>
                  <Button type="text" size="small" htmlType="button" disabled={disabled} icon={<MoreOutlined aria-hidden="true" />}
                    aria-label={'优先级 ' + (groupIndex + 1) + ' 更多操作'} />
                </Dropdown>
              )}>
                <Flex vertical gap={8}>
                  {group.map((text, rowIndex) => {
                    const item = byKey.get(normalizeRequirement(text));
                    const menu = [
                      { key:'up', label:'组内上移', disabled:rowIndex===0, onClick:()=>moveRequirement(item.key,groupIndex,rowIndex-1) },
                      { key:'down', label:'组内下移', disabled:rowIndex===group.length-1, onClick:()=>moveRequirement(item.key,groupIndex,rowIndex+1) },
                      { key:'split', label:'独立成级', disabled:group.length===1, onClick:()=>splitRequirement(item.key,groupIndex+1) },
                      { key:'move', label:'移动到优先级', children:groups.map((_,index)=>({
                        key:'move-'+index, label:'优先级 '+(index+1), disabled:index===groupIndex,
                        onClick:()=>moveRequirement(item.key,index),
                      })) },
                    ];
                    return (
                      <Flex key={item.key} align="start" gap={6} draggable={!disabled}
                        data-priority-row={rowIndex} data-requirement-key={item.key}
                        onDragStart={event => beginDrag(event, { kind:'requirement', key:item.key })}
                        onDragEnd={() => { dragging.current=null; }}
                        onDragOver={allowDrop} onDrop={event => drop(event,groupIndex,rowIndex)}
                        style={{ padding:10, border:'1px solid #e5e9ed', borderRadius:6, minWidth:0,
                          background:'#fff', cursor:disabled?'default':'grab' }}>
                        <HolderOutlined aria-hidden="true" />
                        <Text style={{ whiteSpace:'pre-wrap', overflowWrap:'anywhere', minWidth:0, flex:1 }}>{item.text}</Text>
                        <Checkbox checked={item.required} disabled={disabled}
                          aria-label={'必备要求 '+item.text} onChange={event=>onRequiredChange?.(item.key,event.target.checked)}>必备</Checkbox>
                        <Dropdown trigger={['click']} disabled={disabled} menu={{ items:menu }}>
                          <Button type="text" size="small" htmlType="button" disabled={disabled} icon={<MoreOutlined aria-hidden="true" />}
                            aria-label={'要求 '+item.text+' 更多操作'} />
                        </Dropdown>
                      </Flex>
                    );
                  })}
                </Flex>
              </Card>
            </div>
          </React.Fragment>
        ))}
        {groups.length>0 && boundary(groups.length)}
      </div>
    </Flex>
  );
}
