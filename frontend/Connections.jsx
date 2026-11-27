import { useRef, useState } from 'react';
import {
  Alert, Button, Card, Col, Divider, Form, Input, Row, Space, Tag, Typography,
} from 'antd';
import AiConfiguration from './AiConfiguration';
import ExtensionDownload from './ExtensionDownload';
import { rememberBrowserExtension } from './browser-extension.mjs';

const { Paragraph } = Typography;

export default function Connections({ state, refresh, api, notify }) {
  const [pairing, setPairing] = useState('');
  const pairingRef = useRef(false);

  async function updateAuthorization(action, data) {
    if (pairingRef.current) return;
    pairingRef.current = true;
    setPairing(action);
    try {
      await api('/api/extension/' + action, data);
      rememberBrowserExtension(action === 'pair' ? data.id : '');
      await refresh();
      notify(action === 'pair'
        ? '已授权扩展。请在安装插件的浏览器中打开已登录的 BOSS 候选人列表，再启动批量采集。'
        : '已解除本浏览器扩展的授权，其他扩展授权保持不变。');
    } catch (error) {
      notify(error.message, true);
    } finally {
      pairingRef.current = false;
      setPairing('');
    }
  }


  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={12}>
        <Card
          title="浏览器插件下载与连接"
          extra={state.extension_paired ? <Tag color="success">本浏览器已授权</Tag> : <Tag>本浏览器待授权</Tag>}
          style={{ height: '100%' }}
        >
          <ExtensionDownload api={api} />
          <Divider titlePlacement="start">授权连接工作台</Divider>
          <Paragraph type="secondary">
            授权后，在已登录的 BOSS 候选人列表打开 HRM 插件，选择岗位并开始采集。保存的履历会出现在候选人工作台。
          </Paragraph>
          {state.extension_paired && <Paragraph>
            本浏览器扩展：<Typography.Text code copyable>{state.extension_id}</Typography.Text>
          </Paragraph>}
          {state.extension_selection_required && <Alert type="info" showIcon style={{ marginBottom: 16 }}
            title="请确认本浏览器的扩展 ID"
            description="工作台已有扩展授权。请打开本浏览器安装的 HRM 插件，复制其扩展 ID 到下方并点击“授权连接”，以便本浏览器使用收藏定位。" />}
          <Form
            layout="vertical"
            onFinish={({ extensionId }) => updateAuthorization('pair', { id: extensionId.trim() })}
          >
            <Form.Item
              name="extensionId"
              label="本浏览器的扩展 ID"
              htmlFor="extension-pair-id"
              rules={[{ pattern: /^[a-p]{32}$/, required: true, message: '请输入扩展显示的 32 位 a-p 字母 ID' }]}
            >
              <Input id="extension-pair-id" maxLength={32} placeholder="粘贴扩展显示的 32 位 ID" autoComplete="off" />
            </Form.Item>
            <Space wrap>
              <Button id="extension-pair" type="primary" htmlType="submit" loading={pairing === 'pair'} disabled={pairing === 'revoke'}>
                授权连接
              </Button>
              <Button id="extension-revoke" onClick={() => updateAuthorization('revoke', { id: state.extension_id })}
                loading={pairing === 'revoke'} disabled={!state.extension_paired || pairing === 'pair'}>
                解除本浏览器授权
              </Button>
              <Button type="link" href="https://www.zhipin.com/web/user/?ka=header-boss" target="_blank" rel="noopener noreferrer">
                打开 BOSS 直聘 ↗
              </Button>
            </Space>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <AiConfiguration state={state} refresh={refresh} api={api} notify={notify} />
      </Col>
    </Row>
  );
}
