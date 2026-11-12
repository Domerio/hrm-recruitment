import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { FileTextOutlined, UserOutlined } from '@ant-design/icons';
import {
  Alert, Button, Collapse, Descriptions, Empty, Flex, Form, Image, Input, Modal,
  Select, Tabs, Tag, Tooltip, Typography, Upload,
} from 'antd';
import { evidenceDisplay, evidencePreview } from './evidence-display.mjs';

export const reviewOptions = ['未复核', '通过复核', '待补充信息', '暂不推进'].map(value => ({
  value, label: value,
}));

export function EvaluationTag({ category }) {
  const colors = { 推荐: 'success', 待确认: 'warning', 低匹配: 'default' };
  return <Tag color={colors[category]}>{category}</Tag>;
}

export function ReviewTag({ status }) {
  const colors = { 通过复核: 'success', 待补充信息: 'warning', 暂不推进: 'default' };
  return <Tag color={colors[status]}>{status}</Tag>;
}

function sourceDescription(meta, value) {
  if (meta?.source === 'resume') return '简历自动提取' + (meta.evidence ? `：${meta.evidence}` : '');
  if (meta?.source === 'manual') return value ? '人工维护，自动提取会保留此内容。' : '已人工留空，自动提取会保留此设置。';
  return value ? '已保存的候选人资料' : '简历中未识别到可靠信息，可在编辑资料中补充。';
}

export function ProfileSourceTag({ meta, value }) {
  if (!['resume', 'manual'].includes(meta?.source)) return null;
  return <Tooltip title={sourceDescription(meta, value)}>
    <Tag color={meta.source === 'resume' ? 'cyan' : 'default'} style={{ marginInlineEnd: 0 }}>
      {meta.source === 'resume' ? '简历提取' : '人工维护'}
    </Tag>
  </Tooltip>;
}

export function skillTags(value) {
  if (typeof value !== 'string') return [];
  const seen = new Set();
  return value.split(/[\r\n,，、]+/u).map(tag => tag.trim()).filter(tag => {
    const key = tag.normalize('NFKC').replace(/\s+/gu, ' ').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function SkillTags({ value, meta, showSource }) {
  return <Flex vertical gap={8} className="candidate-skill-value" style={{ width: '100%', minWidth: 0 }}>
    <Flex wrap gap={6} role="list" aria-label="技能标签" style={{ maxWidth: '100%', minWidth: 0 }}>
      {skillTags(value).map(tag => <Tag key={tag} role="listitem" style={{
        marginInlineEnd: 0, maxWidth: '100%', minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere',
      }}>{tag}</Tag>)}
    </Flex>
    <Flex wrap align="center" gap={8} className="candidate-skill-source">
      {showSource && <ProfileSourceTag meta={meta} value={value} />}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}
        copyable={{ text: value, tooltips: ['复制技能原文', '已复制'] }}>复制原文</Typography.Text>
    </Flex>
  </Flex>;
}

export function ProfileValue({ candidate, field, secondary = false, showSource = false }) {
  const value = candidate[field];
  const meta = candidate.profile_sources?.[field];
  if (field === 'skills' && skillTags(value).length) return <SkillTags value={value} meta={meta} showSource={showSource} />;
  return <Flex align="start" gap={6} wrap>
    <Tooltip title={sourceDescription(meta, value)}>
      <Typography.Text type={secondary || !value ? 'secondary' : undefined} className="candidate-profile-text">
        {value || (meta?.source === 'manual' ? '已留空' : '未识别')}
      </Typography.Text>
    </Tooltip>
    {showSource && <ProfileSourceTag meta={meta} value={value} />}
  </Flex>;
}

const evidenceColors = { 满足: 'success', 不满足: 'error', 信息不足: 'warning' };
const displayTime = value => Number.isNaN(Date.parse(value)) ? '—' : new Date(value).toLocaleString('zh-CN', { timeZone:'Asia/Shanghai', hour12:false });
const currentScoringVersions = new Set(['equal-weight-v4', 'priority-weight-v4']);
const halfCreditScoringVersions = new Set(['equal-weight-v3', 'priority-weight-v3']);
const previousScoringVersions = new Set(['equal-weight-v2', 'priority-weight-v2']);

function scoringAdjustment(result) {
  if (result?.scoring_adjustment_v4?.reason === 'graded_evidence_v4') {
    return { ...result.scoring_adjustment_v4, label: '已按有依据部分支持 10%–90% 的分档规则重算' };
  }
  if (result?.scoring_adjustment_v3?.reason === 'partial_evidence_v3') {
    return { ...result.scoring_adjustment_v3, label: '曾按历史 v3 部分支持计 50% 的规则重算' };
  }
  if (result?.scoring_adjustment?.reason === 'unknown_zero_v2') {
    return { ...result.scoring_adjustment, label: '已按当时的 v2 规则重算' };
  }
  return null;
}

function conditionKey(value) {
  let condition = typeof value === 'string' ? value.normalize('NFKC').trim() : '';
  const prefix = /^(?:(?:\d+\.(?!\d)|\d+[、)]|\(\d+\))\s*|-(?!-)\s*|\*\s+|[•●▪◦‣·–—]\s*)/u;
  while (prefix.test(condition)) condition = condition.replace(prefix, '').trim();
  return condition.replace(/\s+/gu, ' ').toLowerCase();
}

function checkPresentation(check, scoring) {
  const presentation = { label: check.status, color: evidenceColors[check.status], ratio: null };
  const current = currentScoringVersions.has(scoring?.version);
  const historical = halfCreditScoringVersions.has(scoring?.version);
  if (!current && !historical) return presentation;
  const detail = Array.isArray(scoring.condition_scores) && scoring.condition_scores.find(item =>
    item && item.status === check.status && conditionKey(item.condition) === conditionKey(check.condition));
  if (!detail) return presentation;
  if (check.status === '满足' && detail.credit === 'full' && detail.ratio === 1) return { ...presentation, ratio: 1 };
  if (check.status === '不满足' && detail.credit === 'none' && detail.ratio === 0) return { ...presentation, ratio: 0 };
  const partialRatio = Number.isFinite(detail.ratio) && detail.ratio >= 0.1 && detail.ratio <= 0.9 &&
    Number.isInteger(detail.ratio * 10) && (current || detail.ratio === 0.5);
  if (check.status === '信息不足' && detail.credit === 'partial' && partialRatio) {
    return { ...presentation, label: '部分支持（待核实）', ratio: detail.ratio };
  }
  if (check.status === '信息不足' && detail?.credit === 'none' && detail.ratio === 0) {
    return { ...presentation, label: '信息不足（未计分）', ratio: 0 };
  }
  return presentation;
}

export function EvidenceQuotes({ item }) {
  const { quotes, duplicateCount } = evidenceDisplay(item);
  const preview = evidencePreview(quotes);
  const signature = JSON.stringify(quotes);
  const [expandedFor, setExpandedFor] = useState(null);
  const expanded = expandedFor === signature;
  const contentId = useId();
  const visible = expanded ? quotes : preview.quotes;
  if (!quotes.length) return <Typography.Paragraph className="candidate-evidence-quote" type="secondary">
    资料中没有足够证据
  </Typography.Paragraph>;
  return <div className="candidate-evidence-source" style={{ minWidth: 0, marginTop: 7 }}>
    <Typography.Text type="secondary" className="candidate-evidence-caption" style={{ fontSize: 12 }}>简历原文依据</Typography.Text>
    <div id={contentId} className={quotes.length > 1 ? 'candidate-evidence-quotes' : undefined}>
      {visible.map((quote, index) => <div key={index} className="candidate-evidence-snippet" style={
        !expanded && preview.clipFirst ? { display: '-webkit-box', WebkitLineClamp: '5',
          WebkitBoxOrient: 'vertical', overflow: 'hidden' } : undefined}>
        <Typography.Paragraph className="candidate-evidence-quote" type="secondary"
          style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {quote}
        </Typography.Paragraph>
      </div>)}
    </div>
    <Flex gap={6} wrap align="center" className="candidate-evidence-controls" style={{ marginTop: 5 }}>
      {duplicateCount > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        已合并{duplicateCount}条重复引用
      </Typography.Text>}
      {preview.needsExpansion && <Button type="link" size="small" htmlType="button" style={{ paddingInline: 0, height: 'auto', whiteSpace: 'normal' }}
        aria-controls={contentId} aria-expanded={expanded} onClick={() => setExpandedFor(expanded ? null : signature)}>
        {expanded ? '收起依据' : `展开全部${quotes.length}条依据`}
      </Button>}
    </Flex>
  </div>;
}

function CheckEvidence({ check, scoring }) {
  const { label, color, ratio } = checkPresentation(check, scoring);
  return <li className="candidate-evidence-item">
    <div className="candidate-evidence-heading">
      <Typography.Text strong>{check.condition}</Typography.Text>
      <Flex gap={4} wrap>
        {check.basis === 'inferred' && <Tag color="gold">项目推断</Tag>}
        <Tag color={color}>{label}</Tag>
        {ratio !== null && <Tag>{Math.round(ratio * 100)}% 计分</Tag>}
      </Flex>
    </div>
    {typeof check.reasoning === 'string' && check.reasoning.trim() && (
      <Typography.Paragraph className={check.basis === 'inferred' ? 'candidate-inference-reason' : 'candidate-check-reason'}>
        {check.reasoning}
      </Typography.Paragraph>
    )}
    <EvidenceQuotes item={check} />
  </li>;
}

function ScoringAdjustment({ result }) {
  const adjustment = scoringAdjustment(result);
  if (!adjustment) return null;
  const previous = adjustment.previous_score;
  return <Typography.Text type="secondary" className="candidate-scoring-adjustment">
    {adjustment.label}{Number.isFinite(previous) ? `（原 ${previous} 分）` : ''}；摘要保留原评估内容。
  </Typography.Text>;
}

function ScoringCounts({ scoring, current }) {
  const count = value => Number.isSafeInteger(value) && value >= 0;
  if (!scoring || !['total', 'met', 'unknown', 'not_met'].every(key => count(scoring[key]))) return null;
  const breakdown = current && count(scoring.partial) && count(scoring.no_evidence) &&
    scoring.partial + scoring.no_evidence === scoring.unknown;
  return <div>共 {scoring.total} 项：完全满足 {scoring.met} 项，{breakdown
    ? <>部分支持 {scoring.partial} 项，无可计分依据 {scoring.no_evidence} 项</>
    : <>信息不足 {scoring.unknown} 项{current ? '（未记录部分支持拆分）' : ''}</>}，不满足 {scoring.not_met} 项。</div>;
}

function ScoringExplanation({ result }) {
  if (result.scoring_obsolete) return <Alert type="warning" showIcon title="旧规则，待重评"
    description="旧评估未完整记录条件与权重，请重新评估以应用当前规则：完全满足 100%，有依据部分支持 10%–90%（每 10% 一档），无依据或不满足 0%；所有条件均计入分母。" />;
  const current = currentScoringVersions.has(result.scoring?.version);
  const halfCredit = halfCreditScoringVersions.has(result.scoring?.version);
  const previous = previousScoringVersions.has(result.scoring?.version);
  if (!current && !halfCredit && !previous) return <Alert type="warning" showIcon title="评分规则版本未记录，待重评"
    description="无法确认此评估采用的计分规则，请重新评估以应用当前规则：完全满足 100%，有依据部分支持 10%–90%（每 10% 一档），无依据或不满足 0%；摘要保留原评估内容。" />;
  const weighted = Array.isArray(result.scoring?.priority_groups) && result.scoring.priority_groups.length > 0;
  return <Alert type={current ? 'info' : 'warning'} showIcon
    title={current ? '评分规则：证据分档计分' : `历史评分规则（${halfCredit ? 'v3' : 'v2'}），待重评`} description={
    <Flex vertical gap={6}>
      <Flex gap={5} wrap>
        <Tag color="success" style={{ marginInlineEnd: 0 }}>完全满足：100%</Tag>
        {(current || halfCredit) && <Tag color="gold" style={{ marginInlineEnd: 0, maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
          {current ? '有依据部分支持：10%–90%（每 10% 一档）' : '历史部分支持：50%'}
        </Tag>}
        <Tag style={{ marginInlineEnd: 0, maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
          {current || halfCredit ? '无依据或不满足：0%' : '当时信息不足或不满足：0%'}
        </Tag>
      </Flex>
      {current ? <div>部分支持须有简历项目原文依据和推导理由，但尚不足以完全确认，仍需核实。</div>
        : <div>此分数沿用历史 {halfCredit ? 'v3 半分' : 'v2'} 规则，尚未采用有依据部分支持 10%–90% 的当前分档规则，请重新评估。</div>}
      <Typography.Text strong>所有条件均计入分母。</Typography.Text>
      <div>{current ? weighted
        ? '得分 = 各条件（权重 × 计分比例）之和 ÷ 全部条件权重之和 × 100。'
        : '得分 = 各条件计分比例之和 ÷ 全部条件数 × 100（各条件等权）。'
        : halfCredit ? weighted
        ? '得分 =（完全满足权重之和 + 0.5 × 部分支持权重之和）÷ 全部条件权重之和 × 100。'
        : '得分 =（完全满足条件数 + 0.5 × 部分支持条件数）÷ 全部条件数 × 100。'
        : weighted ? '当时得分 = 满足条件权重之和 ÷ 全部条件权重之和 × 100。'
          : '当时得分 = 满足条件数 ÷ 全部条件数 × 100。'}</div>
      <ScoringCounts scoring={result.scoring} current={current || halfCredit} />
      <ScoringAdjustment result={result} />
    </Flex>
  } />;
}

function EvaluationSummary({ history, pending, evaluation }) {
  const result = history[0]?.result;
  const checks = Array.isArray(result?.checks) ? result.checks.filter(item => item && typeof item === 'object') : [];
  const requiredChecks = Array.isArray(result?.required_checks) ? result.required_checks.filter(item => item && typeof item === 'object') : [];
  const inferredCapabilities = Array.isArray(result?.inferred_capabilities) ? result.inferred_capabilities.filter(item => item && typeof item === 'object') : [];
  const questions = Array.isArray(result?.questions) ? result.questions : [];
  const priorityGroups = !result?.scoring_obsolete && Array.isArray(result?.scoring?.priority_groups)
    ? result.scoring.priority_groups.filter(group => group && Array.isArray(group.conditions)) : [];
  const originalSummary = result?.scoring_obsolete || scoringAdjustment(result) ||
    result?.scoring_adjustment?.reason === 'unknown_zero_v2';
  const counts = [...checks.reduce((groups, check) => {
    const { label, color } = checkPresentation(check, result?.scoring);
    const item = groups.get(label) || { label, color, count: 0 };
    groups.set(label, { ...item, count: item.count + 1 });
    return groups;
  }, new Map()).values()];

  return (
    <Flex vertical gap={16}>
      {evaluation?.text && <Alert title={evaluation.text}
        type={evaluation.error ? 'error' : evaluation.running ? 'info' : 'success'} showIcon />}
      {pending && !result?.scoring_obsolete && <Alert title="评估待重试" description="请重新评估并核对履历原文依据。" type="warning" showIcon />}
      {result ? (
        <>
          <ScoringExplanation result={result} />
          <div className="candidate-eval-summary">
            <h3 className="candidate-eval-section-title">{originalSummary ? '原评估摘要' : pending ? '上次评估摘要' : '评估摘要'}</h3>
            <Typography.Paragraph>{result.summary}</Typography.Paragraph>
            {result.scoring_obsolete && <Typography.Text type="secondary">摘要保留原评估内容，分数与结论需重新评估。</Typography.Text>}
          </div>
          {priorityGroups.length > 0 && <Collapse size="small" items={[{
            key:'weights',label:'优先级与评分权重',children:<Flex vertical gap={10}>
              {priorityGroups.map(group=><div key={group.priority}>
                <Typography.Text strong>优先级 {group.priority} · 权重 {group.weight}</Typography.Text>
                <ul className="candidate-eval-questions">{group.conditions.map((condition,index)=><li key={index}>{condition}</li>)}</ul>
              </div>)}
            </Flex>,
          }]} />}
          {result.evaluation_context && <Typography.Text type="secondary">
            评估时岗位版本 {result.evaluation_context.job_revision} · 资料版本 {result.evaluation_context.candidate_revision} · {result.evaluation_context.evaluation_date}
          </Typography.Text>}
          {result.must_have_status && <section>
            <h3 className="candidate-eval-section-title">必备条件</h3>
            <Tag color={{ met:'success', not_met:'error', unknown:'warning' }[result.must_have_status]}>
              {{ met:'全部满足', not_met:'存在未满足项', unknown:'存在待核实项', not_configured:'未配置必备条件' }[result.must_have_status]}
            </Tag>
            {requiredChecks.length > 0 && <ol className="candidate-evidence-list">
              {requiredChecks.map((check, index) => <CheckEvidence key={index} check={check} scoring={result.scoring} />)}
            </ol>}
          </section>}
          <section>
            <h3 className="candidate-eval-section-title">逐项依据</h3>
            <div className="candidate-eval-counts">
              {counts.map(({ label, color, count }) => <Tag key={label} color={color}>{label} {count}</Tag>)}
            </div>
            <ol className="candidate-evidence-list">
              {checks.map((check, index) => <CheckEvidence key={index} check={check} scoring={result.scoring} />)}
            </ol>
          </section>
          {inferredCapabilities.length > 0 && (
            <section>
              <h3 className="candidate-eval-section-title">项目补充能力 <Tag color="gold">待核实</Tag></h3>
              <Typography.Paragraph type="secondary">根据项目经历补充的相关能力，需结合面试核实。</Typography.Paragraph>
              <ol className="candidate-evidence-list">
                {inferredCapabilities.map((item, index) => (
                  <li key={index} className="candidate-evidence-item candidate-inferred-item">
                    <Typography.Text strong>{item.capability}</Typography.Text>
                    <Typography.Paragraph className="candidate-inference-reason">{item.reasoning}</Typography.Paragraph>
                    <EvidenceQuotes item={item} />
                    <Typography.Text type="secondary">建议核实：{item.question}</Typography.Text>
                  </li>
                ))}
              </ol>
            </section>
          )}
          <section>
            <h3 className="candidate-eval-section-title">待确认问题</h3>
            {questions.length
              ? <ul className="candidate-eval-questions">
                {questions.map((question, index) => <li key={index}>{question}</li>)}
              </ul>
              : <Typography.Text type="secondary">暂无待确认问题</Typography.Text>}
          </section>
          <Collapse size="small" items={[{
            key: 'history', label: `历史评估（${history.length} 次）`,
            children: <Flex vertical gap={10}>{history.map((item, index) => (
              <div key={item.id ?? index}>
                <Typography.Text strong>{displayTime(item.created)} · {item.model} · {item.result.scoring_obsolete
                  ? '旧规则，待重评' : `${item.result.score} 分${scoringAdjustment(item.result) ? '（重算后）' : ''}`}</Typography.Text>
                <div><ScoringAdjustment result={item.result} /></div>
                {!item.result.scoring_obsolete && (halfCreditScoringVersions.has(item.result.scoring?.version) || previousScoringVersions.has(item.result.scoring?.version)) &&
                  <div><Typography.Text type="secondary">历史 {halfCreditScoringVersions.has(item.result.scoring?.version) ? 'v3 半分' : 'v2'} 规则：尚未采用部分支持 10%–90% 的分档规则。</Typography.Text></div>}
                {item.result.scoring_obsolete && <div><Typography.Text type="secondary">旧分数未采用，请重新评估；摘要保留原评估内容。</Typography.Text></div>}
                <Typography.Text type="secondary">{item.result.summary}</Typography.Text>
              </div>
            ))}</Flex>,
          }]} />
        </>
      ) : !pending && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未进行 AI 评估" />}
    </Flex>
  );
}

function CandidateSource({ candidate, api, refresh, notify }) {
  const [saving, setSaving] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const savingRef = useRef(false);
  const recognizingRef = useRef(false);
  const source = candidate.source || {};
  const capture = source.capture;
  const status = {
    visible_complete: '已展开并读取至稳定底部（当前账号可见内容）',
    needs_review: '内容待核对',
  }[capture?.status] || '未记录详情采集状态';

  async function saveShareImage(file) {
    if (savingRef.current || recognizingRef.current) return Upload.LIST_IGNORE;
    savingRef.current = true;
    setSaving(true);
    try {
      if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 3_000_000) {
        throw new Error('请选择不超过 3 MB 的 PNG 或 JPEG 分享图片');
      }
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      try {
        if (bitmap.width > 4096 || bitmap.height > 4096) {
          throw new Error('图片尺寸须不超过 4096 × 4096');
        }
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
      } finally {
        bitmap.close();
      }
      await api('/api/candidates/share', { id: candidate.id, image: canvas.toDataURL('image/png') });
      await refresh();
      notify('回访图片已保存到对应候选人。');
    } catch (error) {
      notify(error.message, true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    return Upload.LIST_IGNORE;
  }

  async function recognizeQr() {
    if (savingRef.current || recognizingRef.current) return;
    recognizingRef.current = true;
    setRecognizing(true);
    try {
      const response = await api('/api/candidates/recognize-qr', { id: candidate.id });
      const result = await response.json();
      await refresh();
      notify(result.qr_url ? '二维码已识别，可以打开平台简历。' : qrMessages[result.qr_status] || '未能识别可打开的链接，请使用原图片扫码。');
    } catch (error) {
      notify(error.message, true);
    } finally {
      recognizingRef.current = false;
      setRecognizing(false);
    }
  }

  const qrMessages = {
    recognized: '已识别平台链接',
    not_checked: '尚未识别二维码',
    not_found: '未检测到二维码，可更换更清晰的分享图片',
    unreadable: '二维码暂时无法解析，请使用原图片扫码',
    multiple: '图片包含多个二维码，无法确认对应链接',
    unsupported: '二维码内容不是可直接打开的 BOSS 网页链接，请扫码查看',
  };
  let qrUrl = '';
  try {
    const url = new URL(source.qr_url);
    if (url.protocol === 'https:' && (url.hostname === 'zhipin.com' || url.hostname.endsWith('.zhipin.com') || url.hostname === 'zpurl.cn') &&
        !url.username && !url.password && (!url.port || url.port === '443')) qrUrl = url.href;
  } catch { /* Keep the source image available when no supported URL exists. */ }

  const details = [
    { key: 'phone', label: '手机', children: candidate.phone || '未获取' },
    { key: 'email', label: '邮箱', children: candidate.email || '未获取' },
    { key: 'wechat', label: '微信', children: candidate.wechat || '未获取' },
    { key: 'status', label: '采集状态', children: status },
    { key: 'share', label: '二维码', children: source.share_status || '未获取' },
  ];
  return (
    <Flex vertical gap={12}>
      <Descriptions size="small" column={1} items={details} />
      {candidate.link && /^https:\/\//i.test(candidate.link) && (
        <Typography.Link href={candidate.link} target="_blank" rel="noopener noreferrer">打开平台入口 ↗</Typography.Link>
      )}
      {capture && (
        <Flex vertical gap={4}>
          <Typography.Text type="secondary">已识别章节：{capture.sections.join('、') || '未识别'}</Typography.Text>
          {capture.warnings.length > 0 && <Typography.Text type="warning">{capture.warnings.join('；')}</Typography.Text>}
        </Flex>
      )}
      {source.image_url && (
        <Flex vertical align="start" gap={8}>
          <Image className="candidate-share-image" src={source.image_url} preview={false}
            alt={`候选人 #${candidate.id} 的平台回访二维码卡片`} />
          <Typography.Link href={source.image_url} download={`candidate-${candidate.id}.png`}>下载回访图片</Typography.Link>
          {qrUrl && (
            <Flex align="center" gap={12} wrap>
              <Button type="primary" href={qrUrl} target="_blank" rel="noopener noreferrer">打开平台简历 ↗</Button>
              <Typography.Text copyable={{ text: qrUrl }}>复制链接</Typography.Text>
            </Flex>
          )}
          <Typography.Text type="secondary">{qrMessages[source.qr_status] || qrMessages.not_checked}</Typography.Text>
          <Button onClick={recognizeQr} loading={recognizing} disabled={saving}>
            {source.qr_status && source.qr_status !== 'not_checked' ? '重新识别二维码' : '识别二维码链接'}
          </Button>
        </Flex>
      )}
      <Typography.Text type="secondary">链接及扫码能否打开，以平台当前账号权限和有效期为准。</Typography.Text>
      <Upload accept="image/png,image/jpeg" showUploadList={false} beforeUpload={saveShareImage} disabled={saving || recognizing}>
        <Button loading={saving}>补充或更换分享图片</Button>
      </Upload>
    </Flex>
  );
}

export default function CandidateDetail({ candidate, jobTitle, onClose, api, refresh, notify, evaluateButton, evaluation, onEdit, editDisabled = false }) {
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('evaluation');
  const savingRef = useRef(false);
  const sidebar = useRef(null);
  const reviewSelect = useRef(null);
  const reviewRequested = useRef(false);
  const pending = Boolean(candidate.ai_pending);
  const result = candidate.history[0]?.result;

  const focusReview = useCallback(() => {
    sidebar.current?.scrollIntoView({ block: 'nearest' });
    reviewSelect.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (tab === 'review' && reviewRequested.current) {
      reviewRequested.current = false;
      focusReview();
    }
  }, [tab, focusReview]);

  function openReview() {
    if (tab === 'review') {
      focusReview();
      return;
    }
    reviewRequested.current = true;
    setTab('review');
  }

  async function saveReview(values) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await api('/api/review', { id: candidate.id, ...values });
      onClose();
      await refresh();
      notify('人工复核已保存。');
    } catch (error) {
      notify(error.message, true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const tabs = [
    {
      key:'information', label:'基本资料',
      children:<div className="candidate-detail-tab-panel">
        <Descriptions size="small" column={1} items={[
          {key:'name',label:'姓名',children:candidate.name},
          {key:'job',label:'关联岗位',children:jobTitle || '—'},
          ...[['company','最近公司'],['title','最近职位'],['city','城市'],['education','学历'],
            ['skills','技能'],['phone','手机'],['email','邮箱'],['wechat','微信'],['note','备注']].map(([key,label])=>({
              key,label,children:['company','title','city','education','skills'].includes(key)
                ? <ProfileValue candidate={candidate} field={key} showSource />
                : <span className="candidate-profile-text">{candidate[key] || '—'}</span>,
            })),
          {key:'created',label:'导入时间',children:displayTime(candidate.created)},
        ]} />
        {onEdit && <Button onClick={onEdit} disabled={saving || editDisabled}>编辑资料</Button>}
      </div>,
    },
    {
      key: 'evaluation', label: 'AI 评估',
      children: <div className="candidate-detail-tab-panel">
        <EvaluationSummary history={candidate.history} pending={pending} evaluation={evaluation} />
      </div>,
    },
    {
      key: 'review', label: '人工复核',
      children: <div className="candidate-detail-tab-panel">
        <Form layout="vertical" initialValues={{ review: candidate.review, note: candidate.note }} onFinish={saveReview}>
          <Form.Item label="复核状态" name="review" rules={[{ required: true, message: '请选择复核状态' }]}>
            <Select ref={reviewSelect} options={reviewOptions} />
          </Form.Item>
          <Form.Item label="备注" name="note">
            <Input.TextArea rows={4} maxLength={4000} placeholder="记录复核依据或待确认的问题" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>保存复核</Button>
        </Form>
      </div>,
    },
    {
      key: 'contact', label: '联系与回访',
      children: <div className="candidate-detail-tab-panel">
        <CandidateSource candidate={candidate} api={api} refresh={refresh} notify={notify} />
      </div>,
    },
  ];

  return (
    <Modal open centered width={1180} rootClassName="candidate-detail-modal" footer={null}
      keyboard={!saving} mask={{ closable: !saving }} closable={{ disabled: saving }}
      onCancel={() => { if (!saving) onClose(); }}
      classNames={{
        container: 'candidate-detail-shell', header: 'candidate-detail-header',
        body: 'candidate-detail-body', close: 'candidate-detail-close',
      }}
      title={
        <div className="candidate-detail-identity">
          <span className="candidate-detail-avatar" aria-hidden="true"><UserOutlined /></span>
          <div>
            <h2 className="candidate-detail-name">{candidate.name}</h2>
            <div className="candidate-detail-meta">
              {jobTitle && <Typography.Text type="secondary">{jobTitle}</Typography.Text>}
              <ReviewTag status={candidate.review} />
            </div>
          </div>
        </div>
      }>
      <div className="candidate-detail-overview">
        <div className="candidate-detail-score">
          <span className="candidate-detail-score-label">{pending && result && !result.scoring_obsolete ? '上次 AI 匹配' : 'AI 匹配'}</span>
          {result?.scoring_obsolete ? <Tag color="warning">旧规则，待重评</Tag> : result ? (
            <>
              <span className="candidate-detail-score-value"><strong>{result.score}</strong><span>分</span></span>
              <EvaluationTag category={result.category} />
            </>
          ) : !pending && !evaluation?.running && <Tag>尚未评估</Tag>}
          {evaluation?.running ? <Tag color="processing">评估中</Tag> : pending && !result?.scoring_obsolete && <Tag color="warning">待重试</Tag>}
        </div>
        <div className="candidate-detail-actions">
          {onEdit && <Button onClick={onEdit} disabled={saving || editDisabled}>编辑资料</Button>}
          {evaluateButton}
          <Button onClick={openReview}>人工复核</Button>
        </div>
      </div>
      <div className="candidate-detail-workspace">
        <section className="candidate-resume-pane" aria-labelledby="candidate-resume-heading">
          <div className="candidate-resume-heading">
            <FileTextOutlined aria-hidden="true" />
            <h3 id="candidate-resume-heading">履历资料</h3>
          </div>
          <iframe className="candidate-resume-frame" src={`/api/candidates/${candidate.id}/resume.html?revision=${candidate.revision || 0}`}
            title="履历资料" sandbox="" />
        </section>
        <div className="candidate-detail-sidebar" ref={sidebar}>
          <Tabs className="candidate-detail-tabs" activeKey={tab} onChange={setTab} items={tabs} />
        </div>
      </div>
    </Modal>
  );
}
