import React, { useEffect, useRef, useState } from 'react';
import { Alert, Col, Divider, Flex, Form, Input, Modal, Row, Select, Typography } from 'antd';
import { ProfileSourceTag } from './CandidateDetail';

const textFields = [
  'name', 'phone', 'email', 'link', 'wechat', 'company', 'title', 'city', 'education', 'skills', 'resume', 'note',
];
const evaluationFields = ['resume', 'company', 'title', 'city', 'education', 'skills'];
const automaticFields = ['company', 'title', 'city', 'education', 'skills'];

export default function CandidateForm({
  jobs, candidate, defaultJobId, api, refresh, notify, onClose, onSaved, disabled = false, isBusy,
}) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [materialChange, setMaterialChange] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractMessage, setExtractMessage] = useState('');
  const [extractError, setExtractError] = useState('');
  const [profileSources, setProfileSources] = useState(candidate?.profile_sources || {});
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const extractionId = useRef(0);
  const lastExtractedResume = useRef('');
  const manualFields = useRef(new Set());
  const automatic = useRef(new Set(automaticFields.filter(field => candidate?.profile_sources?.[field]?.source === 'resume')));
  const editing = Boolean(candidate);
  const initialValues = {
    ...Object.fromEntries(textFields.map(field => [field, candidate?.[field] || ''])),
    job_id: candidate?.job_id ?? defaultJobId ?? jobs[0]?.id,
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; extractionId.current += 1; };
  }, []);

  function updateMaterialChange(values) {
    setMaterialChange(editing && (values.job_id !== candidate.job_id || evaluationFields.some(field =>
      (values[field] || '').trim() !== (candidate[field] || '').trim())));
  }

  function valuesChanged(changes, values) {
    if ('resume' in changes) {
      extractionId.current += 1;
      lastExtractedResume.current = '';
      setExtracting(false);
      setExtractMessage('');
      setExtractError('');
    }
    const changedProfile = automaticFields.filter(field => field in changes);
    if (changedProfile.length) {
      for (const field of changedProfile) {
        manualFields.current.add(field);
        automatic.current.delete(field);
      }
      setProfileSources(previous => ({ ...previous,
        ...Object.fromEntries(changedProfile.map(field => [field, { source: 'manual' }])),
      }));
    }
    updateMaterialChange(values);
  }

  async function fillFromResume() {
    const resume = form.getFieldValue('resume') || '';
    const fillable = automaticFields.filter(field => !manualFields.current.has(field) &&
      candidate?.profile_sources?.[field]?.source !== 'manual' && !(form.getFieldValue(field) || '').trim());
    if (!resume.trim() || !fillable.length || savingRef.current || disabled || isBusy?.() ||
        lastExtractedResume.current === resume) return;
    const requestId = ++extractionId.current;
    lastExtractedResume.current = resume;
    setExtracting(true);
    setExtractError('');
    try {
      const response = await api('/api/candidates/extract-profile', { resume });
      const result = await response.json();
      if (!mounted.current || extractionId.current !== requestId || savingRef.current ||
          form.getFieldValue('resume') !== resume) return;
      const updates = {};
      for (const field of fillable) {
        const value = result.profile?.[field];
        if (typeof value === 'string' && value.trim() && !manualFields.current.has(field) &&
            !(form.getFieldValue(field) || '').trim()) {
          updates[field] = value;
          automatic.current.add(field);
        }
      }
      form.setFieldsValue(updates);
      setProfileSources(previous => ({ ...previous,
        ...Object.fromEntries(Object.keys(updates).map(field => [field,
          { source: 'resume', evidence: result.profile_sources?.[field]?.evidence || '' }])),
      }));
      updateMaterialChange(form.getFieldsValue());
      setExtractMessage(Object.keys(updates).length
        ? `已从简历补全 ${Object.keys(updates).length} 项空白信息，可直接保存或修正。`
        : '简历中未识别到其他可靠信息，已保留空白。');
    } catch (error) {
      if (mounted.current && extractionId.current === requestId) {
        lastExtractedResume.current = '';
        setExtractError(error.message);
      }
    } finally {
      if (mounted.current && extractionId.current === requestId) setExtracting(false);
    }
  }

  function profileLabel(field, label) {
    return <Flex align="center" gap={8}>
      <span>{label}</span><ProfileSourceTag meta={profileSources[field]} value={form.getFieldValue(field)} />
    </Flex>;
  }

  async function save(values) {
    if (savingRef.current) return;
    if (disabled || isBusy?.()) {
      notify('请等待当前操作结束后再保存候选人资料。', true);
      return;
    }
    savingRef.current = true;
    extractionId.current += 1;
    setExtracting(false);
    setSaving(true);
    setSaveError('');
    try {
      const payload = {
        ...Object.fromEntries(textFields.map(field => [field, values[field] || ''])),
        job_id: values.job_id,
        profile_auto_fields: [...automatic.current],
        profile_manual_fields: [...manualFields.current],
        ...(editing ? { id: candidate.id, revision: candidate.revision ?? 0 } : {}),
      };
      const response = await api(editing ? '/api/candidates/update' : '/api/candidates', payload);
      const result = await response.json();
      let refreshFailed = false;
      try {
        await refresh();
      } catch {
        refreshFailed = true;
      }
      onSaved?.({ ...result, refreshFailed });
      if (refreshFailed) {
        notify('候选人资料已保存，列表刷新失败，请点击“刷新列表”查看。', true);
      } else if (result.evaluation_invalidated) {
        notify('候选人资料已保存，已标记待重评，历史评估保留。');
      } else {
        notify(editing ? result.changed === false ? '候选人资料没有变化。' : '候选人资料已保存。' : '候选人已保存。');
      }
    } catch (error) {
      setSaveError(error.message);
      notify(error.message, true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Modal title={editing ? '编辑候选人资料' : '录入候选人'} open width={860}
      okText={editing ? '保存资料' : '保存候选人'} onOk={() => form.submit()}
      onCancel={() => { if (!savingRef.current) onClose(); }} confirmLoading={saving}
      okButtonProps={{ disabled }} cancelButtonProps={{ disabled: saving }} keyboard={!saving}
      mask={{ closable: !saving }} closable={{ disabled: saving }} destroyOnHidden
      styles={{ body: { maxHeight: '72vh', overflowY: 'auto', paddingRight: 8 } }}>
      <Form form={form} layout="vertical" initialValues={initialValues} onFinish={save}
        disabled={saving || disabled} scrollToFirstError
        onValuesChange={valuesChanged}>
        <Typography.Paragraph type="secondary">
          公司、职位、城市、学历和技能会从简历自动提取，无需逐项填写；保存时自动补全空字段，人工修改和留空会保留。
        </Typography.Paragraph>
        {editing && <Typography.Paragraph type="secondary">
          岗位、履历、公司、职位、城市、学历和技能用于 AI 匹配；修改后将标记待重评，并保留历史评估。
        </Typography.Paragraph>}
        {saveError && <Alert type="error" showIcon title={saveError} style={{ marginBottom: 16 }} />}
        {disabled && <Alert type="info" showIcon title="当前操作尚未结束，请稍后保存。" style={{ marginBottom: 16 }} />}
        <Row gutter={16}>
          <Col xs={24} sm={12}>
            <Form.Item label="关联岗位" name="job_id" rules={[{ required: true, message: '请选择关联岗位' }]}>
              <Select showSearch optionFilterProp="label"
                options={jobs.map(job => ({ value: job.id, label: job.title }))} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item label="候选人姓名" name="name"
              rules={[{ required: true, whitespace: true, message: '请输入候选人姓名' }]}>
              <Input maxLength={150} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item label={profileLabel('company', '最近公司')} name="company"><Input maxLength={200} placeholder="从简历自动提取，可修正" /></Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item label={profileLabel('title', '最近职位')} name="title"><Input maxLength={200} placeholder="从简历自动提取，可修正" /></Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item label={profileLabel('city', '城市')} name="city"><Input maxLength={100} placeholder="简历注明的所在地或期望城市" /></Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item label={profileLabel('education', '学历')} name="education"><Input maxLength={200} placeholder="从简历自动提取，可修正" /></Form.Item>
          </Col>
        </Row>
        <Form.Item label={profileLabel('skills', '技能标签')} name="skills">
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} maxLength={4000} placeholder="从简历自动提取，也可用逗号、顿号或换行修正" />
        </Form.Item>
        <Divider titlePlacement="start">联系方式</Divider>
        <Row gutter={16}>
          <Col xs={24} sm={12}>
            <Form.Item label="手机号" name="phone"><Input maxLength={100} /></Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item label="微信" name="wechat"><Input maxLength={100} /></Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item label="邮箱" name="email" rules={[{ type: 'email', message: '请输入有效的邮箱' }]}>
              <Input type="email" maxLength={200} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item label="平台内联系入口" name="link"
              rules={[{ pattern: /^https:\/\/\S+$/i, message: '请输入 HTTPS 链接' }]}>
              <Input maxLength={2000} placeholder="https://…" />
            </Form.Item>
          </Col>
        </Row>
        <Divider titlePlacement="start">履历与备注</Divider>
        <Form.Item label="履历资料" name="resume"
          rules={[{ required: true, whitespace: true, message: '请输入履历资料' }]}
          extra={materialChange ? '保存后将标记待重评，历史 AI 评估保留。' : undefined}>
          <Input.TextArea rows={9} maxLength={30000} onBlur={fillFromResume}
            placeholder="粘贴简历后，离开输入框会自动补全上方空白信息；保存时也会自动提取" />
        </Form.Item>
        {extracting && <Typography.Paragraph type="secondary" role="status">正在从简历补全空白信息…</Typography.Paragraph>}
        {!extracting && extractMessage && <Typography.Paragraph type="secondary" role="status">{extractMessage}</Typography.Paragraph>}
        {extractError && <Alert type="warning" showIcon title="自动补全暂未完成" description={extractError} style={{ marginBottom: 16 }} />}
        <Form.Item label="备注" name="note">
          <Input.TextArea rows={3} maxLength={4000} placeholder="记录待确认事项或补充说明" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
