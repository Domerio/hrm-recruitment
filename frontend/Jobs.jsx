import React, { useEffect, useRef, useState } from 'react';
import { ArrowRightOutlined, EditOutlined, FileTextOutlined, SearchOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Col, Empty, Flex, Form, Input, Row, Table, Tag, Typography, Upload } from 'antd';
import PriorityEditor, { jobRequirements, prepareJobRequirements, PrioritySummary, reconcilePriorityGroups } from './PriorityEditor';
import PlatformSearchConditions, { PlatformSearchSummary } from './PlatformSearchConditions';
import {defaultSearchConditions,prepareSearchConditions,validateSearchConditions} from './platform-search-conditions.mjs';

const { Paragraph, Text } = Typography;
const required = message => [{ required: true, whitespace: true, message }];
const titleOrder = new Intl.Collator('zh-CN-u-co-pinyin', { numeric: true });
const mustHaveLines = value => String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const mustHaveText = value => mustHaveLines(value).join('\n');
const jobValues = job => ({
  title: job.title || '', city: job.city || '', jd: job.jd || '',
  ...prepareJobRequirements(job),
  search_conditions: prepareSearchConditions(job.search_conditions),
});
const mustHaveRule = {
  validator: (_, value) => {
    const lines = mustHaveLines(value);
    if (String(value || '').length > 12000) return Promise.reject(new Error('必备条件总长度不能超过 12000 字。'));
    if (lines.length > 100) return Promise.reject(new Error('岗位要求最多 100 条。'));
    return Promise.resolve();
  },
};

async function encodeFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export default function Jobs({ state, refresh, api, notify, onViewCandidates }) {
  const [form] = Form.useForm();
  const [pending, setPending] = useState(null);
  const busy = useRef(false);
  const [editing, setEditing] = useState(null);
  const [fileName, setFileName] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const jd = Form.useWatch('jd', form);
  const criteria = Form.useWatch('criteria', form);
  const mustHave = Form.useWatch('must_have', form);
  const priorities = Form.useWatch('priority_groups', form);
  const requirements = jobRequirements(form.getFieldValue('criteria'), form.getFieldValue('must_have'));
  const selectedMust = requirements.filter(item => item.required).map(item => item.text).join('\n');
  useEffect(() => {
    if ((form.getFieldValue('must_have') || '') !== selectedMust) form.setFieldValue('must_have', selectedMust);
  }, [form, selectedMust]);
  const query = search.trim().toLowerCase();
  const savedJobs = state.jobs.filter(job =>
    !query || [job.title, job.city, job.jd, job.criteria, job.must_have].join(' ').toLowerCase().includes(query));
  const candidateCounts = new Map();
  for (const candidate of state.candidates) {
    candidateCounts.set(candidate.job_id, (candidateCounts.get(candidate.job_id) || 0) + 1);
  }
  const candidateCount = job => candidateCounts.get(job.id) || 0;
  const currentPage = Math.min(page, Math.max(1, Math.ceil(savedJobs.length / pageSize)));
  const priorityChanged = editing && JSON.stringify(reconcilePriorityGroups(form.getFieldValue('priority_groups') ?? priorities, requirements)) !==
    JSON.stringify(reconcilePriorityGroups(editing.priority_groups, jobRequirements(editing.criteria, editing.must_have)));
  const changesEvaluation = editing && (
    String(jd || '').trim() !== editing.jd.trim() ||
    String(criteria || '').trim() !== editing.criteria.trim() ||
    mustHaveText(mustHave) !== mustHaveText(editing.must_have) || priorityChanged
  );
  const savedRevision = state.jobs.find(job => job.id === editing?.id)?.revision ?? 0;
  const outdated = editing && savedRevision !== editing.revision;
  const priorityRule = {
    validator: (_, value) => {
      const items = jobRequirements(form.getFieldValue('criteria'), form.getFieldValue('must_have'));
      if (!items.length) return Promise.reject(new Error('请先填写至少一条有效岗位要求。'));
      if (value !== undefined && (!Array.isArray(value) ||
          value.some(group => !Array.isArray(group) || group.some(text => typeof text !== 'string')))) {
        return Promise.reject(new Error('请重新确认岗位要求的优先级分组。'));
      }
      return mustHaveRule.validator(_, form.getFieldValue('must_have'));
    },
  };

  function searchJobs(value) {
    setSearch(value);
    setPage(1);
  }

  function editJob(job) {
    if (busy.current) return;
    const values = jobValues(job);
    setEditing({ id: job.id, revision: job.revision ?? 0, priority_configured: Boolean(job.priority_configured), ...values });
    form.resetFields();
    form.setFieldsValue(values);
    setFileName('');
    form.scrollToField('title', { focus: true });
  }

  function createJob() {
    if (busy.current) return;
    setEditing(null);
    form.resetFields();
    setFileName('');
    form.scrollToField('title', { focus: true });
  }

  function setRequired(key, checked) {
    if (busy.current) return;
    const current = jobRequirements(form.getFieldValue('criteria'), form.getFieldValue('must_have'));
    form.setFieldValue('must_have', current.filter(item => item.key === key ? checked : item.required)
      .map(item => item.text).join('\n'));
  }

  const columns = [
    {
      title: '岗位 / 地点', key: 'title', width: 190,
      sorter: (a, b) => titleOrder.compare(a.title, b.title),
      render: (_, job) => (
        <Flex vertical gap={2}>
          <Text strong className="jobs-table-title">{job.title}</Text>
          <Text type="secondary" className="jobs-table-location">{job.city || '地点未填写'}</Text>
        </Flex>
      ),
    },
    {
      title: '候选人数', key: 'candidates', width: 116,
      sorter: (a, b) => candidateCount(a) - candidateCount(b) || a.id - b.id,
      render: (_, job) => <Tag color={candidateCount(job) ? 'cyan' : 'default'}>{candidateCount(job)} 位候选人</Tag>,
    },
    {
      title: '操作', key: 'actions', width: 174,
      render: (_, job) => (
        <Flex gap={10} wrap>
          <Button size="small" type="link" disabled={pending !== null} onClick={() => editJob(job)}
            icon={<EditOutlined aria-hidden="true" />} aria-label={'编辑岗位 ' + job.title}>编辑</Button>
          <Button size="small" type="link" disabled={pending !== null} onClick={() => onViewCandidates?.(job.id)}
            icon={<ArrowRightOutlined aria-hidden="true" />} iconPlacement="end">
            查看候选人
          </Button>
        </Flex>
      ),
    },
  ];

  async function run(action, work) {
    if (busy.current) return;
    busy.current = true;
    setPending(action);
    try {
      await work();
    } catch (error) {
      notify(error.message, true);
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  function importFile(file) {
    void run('import', async () => {
      if (!/\.(docx|txt)$/i.test(file.name)) throw new Error('支持 DOCX 和 UTF-8 TXT 文件，PDF 可复制文本后粘贴。');
      if (file.size > 2_000_000) throw new Error('文件不能超过 2 MB。');
      const response = await api('/api/extract', { name: file.name, content: await encodeFile(file) });
      const { text } = await response.json();
      form.setFieldValue('jd', text);
      setFileName(file.name);
      notify('文档已读取，请检查岗位 JD。');
    });
    return Upload.LIST_IGNORE;
  }

  function draftCriteria() {
    const jd = form.getFieldValue('jd')?.trim();
    if (!jd) {
      notify('请先填写或上传岗位 JD。', true);
      form.scrollToField('jd', { focus: true });
      return;
    }
    return run('draft', async () => {
      const response = await api('/api/ai/criteria', { jd });
      const { criteria } = await response.json();
      form.setFieldValue('criteria', criteria);
      notify('AI 条件草稿已生成，请确认后保存。');
    });
  }

  function saveJob(values) {
    return run('save', async () => {
      const items = jobRequirements(values.criteria, values.must_have);
      const payload = { ...values, must_have: items.filter(item => item.required).map(item => item.text).join('\n'),
        requirements_mode:'selected', priority_groups:reconcilePriorityGroups(values.priority_groups, items),
        search_conditions:validateSearchConditions(values.search_conditions) };
      const response = await api(editing ? '/api/jobs/update' : '/api/jobs', editing
        ? { ...payload, id: editing.id, revision: editing.revision } : payload);
      const result = await response.json();
      if (result.ok !== true) throw new Error('服务端没有确认保存岗位，请重试。');
      const message = editing && result.changed === false ? '岗位内容没有变化。'
        : result.pending_candidates > 0
          ? '岗位已更新，' + result.pending_candidates + ' 位候选人已标记为待重新评估。'
          : editing ? '岗位已更新。' : '岗位已保存，可开始录入候选人。';
      setEditing(null);
      form.resetFields();
      setFileName('');
      try {
        await refresh();
        notify(message);
      } catch {
        notify('岗位已保存，列表刷新失败，请刷新工作台查看。', true);
      }
    });
  }

  return (
    <div className="jobs-workspace">
        <Card className="jobs-create-card" title={editing ? '编辑岗位配置' : '创建岗位配置'}
          extra={editing && <Button size="small" disabled={pending !== null} onClick={createJob}>取消编辑 / 新建</Button>}>
          <Paragraph type="secondary">{editing
            ? '正在编辑配置 #' + editing.id + '。修改后保存即可应用新的岗位要求。'
            : '导入或填写岗位 JD，在统一岗位要求中勾选必备条件并调整优先级。'}</Paragraph>
          <Form name="job-config" form={form} layout="vertical" onFinish={saveJob} disabled={pending !== null}
            initialValues={{search_conditions:defaultSearchConditions()}}>
            <Row gutter={12}>
              <Col xs={24} sm={12}>
                <Form.Item name="title" label="岗位名称" rules={required('请输入岗位名称。')}>
                  <Input maxLength={150} placeholder="例如：视觉工程师" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item name="city" label="工作地点">
                  <Input maxLength={150} placeholder="例如：上海" />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item name="search_conditions" rules={[{validator:async (_,value) => {validateSearchConditions(value);}}]}>
              <PlatformSearchConditions disabled={pending !== null}/>
            </Form.Item>
            <Form.Item label="上传岗位文档">
              <Upload.Dragger accept=".docx,.txt" beforeUpload={importFile} showUploadList={false}
                disabled={pending !== null} aria-label="上传岗位文档">
                <p className="ant-upload-drag-icon"><FileTextOutlined /></p>
                <p className="ant-upload-text">{pending === 'import' ? '正在读取文档…' : '点击或拖入岗位文档'}</p>
                <p className="ant-upload-hint">支持 DOCX、UTF-8 TXT，最大 2 MB。PDF 可复制文本后粘贴。</p>
              </Upload.Dragger>
              {fileName && <Text type="secondary">已导入 {fileName}</Text>}
            </Form.Item>
            <Form.Item name="jd" label="岗位 JD" rules={required('请输入或导入岗位 JD。')}>
              <Input.TextArea rows={6} maxLength={30000} placeholder="粘贴岗位职责和任职要求" />
            </Form.Item>
            <Form.Item name="must_have" hidden><Input type="hidden" /></Form.Item>
            <Flex justify="end">
              <Button htmlType="button" size="small" loading={pending === 'draft'} onClick={draftCriteria}>AI 提取岗位要求</Button>
            </Flex>
            <Form.Item name="criteria" label="岗位要求" rules={required('请填写岗位要求。')}
              extra="每行一条要求，可使用数字编号；在下方逐项勾选必备。">
              <Input.TextArea rows={7} maxLength={12000} placeholder={'1. 4 年以上图像处理相关工作经历\n2. 熟悉 C++ 和 OpenCV\n3. 具有一定光学知识'} />
            </Form.Item>
            <Form.Item name="priority_groups" label="要求优先级" rules={[priorityRule]}>
              <PriorityEditor key={editing ? `${editing.id}:${editing.revision}:${editing.priority_configured}` : 'new'}
                requirements={requirements} configured={editing?.priority_configured}
                onRequiredChange={setRequired} disabled={pending !== null} />
            </Form.Item>
            <Flex vertical gap={12} align="start">
              {outdated && <Alert type="warning" showIcon title="该岗位已有新版本，重新点击编辑可载入最新配置。" />}
              {changesEvaluation && candidateCount(editing) > 0 && (
                <Alert type="warning" showIcon title={'保存新的评估要求后，' + candidateCount(editing) + ' 位关联候选人需要重新评估。'} />
              )}
              <Button type="primary" htmlType="submit" loading={pending === 'save'}
                aria-label={editing ? '保存修改' : '保存岗位'}>{editing ? '保存修改' : '保存岗位'}</Button>
            </Flex>
          </Form>
        </Card>
      <section className="jobs-saved-column" aria-label="已保存岗位">
        <Card className="jobs-saved-card" title="已保存岗位"
          extra={<Flex align="center" gap={8}><Tag>{state.jobs.length} 个岗位</Tag>
            <Button size="small" disabled={pending !== null && pending !== 'refresh'} loading={pending === 'refresh'}
              onClick={() => run('refresh', refresh)}>刷新岗位</Button></Flex>}>
          <div className="jobs-saved-toolbar">
            <Input value={search} onChange={event => searchJobs(event.target.value)} allowClear
              prefix={<SearchOutlined aria-hidden="true" />} aria-label="搜索已保存岗位"
              placeholder="搜索岗位、地点、JD 或条件" />
            <Text type="secondary" role="status" aria-live="polite">
              显示 {savedJobs.length} / {state.jobs.length} 个岗位
            </Text>
          </div>
          <div className="jobs-saved-list" tabIndex={0} role="region" aria-label="岗位列表">
            <Table className="jobs-table" rowKey="id" size="small" dataSource={savedJobs} columns={columns}
              scroll={{ x: 530 }} showSorterTooltip={false}
              pagination={{
                current: currentPage, pageSize, size: 'small', hideOnSinglePage: savedJobs.length <= 10,
                showSizeChanger: true, pageSizeOptions: [10, 20, 50],
                onChange: (nextPage, nextSize) => { setPage(nextPage); setPageSize(nextSize); },
              }}
              expandable={{
                columnTitle: '配置', columnWidth: 49,
                expandedRowRender: job => (
                  <div className="jobs-table-config">
                    <Text type="secondary">岗位配置 #{job.id} · 版本 {job.revision ?? 0}</Text>
                    <h3>岗位 JD</h3>
                    <Paragraph className="job-criteria">{job.jd || '未填写岗位 JD'}</Paragraph>
                    <h3>要求优先级</h3>
                    <PrioritySummary job={job} />
                    <h3>平台查询条件</h3>
                    <PlatformSearchSummary value={job.search_conditions}/>
                  </div>
                ),
              }}
              locale={{ emptyText: (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={state.jobs.length ? '没有符合搜索条件的岗位' : '暂无岗位配置'}>
                  {state.jobs.length > 0 && <Button onClick={() => searchJobs('')}>清除搜索</Button>}
                </Empty>
              ) }} />
          </div>
        </Card>
      </section>
    </div>
  );
}
