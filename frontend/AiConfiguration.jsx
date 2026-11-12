import { useEffect, useRef, useState } from 'react';
import {
  Alert, App, AutoComplete, Button, Card, Checkbox, Descriptions, Flex, Form, Input, Select, Tag, Typography,
} from 'antd';

const providers = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openai-compatible', label: 'OpenAI 兼容（含内部模型）' },
];
const normalUrl = value => (value || '').trim().replace(/\/+$/, '');
const endpoint = values => `${values.provider}|${normalUrl(values.base_url)}`;
const formValues = config => ({
  provider: config.provider, base_url: config.base_url, model: config.model, api_key: '', clear_key: false,
});
function isDirty(values, saved) {
  return endpoint(values) !== endpoint(saved) || (values.model || '').trim() !== saved.model ||
    Boolean((values.api_key || '').trim()) || Boolean(values.clear_key);
}
function safeConfig(value) {
  if (!value || !providers.some(provider => provider.value === value.provider) ||
      typeof value.base_url !== 'string' || typeof value.model !== 'string' ||
      !Number.isInteger(value.revision)) throw new Error('模型配置响应无效，请重新读取配置。');
  return {
    provider: value.provider, base_url: value.base_url, model: value.model, revision: value.revision,
    has_key: Boolean(value.has_key), source: ['saved','invalid'].includes(value.source) ? value.source : 'environment',
  };
}

export default function AiConfiguration({ state, refresh, api, notify }) {
  const inherited = state.ai_config || {
    provider: 'deepseek', base_url: 'https://api.deepseek.com', model: state.model || 'deepseek-chat',
    revision: 0, has_key: Boolean(state.configured), source: 'environment',
  };
  const [form] = Form.useForm();
  const [saved, setSaved] = useState(() => safeConfig(inherited));
  const savedRef = useRef(saved);
  const [draft, setDraft] = useState(() => formValues(saved));
  const draftRef = useRef(draft);
  const initialValues = useRef(draft);
  const [busy, setBusy] = useState('');
  const busyRef = useRef('');
  const [models, setModels] = useState([]);
  const [feedback, setFeedback] = useState(null);
  const [needsReload, setNeedsReload] = useState(false);
  const { modal } = App.useApp();
  const dirty = isDirty(draft, saved);
  const endpointChanged = endpoint(draft) !== endpoint(saved);

  function applyConfig(config) {
    const next = safeConfig(config);
    savedRef.current = next;
    setSaved(next);
    const values = formValues(next);
    draftRef.current = values;
    setDraft(values);
    form.setFieldsValue(values);
    setNeedsReload(false);
  }

  useEffect(() => {
    if (!state.ai_config || busyRef.current || isDirty(draftRef.current, savedRef.current)) return;
    try {
      const next = safeConfig(state.ai_config);
      if (JSON.stringify(next) !== JSON.stringify(savedRef.current)) {
        if (endpoint(next) !== endpoint(savedRef.current)) setModels([]);
        applyConfig(next);
        setFeedback(null);
      }
    } catch { /* Keep a working form while a refresh is unavailable. */ }
  }, [state.ai_config]);

  function changeValues(changed, values) {
    let next = values;
    if (('provider' in changed || 'base_url' in changed) && endpoint(values) !== endpoint(draftRef.current)) {
      next = { ...values, api_key: '', clear_key: false };
      form.setFieldsValue({ api_key: '', clear_key: false });
      setModels([]);
    } else if (changed.clear_key) {
      next = { ...values, api_key: '' };
      form.setFieldsValue({ api_key: '' });
    }
    draftRef.current = next;
    setDraft(next);
    setFeedback(null);
  }

  function fillDeepSeekPreset() {
    if (busyRef.current) return;
    const values = { ...form.getFieldsValue(), provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-chat' };
    if (endpoint(values) !== endpoint(draftRef.current)) {
      values.api_key = '';
      values.clear_key = false;
      setModels([]);
    }
    form.setFieldsValue(values);
    draftRef.current = values;
    setDraft(values);
    setFeedback({ type: 'info', title: '已填入 DeepSeek 预设，请保存后使用。' });
  }

  async function readConfig() {
    const response = await fetch('/api/ai/config', { cache: 'no-store' });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error || '无法读取模型配置，请稍后重试。');
    }
    return safeConfig(await response.json());
  }

  async function reload() {
    if (busyRef.current) return;
    busyRef.current = 'reload';
    setBusy('reload');
    try {
      const config = await readConfig();
      if (endpoint(config) !== endpoint(savedRef.current)) setModels([]);
      applyConfig(config);
      setFeedback({ type: 'success', title: '已读取当前保存的模型配置。' });
    } catch (error) {
      setFeedback({ type: 'error', title: error.message });
    } finally {
      busyRef.current = '';
      setBusy('');
    }
  }

  function confirmReload() {
    if (busyRef.current) return;
    if (!isDirty(form.getFieldsValue(), savedRef.current)) {
      void reload();
      return;
    }
    modal.confirm({
      title: '重新读取模型配置',
      content: '将用服务端已保存的配置替换当前草稿，未保存的输入会被清除。',
      okText: '重新读取', cancelText: '保留草稿', onOk: reload,
    });
  }

  async function save(values) {
    if (busyRef.current || needsReload) return;
    busyRef.current = 'save';
    setBusy('save');
    setFeedback(null);
    let written = false;
    try {
      const key = (values.api_key || '').trim();
      const response = await api('/api/ai/config', {
        provider: values.provider, base_url: normalUrl(values.base_url), model: values.model.trim(),
        revision: savedRef.current.revision, clear_key: Boolean(values.clear_key),
        ...(key ? { api_key: key } : {}),
      });
      written = true;
      // Clear a newly entered secret immediately after the server accepts the update.
      form.setFieldValue('api_key', '');
      draftRef.current = { ...draftRef.current, api_key: '' };
      setDraft(draftRef.current);
      let result;
      try { result = await response.json(); } catch { result = {}; }
      let config;
      try { config = safeConfig(result.config); } catch { config = await readConfig(); }
      applyConfig(config);
      let refreshFailed = false;
      try { await refresh(); } catch { refreshFailed = true; }
      const pending = Number.isInteger(result.pending_candidates) && result.pending_candidates > 0
        ? `，${result.pending_candidates} 名候选人已标记待重评` : '';
      const text = `AI 模型配置已保存${pending}。`;
      setFeedback({ type: refreshFailed ? 'warning' : 'success',
        title: refreshFailed ? `${text}工作台状态刷新失败，请刷新页面查看。` : text });
      notify(text);
    } catch (error) {
      if (written) {
        setNeedsReload(true);
        setFeedback({ type: 'warning', title: '配置已保存，暂时无法读取最新版本。请重新读取配置后再继续操作。' });
        notify('配置已保存，请重新读取配置以确认最新状态。', true);
      } else {
        setFeedback({ type: 'error', title: error.message });
        notify(error.message, true);
      }
    } finally {
      busyRef.current = '';
      setBusy('');
    }
  }

  async function savedAction(action) {
    if (busyRef.current || needsReload) return;
    if (isDirty(form.getFieldsValue(), savedRef.current)) {
      setFeedback({ type: 'info', title: '请先保存修改，再读取模型列表或测试连接。' });
      return;
    }
    busyRef.current = action;
    setBusy(action);
    setFeedback(null);
    try {
      const response = await api(action === 'models' ? '/api/ai/models' : '/api/ai/test', {});
      if (action === 'models') {
        const result = await response.json();
        if (!Array.isArray(result.models)) throw new Error('模型列表响应无效，仍可手动输入模型 ID。');
        const ids = [...new Set(result.models.filter(model => typeof model?.id === 'string' && model.id.trim()).map(model => model.id.trim()))];
        setModels(ids.sort().map(value => ({ value })));
        setFeedback({ type: ids.length ? 'success' : 'info',
          title: ids.length ? `已读取 ${ids.length} 个模型，可选择或手动输入模型 ID。` : '服务未返回模型列表，仍可手动输入模型 ID。' });
      } else {
        setFeedback({ type: 'success', title: '连接成功，已保存模型的 JSON 输出验证通过。' });
      }
    } catch (error) {
      setFeedback({ type: 'error', title: error.message });
    } finally {
      busyRef.current = '';
      setBusy('');
    }
  }

  return (
    <Card title="AI 模型配置" style={{ height: '100%' }}
      extra={<Tag color={saved.provider === 'openai-compatible' ? 'purple' : 'blue'}>
        {saved.provider === 'openai-compatible' ? 'OpenAI 兼容' : 'DeepSeek'}
      </Tag>}>
      <Flex vertical gap={14}>
        <Descriptions size="small" column={1} items={[
          { key: 'model', label: '已保存模型', children: saved.model || '—' },
          { key: 'key', label: 'API Key', children: saved.has_key ? '已配置（不显示）' : '未配置' },
          { key: 'source', label: '配置来源', children: saved.source === 'invalid' ? '配置待修复，请重新保存' : saved.source === 'saved' ? '工作台保存' : '服务端环境配置' },
        ]} />
        <Form form={form} layout="vertical" initialValues={initialValues.current} onValuesChange={changeValues}
          onFinish={save} disabled={Boolean(busy)}>
          <Form.Item name="provider" label="模型提供商" rules={[{ required: true, message: '请选择模型提供商' }]}>
            <Select id="ai-provider" options={providers} />
          </Form.Item>
          <Form.Item name="base_url" label="API 地址" extra="填写 OpenAI 兼容接口的基础地址，内部服务可使用本机或局域网 HTTP 地址。"
            rules={[{ required: true, whitespace: true, message: '请输入 API 基础地址' }, {
              validator: async (_, value) => {
                if (!value?.trim()) return;
                try {
                  const url = new URL(value.trim());
                  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error();
                } catch { throw new Error('请输入有效的 HTTP 或 HTTPS 基础地址'); }
              },
            }]}>
            <Input id="ai-base-url" maxLength={2000} placeholder="https://api.deepseek.com 或 http://内网地址:端口/v1" autoComplete="off" />
          </Form.Item>
          <Form.Item name="api_key" label="API Key"
            extra="密钥输入不会回填。留空保留当前服务已配置的密钥；内部无密钥服务可留空。">
            <Input.Password id="ai-api-key" maxLength={1000} autoComplete="new-password" disabled={Boolean(busy) || draft.clear_key}
              placeholder={saved.has_key && !endpointChanged && !draft.clear_key ? '已配置，留空保留' : '输入当前服务的 API Key（可留空）'} />
          </Form.Item>
          <Form.Item name="clear_key" valuePropName="checked">
            <Checkbox id="ai-clear-key" disabled={Boolean(busy) || !saved.has_key || endpointChanged}>删除已保存的密钥</Checkbox>
          </Form.Item>
          {endpointChanged && <Alert type="warning" showIcon style={{ marginBottom: 16 }}
            title="服务地址或提供商已更改，原密钥不会用于新服务。请重新输入该服务的密钥；内部无密钥服务可留空。" />}
          <Form.Item name="model" label="模型 ID" rules={[{ required: true, whitespace: true, message: '请选择或输入模型 ID' }]}>
            <AutoComplete id="ai-model" options={models} allowClear
              filterOption={(input, option) => option.value.toLowerCase().includes(input.toLowerCase())}>
              <Input maxLength={200} placeholder="从模型列表选择，或直接输入模型 ID" />
            </AutoComplete>
          </Form.Item>
          <Flex gap={8} wrap>
            <Button id="save-ai-config" type="primary" htmlType="submit" loading={busy === 'save'} disabled={Boolean(busy) || !dirty || needsReload}>保存配置</Button>
            <Button id="preset-deepseek" onClick={fillDeepSeekPreset} disabled={Boolean(busy)}>填入 DeepSeek 预设</Button>
            <Button id="reload-ai-config" onClick={confirmReload} loading={busy === 'reload'} disabled={Boolean(busy)}>重新读取配置</Button>
          </Flex>
        </Form>
        {dirty && !needsReload && <Alert type="info" showIcon title="有未保存的修改，请先保存，再读取模型列表或测试连接。" />}
        <Flex gap={8} wrap>
          <Button id="load-ai-models" onClick={() => savedAction('models')} loading={busy === 'models'}
            disabled={Boolean(busy) || dirty || needsReload}>读取模型列表</Button>
          <Button id="test-ai" onClick={() => savedAction('test')} loading={busy === 'test'}
            disabled={Boolean(busy) || dirty || needsReload}>测试模型连接</Button>
        </Flex>
        <Typography.Text type="secondary">读取模型和连接测试使用服务端已保存的配置。选择模型后需再次保存。</Typography.Text>
        {feedback && <Alert showIcon {...feedback} />}
      </Flex>
    </Card>
  );
}
