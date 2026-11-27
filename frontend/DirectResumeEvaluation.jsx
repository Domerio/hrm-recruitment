import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Col, Flex, Input, Modal, Row, Select, Statistic, Typography, Upload } from 'antd';
import { EvaluationSummary, EvaluationTag } from './CandidateDetail';
import { isRuleRejected } from '../extension/evaluation-result.mjs';

async function encodeFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function suggestedName(value) {
  const sections = new Set(['个人优势','个人简介','期望职位','工作经历','项目经历','教育经历','资格证书','专业技能','所获荣誉','语言能力']);
  for (const raw of String(value || '').split(/\r?\n/).slice(0, 8)) {
    const line = raw.trim().replace(/\s+(?:热搜|已收藏|在线|刚刚活跃|今日活跃)\s*$/g, '');
    if (!line || sections.has(line)) continue;
    if (/^(?:[\u3400-\u9fff·]{2,15}|[\u3400-\u9fff·]{1,14}\*{1,2})$/.test(line) ||
        /^[A-Za-z][A-Za-z .'-]{1,79}$/.test(line)) return line;
  }
  return '';
}

export default function DirectResumeEvaluation({ jobs, defaultJobId, configured, api, refresh, onClose, onBusyChange }) {
  const [jobId, setJobId] = useState(() => jobs.some(job => job.id === defaultJobId)
    ? defaultJobId : jobs.length === 1 ? jobs[0].id : undefined);
  const [candidateName, setCandidateName] = useState('');
  const [resume, setResume] = useState('');
  const [fileName, setFileName] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [running, setRunning] = useState(false);
  const [response, setResponse] = useState(null);
  const [error, setError] = useState('');
  const request = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(true);
  const selectedJob = jobs.find(job => job.id === jobId);
  const jobVersion = selectedJob ? JSON.stringify(selectedJob) : '';
  const busy = running || extracting;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current += 1;
      onBusyChange?.(false);
    };
  }, [onBusyChange]);
  useEffect(() => {
    // A refreshed or changed job cannot inherit a result for older requirements.
    request.current += 1;
    setResponse(null);
    setError('');
  }, [jobVersion]);

  function changeResume(value) {
    request.current += 1;
    setResume(value);
    if (!candidateName.trim()) setCandidateName(suggestedName(value));
    setResponse(null);
    setError('');
    setUploadError('');
  }
  function changeJob(value) {
    request.current += 1;
    setJobId(value);
    setResponse(null);
    setError('');
  }
  function changeName(value) {
    request.current += 1;
    setCandidateName(value);
    setResponse(null);
    setError('');
  }
  function close() {
    request.current += 1;
    onClose();
  }
  function importFile(file) {
    const id = ++request.current;
    setResponse(null);
    setError('');
    setUploadError('');
    setFileName('');
    if (!/\.(pdf|docx|txt|png|jpe?g|webp)$/i.test(file.name)) {
      setUploadError('支持 PDF、DOCX、UTF-8 TXT、PNG、JPG、JPEG 和 WEBP 文件。');
      return Upload.LIST_IGNORE;
    }
    if (file.size > 5_000_000) {
      setUploadError('文件不能超过 5 MB。');
      return Upload.LIST_IGNORE;
    }
    setExtracting(true);
    onBusyChange?.(true);
    void (async () => {
      try {
        const result = await api('/api/resume/extract', { name: file.name, content: await encodeFile(file) });
        const body = await result.json();
        if (mounted.current && request.current === id) {
          setResume(body.text);
          if (!candidateName.trim()) setCandidateName(suggestedName(body.text));
          setFileName(file.name);
        }
      } catch (failure) {
        if (mounted.current && request.current === id) setUploadError(failure.message);
      } finally {
        if (mounted.current) {
          setExtracting(false);
          onBusyChange?.(false);
        }
      }
    })();
    return Upload.LIST_IGNORE;
  }
  async function evaluate() {
    if (pending.current || !selectedJob || !configured) return;
    if (!candidateName.trim()) {
      setError('请输入候选人姓名，用于写入名单和识别重复记录。');
      return;
    }
    if (resume.trim().length < 40) {
      setError('请粘贴完整履历，至少 40 个字符。');
      return;
    }
    const id = ++request.current;
    pending.current = true;
    setRunning(true);
    setResponse(null);
    setError('');
    onBusyChange?.(true);
    try {
      const result = await api('/api/ai/direct-resume', { job_id: jobId, name: candidateName.trim(), resume });
      const body = await result.json();
      let refreshFailed = false;
      try {
        await refresh?.();
      } catch {
        refreshFailed = true;
      }
      if (mounted.current && request.current === id) setResponse({ ...body, refreshFailed });
    } catch (failure) {
      if (mounted.current && request.current === id) setError(failure.message);
    } finally {
      pending.current = false;
      if (mounted.current) {
        setRunning(false);
        onBusyChange?.(false);
      }
    }
  }

  return <Modal open title="直接评估简历" width={1180} footer={null} onCancel={close}
    maskClosable={false} styles={{ body: { maxHeight: '76vh', overflowY: 'auto' } }}>
    <Flex vertical gap={16}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        选择岗位后，可粘贴完整履历，也可上传图片或文档。图片由本机 OCR 识别；点击评估后，
        先核对能由原文明确定论的硬条件；不达标时直接展示依据且不调用模型，其余履历文字与岗位要求会发送给当前配置的 AI 模型。
        评估成功后会写入候选人名单与评估历史，并标记为“直接评估”；相同岗位、姓名和履历会复用已有记录。
      </Typography.Paragraph>
      {!configured && <Alert type="warning" showIcon title="请先在连接与集成中保存可用的模型服务配置。" />}
      {!jobs.length && <Alert type="info" showIcon title="请先在岗位管理中添加岗位与评估要求。" />}
      <Row gutter={[24, 20]} style={{ margin: 0 }}>
        <Col xs={24} lg={10}>
          <Flex vertical gap={12}>
            <label htmlFor="direct-resume-job">匹配岗位</label>
            <Select id="direct-resume-job" aria-label="匹配岗位" value={jobId} onChange={changeJob}
              disabled={busy} placeholder="选择用于评估的岗位"
              options={jobs.map(job => ({ value: job.id, label: job.title }))} />
            <label htmlFor="direct-resume-name">候选人姓名</label>
            <Input id="direct-resume-name" aria-label="候选人姓名" value={candidateName}
              onChange={event => changeName(event.target.value)} disabled={busy} maxLength={150}
              placeholder="用于候选名单和重复记录识别" />
            <label>上传简历</label>
            <Upload.Dragger className="direct-resume-upload"
              accept=".pdf,.docx,.txt,.png,.jpg,.jpeg,.webp" beforeUpload={importFile}
              showUploadList={false} disabled={busy} aria-label="上传简历图片或文档">
              <p className="ant-upload-text">{extracting ? '正在读取简历…' : '点击或拖入简历图片 / 文档'}</p>
              <p className="ant-upload-hint">支持 PDF、DOCX、TXT、PNG、JPG、WEBP，最大 5 MB</p>
            </Upload.Dragger>
            {fileName && <Typography.Text type="success">已读取 {fileName}，请检查下方文字。</Typography.Text>}
            {uploadError && <Alert type="error" showIcon title="简历读取失败" description={uploadError} />}
            <label htmlFor="direct-resume-text">履历原文</label>
            <Input.TextArea id="direct-resume-text" aria-label="履历原文" value={resume}
              onChange={event => changeResume(event.target.value)} disabled={busy}
              rows={12} maxLength={30000} showCount placeholder="粘贴完整履历，或上传文件后在这里检查和修改识别文字" />
            <Flex gap={8} wrap style={{ marginTop: 10 }}>
              <Button type="primary" loading={running}
                disabled={extracting || !configured || !selectedJob || !candidateName.trim() || !resume.trim()}
                onClick={evaluate}>{response ? '重新评估' : error ? '重试评估' : '开始评估'}</Button>
              <Button onClick={close}>关闭</Button>
            </Flex>
            <Typography.Text type="secondary">成功结果会保存在候选名单；AI 结论仍需人工核对。</Typography.Text>
          </Flex>
        </Col>
        <Col xs={24} lg={14}>
          <Flex vertical gap={16}>
            {running && <Alert type="info" showIcon title="正在评估并核对原文依据…" />}
            {error && <Alert type="error" showIcon title="评估未完成"
              description={<>{error}<br />原文保留在左侧，可修改后重试。</>} />}
            {response ? <>
              <Alert type="success" showIcon title={response.candidate?.added ? '已写入候选名单' : '已更新候选人评估'}
                description={`候选人：${response.candidate?.name || candidateName} · 记录 #${response.candidate?.id}`}/>
              {response.refreshFailed && <Alert type="warning" showIcon title="评估已保存，但名单刷新失败，请关闭后刷新列表。" />}
              <Flex align="center" gap={16} wrap>
                {!isRuleRejected(response.result) && <><Statistic title="匹配度" value={response.result.score} suffix="分" />
                  <EvaluationTag category={response.result.category} /></>}
                <Typography.Text type="secondary">{response.job.title}{!isRuleRejected(response.result) && <> · {response.model}</>}</Typography.Text>
              </Flex>
              <EvaluationSummary result={response.result} />
            </> : !running && !error && <Typography.Paragraph type="secondary">
              评估完成后，这里显示评分、岗位条件的逐项原文依据和待确认问题。
            </Typography.Paragraph>}
          </Flex>
        </Col>
      </Row>
    </Flex>
  </Modal>;
}
