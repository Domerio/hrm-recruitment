import { useRef, useState } from 'react';
import {
  Button, Card, Col, Form, Input, Row, Space, Tag, Typography,
} from 'antd';
import AiConfiguration from './AiConfiguration';

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
      await refresh();
      notify(action === 'pair'
        ? '已授权扩展。请在 Edge 中打开已登录的 BOSS 候选人列表，再启动批量采集。'
        : '已解除扩展授权。');
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
          title="Edge 扩展采集"
          extra={state.extension_paired ? <Tag color="success">已授权</Tag> : <Tag>待授权</Tag>}
          style={{ height: '100%' }}
        >
          <Paragraph type="secondary">
            在已登录的 BOSS 候选人列表打开 HRM 扩展，选择岗位并开始采集。保存的履历会出现在候选人工作台。
          </Paragraph>
          <Form
            layout="vertical"
            onFinish={({ extensionId }) => updateAuthorization('pair', { id: extensionId.trim() })}
          >
            <Form.Item
              name="extensionId"
              label="扩展 ID"
              htmlFor="extension-pair-id"
              rules={[{ pattern: /^[a-p]{32}$/, required: true, message: '请输入扩展显示的 32 位 a-p 字母 ID' }]}
            >
              <Input id="extension-pair-id" maxLength={32} placeholder="粘贴扩展显示的 32 位 ID" autoComplete="off" />
            </Form.Item>
            <Space wrap>
              <Button id="extension-pair" type="primary" htmlType="submit" loading={pairing === 'pair'} disabled={pairing === 'revoke'}>
                授权连接
              </Button>
              <Button id="extension-revoke" onClick={() => updateAuthorization('revoke', {})}
                loading={pairing === 'revoke'} disabled={!state.extension_paired || pairing === 'pair'}>
                解除授权
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
