import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DownloadOutlined, PaperClipOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Collapse, Empty, Input, Select, Space, Spin, Tag, Typography, Upload } from 'antd';
import './communications.css';
import ChatResumeSources from './ChatResumeSources.jsx';
import { bossChatUrl } from './boss-chat-link.mjs';

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const directionLabels = { incoming: '候选人', outgoing: '我方', system: '系统' };

function displayTime(value) {
  if (!value) return '时间未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 100) : date.toLocaleString('zh-CN');
}

function fileContent(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取附件，请重新选择文件。'));
    reader.onabort = () => reject(new Error('附件读取已中断。'));
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.includes(',')) {
        reject(new Error('附件读取结果无效。'));
        return;
      }
      resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

function Attachment({ message, busy, onImport }) {
  const received = message.direction === 'incoming' && message.attachment_status === 'received';
  const attachment = message.attachment;
  const incomingStateLabel = {
    pending: '接收状态待确认', expired: '附件已过期', received: '已收到',
  }[message.attachment_status] || '接收状态待确认';
  const stateLabel = message.direction === 'incoming' ? incomingStateLabel : '我方附件';

  return (
    <div className="communication-attachment">
      <Space wrap size={6}>
        <PaperClipOutlined aria-hidden="true" />
        <strong>{message.attachment_name || attachment?.name || '附件简历'}</strong>
        <Tag color={received ? 'success' : 'default'}>{stateLabel}</Tag>
      </Space>
      {attachment ? (
        <>
          <Space wrap>
            <Typography.Text type="secondary">
              已导入 {attachment.name} · {Math.max(1, Math.ceil(attachment.size / 1024))} KB
            </Typography.Text>
            <Button size="small" icon={<DownloadOutlined aria-hidden="true" />}
              href={`/api/communications/attachments/${encodeURIComponent(attachment.id)}`} download>
              下载已保存附件
            </Button>
          </Space>
          {attachment.text && <Collapse size="small" items={[{
            key: String(attachment.id), label: '查看附件提取文本',
            children: <pre className="communication-attachment-text">{attachment.text}</pre>,
          }]} />}
        </>
      ) : received ? (
        <>
          <Typography.Text type="secondary">
            从 BOSS 下载这条消息中已收到的附件，再选择对应文件导入。支持 PDF、DOCX、UTF-8 TXT，最大 5 MB。
          </Typography.Text>
          <Upload accept=".pdf,.docx,.txt" showUploadList={false} multiple={false}
            disabled={busy} beforeUpload={file => { onImport(message, file); return false; }}>
            <Button size="small" disabled={busy} icon={<UploadOutlined aria-hidden="true" />}>
              选择对应附件并导入
            </Button>
          </Upload>
        </>
      ) : <Typography.Text type="secondary">{message.direction === 'incoming'
        ? '待 BOSS 页面确认收到附件后，重新导入这段聊天记录。'
        : '此条为我方发出的附件消息。'}</Typography.Text>}
    </div>
  );
}

export default function Communications({ state, api, notify }) {
  const [jobId, setJobId] = useState(undefined);
  const [query, setQuery] = useState('');
  const [conversations, setConversations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [candidateId, setCandidateId] = useState(undefined);
  const [binding, setBinding] = useState(false);
  const mounted = useRef(false);
  const selectedRef = useRef(null);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const uploadingRef = useRef(false);
  const bindingRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      listSequence.current += 1;
      detailSequence.current += 1;
    };
  }, []);

  const selectConversation = useCallback(id => {
    if (selectedRef.current === id) return;
    selectedRef.current = id;
    detailSequence.current += 1;
    setSelectedId(id);
    setDetail(null);
    setDetailError('');
    setCandidateId(undefined);
  }, []);

  const loadList = useCallback(async () => {
    const sequence = ++listSequence.current;
    setListLoading(true);
    setListError('');
    try {
      const response = await api('/api/communications/list', jobId ? { job_id: jobId } : {});
      const body = await response.json();
      if (!Array.isArray(body.conversations)) throw new Error('沟通列表返回格式无效，请重试。');
      if (!mounted.current || sequence !== listSequence.current) return false;
      setConversations(body.conversations);
      if (!body.conversations.some(item => item.id === selectedRef.current)) {
        selectConversation(body.conversations[0]?.id ?? null);
      }
      return true;
    } catch (error) {
      if (mounted.current && sequence === listSequence.current) {
        setListError(error.message);
        notify(error.message, true);
      }
      return false;
    } finally {
      if (mounted.current && sequence === listSequence.current) setListLoading(false);
    }
  }, [api, jobId, notify, selectConversation]);

  const loadDetail = useCallback(async id => {
    if (id === null || selectedRef.current !== id) return;
    const sequence = ++detailSequence.current;
    setDetailLoading(true);
    setDetailError('');
    try {
      const response = await api('/api/communications/detail', { id });
      const body = await response.json();
      if (body.conversation?.id !== id || !Array.isArray(body.messages)) {
        throw new Error('会话详情返回格式不符，请刷新后重试。');
      }
      if (!mounted.current || sequence !== detailSequence.current || selectedRef.current !== id) return;
      setDetail(body);
    } catch (error) {
      if (mounted.current && sequence === detailSequence.current && selectedRef.current === id) {
        setDetailError(error.message);
        notify(error.message, true);
      }
    } finally {
      if (mounted.current && sequence === detailSequence.current && selectedRef.current === id) {
        setDetailLoading(false);
      }
    }
  }, [api, notify]);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { if (selectedId !== null) loadDetail(selectedId); }, [selectedId, loadDetail]);

  const jobs = useMemo(() => new Map(state.jobs.map(job => [job.id, job.title])), [state.jobs]);
  const visibleConversations = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return conversations.filter(item => !needle
      || `${item.candidate_name} ${item.friend_id} ${item.account_name || ''}`.toLocaleLowerCase().includes(needle));
  }, [conversations, query]);

  function changeJob(value) {
    listSequence.current += 1;
    setConversations([]);
    selectConversation(null);
    setDetailLoading(false);
    setJobId(value);
  }

  async function refreshRecords() {
    const previousId = selectedRef.current;
    const loaded = await loadList();
    if (loaded && previousId !== null && selectedRef.current === previousId) await loadDetail(previousId);
  }

  async function importAttachment(conversationId, message, file) {
    if (uploadingRef.current || bindingRef.current) return;
    if (selectedRef.current !== conversationId) {
      notify('会话已切换，请在对应消息下重新选择附件。', true);
      return;
    }
    if (message.direction !== 'incoming' || message.kind !== 'attachment' || message.attachment_status !== 'received') {
      notify('只能为已经收到的候选人附件消息导入文件。', true);
      return;
    }
    if (!/\.(pdf|docx|txt)$/i.test(file.name) || !file.size || file.size > MAX_ATTACHMENT_BYTES) {
      notify('请选择非空的 PDF、DOCX 或 UTF-8 TXT，文件须不超过 5 MB。', true);
      return;
    }
    uploadingRef.current = true;
    setUploading(true);
    try {
      const content = await fileContent(file);
      if (!mounted.current) return;
      if (selectedRef.current !== conversationId) throw new Error('会话已切换，请在对应消息下重新选择附件。');
      const response = await api('/api/communications/attachment', {
        conversation_id: conversationId, message_id: message.id, name: file.name, content,
      });
      const body = await response.json();
      if (!body.attachment?.id) throw new Error('附件导入结果尚未确认，请刷新当前会话核对。');
      if (!mounted.current) return;
      notify('附件已关联到这条候选人消息。');
      if (selectedRef.current === conversationId) await loadDetail(conversationId);
    } catch (error) {
      if (mounted.current) notify(error.message, true);
    } finally {
      uploadingRef.current = false;
      if (mounted.current) setUploading(false);
    }
  }

  const conversation = detail?.conversation;
  const selectedConversation = conversations.find(item => item.id === selectedId);
  const chatIdentityMatches = conversation?.id === selectedId && selectedConversation
    && selectedConversation.friend_id === conversation.friend_id
    && selectedConversation.account_id === conversation.account_id;
  const chatUrl = !detailLoading && !detailError && chatIdentityMatches ? bossChatUrl(conversation.friend_id) : '';
  const chatUnavailable = detailLoading ? '正在核对当前会话…'
    : !chatIdentityMatches || detailError ? '会话信息已变化，请刷新后重试。'
      : '缺少有效的 BOSS 会话 ID，请从 BOSS 重新导入该会话。';
  const candidateOptions = (state.candidates || []).filter(candidate =>
    candidate.job_id === conversation?.job_id && !candidate.deleted);
  const linkedCandidate = (state.candidates || []).find(candidate =>
    candidate.id === conversation?.candidate_id && candidate.job_id === conversation?.job_id && !candidate.deleted);

  async function bindCandidate() {
    if (bindingRef.current || uploadingRef.current || !conversation || selectedRef.current !== conversation.id) return;
    const target = candidateOptions.find(candidate => candidate.id === candidateId);
    if (!target) {
      notify('请先选择当前岗位的候选人档案。', true);
      return;
    }
    const conversationId = conversation.id;
    bindingRef.current = true;
    setBinding(true);
    try {
      const response = await api('/api/communications/bind', {
        conversation_id: conversationId, candidate_id: target.id,
      });
      const body = await response.json();
      if (body.conversation?.id !== conversationId || body.conversation.candidate_id !== target.id) {
        throw new Error('档案关联结果尚未确认，请刷新当前会话核对。');
      }
      if (!mounted.current) return;
      notify(`会话已关联到 ${target.name} 的档案 #${target.id}。`);
      if (selectedRef.current === conversationId) await loadDetail(conversationId);
    } catch (error) {
      if (mounted.current) notify(error.message, true);
    } finally {
      bindingRef.current = false;
      if (mounted.current) setBinding(false);
    }
  }

  return (
    <div className="communications">
      <Card size="small" className="communications-toolbar">
        <div className="communications-filters">
          <div className="communications-filter">
            <label htmlFor="communication-job">岗位</label>
            <Select id="communication-job" allowClear value={jobId} placeholder="全部岗位"
              onChange={changeJob} options={state.jobs.map(job => ({ value: job.id, label: job.title }))} />
          </div>
          <div className="communications-filter communications-search">
            <label htmlFor="communication-search">查找会话</label>
            <Input id="communication-search" allowClear value={query}
              onChange={event => setQuery(event.target.value)} placeholder="候选人姓名或会话 ID" />
          </div>
          <Button onClick={refreshRecords} loading={listLoading} icon={<ReloadOutlined aria-hidden="true" />}>
            刷新本地记录
          </Button>
        </div>
        <Typography.Paragraph type="secondary" className="communications-import-help">
          在 BOSS 沟通页打开扩展的“沟通记录与简历采集”，勾选会话后导入记录或采集简历。这里显示最近保存的本地记录。
        </Typography.Paragraph>
      </Card>
      {listError && <Alert type="error" showIcon title={listError} />}
      <div className="communications-layout">
        <Card size="small" className="communications-list-card" title={`已导入会话 · ${visibleConversations.length}`}>
          <Spin spinning={listLoading}>
            {visibleConversations.length ? <ul className="communications-list" aria-label="候选人会话">
              {visibleConversations.map(item => <li key={item.id}>
                <button type="button" className={`communication-choice${item.id === selectedId ? ' is-selected' : ''}`}
                  onClick={() => selectConversation(item.id)} aria-pressed={item.id === selectedId}>
                  <span className="communication-choice-heading">
                    <strong>{item.candidate_name || '姓名未记录'}</strong>
                    <Tag color={item.unread_count > 0 ? 'orange' : 'default'}>
                      同步时未读 {item.unread_count ?? '未知'}
                    </Tag>
                  </span>
                  <span className="communication-choice-meta">{jobs.get(item.job_id) || `岗位 ${item.job_id}`} · {item.account_name || item.account_id}</span>
                  <span className="communication-choice-preview">{item.last_message || '最近消息未导入'}</span>
                  <span className="communication-choice-meta">{item.message_count || 0} 条已保存消息 · {displayTime(item.updated)}</span>
                </button>
              </li>)}
            </ul> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={query ? '没有匹配的已导入会话' : '尚未导入沟通记录'} />}
          </Spin>
        </Card>
        <Card size="small" className="communications-history-card" title="聊天历史">
          {detailError && <Alert type="error" showIcon title={detailError}
            action={<Button size="small" onClick={() => loadDetail(selectedId)}>重试</Button>} />}
          <Spin spinning={detailLoading}>
            {conversation ? <>
              <header className="communication-detail-heading">
                <Typography.Title level={4}>{conversation.candidate_name || '姓名未记录'}</Typography.Title>
                <Typography.Text>{jobs.get(conversation.job_id) || `岗位 ${conversation.job_id}`} · {conversation.account_name || conversation.account_id}</Typography.Text>
                <Typography.Text type="secondary">会话 ID {conversation.friend_id} · 同步于 {displayTime(conversation.updated)}</Typography.Text>
                <Typography.Text type="secondary">未读数为同步时快照，当前已读状态以 BOSS 页面为准。</Typography.Text>
                <Space wrap>
                  <Button href={chatUrl || undefined} target="_blank" rel="noopener noreferrer"
                    disabled={!chatUrl} data-boss-chat-link
                    title={`请先在 BOSS 登录招聘账号「${conversation.account_name || conversation.account_id}」。仅打开会话，消息由你在 BOSS 中发送。`}>
                    在 BOSS 中聊天
                  </Button>
                  {!chatUrl && <Typography.Text type="secondary">{chatUnavailable}</Typography.Text>}
                </Space>
                <section className="communication-candidate-binding" aria-label="候选人档案关联">
                  {conversation.candidate_id ? <>
                    <Space wrap>
                      <Tag color="success">已关联候选人档案</Tag>
                      <strong>{linkedCandidate?.name ? `${linkedCandidate.name} · ` : ''}档案 #{conversation.candidate_id}</strong>
                    </Space>
                    <Typography.Text type="secondary">此会话导入的附件会关联到该候选人档案。</Typography.Text>
                  </> : candidateOptions.length ? <>
                    <Typography.Text>{conversation.candidate_binding_reason || '尚未关联候选人档案，请核对姓名和档案 ID 后确认关联。'}</Typography.Text>
                    <label htmlFor="communication-candidate">对应候选人档案</label>
                    <div className="communication-bind-controls">
                      <Select id="communication-candidate" value={candidateId} allowClear
                        onChange={setCandidateId} placeholder="选择当前岗位的候选人档案"
                        disabled={binding || uploading}
                        options={candidateOptions.map(candidate => ({
                          value: candidate.id, label: `${candidate.name} · 档案 #${candidate.id}`,
                        }))} />
                      <Button onClick={bindCandidate} loading={binding}
                        disabled={uploading || !candidateOptions.some(candidate => candidate.id === candidateId)}>
                        确认关联
                      </Button>
                    </div>
                  </> : <Typography.Text type="secondary">
                    该岗位暂无可关联的候选人档案。请先在候选人工作台录入档案，再刷新工作台。
                  </Typography.Text>}
                </section>
              </header>
              <ChatResumeSources sources={conversation.resumes||[]} api={api} notify={notify} onRefresh={()=>loadDetail(conversation.id)}/>
              {detail.messages.length ? <ol className="communication-messages" aria-label="已保存聊天消息">
                {detail.messages.map(message => <li key={message.id}
                  className={`communication-message is-${message.direction}`}>
                  <div className="communication-message-heading">
                    <strong>{directionLabels[message.direction] || '来源未记录'}</strong>
                    <time>{displayTime(message.sent_at)}</time>
                  </div>
                  {message.text && <div className="communication-message-text">{message.text}</div>}
                  {message.kind === 'attachment' && <Attachment message={message} busy={uploading || binding}
                    onImport={(entry, file) => importAttachment(conversation.id, entry, file)} />}
                  {!message.text && message.kind !== 'attachment' && <Typography.Text type="secondary">这条消息未导入可显示的正文。</Typography.Text>}
                </li>)}
              </ol> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="这段会话尚未导入消息。请在 BOSS 打开对应聊天，再用扩展导入当前历史。" />}
            </> : <div className="communications-detail-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={selectedId === null ? '选择一段已导入会话查看历史' : detailLoading ? '正在读取本地聊天历史' : '会话详情尚未加载'} /></div>}
          </Spin>
        </Card>
      </div>
    </div>
  );
}
