import {useEffect, useRef, useState} from 'react';
import {Alert, Button, Card, Flex, InputNumber, Tag, Typography} from 'antd';

const stateLabels = {queued:'排队中', running:'运行中', succeeded:'已完成', failed:'失败', cancelled:'已取消'};
const stateColors = {queued:'gold', running:'blue', succeeded:'green', failed:'red'};
const text = value => typeof value === 'string' ? value.slice(0, 160) : '';
const readBody = async response => typeof response?.json === 'function' ? response.json() : response;

function readSettings(value) {
  if (!value || !Number.isInteger(value.max_concurrency) || value.max_concurrency < 1 || value.max_concurrency > 8
      || !Number.isSafeInteger(value.queued) || value.queued < 0
      || !Number.isSafeInteger(value.running) || value.running < 0) throw Error('Invalid task settings');
  return {max_concurrency:value.max_concurrency, queued:value.queued, running:value.running,
    max_pending:Number.isSafeInteger(value.max_pending) && value.max_pending > 0 ? value.max_pending : 100};
}

function recentTasks(tasks) {
  if (!Array.isArray(tasks)) throw Error('Invalid task list');
  // Keep only the public fields needed here; results, resumes and credentials never reach the view.
  return tasks.filter(row => row && typeof row === 'object').map((row, index) => ({
    key:`${text(row.id)}-${index}`, state:Object.hasOwn(stateLabels, row.state) ? row.state : 'unknown',
    position:Number.isSafeInteger(row.position) && row.position > 0 ? row.position : null,
    name:text(row.metadata?.candidate_name), job:text(row.metadata?.job_title),
    created:text(row.created_at),
  })).sort((a,b) => (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0)).slice(0,20);
}

export default function AiTaskSettings({api, notify}) {
  const [settings, setSettings] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [draft, setDraft] = useState(3);
  const [known, setKnown] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = useRef(false);
  const controller = useRef(null);

  useEffect(() => {
    const current = {active:true, reading:false, saving:false, sequence:0, known:false, settings:null};
    controller.current = current;
    dirty.current = false;
    setSettings(null); setTasks([]); setDraft(3); setKnown(false); setError(''); setSaving(false);
    current.refresh = async () => {
      if (!current.active || current.reading || current.saving) return;
      current.reading = true;
      const sequence = ++current.sequence;
      try {
        const body = await readBody(await api('/api/ai/tasks'));
        const nextSettings = readSettings(body?.settings), nextTasks = recentTasks(body?.tasks);
        if (!current.active || sequence !== current.sequence) return;
        current.settings = nextSettings; current.known = true;
        setSettings(nextSettings); setTasks(nextTasks); setKnown(true); setError('');
        if (!dirty.current) setDraft(nextSettings.max_concurrency);
      } catch {
        if (!current.active || sequence !== current.sequence) return;
        current.known = false;
        setKnown(false); setError('暂时无法读取任务状态，正在重试；确认状态前不能保存并发设置。');
      } finally { current.reading = false; }
    };
    void current.refresh();
    const timer = setInterval(() => { void current.refresh(); }, 3000);
    return () => { current.active = false; ++current.sequence; clearInterval(timer); };
  }, [api]);

  const validDraft = Number.isInteger(draft) && draft >= 1 && draft <= 8;
  const busy = Boolean(settings?.queued || settings?.running);
  async function save() {
    const current = controller.current;
    if (!current?.active || !current.known || current.saving || !validDraft
        || current.settings.queued || current.settings.running) return;
    current.saving = true;
    const sequence = ++current.sequence;
    setSaving(true); setError('');
    try {
      const body = await readBody(await api('/api/ai/runtime', {max_concurrency:draft}));
      const next = readSettings(body?.settings ?? body);
      if (!current.active || sequence !== current.sequence) return;
      current.settings = next; current.known = true;
      dirty.current = false;
      setSettings(next); setDraft(next.max_concurrency); setKnown(true);
      notify?.('AI 并发设置已保存。');
    } catch {
      if (!current.active || sequence !== current.sequence) return;
      current.known = false;
      setKnown(false); setError('未能确认并发设置已保存，请等待任务状态刷新后重试。');
    } finally {
      current.saving = false;
      if (current.active && sequence === current.sequence) setSaving(false);
    }
  }

  return <Card title="AI 任务与并发" size="small">
    <Flex vertical gap={12}>
      <Typography.Text type="secondary">所有工作台访问者共用任务队列。默认同时运行 3 个任务，可设置为 1–8 个；任务排队或运行期间不能更改。</Typography.Text>
      <Flex gap={8} align="center" wrap>
        <label htmlFor="ai-task-concurrency">同时运行任务数</label>
        <InputNumber id="ai-task-concurrency" min={1} max={8} precision={0} value={draft} disabled={saving}
          onChange={value => { dirty.current = true; setDraft(value); }} />
        <Button onClick={save} loading={saving} disabled={!known || busy || saving || !validDraft}>保存并发设置</Button>
      </Flex>
      {error && <Alert type="warning" title={error} showIcon />}
      <Typography.Text role="status">
        {known ? `正在运行 ${settings.running} 个 · 排队 ${settings.queued} 个 · 最多排队 ${settings.max_pending} 个`
          : error ? '当前任务状态未知' : '正在读取任务状态…'}
      </Typography.Text>
      <Typography.Text strong>最近 20 条公共任务</Typography.Text>
      {tasks.length ? <ul style={{listStyle:'none', margin:0, padding:0}}>
        {tasks.map(task => <li key={task.key} style={{padding:'8px 0', borderBottom:'1px solid #f0f0f0'}}>
          <Flex gap={8} align="center" wrap>
            <Tag color={stateColors[task.state]}>{stateLabels[task.state] || '状态更新中'}{task.state === 'queued' && task.position ? ` · 第 ${task.position} 位` : ''}</Tag>
            <Typography.Text>{task.name || 'AI 任务'}{task.job ? ` · ${task.job}` : ''}</Typography.Text>
            {task.created && <Typography.Text type="secondary">{task.created}</Typography.Text>}
          </Flex>
        </li>)}
      </ul> : known ? <Typography.Text type="secondary">暂无任务记录</Typography.Text> : null}
    </Flex>
  </Card>;
}
