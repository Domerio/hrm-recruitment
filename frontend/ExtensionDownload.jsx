import { useEffect, useState } from 'react';
import { DownloadOutlined } from '@ant-design/icons';
import { Alert, Button, Flex, Tag, Typography } from 'antd';

export default function ExtensionDownload({ api }) {
  const [bundle, setBundle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [request, setRequest] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setBundle(null);
    void (async () => {
      try {
        const response = await api('/api/extension/package');
        const value = await response.json();
        if (!value || typeof value.name !== 'string' || !value.name.trim() ||
            typeof value.version !== 'string' || !value.version.trim() ||
            typeof value.filename !== 'string' || !value.filename.endsWith('.zip') ||
            value.download_url !== '/api/extension/download') {
          throw new Error('安装包信息不完整，请重新读取。');
        }
        if (typeof value.workbench_origin !== 'string' ||
            new URL(value.workbench_origin).origin !== globalThis.location?.origin) {
          throw new Error('工作台服务尚未提供当前地址的安装包，请更新或重启服务后重试。');
        }
        if (active) setBundle(value);
      } catch (failure) {
        if (active) setError(failure.message || '无法读取插件安装包，请确认工作台服务正常后重试。');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [api, request]);

  return <section aria-label="采集插件下载安装">
    <Typography.Title level={5} style={{ marginTop: 0 }}>下载安装采集插件</Typography.Title>
    <Flex vertical gap={12}>
      {bundle && <Flex align="center" gap={8} wrap>
        <Typography.Text strong>{bundle.name}</Typography.Text>
        <Tag color="blue">版本 {bundle.version}</Tag>
      </Flex>}
      {error && <Alert type="error" showIcon title="暂时无法读取安装包"
        description={error}
        action={<Button size="small" onClick={() => setRequest(value => value + 1)}>重试</Button>} />}
      <Flex gap={8} align="center" wrap>
        <Button id="extension-download" type="primary" icon={<DownloadOutlined aria-hidden="true" />}
          href={bundle?.download_url} download={bundle?.filename}
          loading={loading} disabled={!bundle || loading}>
          {loading ? '正在读取安装包' : '下载插件 ZIP'}
        </Button>
        <Typography.Text type="secondary">支持 Edge 和 Chrome，下载后需手动加载。</Typography.Text>
      </Flex>
      <Alert type="info" showIcon title="安装包自动带入当前工作台地址"
        description={<>无需填写 IP 或端口。插件将连接 <Typography.Text code>{bundle?.workbench_origin || globalThis.location?.origin}</Typography.Text>。其他电脑请先通过服务器的局域网 IP 打开本页，再下载安装并分别授权。</>} />
    </Flex>
    <ol style={{ paddingInlineStart: 22, marginBlock: 16 }}>
      <li style={{ marginBottom: 12 }}>
        <Typography.Text strong>下载并解压</Typography.Text>
        <div>将 ZIP 解压到固定目录，保留其中的 <Typography.Text code>hrm-boss-extension</Typography.Text> 文件夹，不要直接加载 ZIP。</div>
      </li>
      <li style={{ marginBottom: 12 }}>
        <Typography.Text strong>打开浏览器扩展管理页</Typography.Text>
        <div>在 Edge 地址栏输入 <Typography.Text code copyable>edge://extensions</Typography.Text>。</div>
        <div>Chrome 用户输入 <Typography.Text code copyable>chrome://extensions</Typography.Text>。</div>
      </li>
      <li style={{ marginBottom: 12 }}>
        <Typography.Text strong>加载解压后的插件</Typography.Text>
        <div>打开“开发人员模式”，选择“加载解压缩的扩展”或“加载已解压的扩展程序”，选中直接包含 <Typography.Text code>manifest.json</Typography.Text> 的 <Typography.Text code>hrm-boss-extension</Typography.Text> 文件夹。</div>
      </li>
      <li>
        <Typography.Text strong>允许访问工作台并授权扩展</Typography.Text>
        <div>打开浏览器工具栏中的 HRM 插件，点击“连接工作台”，按浏览器提示允许访问此服务器；再复制扩展 ID，粘贴到下方表单并点击“授权连接”。每个浏览器分别完成一次。</div>
      </li>
    </ol>
    <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
      升级时，将新版文件覆盖到原来的同一目录，再到扩展管理页点击“重新加载”。保持目录不变，以免扩展 ID 改变后需要重新授权。
    </Typography.Paragraph>
  </section>;
}
