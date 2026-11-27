import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DownOutlined, FilterFilled, MoreOutlined, ThunderboltOutlined } from '@ant-design/icons';
import {
  Alert, App, Button, Card, Checkbox, Col, Collapse, Dropdown, Empty, Flex, Modal, Progress, Radio, Row, Select, Statistic, Table, Tag, Typography,
} from 'antd';
import CandidateDetail, { EvaluationTag, ProfileValue, ReviewTag, reviewOptions } from './CandidateDetail';
import CandidateFavoriteEntry from './CandidateFavoriteEntry';
import CandidateForm from './CandidateEditor';
import DirectResumeEvaluation from './DirectResumeEvaluation';
import CandidateColumnFilter from './CandidateColumnFilter';
import { CandidateContactOptions } from './CandidateChatEntry';
import { bossChatUrl } from './boss-chat-link.mjs';
import ResizableHeaderCell from './ResizableHeaderCell';
import { readCandidateColumnWidths, writeCandidateColumnWidths, clampColumnWidth } from './column-widths.mjs';
import { currentEvaluation, aiStatus, contacts, filterAndSort, hasFilterValue } from './candidate-table-data.mjs';
import { createAiTaskBatch, aiTaskLabel } from './ai-task-client.mjs';
import { candidateEvaluationFailure } from './evaluation-failure.mjs';
import { isRuleRejected } from '../extension/evaluation-result.mjs';

const options = values => values.map(value => ({ value, label: value }));
const aiOptions = [
  { value: 'pending', label: '待重试' },
  { value: 'unevaluated', label: '尚未评估' },
  { value: 'evaluated', label: '已评估' },
];
const categoryOptions = options(['推荐', '待确认', '低匹配']);
const contactOptions = [
  { value: 'available', label: '已获取联系方式' },
  { value: 'missing', label: '未获取联系方式' },
  { value: 'phone', label: '有手机号' },
  { value: 'email', label: '有邮箱' },
  { value: 'wechat', label: '有微信' },
  { value: 'link', label: '有平台入口' },
];
const sortOptions = [
  { value: 'created-desc', label: '导入时间 · 最新优先' },
  { value: 'created-asc', label: '导入时间 · 最早优先' },
  { value: 'score-desc', label: 'AI 分数 · 从高到低' },
  { value: 'score-asc', label: 'AI 分数 · 从低到高' },
  { value: 'name-asc', label: '姓名 · 拼音升序' },
  { value: 'name-desc', label: '姓名 · 拼音降序' },
];
function importDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
const failureSnapshot = candidate => {
  const failure = candidateEvaluationFailure(candidate);
  return JSON.stringify(failure ? [failure.created ?? null,failure.code ?? null,failure.message] : null);
};
const evaluationSnapshot = candidate => ({jobId:candidate?.job_id,
  history:JSON.stringify(candidate?.history?.[0] ?? null), failure:failureSnapshot(candidate)});
const supersededEvaluation = (candidate, baseline) => baseline && (candidate.job_id !== baseline.jobId ||
  failureSnapshot(candidate) !== baseline.failure ||
  !candidate.ai_pending && candidate.history?.[0]?.result && JSON.stringify(candidate.history[0]) !== baseline.history);

export default function Candidates({ state, refresh, api, notify, active = true, onNavigate, candidateJobRequest }) {
  const { jobs, configured } = state;
  const [removedIds, setRemovedIds] = useState(() => new Set());
  const candidates = useMemo(() => state.candidates.filter(candidate => !removedIds.has(candidate.id)),
    [state.candidates, removedIds]);
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState('created-desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selected, setSelected] = useState([]);
  const [detailId, setDetailId] = useState(null);
  const [contactTarget, setContactTarget] = useState(null);
  const [editor, setEditor] = useState(null);
  const editorRef = useRef(null);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState('');
  const [deletingIds, setDeletingIds] = useState([]);
  const [evaluation, setEvaluation] = useState(null);
  const [batch, setBatch] = useState(null);
  const [batchScope, setBatchScope] = useState(null);
  const [directOpen, setDirectOpen] = useState(false);
  const [directBusy, setDirectBusy] = useState(false);
  const [clearing, setClearing] = useState(false);
  const tableRegion = useRef(null);
  const [tableWidth, setTableWidth] = useState(0);
  const [columnWidths, setColumnWidths] = useState(readCandidateColumnWidths);
  useEffect(() => { writeCandidateColumnWidths(columnWidths); }, [columnWidths]);
  const evaluating = useRef(null);
  const evaluationControl = useRef(null);
  const evaluationSequence = useRef(0);
  const batchControl = useRef(null);
  const batchInputs = useRef(null);
  const clearingRef = useRef(false);
  const clearConfirmationOpen = useRef(false);
  const mounted = useRef(true);
  const deleting = useRef(false);
  const deleteConfirmationOpen = useRef(false);
  const { modal } = App.useApp();
  useEffect(() => {
    const element = tableRegion.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      if (width > 0) setTableWidth(width);
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      batchControl.current?.detach();
      evaluationControl.current?.detach();
    };
  }, []);
  useEffect(() => {
    if (!candidateJobRequest) return;
    setFilters({ job: candidateJobRequest.jobId });
    setPage(1);
    setDetailId(null);
    setContactTarget(null);
    setEditor(null);
    editorRef.current = null;
  }, [candidateJobRequest]);
  useEffect(() => { if (!active) { setDirectOpen(false); setContactTarget(null); } }, [active]);
  useEffect(() => {
    const ids = new Set(candidates.map(candidate => candidate.id));
    setSelected(previous => {
      const current = previous.filter(id => ids.has(id));
      return current.length === previous.length ? previous : current;
    });
    setDetailId(previous => previous !== null && !ids.has(previous) ? null : previous);
    setContactTarget(previous => previous && !ids.has(previous.id) ? null : previous);
    if (editorRef.current?.candidate && !ids.has(editorRef.current.candidate.id)) {
      editorRef.current = null;
      setEditor(null);
    }
  }, [candidates]);
  function setFilter(key, value) {
    setFilters(prev => ({ ...prev, [key]: value }));
    setPage(1);
  }
  function clearFilters() {
    setFilters({});
    setPage(1);
  }
  function toggleFilter(key, value) {
    setFilters(prev => ({ ...prev, [key]: prev[key] === value ? undefined : value }));
    setPage(1);
  }
  function changeSort(value) {
    setSort(value);
    setPage(1);
  }

  const rows = filterAndSort(candidates, filters, sort);
  const lastPage = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, lastPage);
  useEffect(() => { setPage(previous => Math.min(previous, lastPage)); }, [lastPage]);
  const pageStart = (currentPage - 1) * pageSize;
  const pageRows = rows.slice(pageStart, pageStart + pageSize);
  const jobNames = new Map(jobs.map(j => [j.id, j.title]));
  const detail = candidates.find(c => c.id === detailId);
  const contactCandidate = active && contactTarget ? candidates.find(c => c.id === contactTarget.id && !c.deleted &&
    c.job_id === contactTarget.jobId && bossChatUrl(c.source?.boss_chat_uid) === contactTarget.href) : null;
  useEffect(() => { if (contactTarget && !contactCandidate) setContactTarget(null); }, [contactTarget, contactCandidate]);
  const jobOptions = jobs.map(j => ({ value: j.id, label: j.title }));
  const displayed = new Set(rows.map(c => c.id));
  const hiddenCount = selected.filter(id => !displayed.has(id)).length;
  const currentPageIds = new Set(pageRows.map(candidate => candidate.id));
  const otherPagesCount = selected.filter(id => displayed.has(id) && !currentPageIds.has(id)).length;
  const evaluatingId = evaluation?.running ? evaluation.id : null;
  const batchRunning = Boolean(batch?.running);
  const batchTaskById = new Map((batch?.tasks || []).map(task => [task.id, task]));
  const aiBusy = evaluatingId !== null || batchRunning || directBusy;
  const deletingNow = deletingIds.length > 0;
  const reviewCount = candidates.filter(c => c.review === '未复核').length;
  const pendingCount = candidates.filter(c => c.ai_pending).length;
  const approvedCount = candidates.filter(c => c.review === '通过复核').length;
  // Read again when Start is clicked: an open review can outlive a list refresh or selection change.
  batchInputs.current = { candidates, rows, selected, configured };
  function batchTargets(scope) {
    const current = batchInputs.current;
    const chosen = new Set(current.selected);
    const targets = scope === 'selected' ? current.candidates.filter(candidate => chosen.has(candidate.id))
      : scope === 'filtered' ? current.rows : current.rows.filter(candidate => aiStatus(candidate) !== 'evaluated');
    return targets.map(({ id, name, job_id }) => ({ id, name, job_id }));
  }
  const batchScopeLabels = {
    pending: '当前筛选内尚未评估及待重试', selected: '已选候选人', filtered: '当前筛选全部候选人',
  };
  const batchReviewTargets = batchScope ? batchTargets(batchScope) : [];
  const batchJobCounts = new Map();
  batchReviewTargets.forEach(target => batchJobCounts.set(target.job_id, (batchJobCounts.get(target.job_id) || 0) + 1));

  async function refreshList() {
    setRefreshing(true);
    try {
      await refresh();
      // A cleared mark can be recollected under its original record ID.
      // A successful server read supersedes the temporary deletion mask.
      if (!deleting.current) setRemovedIds(new Set());
      notify('候选人列表已刷新。');
    } catch (error) {
      notify(error.message, true);
    } finally {
      setRefreshing(false);
    }
  }
  async function evaluate(id) {
    if (evaluating.current !== null || batchControl.current || deleting.current || clearingRef.current || editorRef.current !== null) return;
    const attempt = {id, requestId:++evaluationSequence.current,
      baseline:evaluationSnapshot(candidates.find(candidate => candidate.id === id))};
    if (!configured) {
      const text = '请先在连接与集成中保存可用的模型服务配置。';
      setEvaluation({ ...attempt, text, error: true });
      notify(text, true);
      return;
    }
    evaluating.current = id;
    const control = createAiTaskBatch({api, targets:[{id}], onUpdate:progress => {
      if (mounted.current && evaluationControl.current === control) {
        const task = progress.tasks[0];
        setEvaluation({...attempt, running:progress.running, taskState:task.state,
          error:['failed','unavailable'].includes(task.state),
          text:task.pollError || task.message || `${aiTaskLabel(task)}，完成后自动保存评估。`});
      }
    }});
    evaluationControl.current = control;
    let taskState;
    try {
      const progress = await control.run();
      if (progress.detached || !mounted.current) return;
      const task = progress.tasks[0];
      taskState = task.state;
      if (task.state !== 'succeeded') throw new Error(task.message || '评估未完成，请刷新列表核对。');
      await refresh();
      if (!mounted.current) return;
      const result = task.result || {};
      const text = result.cached ? '已复用当前资料的有效评估，可查看原文依据。' : '评估已保存，可查看原文依据并人工复核。';
      setEvaluation({ ...attempt, text, taskState });
      notify(text);
    } catch (error) {
      await refresh().catch(() => {});
      if (!mounted.current) return;
      setEvaluation({ ...attempt, text: error.message, error: true, taskState });
      notify(error.message, true);
    } finally {
      evaluating.current = null;
      if (evaluationControl.current === control) evaluationControl.current = null;
    }
  }
  function openBatchReview() {
    if (evaluating.current !== null || batchControl.current || deleting.current || clearingRef.current || editorRef.current) return;
    setBatchScope('pending');
  }
  async function evaluateSelected(targetSnapshot, scopeLabel) {
    if (evaluating.current !== null || batchControl.current || deleting.current || clearingRef.current || editorRef.current) return;
    if (!batchInputs.current.configured) {
      notify('请先在连接与集成中保存可用的模型服务配置。', true);
      return;
    }
    const existingIds = new Set(batchInputs.current.candidates.map(candidate => candidate.id));
    const targets = targetSnapshot.filter(target => existingIds.has(target.id)).map(target => ({ ...target }));
    if (!targets.length) return;
    setEvaluation(previous => targets.some(target => target.id === previous?.id) ? null : previous);
    const attempt = {requestId:++evaluationSequence.current, baselines:Object.fromEntries(targets.map(target =>
      [target.id,evaluationSnapshot(batchInputs.current.candidates.find(candidate => candidate.id === target.id))]))};
    const control = createAiTaskBatch({api, targets, onUpdate:progress => {
      if (mounted.current && batchControl.current === control) {
        setBatch({...progress, ...attempt, scopeLabel});
      }
    }});
    batchControl.current = control;
    setBatchScope(null);
    try {
      const progress = await control.run();
      if (progress.detached || !mounted.current) return;
      let refreshFailed = false;
      try { await refresh(); } catch { refreshFailed = true; }
      if (!mounted.current || batchControl.current !== control) return;
      setBatch({...progress, ...attempt, scopeLabel, refreshFailed});
      notify(`批量评估${progress.stopped ? '已停止等待' : '已完成'}：成功 ${progress.success} 人（复用 ${progress.reused} 人），失败 ${progress.failed} 人，停止等待 ${progress.cancelled} 人。`, progress.failed > 0);
    } catch (error) {
      if (mounted.current) {
        setBatch(previous => previous && {...previous, running:false, reason:error.message});
        notify(error.message, true);
      }
    } finally {
      if (batchControl.current === control) batchControl.current = null;
    }
  }
  function stopBatch() {
    if (!batchControl.current) return;
    batchControl.current.stop();
  }
  async function exportRows(format) {
    if (deleting.current || clearingRef.current) return;
    setExporting(format);
    try {
      const response = await api('/api/export', format === 'bundle' ? { ids: selected, format } : { ids: selected });
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = format === 'bundle' ? '候选人资料与回访图片.zip' : '候选人名单.csv';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      notify(`已导出 ${selected.length} 名候选人。`);
    } catch (error) {
      notify(error.message, true);
    } finally {
      setExporting('');
    }
  }
  async function deleteCandidates(ids, { clearCollectionMarks, renderContent }, confirmation, close) {
    if (deleting.current || clearingRef.current) return;
    if (evaluating.current !== null || batchControl.current) {
      notify('请等待 AI 评估结束后再删除。', true);
      return;
    }
    deleting.current = true;
    setDeletingIds(ids);
    confirmation.update({
      content: renderContent(true),
      okButtonProps: { danger: true, loading: true },
      cancelButtonProps: { disabled: true },
      keyboard: false,
    });
    let completed = false;
    try {
      const response = await api('/api/candidates/delete', { ids, clear_collection_marks: clearCollectionMarks });
      const result = await response.json();
      if (!Array.isArray(result.deleted) || result.deleted.length !== ids.length ||
          new Set(result.deleted).size !== ids.length || result.deleted.some(id => !Number.isInteger(id) || !ids.includes(id))) {
        throw new Error('工作台没有确认删除结果，请刷新列表后重试。');
      }
      const removed = new Set(result.deleted);
      if (clearCollectionMarks && (!Array.isArray(result.collection_marks_cleared) ||
          result.collection_marks_cleared.length !== removed.size ||
          new Set(result.collection_marks_cleared).size !== removed.size ||
          result.collection_marks_cleared.some(id => !removed.has(id)))) {
        throw new Error('工作台未确认采集标记已清除，请刷新后重试。');
      }
      setRemovedIds(previous => new Set([...previous, ...removed]));
      setSelected(previous => previous.filter(id => !removed.has(id)));
      setDetailId(previous => removed.has(previous) ? null : previous);
      setEvaluation(previous => previous && removed.has(previous.id) ? null : previous);
      completed = true;
      close();
      try {
        await refresh();
        setRemovedIds(previous => new Set([...previous].filter(id => !removed.has(id))));
        notify(`已删除 ${removed.size} 条候选人记录，${clearCollectionMarks ? '已清除对应采集标记，可重新采集' : '保留采集标记'}。`);
      } catch {
        notify('候选人记录已删除，列表刷新失败，请点击“刷新列表”查看。', true);
      }
    } catch (error) {
      notify(error.message, true);
    } finally {
      deleting.current = false;
      setDeletingIds([]);
      if (!completed) {
        confirmation.update({
          content: renderContent(false),
          okButtonProps: { danger: true, loading: false },
          cancelButtonProps: { disabled: false },
          keyboard: true,
        });
      }
    }
  }
  function confirmDelete(ids) {
    if (deleting.current || clearingRef.current || deleteConfirmationOpen.current || exporting) return;
    const targets = candidates.filter(candidate => ids.includes(candidate.id));
    if (!targets.length) return;
    if (evaluating.current !== null || batchControl.current) {
      notify('请等待 AI 评估结束后再删除。', true);
      return;
    }
    deleteConfirmationOpen.current = true;
    let clearCollectionMarks = false;
    const renderContent = (disabled = false) => (
        <Flex vertical gap={8}>
          <Typography.Text>确认从工作台移除以下 {targets.length} 条记录？</Typography.Text>
          <Checkbox checked={clearCollectionMarks} disabled={disabled} onChange={event => {
            if (deleting.current) return;
            clearCollectionMarks = event.target.checked;
            confirmation.update({ content: renderContent() });
          }}>同时清除采集标记</Checkbox>
          <Typography.Text type="secondary">
            {clearCollectionMarks ? '清除后，扩展可以重新采集这些候选人。' : '保留标记，扩展将继续跳过这些候选人。'}
          </Typography.Text>
          <Flex vertical gap={4}>
            {targets.slice(0, 6).map(candidate => (
              <Typography.Text key={candidate.id} type="secondary">
                {candidate.name} · {jobNames.get(candidate.job_id)} · #{candidate.id}
              </Typography.Text>
            ))}
            {targets.length > 6 && <Typography.Text type="secondary">另有 {targets.length - 6} 条记录</Typography.Text>}
          </Flex>
        </Flex>
      );
    const confirmation = modal.confirm({
      title: '删除候选人记录',
      content: renderContent(),
      okText: '确认删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      mask: { closable: false },
      onOk: close => { void deleteCandidates(targets.map(candidate => candidate.id), { clearCollectionMarks, renderContent }, confirmation, close); },
      afterClose: () => { deleteConfirmationOpen.current = false; },
    });
  }
  function confirmClearEvaluations() {
    if (evaluating.current !== null || batchControl.current || deleting.current || clearingRef.current ||
        clearConfirmationOpen.current || editorRef.current || exporting) return;
    clearConfirmationOpen.current = true;
    const confirmation = modal.confirm({
      title: '清空全部 AI 评估记录',
      content: '将清除工作台内全部候选人的 AI 评估记录（含历史评估）。候选人、履历、联系方式和人工复核记录会保留。需要时可重新评估。',
      okText: '确认清空评估', cancelText: '取消', okButtonProps: { danger: true }, mask: { closable: false },
      onOk: close => {
        if (clearingRef.current || evaluating.current !== null || batchControl.current || deleting.current) return;
        clearingRef.current = true;
        setClearing(true);
        confirmation.update({ okButtonProps: { danger: true, loading: true }, cancelButtonProps: { disabled: true }, keyboard: false });
        void (async () => {
          let completed = false;
          try {
            const response = await api('/api/evaluations/clear', {});
            const result = await response.json();
            if (!result.ok || !Number.isInteger(result.deleted) || result.deleted < 0) throw new Error('工作台没有确认清空结果，请刷新后重试。');
            setEvaluation(null);
            setBatch(null);
            completed = true;
            close();
            try {
              await refresh();
              notify(`已清除 ${result.deleted} 条 AI 评估记录。`);
            } catch {
              notify('AI 评估记录已清除，列表刷新失败，请点击“刷新列表”查看。', true);
            }
          } catch (error) {
            notify(error.message, true);
          } finally {
            clearingRef.current = false;
            setClearing(false);
            if (!completed) confirmation.update({ okButtonProps: { danger: true, loading: false }, cancelButtonProps: { disabled: false }, keyboard: true });
          }
        })();
      },
      afterClose: () => { clearConfirmationOpen.current = false; },
    });
  }
  function addCandidate() {
    if (batchControl.current || evaluating.current !== null || deleting.current || clearingRef.current) return;
    if (jobs.length) {
      const nextEditor = { candidate: null, returnId: null };
      editorRef.current = nextEditor;
      setEditor(nextEditor);
      setDetailId(null);
    } else {
      onNavigate?.('jobs');
      notify('请先创建一个岗位。', true);
    }
  }
  function openEdit(candidate) {
    if (evaluating.current !== null || batchControl.current || deleting.current || clearingRef.current) return;
    const nextEditor = { candidate: { ...candidate }, returnId: detailId === candidate.id ? candidate.id : null };
    editorRef.current = nextEditor;
    setEditor(nextEditor);
    setDetailId(null);
  }
  function closeEditor(result) {
    const returnId = editorRef.current?.returnId;
    editorRef.current = null;
    setEditor(null);
    if (result?.evaluation_invalidated) {
      setEvaluation(previous => previous?.id === result.id ? null : previous);
    }
    if (returnId && !result?.refreshFailed) setDetailId(returnId);
  }
  function sortOrder(field) {
    if (sort === `${field}-asc`) return 'ascend';
    if (sort === `${field}-desc`) return 'descend';
    return null;
  }

  function evaluationButton(candidate, size = 'small') {
    const running = evaluatingId === candidate.id;
    let label = 'AI 评估';
    if (running) label = evaluation.taskState === 'queued' ? '排队中' : '评估中';
    else if (candidate.ai_pending) label = '重试评估';
    else if (candidate.history.length) label = '重新评估';
    return (
      <Button type="primary" size={size} loading={running} disabled={deletingNow || clearing || batchRunning || (!running && evaluatingId !== null)}
        onClick={() => evaluate(candidate.id)}>{label}</Button>
    );
  }

  const wideTable = tableWidth >= 1180;
  const narrowTable = tableWidth > 0 && tableWidth < 760;
  const inlineScore = tableWidth > 0 && tableWidth < 540;
  const tableLayout = wideTable ? 'wide' : inlineScore ? 'compact' : narrowTable ? 'narrow' : 'condensed';
  const filterFields = {
    name:[{ key:'search', label:'姓名或履历关键词', type:'search', placeholder:'姓名、技能或履历关键词' },
      { key:'job', label:'招聘岗位', type:'select', options:jobOptions, placeholder:'全部岗位' }],
    profile:[{ key:'company', label:'最近公司', type:'search' }, { key:'title', label:'最近职位', type:'search' }],
    background:[{ key:'city', label:'城市关键词', type:'search' }, { key:'education', label:'学历关键词', type:'search' }],
    score:[{ key:'ai', label:'AI 状态', type:'select', options:aiOptions, placeholder:'全部 AI 状态' },
      { key:'category', label:'AI 结论', type:'select', options:categoryOptions, placeholder:'全部结论' },
      { key:'mustHave', label:'必备条件状态', type:'select', options:options(['全部满足','存在未满足项','待核实','未配置']).map((item,index)=>({ ...item,value:['met','not_met','unknown','not_configured'][index] })) },
      { key:'minScore', label:'最低分', type:'number', min:0, max:100 }, { key:'maxScore', label:'最高分', type:'number', min:0, max:100 }],
    created:[{ key:'createdFrom', label:'导入开始日期（北京时间）', type:'date' }, { key:'createdTo', label:'导入结束日期（北京时间）', type:'date' }],
    contact:[{ key:'contact', label:'联系方式', type:'select', options:contactOptions, placeholder:'不限联系方式' }],
    review:[{ key:'review', label:'人工复核', type:'select', options:reviewOptions, placeholder:'全部复核状态' }],
  };
  const columnFilterFields = {
    name:[...filterFields.name, ...(!wideTable ? [...filterFields.created,...filterFields.contact] : []),
      ...(narrowTable ? [...filterFields.profile,...filterFields.background] : []), ...(inlineScore ? [...filterFields.score,...filterFields.review] : [])],
    profile:[...filterFields.profile,...(!wideTable ? filterFields.background : [])],
    background:filterFields.background, score:[...filterFields.score,...(!wideTable ? filterFields.review : [])],
    created:filterFields.created, contact:filterFields.contact, review:filterFields.review,
  };
  function applyColumnFilter(next) {
    setFilters(previous => ({ ...previous,...next }));
    setPage(1);
  }
  function resetColumnFilter(keys) {
    setFilters(previous => Object.fromEntries(Object.entries(previous).filter(([key])=>!keys.includes(key))));
    setPage(1);
  }
  function resizeColumn(key, width) {
    setColumnWidths(previous => ({ ...previous, [tableLayout]:{ ...previous[tableLayout], [key]:width } }));
  }
  function resetColumnWidth(key) {
    setColumnWidths(previous => ({ ...previous, [tableLayout]:Object.fromEntries(Object.entries(previous[tableLayout] || {}).filter(([name])=>name!==key)) }));
  }
  function candidateAttempt(c) {
    const single = evaluation?.id === c.id && !supersededEvaluation(c, evaluation.baseline) ? evaluation : null;
    const task = !supersededEvaluation(c, batch?.baselines?.[c.id]) ? batchTaskById.get(c.id) : null;
    const useSingle = single && (!task || single.requestId > batch.requestId);
    return {single:useSingle ? single : null, task:useSingle ? null : task};
  }
  function candidateEvaluationFeedback(c) {
    const {single,task} = candidateAttempt(c);
    if (single) return single;
    if (!task || task.state === 'cancelled') return null;
    const failed = ['failed','unavailable'].includes(task.state);
    return {id:c.id, taskState:task.state, error:failed, running:!['succeeded','failed','unavailable'].includes(task.state),
      text:failed ? task.message || '评估未完成，请重试。' : task.pollError || aiTaskLabel(task)};
  }
  function evaluationCell(c) {
    const {single,task:activeTask} = candidateAttempt(c);
    if (single?.running) return <div className="candidate-ai-state candidate-ai-running"><span className="candidate-ai-dot" />{single.taskState === 'queued' ? '排队中' : '正在评估'}</div>;
    const failedTask = activeTask && ['failed','unavailable'].includes(activeTask.state);
    const failedSingle = single?.error && single.taskState !== 'succeeded';
    const succeeded = single ? single.taskState === 'succeeded' : activeTask?.state === 'succeeded';
    const savedFailure = candidateEvaluationFailure(c);
    const failureMessage = failedTask ? activeTask.message || '评估未完成，请重试。'
      : failedSingle ? single.text : !succeeded ? savedFailure?.message : '';
    if (activeTask && batchRunning && !failedTask) return <div className="candidate-ai-state"><span className="candidate-ai-dot" />{aiTaskLabel(activeTask)}</div>;
    if (failureMessage) return <div className="candidate-ai-failure">
      <div className="candidate-ai-state candidate-ai-failed"><span className="candidate-ai-dot" />{activeTask?.state === 'unavailable' ? '状态读取失败' : '评估失败'}</div>
      <span className="candidate-ai-failure-reason" title={failureMessage}>{failureMessage}</span>
    </div>;
    if (succeeded && c.ai_pending) return <div className="candidate-ai-state"><span className="candidate-ai-dot" />已完成，待刷新</div>;
    if (c.ai_pending) return <div className="candidate-ai-state candidate-ai-pending"><span className="candidate-ai-dot" />待重试</div>;
    const result = currentEvaluation(c);
    if (!result) return <div className="candidate-ai-state candidate-ai-empty"><span className="candidate-ai-dot" />尚未评估</div>;
    if (isRuleRejected(result)) return <div className="candidate-ai-result"><Tag color="warning" style={{ maxWidth:'100%', whiteSpace:'normal' }}>规则预筛不达标 · 未调用模型</Tag></div>;
    const mustHave = {
      not_met: { color: 'error', label: '必备未满足' },
      unknown: { color: 'warning', label: '必备待核实' },
      met: { color: 'success', label: '必备全部满足' },
    }[result.must_have_status];
    return <div className="candidate-ai-result"><div className="candidate-ai-headline">
      <span className="candidate-ai-score"><strong>{result.score}</strong><span>分</span></span>
      <EvaluationTag category={result.category} /></div>
      {mustHave && <Tag className="candidate-ai-requirement" color={mustHave.color}>{mustHave.label}</Tag>}
    </div>;
  }
  function backgroundCell(c) {
    return <Flex wrap gap="4px 8px" className="candidate-inline-background">
      <ProfileValue candidate={c} field="city" secondary />
      <ProfileValue candidate={c} field="education" secondary />
    </Flex>;
  }
  function profileCell(c) {
    return <Flex vertical gap={3}>
      <ProfileValue candidate={c} field="company" />
      <ProfileValue candidate={c} field="title" secondary />
      {!wideTable && backgroundCell(c)}
    </Flex>;
  }
  const baseColumns = [
    {
      title: '候选人 / 岗位', key: 'name', width: narrowTable ? undefined : 160, sorter: true, sortOrder: sortOrder('name'),
      sortDirections: ['ascend', 'descend', 'ascend'],
      render: (_, c) => (
        <Flex vertical gap={4}>
          <Flex align="center" gap={6} wrap>
            <Typography.Text strong>{c.name}</Typography.Text>
            {c.source?.origin === 'direct_evaluation' && <Tag color="purple" style={{ marginInlineEnd: 0 }}>直接评估</Tag>}
          </Flex>
          <Typography.Text type="secondary">{jobNames.get(c.job_id)}</Typography.Text>
          {narrowTable && profileCell(c)}
          {!wideTable && <Typography.Text className="candidate-import-inline" type="secondary">导入：{importDate(c.created)}</Typography.Text>}
          {!wideTable && <Typography.Text type="secondary">联系：{contacts(c).join(' / ') || '未获取'}</Typography.Text>}
          {inlineScore && <div className="candidate-inline-evaluation">{evaluationCell(c)}</div>}
          {inlineScore && <ReviewTag status={c.review} />}
        </Flex>
      ),
    },
    {
      title: '最近公司 / 职位', key: 'profile', hidden: narrowTable,
      render: (_, c) => profileCell(c),
    },
    {
      title: '城市 / 学历', key: 'background', width: 110, hidden: !wideTable,
      render: (_, c) => <Flex vertical gap={2}>
        <ProfileValue candidate={c} field="city" />
        <ProfileValue candidate={c} field="education" secondary />
      </Flex>,
    },
    {
      title: wideTable ? 'AI 评估' : '评估 / 复核', key: 'score', width: 166, hidden: inlineScore, sorter: true, sortOrder: sortOrder('score'),
      sortDirections: ['descend', 'ascend', 'descend'],
      render: (_, c) => <Flex vertical gap={8}>{evaluationCell(c)}{!wideTable && <ReviewTag status={c.review} />}</Flex>,
    },
    {
      title: '导入时间', key: 'created', width: 138, hidden: !wideTable, sorter: true, sortOrder: sortOrder('created'),
      sortDirections: ['descend', 'ascend', 'descend'],
      render: (_, c) => <Typography.Text type="secondary">{importDate(c.created)}</Typography.Text>,
    },
    {
      title: '联系方式', key: 'contact', width: 110, hidden: !wideTable,
      render: (_, c) => contacts(c).join(' / ') || <Typography.Text type="secondary">未获取</Typography.Text>,
    },
    {
      title: '人工复核', key: 'review', width: 90, hidden: !wideTable,
      render: (_, c) => <ReviewTag status={c.review} />,
    },
    {
      title: '操作', key: 'actions', width: narrowTable ? 104 : 148,
      render: (_, c) => (
        <Flex className="candidate-row-actions" gap={6} wrap>
          <Button size="small" onClick={() => { setContactTarget(null); setDetailId(c.id); }}>查看详情</Button>
          <CandidateFavoriteEntry candidate={c} extensionId={state.extension_id} size="small" />
          <Dropdown trigger={['click']} menu={{ items: [
            ...(bossChatUrl(c.source?.boss_chat_uid) ? [{ key:'chat', label:'联系候选人',
              onClick:()=>setContactTarget({ id:c.id, jobId:c.job_id, href:bossChatUrl(c.source.boss_chat_uid) }) }] : []),
            { key:'edit', label:'编辑资料', disabled:deletingNow || aiBusy || clearing, onClick:()=>openEdit(c) },
            { key:'evaluate', label:evaluatingId === c.id ? '评估中…' : c.ai_pending ? '重试评估' : c.history.length ? '重新评估' : 'AI 评估',
              disabled:deletingNow || aiBusy || clearing, onClick:()=>evaluate(c.id) },
            { type:'divider' },
            { key:'delete', danger:true, label:'删除', disabled:deletingNow || aiBusy || clearing || Boolean(exporting), onClick:()=>confirmDelete([c.id]) },
          ] }}>
            <Button size="small" icon={<MoreOutlined />} title="更多操作" loading={deletingIds.includes(c.id)}
              aria-label={`${c.name} #${c.id} 的更多操作`} />
          </Dropdown>
        </Flex>
      ),
    },
  ];
  const visibleColumns = baseColumns.filter(column=>!column.hidden);
  const flexibleKey = narrowTable ? 'name' : 'profile';
  const minimumWidths = { name:130, profile:112, background:110, score:144, created:128, contact:100, review:96, actions:104 };
  const widths = {};
  for (const column of visibleColumns) {
    if (column.key !== flexibleKey) widths[column.key] = clampColumnWidth(columnWidths[tableLayout]?.[column.key] ?? column.width,
      minimumWidths[column.key],800);
  }
  const remainder = tableWidth - 40 - Object.values(widths).reduce((sum,width)=>sum+width,0);
  widths[flexibleKey] = clampColumnWidth(columnWidths[tableLayout]?.[flexibleKey] ?? remainder,minimumWidths[flexibleKey],800);
  const tableContentWidth = 40 + Object.values(widths).reduce((sum,width)=>sum+width,0);
  const columns = visibleColumns.map(column => {
    const fields = columnFilterFields[column.key];
    return { ...column, width:widths[column.key],
      onHeaderCell:()=>({ width:widths[column.key],minWidth:minimumWidths[column.key],maxWidth:800,
        resizeLabel:`调整${column.title}列宽`,onResize:width=>resizeColumn(column.key,width),onReset:()=>resetColumnWidth(column.key) }),
      ...(fields?.length ? {
        filteredValue:fields.some(field=>hasFilterValue(filters[field.key])) ? ['active'] : null,
        filterIcon:filtered=><FilterFilled aria-label={`${column.title}筛选菜单`} title={`${column.title}筛选`} style={{ color:filtered?'#146d65':undefined }} />,
        filterDropdownProps:{ destroyOnHidden:true,autoAdjustOverflow:{ adjustX:true,adjustY:true,shiftX:true,shiftY:true } },
        filterDropdown:({ close })=><CandidateColumnFilter title={column.title} fields={fields} values={filters}
          ranges={[{ from:'minScore',to:'maxScore' },{ from:'createdFrom',to:'createdTo' }]}
          onApply={applyColumnFilter} onReset={resetColumnFilter} close={close} />,
      } : {}),
    };
  });
  const filterCount = Object.values(filters).filter(hasFilterValue).length;
  const emptyList = (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={candidates.length ? '没有符合筛选条件的候选人' : '暂无候选人'}>
      {candidates.length > 0 && <Button onClick={clearFilters}>清除筛选</Button>}
      {!candidates.length && !jobs.length && <Button onClick={addCandidate}>创建岗位配置</Button>}
    </Empty>
  );

  return (
    <Flex vertical gap={16}>
      <Row gutter={[12, 12]} aria-label="招聘概况">
        <Col xs={12} lg={6}><Card size="small"><Statistic title="候选人总数" value={candidates.length} /></Card></Col>
        <Col xs={12} lg={6}>
          <Card size="small">
            <Statistic title={<Button size="small" type={filters.ai === 'pending' ? 'primary' : 'link'}
              aria-pressed={filters.ai === 'pending'} onClick={() => toggleFilter('ai', 'pending')}>AI 待重试</Button>}
              value={pendingCount} />
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card size="small">
            <Statistic title={<Button size="small" type={filters.review === '未复核' ? 'primary' : 'link'}
              aria-pressed={filters.review === '未复核'} onClick={() => toggleFilter('review', '未复核')}>待人工复核</Button>}
              value={reviewCount} />
          </Card>
        </Col>
        <Col xs={12} lg={6}><Card size="small"><Statistic title="已通过复核" value={approvedCount} /></Card></Col>
      </Row>
      {batch && <Card size="small" title="批量评估进度" extra={batch.running
        ? <Button onClick={stopBatch} disabled={batch.stopping}>{batch.stopping ? '正在停止排队任务' : '停止批量评估'}</Button>
        : <Button type="text" onClick={() => setBatch(null)}>关闭结果</Button>}>
        <Flex vertical gap={10}>
          <Flex justify="space-between" align="center" wrap gap={8}>
            <Typography.Text strong>
              {batch.running ? batch.stopping ? '正在停止等待，已运行任务继续完成' : '后台评估队列运行中'
                : batch.stopped ? '已停止本批等待' : '批量评估已完成'}
            </Typography.Text>
            <Typography.Text>已结束 {batch.completed} / {batch.total} 人 · 成功 {batch.success} 人（复用 {batch.reused} 人）· 失败 {batch.failed} 人 · 停止等待 {batch.cancelled} 人</Typography.Text>
          </Flex>
          <Progress percent={Math.round(batch.completed / batch.total * 100)}
            status={batch.running ? 'active' : batch.stopped ? 'normal' : batch.failed ? 'exception' : 'success'} />
          <Typography.Text role="status">等待提交 {batch.waiting} 人 · 正在提交 {batch.submitting} 人 · 排队中 {batch.queued} 人 · 正在评估 {batch.activeCount} 人</Typography.Text>
          <Typography.Text type="secondary">本次 {batch.total} 人（{batch.scopeLabel}）由后台统一排队。关闭或刷新页面不影响已提交任务，完成后刷新列表查看结果。停止只释放本批任务的等待，已运行任务会继续保存结果。</Typography.Text>
          {batch.tasks?.length > 0 && <Collapse size="small" items={[{key:'tasks', label:'查看每位候选人的任务状态',
            children:<Flex vertical gap={8}>{batch.tasks.map(task => <Flex key={task.id} vertical gap={3}>
              <Flex wrap gap={8} align="center"><Typography.Text>{task.name} · {aiTaskLabel(task)}</Typography.Text>
                <Button type="link" size="small" onClick={() => setDetailId(task.id)}>查看详情</Button></Flex>
              {(task.pollError || task.cancelError) && <Typography.Text type="warning">{task.cancelError || task.pollError}</Typography.Text>}
            </Flex>)}</Flex>}]} />}
          {batch.reason && <Alert type="warning" showIcon title={`后续评估已停止：${batch.reason}`} />}
          {batch.refreshFailed && <Alert type="warning" showIcon title="部分结果保存后的列表刷新失败，请刷新列表查看最新评估。" />}
          {batch.failures.length > 0 && <Collapse size="small" items={[{
            key: 'failures', label: `${batch.failures.length} 名候选人评估未完成，查看原因`,
            children: <Flex vertical gap={10}>{batch.failures.map(failure => <Flex key={failure.id} vertical gap={3}>
              <Flex align="center" gap={8}>
                <Typography.Text strong>{failure.name}</Typography.Text>
                <Button type="link" size="small" onClick={() => setDetailId(failure.id)}>查看详情</Button>
              </Flex>
              <Typography.Text type="danger">{failure.message}</Typography.Text>
            </Flex>)}</Flex>,
          }]} />}
        </Flex>
      </Card>}
      <Card className="candidate-table-card" title="候选人列表" extra={
        <Flex className="candidate-header-actions" gap={8} wrap>
          <Button type="primary" aria-label="批量评估" icon={<ThunderboltOutlined aria-hidden="true" />} loading={batchRunning}
            disabled={aiBusy || deletingNow || clearing} onClick={openBatchReview}>批量评估</Button>
          <Button icon={<ThunderboltOutlined aria-hidden="true" />} disabled={aiBusy || deletingNow || clearing}
            onClick={() => setDirectOpen(true)}>直接评估简历</Button>
          <Button loading={refreshing} onClick={refreshList}>刷新列表</Button>
          <Button danger loading={clearing} disabled={aiBusy || deletingNow || Boolean(exporting)}
            onClick={confirmClearEvaluations}>清空全部评估</Button>
          <Button disabled={aiBusy || deletingNow || clearing} onClick={addCandidate}>录入候选人</Button>
        </Flex>
      }>
        <div ref={tableRegion} className="candidate-table-region" data-candidate-layout={wideTable ? 'wide' : narrowTable ? 'narrow' : 'condensed'}>
        <div className="candidate-selection candidate-table-toolbar">
          <Flex vertical gap={4}>
            <Typography.Text type="secondary" role="status">
              共 {rows.length} 人 / 全部 {candidates.length} 人 · 当前 {rows.length ? pageStart + 1 : 0}–{Math.min(pageStart + pageSize, rows.length)} 人
              {' · '}已选 {selected.length} 人
              {otherPagesCount > 0 && `（${otherPagesCount} 人在其他页）`}
              {hiddenCount > 0 && `（${hiddenCount} 人在筛选结果外）`}
            </Typography.Text>
            <Typography.Text type="secondary">全选仅作用于当前页，翻页保留已选候选人。</Typography.Text>
          </Flex>
          <Flex className="candidate-table-tools" wrap align="center" gap={12}>
            <div className="candidate-sort-control">
              <label htmlFor="candidate-sort">排序</label>
              <Select id="candidate-sort" value={sort} options={sortOptions} onChange={changeSort} />
            </div>
            <Flex className="candidate-export-actions" wrap gap={8} role="group" aria-label="所选候选人操作">
              {filterCount > 0 && <Button onClick={clearFilters}>清除筛选（{filterCount}）</Button>}
              <Button onClick={()=>setColumnWidths(previous=>({ ...previous,[tableLayout]:{} }))}>重置列宽</Button>
              {selected.length > 0 && <Button disabled={deletingNow} onClick={() => setSelected([])}>清空已选</Button>}
              <Dropdown trigger={['click']} disabled={!selected.length || Boolean(exporting) || deletingNow || clearing}
                menu={{ items:[{ key:'csv', label:'导出名单 CSV' }, { key:'bundle', label:'导出履历与回访图片 ZIP' }],
                  onClick:({ key })=>exportRows(key) }}>
                <Button loading={Boolean(exporting)} disabled={!selected.length || Boolean(exporting) || deletingNow || clearing}>导出所选<DownOutlined /></Button>
              </Dropdown>
              <Button danger loading={deletingNow}
                disabled={!selected.length || deletingNow || Boolean(exporting) || aiBusy || clearing}
                onClick={() => confirmDelete(selected)}>删除所选</Button>
            </Flex>
          </Flex>
        </div>
        <Table className="candidate-table" tableLayout="fixed" rowKey="id" size="middle" dataSource={rows} columns={columns}
          components={{ header:{ cell:ResizableHeaderCell } }} scroll={{ x:tableContentWidth }}
          style={{ '--candidate-table-width':`${tableContentWidth}px` }}
          pagination={{
            current: currentPage, pageSize, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100],
            responsive: true, showLessItems: narrowTable,
            showQuickJumper: rows.length > pageSize,
            showTotal: (total, range) => `共 ${total} 人 · 第 ${range[0]}–${range[1]} 人`,
          }}
          locale={{ emptyText: emptyList }} showSorterTooltip={false}
          rowSelection={{
            columnWidth: 40,
            selectedRowKeys: selected, preserveSelectedRowKeys: true, onChange: setSelected,
            getCheckboxProps: c => ({ 'aria-label': `选择 ${c.name}`, disabled: deletingNow || clearing }),
            getTitleCheckboxProps: () => ({ 'aria-label': '选中当前页候选人', disabled: deletingNow || clearing }),
          }}
          onChange={(pagination, _, sorter, extra) => {
            if (extra.action === 'sort' && sorter.order) {
              changeSort(`${sorter.columnKey}-${sorter.order === 'ascend' ? 'asc' : 'desc'}`);
            } else if (extra.action === 'paginate') {
              setPageSize(pagination.pageSize);
              setPage(pagination.pageSize !== pageSize ? 1 : pagination.current);
            }
          }} />
        </div>
        <Typography.Paragraph type="secondary" style={{ margin: '12px 0 0' }}>
          公司、职位、城市和学历从简历自动提取，悬停可查看来源；可在“编辑资料”中修正。
        </Typography.Paragraph>
      </Card>
      {contactCandidate && <CandidateContactOptions candidate={contactCandidate} onClose={() => setContactTarget(null)} />}
      <Modal title="批量评估范围" open={batchScope !== null} onCancel={() => setBatchScope(null)}
        okText={`开始评估（${batchReviewTargets.length} 人）`} cancelText="取消" className="candidate-batch-modal"
        okButtonProps={{ disabled: !configured || !batchReviewTargets.length || aiBusy || deletingNow || clearing }}
        onOk={() => { if (batchScope) void evaluateSelected(batchTargets(batchScope), batchScopeLabels[batchScope]); }}>
        <Flex vertical gap={16}>
          <Typography.Text type="secondary">先确认范围，点击“开始评估”后才会调用模型。已评估且资料未变的候选人会复用有效结果。</Typography.Text>
          <Radio.Group value={batchScope} onChange={event => setBatchScope(event.target.value)} className="candidate-batch-scopes">
            <Radio value="pending"><strong>当前筛选内尚未评估及待重试</strong><span>{batchTargets('pending').length} 人 · 默认范围</span></Radio>
            <Radio value="selected" disabled={!selected.length}><strong>已选候选人</strong><span>{selected.length} 人 · 包含其他页及筛选外的已选人员</span></Radio>
            <Radio value="filtered"><strong>当前筛选全部候选人</strong><span>{rows.length} 人 · 包含已评估人员</span></Radio>
          </Radio.Group>
          <div className="candidate-batch-summary" role="status">
            <Typography.Text strong>本次评估 {batchReviewTargets.length} 人</Typography.Text>
            <Flex gap={6} wrap className="candidate-batch-jobs">
              {[...batchJobCounts].map(([jobId, count]) => <Tag key={jobId}>{jobNames.get(jobId) || '未关联岗位'} · {count} 人</Tag>)}
              {!batchReviewTargets.length && <Typography.Text type="secondary">此范围内暂无候选人，可切换范围或调整筛选。</Typography.Text>}
            </Flex>
          </div>
          <Typography.Text type="secondary">按开始时的名单提交后台队列，并发数量由模型服务配置控制；可以停止尚未运行的本批任务，已完成结果会保留。</Typography.Text>
          {!configured && <Alert type="warning" showIcon title="请先在连接与集成中保存可用的模型服务配置。" />}
        </Flex>
      </Modal>
      {active && directOpen && <DirectResumeEvaluation jobs={jobs} defaultJobId={filters.job}
        configured={configured} api={api} refresh={refresh}
        onBusyChange={setDirectBusy} onClose={() => setDirectOpen(false)} />}
      {active && editor && <CandidateForm key={editor.candidate?.id ?? 'new'} candidate={editor.candidate}
        defaultJobId={filters.job} jobs={jobs} api={api} refresh={refresh} notify={notify}
        disabled={deletingNow || aiBusy || clearing}
        isBusy={() => evaluating.current !== null || batchControl.current !== null || deleting.current || clearingRef.current}
        onClose={() => closeEditor()} onSaved={closeEditor} />}
      {active && !editor && detail && <CandidateDetail key={detail.id} candidate={detail} jobTitle={jobNames.get(detail.job_id)}
        onClose={() => setDetailId(current => current === detail.id ? null : current)} api={api} refresh={refresh}
        onEdit={() => openEdit(detail)} editDisabled={deletingNow || aiBusy || clearing}
        notify={notify} extensionId={state.extension_id} evaluateButton={evaluationButton(detail, 'middle')}
        evaluation={candidateEvaluationFeedback(detail)} />}
    </Flex>
  );
}
