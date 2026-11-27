import { useEffect, useRef, useState } from 'react';
import {
  Alert, App, AutoComplete, Button, Card, Checkbox, Descriptions, Flex, Form, Input, Select, Tag, Typography,
} from 'antd';
import {profileKinds,profileProviders,kindLabel,profileEndpoint,profileFormValues,isProfileDirty,
  validProfileUrl,safeCatalog,profilePayload} from './ai-profile-helpers.mjs';
import AiTaskSettings from './AiTaskSettings';

export default function AiConfiguration({ state, refresh, api, notify }) {
  const [form] = Form.useForm();
  const [catalog,setCatalog] = useState(null);
  const catalogRef = useRef(null);
  const [selectedId,setSelectedId] = useState(null);
  const selectedRef = useRef(null);
  const [draft,setDraft] = useState(profileFormValues);
  const draftRef = useRef(draft);
  const [busy,setBusy] = useState('');
  const busyRef = useRef('');
  const [models,setModels] = useState([]);
  const [feedback,setFeedback] = useState(null);
  const [needsReload,setNeedsReload] = useState(false);
  const [recovering,setRecovering] = useState(false);
  const loadSequence = useRef(0);
  const {modal} = App.useApp();
  const saved = catalog?.profiles.find(row => row.id === selectedId);
  const active = catalog?.profiles.find(row => row.id === catalog.active_profile_id);
  const dirty = isProfileDirty(draft,saved);
  const activeSelected = Boolean(saved && saved.id === catalog?.active_profile_id);
  const endpointChanged = Boolean(saved && profileEndpoint(draft) !== profileEndpoint(saved));
  const locked = Boolean(busy) || (!catalog && !recovering) || needsReload;

  function selectProfile(id,nextCatalog=catalogRef.current) {
    const profile = nextCatalog?.profiles.find(row => row.id === id);
    const values = profileFormValues(profile);
    selectedRef.current = profile?.id || null;
    setSelectedId(selectedRef.current);
    draftRef.current = values;
    setDraft(values);
    form.setFieldsValue(values);
    setModels([]);
    setFeedback(null);
  }
  function applyCatalog(value,preferred=selectedRef.current) {
    const next = safeCatalog(value);
    catalogRef.current = next;
    setCatalog(next);
    selectProfile(next.profiles.some(row => row.id === preferred) ? preferred : next.active_profile_id,next);
    setNeedsReload(false);
    setRecovering(false);
    return next;
  }
  async function readCatalog() {
    const response = await fetch('/api/ai/profiles',{cache:'no-store'});
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      throw Error(result?.error || '无法读取模型配置，请稍后重试。');
    }
    return safeCatalog(await response.json());
  }
  async function reload() {
    if (busyRef.current) return;
    const sequence = ++loadSequence.current;
    busyRef.current = 'reload'; setBusy('reload');
    try {
      const next = await readCatalog();
      if (sequence !== loadSequence.current) return;
      applyCatalog(next);
      setFeedback({type:'success',title:'已读取保存的模型配置。'});
    } catch (error) {
      if (sequence === loadSequence.current) setFeedback({type:'error',title:error.message});
    } finally {
      if (sequence === loadSequence.current) {busyRef.current = ''; setBusy('');}
    }
  }
  useEffect(() => {
    const savedRow = catalogRef.current?.profiles.find(row => row.id === selectedRef.current);
    if (!busyRef.current && !isProfileDirty(draftRef.current,savedRow) &&
        (!catalogRef.current || state.ai_config?.revision !== catalogRef.current.revision)) void reload();
  },[state.ai_config?.revision]);
  useEffect(() => () => {loadSequence.current++;},[]);

  function confirmDiscard(next,title='切换模型配置') {
    if (busyRef.current) return;
    const savedRow = catalogRef.current?.profiles.find(row => row.id === selectedRef.current);
    if (!isProfileDirty(form.getFieldsValue(),savedRow)) {next(); return;}
    modal.confirm({title,content:'当前修改尚未保存，继续将放弃这些修改。',
      okText:'放弃修改并继续',cancelText:'继续编辑',onOk:next});
  }
  function changeValues(changed,values) {
    let next = {...values};
    if ('kind' in changed) {
      if (next.kind === 'ocr') next.provider = 'paddleocr';
      else if (next.provider === 'paddleocr' || next.kind === 'asr') next.provider = 'openai-compatible';
    }
    if (profileEndpoint(next) !== profileEndpoint(draftRef.current)) {
      next.api_key = ''; next.clear_key = false; setModels([]);
    } else if (changed.clear_key) next.api_key = '';
    form.setFieldsValue(next);
    draftRef.current = next; setDraft(next); setFeedback(null);
  }
  function fillDeepSeekPreset() {
    const values = {...form.getFieldsValue(),kind:'text',provider:'deepseek',
      base_url:'https://api.deepseek.com',model:'deepseek-chat'};
    if (!values.name) values.name = 'DeepSeek';
    changeValues({kind:'text',provider:'deepseek',base_url:values.base_url},values);
  }
  async function mutate(action,values) {
    if (busyRef.current || needsReload || (!catalogRef.current && !recovering)) return;
    const before = catalogRef.current, id = selectedRef.current;
    busyRef.current = action; setBusy(action); setFeedback(null);
    let written = false;
    try {
      const repair = recovering && action === 'save';
      const request = repair ? {...profilePayload(values),revision:0} : {revision:before.revision,action,
        ...(id ? {id} : {}),...(values ? {profile:profilePayload(values)} : {})};
      const response = await api(repair ? '/api/ai/config' : '/api/ai/profiles',request);
      written = true;
      form.setFieldValue('api_key','');
      draftRef.current = {...draftRef.current,api_key:''}; setDraft(draftRef.current);
      const result = await response.json();
      let next;
      try {next = safeCatalog(result.catalog);} catch {next = await readCatalog();}
      const created = next.profiles.filter(row => !before?.profiles.some(old => old.id === row.id));
      const preferred = action === 'delete' ? next.active_profile_id : id ||
        (created.length === 1 ? created[0].id : next.active_profile_id);
      applyCatalog(next,preferred);
      let refreshFailed = false;
      try {await refresh();} catch {refreshFailed = true;}
      const pending = Number.isInteger(result.pending_candidates) && result.pending_candidates > 0
        ? `，${result.pending_candidates} 名候选人已标记待重评` : '';
      const title = (action === 'activate' ? '已切换简历评估模型' : action === 'delete' ? '已删除模型配置' : '模型配置已保存')+pending+'。';
      setFeedback({type:refreshFailed?'warning':'success',title:refreshFailed?title+'工作台状态刷新失败，请刷新页面。':title});
      notify(title);
    } catch (error) {
      if (written) {
        setNeedsReload(true);
        setFeedback({type:'warning',title:'配置已写入，暂时无法确认最新列表。请重新读取配置后继续操作。'});
      } else {
        if (error.status === 409 && error.code === 'record_conflict') setNeedsReload(true);
        setFeedback({type:'error',title:error.message});
      }
    } finally {busyRef.current = ''; setBusy('');}
  }
  function deleteProfile() {
    if (!saved || activeSelected || busyRef.current) return;
    const id = saved.id, revision = catalogRef.current.revision;
    modal.confirm({title:`删除模型配置「${saved.name}」`,content:'将删除此模型的地址、模型 ID 和已保存的密钥。',
      okText:'删除配置',okButtonProps:{danger:true},cancelText:'保留',onOk:() => {
        if (selectedRef.current !== id || catalogRef.current?.revision !== revision) {
          setFeedback({type:'warning',title:'模型列表已更新，请重新核对要删除的配置。'});
          return;
        }
        return mutate('delete');
      }});
  }
  async function savedAction(action) {
    if (busyRef.current || needsReload || !saved || saved.kind !== 'text' || dirty) return;
    busyRef.current = action; setBusy(action); setFeedback(null);
    try {
      const response = await api(action === 'models' ? '/api/ai/models' : '/api/ai/test',
        {profile_id:saved.id,revision:catalogRef.current.revision});
      if (action === 'models') {
        const result = await response.json();
        if (!Array.isArray(result.models)) throw Error('模型列表响应无效，仍可手动输入模型 ID。');
        const ids = [...new Set(result.models.filter(row => typeof row?.id === 'string' && row.id.trim()).map(row => row.id.trim()))];
        setModels(ids.sort().map(value => ({value})));
        setFeedback({type:ids.length?'success':'info',title:ids.length?`已读取 ${ids.length} 个模型，可选择或手动输入模型 ID。`:'服务未返回模型列表，仍可手动输入模型 ID。'});
      } else setFeedback({type:'success',title:'连接成功，所选模型的 JSON 输出验证通过。'});
    } catch (error) {
      if (error.status === 409 && error.code === 'record_conflict') setNeedsReload(true);
      setFeedback({type:'error',title:error.message});
    } finally {busyRef.current = ''; setBusy('');}
  }
  const urlRule = optional => ({validator:async (_,value) => {
    if (!validProfileUrl(value,optional)) throw Error('请输入不含账号、查询参数或片段的 HTTP / HTTPS 地址');
  }});
  const providers = profileProviders.filter(row => draft.kind === 'ocr' ? row.value === 'paddleocr' :
    draft.kind === 'asr' ? row.value === 'openai-compatible' : row.value !== 'paddleocr');

  return <Card title="AI 模型配置" style={{height:'100%'}} extra={<Tag color="blue">{catalog?.profiles.length || '—'} 个配置</Tag>}>
    <Flex vertical gap={14}>
      <Descriptions size="small" column={1} items={[
        {key:'active',label:'当前评估模型',children:active?.name || state.model || '—'},
      ]}/>
      <Flex gap={8} align="center" wrap>
        <Select id="ai-profile" aria-label="选择模型配置" style={{flex:'1 1 240px',minWidth:0}}
          value={selectedId || undefined} placeholder={catalog?'新增配置':'正在读取模型配置…'}
          disabled={Boolean(busy)||!catalog} showSearch optionFilterProp="label"
          options={(catalog?.profiles || []).map(row => ({value:row.id,
            label:`${row.name} · ${kindLabel(row.kind)}${row.id === catalog.active_profile_id?' · 当前使用':''}`}))}
          onChange={id => confirmDiscard(() => selectProfile(id))}/>
        <Button id="add-ai-profile" disabled={locked} onClick={() => confirmDiscard(() => selectProfile(null),'新增模型配置')}>新增模型</Button>
      </Flex>
      <Typography.Text type="secondary">选择配置可查看和编辑；文字模型保存后可单独设为简历评估模型。</Typography.Text>
      {!catalog && state.ai_config?.source === 'invalid' && !recovering && <Button id="repair-ai-config"
        disabled={Boolean(busy)} onClick={() => {selectProfile(null); setRecovering(true); setNeedsReload(false);}}>
        重新配置评估模型
      </Button>}
      {recovering && <Alert type="warning" showIcon title="原配置文件无法读取。保存将用新的文字评估配置修复该文件。"/>}
      <Form form={form} layout="vertical" initialValues={draftRef.current} onValuesChange={changeValues}
        onFinish={values => mutate('save',values)} disabled={locked}>
        {!recovering && <Form.Item name="name" label="配置名称" rules={[{required:true,whitespace:true,message:'请输入配置名称'}]}>
          <Input id="ai-profile-name" maxLength={100} autoComplete="off" placeholder="便于区分的名称"/>
        </Form.Item>}
        <Flex gap={12} wrap>
          <Form.Item name="kind" label="模型用途" style={{flex:'1 1 180px'}}>
            <Select id="ai-profile-kind" options={profileKinds} disabled={locked || activeSelected || recovering}/>
          </Form.Item>
          <Form.Item name="provider" label="接口类型" style={{flex:'1 1 180px'}}>
            <Select id="ai-provider" options={providers}/>
          </Form.Item>
        </Flex>
        {draft.kind !== 'text' && <Alert type="info" showIcon style={{marginBottom:16}}
          title={`${kindLabel(draft.kind)}服务当前仅保存配置，识别功能尚未接入。`}/>}
        <Form.Item name="base_url" label="API 基础地址" rules={[urlRule(false)]}
          extra={draft.kind === 'ocr'?'例如 http://内网地址:9031；调用路径为 /layout-parsing。':'例如 http://内网地址:9030/v1；调用路径为 /chat/completions。'}>
          <Input id="ai-base-url" maxLength={2000} autoComplete="off"/>
        </Form.Item>
        <Form.Item name="model" label="模型 ID" rules={[{required:true,whitespace:true,message:'请选择或输入模型 ID'}]}>
          <AutoComplete id="ai-model" options={models} allowClear filterOption={(input,option) => option.value.toLowerCase().includes(input.toLowerCase())}>
            <Input maxLength={200} placeholder="从模型列表选择，或直接输入模型 ID"/>
          </AutoComplete>
        </Form.Item>
        <Form.Item name="api_key" label="API Key" extra="留空保留此配置的密钥；内部无密钥服务可留空。密钥不会回填。">
          <Input.Password id="ai-api-key" maxLength={4000} autoComplete="new-password" disabled={locked || draft.clear_key}
            placeholder={saved?.has_key && !endpointChanged && !draft.clear_key?'已配置，留空保留':'可留空'}/>
        </Form.Item>
        <Form.Item name="clear_key" valuePropName="checked">
          <Checkbox id="ai-clear-key" disabled={locked || !saved?.has_key || endpointChanged}>删除此配置已保存的密钥</Checkbox>
        </Form.Item>
        {endpointChanged && saved?.has_key && <Typography.Paragraph type="secondary">服务地址或接口类型已更改，原密钥不会用于新服务。</Typography.Paragraph>}
        {!recovering && <Form.Item name="docs_url" label="API 文档（可选）" rules={[urlRule(true)]}>
          <Input id="ai-docs-url" maxLength={2000} autoComplete="off" placeholder="http://内网地址:端口/docs"/>
        </Form.Item>}
        <Flex gap={8} wrap>
          <Button id="save-ai-config" type="primary" htmlType="submit" loading={busy === 'save'} disabled={locked || (!dirty && Boolean(saved))}>保存配置</Button>
          {draft.kind === 'text' && <Button id="preset-deepseek" onClick={fillDeepSeekPreset} disabled={locked}>填入 DeepSeek 预设</Button>}
          <Button id="delete-ai-profile" danger disabled={locked || !saved || activeSelected || dirty} onClick={deleteProfile}>删除配置</Button>
        </Flex>
      </Form>
      {dirty && <Typography.Text type="secondary">有未保存的修改。请先保存，再启用或测试此模型。</Typography.Text>}
      <Flex gap={8} wrap>
        {saved?.kind === 'text' && <>
          <Button id="activate-ai-profile" disabled={locked || dirty || activeSelected} loading={busy === 'activate'} onClick={() => mutate('activate')}>
            {activeSelected?'当前用于简历评估':'用于简历评估'}
          </Button>
          <Button id="load-ai-models" disabled={locked || dirty} loading={busy === 'models'} onClick={() => savedAction('models')}>读取模型列表</Button>
          <Button id="test-ai" disabled={locked || dirty} loading={busy === 'test'} onClick={() => savedAction('test')}>测试模型连接</Button>
        </>}
        {saved?.docs_url && <Button type="link" href={saved.docs_url} target="_blank" rel="noopener noreferrer">查看 API 文档 ↗</Button>}
        <Button id="reload-ai-config" loading={busy === 'reload'} disabled={Boolean(busy)} onClick={() => confirmDiscard(() => reload(),'重新读取模型配置')}>重新读取配置</Button>
      </Flex>
      {feedback && <Alert showIcon {...feedback}/>}
      <AiTaskSettings api={api} notify={notify}/>
    </Flex>
  </Card>;
}
