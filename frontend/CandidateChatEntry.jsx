import { useEffect, useState } from 'react';
import { Alert, Button, Flex, Modal, Typography } from 'antd';
import { bossChatUrl, candidateGreetingRecords, confirmedGreetingAccounts } from './boss-chat-link.mjs';

export function CandidateContactOptions({ candidate, onClose }) {
  const href = bossChatUrl(candidate?.source?.boss_chat_uid);
  if (!candidate || candidate.deleted || !href) return null;
  const accounts = confirmedGreetingAccounts(candidate);
  const uncertain = candidateGreetingRecords(candidate).filter(row => row.state === 'attempted');
  return <Modal open title={`联系候选人 · ${candidate.name}`} onCancel={onClose}
    footer={<Button onClick={onClose}>关闭</Button>} destroyOnHidden>
    <Flex vertical align="start" gap={16}>
      {accounts.length ? <>
        <Alert type="success" showIcon title="已记录确认过的 BOSS 沟通关系"
          description="请使用下面对应的招聘账号登录。记录为采集时的确认结果，实际能否聊天仍以 BOSS 当前状态为准。" />
        {accounts.map(account => <Flex key={account.account_uid} vertical align="start" gap={6}>
          <Typography.Text>招聘账号 {account.account_uid} · {account.state === 'confirmed' ? '已确认打招呼成功' : '已有沟通关系'}</Typography.Text>
          <Button href={href} target="_blank" rel="noopener noreferrer">打开已建立的会话 ↗</Button>
        </Flex>)}
      </> : <Alert type="info" showIcon title="当前账号与这位候选人的沟通关系尚未核实"
        description="从推荐页采集到候选人信息，不代表已经打过招呼或建立会话。" />}
      {uncertain.length > 0 && <Alert type="warning" showIcon title="打招呼结果待核对，系统不会自动重发"
        description={`请在 BOSS 核对招聘账号 ${uncertain.map(row => row.account_uid).join('、')} 的会话记录。`} />}
      <Typography.Text copyable={{ text: candidate.name }}>复制候选人姓名</Typography.Text>
      <Flex vertical align="start" gap={8}>
        <Button href="https://www.zhipin.com/web/chat/recommend" target="_blank" rel="noopener noreferrer">打开推荐牛人列表 ↗</Button>
        <Typography.Text type="secondary">只打开列表，不会自动定位此人。请找到候选人，核对姓名、履历和岗位后，由你本人决定是否打招呼。</Typography.Text>
      </Flex>
      <Flex vertical align="start" gap={8}>
        <Button href={href} target="_blank" rel="noopener noreferrer">尝试打开已有会话 ↗</Button>
        <Typography.Text type="secondary">如果你已用当前招聘账号与此人沟通过，可以尝试打开。尚未建立关系或登录账号不同时，BOSS 可能提示不在好友列表。</Typography.Text>
      </Flex>
    </Flex>
  </Modal>;
}

export default function CandidateChatEntry({ candidate, detailed = false }) {
  const href = bossChatUrl(candidate?.source?.boss_chat_uid);
  const accounts = confirmedGreetingAccounts(candidate);
  const [openedFor, setOpenedFor] = useState(null);
  const matches = Boolean(candidate && !candidate.deleted && href && openedFor?.id === candidate.id &&
    openedFor?.href === href && openedFor?.jobId === candidate.job_id);
  useEffect(() => { if (!matches) setOpenedFor(null); }, [candidate?.id, candidate?.job_id, href, matches]);
  if (!href || candidate?.id == null || candidate.deleted) return null;
  return <>
    <Flex vertical align="start" gap={8}>
      <Button onClick={() => setOpenedFor({ id: candidate.id, href, jobId: candidate.job_id })}>联系候选人</Button>
      {detailed && <Typography.Text type="secondary">{accounts.length
        ? '已记录确认过的沟通关系，请选择对应招聘账号打开会话。'
        : '查看联系选项，当前账号的沟通关系尚未核实。'}</Typography.Text>}
    </Flex>
    {matches && <CandidateContactOptions candidate={candidate} onClose={() => setOpenedFor(null)} />}
  </>;
}
