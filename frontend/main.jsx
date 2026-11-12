import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApartmentOutlined, LinkOutlined, TeamOutlined } from '@ant-design/icons';
import { Alert, App, Breadcrumb, Button, ConfigProvider, Layout, Menu, Spin, Tag, Typography } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import './workbench.css';
import Candidates from './Candidates';
import Jobs from './Jobs';
import Connections from './Connections';

const views = {
  candidates: {
    label: '候选人工作台',
    mobileLabel: '候选人',
    description: '查看候选人、核对评估依据并记录复核结果。',
    icon: <TeamOutlined aria-hidden="true" />,
    Component: Candidates,
  },
  jobs: {
    label: '岗位与筛选条件',
    mobileLabel: '岗位配置',
    description: '维护岗位 JD 和 AI 评估所用的筛选条件。',
    icon: <ApartmentOutlined aria-hidden="true" />,
    Component: Jobs,
  },
  connections: {
    label: '连接与集成',
    mobileLabel: '连接设置',
    description: '管理 Edge 扩展授权、API 地址、密钥与评估模型。',
    icon: <LinkOutlined aria-hidden="true" />,
    Component: Connections,
  },
};

const menuItems = Object.entries(views).map(([key, view]) => ({ key, label: view.label, icon: view.icon }));
const mobileItems = Object.entries(views).map(([key, view]) => ({ key, label: view.mobileLabel }));
const nonce = document.querySelector('meta[name="style-nonce"]')?.content;
const theme = {
  token: {
    colorPrimary: '#146d65',
    colorInfo: '#146d65',
    colorBgLayout: '#f3f6f8',
    colorText: '#1d2939',
    colorTextPlaceholder: '#697983',
    borderRadius: 8,
    fontFamily: 'Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  components: { Menu: { itemSelectedBg: '#e6f3f0' } },
};

function Workbench() {
  const [view, setView] = useState('candidates');
  const [candidateJobRequest, setCandidateJobRequest] = useState(null);
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState('');
  const token = useRef('');
  const readSequence = useRef(0);
  const latestRead = useRef(0);
  const { message } = App.useApp();
  const notify = useCallback((text, error = false) => {
    message[error ? 'error' : 'success'](text);
  }, [message]);

  const refresh = useCallback(async () => {
    const sequence = ++readSequence.current;
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取工作台数据，请确认本地服务已启动。');
    const data = await response.json();
    if (sequence > latestRead.current) {
      latestRead.current = sequence;
      token.current = data.token;
      setState(data);
      setLoadError('');
    }
    return data;
  }, []);

  const api = useCallback(async (path, data) => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Token': token.current },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const error = new Error(typeof body?.error === 'string' && body.error.trim()
        ? body.error : '请求失败，请重试。');
      error.status = response.status;
      error.code = body?.code;
      error.validationPath = typeof body?.validation_path === 'string' ? body.validation_path : undefined;
      error.validationReason = typeof body?.validation_reason === 'string' ? body.validation_reason : undefined;
      throw error;
    }
    return response;
  }, []);

  const load = useCallback(() => {
    setLoadError('');
    refresh().catch(error => setLoadError(error.message));
  }, [refresh]);

  useEffect(load, [load]);

  const navigate = ({ key }) => setView(key);
  function viewJobCandidates(jobId) {
    setCandidateJobRequest({ jobId });
    setView('candidates');
    window.scrollTo({ top: 0 });
  }
  return (
    <Layout className="workbench">
      <Layout.Sider className="workbench-sider" width={226} theme="light">
        <div className="workbench-brand">
          <span className="brand-mark">H</span>
          <div><strong>人才工作台</strong><small>HRM · 招聘管理</small></div>
        </div>
        <nav aria-label="招聘管理">
          <Menu mode="inline" items={menuItems} selectedKeys={[view]} onClick={navigate} />
        </nav>
      </Layout.Sider>
      <Layout className="workbench-main">
        <Layout.Header className="workbench-header">
          <Breadcrumb items={[{ title: '招聘管理' }, { title: views[view].label }]} />
          <Tag color="default">本地开发</Tag>
        </Layout.Header>
        <nav className="workbench-mobile-nav" aria-label="招聘管理">
          <Menu mode="horizontal" items={mobileItems} selectedKeys={[view]} onClick={navigate} />
        </nav>
        <Layout.Content className="workbench-content">
          <div className="workbench-heading">
            <div>
              <Typography.Title level={1}>{views[view].label}</Typography.Title>
              <Typography.Text type="secondary">{views[view].description}</Typography.Text>
            </div>
            {view === 'candidates' && <Button icon={<LinkOutlined aria-hidden="true" />}
              onClick={() => setView('connections')}>采集设置</Button>}
          </div>
          {loadError && (
            <Alert className="workbench-load-error" type="error" showIcon title={loadError}
              action={<Button size="small" onClick={load}>重试加载</Button>} />
          )}
          {!state && !loadError && <div className="workbench-loading"><Spin aria-label="加载工作台" /></div>}
          {state && Object.entries(views).map(([key, { Component }]) => (
            <section key={key} id={key} hidden={view !== key}>
              <Component state={state} refresh={refresh} api={api} notify={notify}
                active={view === key} onNavigate={setView}
                onViewCandidates={viewJobCandidates} candidateJobRequest={candidateJobRequest} />
            </section>
          ))}
        </Layout.Content>
        <Layout.Footer className="workbench-footer">
          <span>HRM 招聘辅助模块 {state?.version && <span>· {state.version}</span>}</span>
          <span>AI 结论仅供参考 · 联系方式仅记录已获授权的信息</span>
        </Layout.Footer>
      </Layout>
    </Layout>
  );
}

createRoot(document.getElementById('root')).render(
  <ConfigProvider locale={zhCN} theme={theme} csp={nonce ? { nonce } : undefined}>
    <App><Workbench /></App>
  </ConfigProvider>,
);
