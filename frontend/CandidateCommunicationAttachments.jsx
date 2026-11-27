import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Collapse, Empty, Flex, Spin, Typography } from 'antd';
import ChatResumeSources from './ChatResumeSources.jsx';
import { bossChatUrl } from './boss-chat-link.mjs';

export default function CandidateCommunicationAttachments({ candidateId, api, notify }) {
  const [loaded, setLoaded] = useState(null);
  // A different candidate must never render the previous candidate's chat links,
  // including the render before its loading effect runs.
  const data = loaded?.candidateId === candidateId ? loaded.data : null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++request.current;
    setLoading(true);
    setError('');
    try {
      const response = await api('/api/communications/candidate', { candidate_id: candidateId });
      const result = await response.json();
      if (!Array.isArray(result.conversations) || !Array.isArray(result.attachments)) {
        throw new Error('沟通附件返回格式无效。');
      }
      if (request.current === sequence) setLoaded({ candidateId, data: result });
    } catch (failure) {
      if (request.current === sequence) {
        setError(failure.message);
        notify(failure.message, true);
      }
    } finally {
      if (request.current === sequence) setLoading(false);
    }
  }, [candidateId, api, notify]);

  useEffect(() => {
    setLoaded(null);
    load();
    return () => { request.current += 1; };
  }, [load]);

  return <div className="candidate-detail-tab-panel">
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center" gap={12}>
        <Typography.Text>关联会话 {data?.conversations.length ?? '—'} 个</Typography.Text>
        <Button size="small" onClick={load} loading={loading}>刷新会话与附件</Button>
      </Flex>
      {error && <Alert type="error" showIcon title={error} />}
      <Spin spinning={loading}>
        {data?.conversations.length > 0 && <Flex vertical gap={12} style={{ marginBottom: 16 }}>
          <Typography.Title level={5} style={{ margin: 0 }}>BOSS 聊天</Typography.Title>
          {data.conversations.map(conversation => {
            const validUrl = bossChatUrl(conversation.friend_id);
            const href = !loading && !error ? validUrl : '';
            const unavailable = loading ? '正在核对当前会话，请稍后。' : error ? '请刷新会话后重试。'
              : '缺少可用的 BOSS 会话标识，请重新导入该候选人的沟通记录。';
            return <Flex key={conversation.id} wrap justify="space-between" align="center" gap={8}>
              <Flex vertical gap={2}>
                <Typography.Text>{conversation.account_name || conversation.account_id || '招聘账号'} · {conversation.candidate_name || '当前候选人'}</Typography.Text>
                <Typography.Text type="secondary">会话 {conversation.friend_id || '未记录'}</Typography.Text>
              </Flex>
              <Button href={href || undefined} target={href ? '_blank' : undefined}
                rel={href ? 'noopener noreferrer' : undefined} disabled={!href}
                title={href ? '请使用这段会话对应的招聘账号登录 BOSS，打开后核对候选人和沟通职位。' : unavailable}>
                在 BOSS 中聊天
              </Button>
              {!validUrl && <Typography.Text type="secondary">缺少可用的会话标识，请重新导入沟通记录。</Typography.Text>}
            </Flex>;
          })}
          <Typography.Text type="secondary">将在新标签页打开对应聊天。请登录这段会话对应的招聘账号，并核对候选人和沟通职位。</Typography.Text>
        </Flex>}
        <ChatResumeSources sources={data?.resumes||[]} api={api} notify={notify} onRefresh={load}/>
        {data?.attachments.length ? <Collapse items={data.attachments.map(attachment => ({
          key: String(attachment.id),
          label: attachment.name,
          children: <Flex vertical gap={12}>
            <Typography.Text type="secondary">
              {attachment.account_name || '招聘账号'} · 会话 {attachment.friend_id} · {(attachment.size / 1024).toFixed(1)} KB
            </Typography.Text>
            <Button href={`/api/communications/attachments/${attachment.id}`} download={attachment.name}>
              下载附件原件
            </Button>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 400,
              overflow: 'auto', font: 'inherit', margin: 0 }}>{attachment.text}</pre>
          </Flex>,
        }))} /> : data && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={data.conversations.length ? '关联会话中尚未导入附件原件' : '尚未关联沟通会话'} />}
      </Spin>
      <Typography.Paragraph type="secondary">
        在“沟通记录”中确认会话与候选人档案的关联后，该会话已保存的附件会自动显示在这里。
      </Typography.Paragraph>
    </Flex>
  </div>;
}
