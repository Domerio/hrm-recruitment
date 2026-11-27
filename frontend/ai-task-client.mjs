const taskStates = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const terminal = state => ['succeeded', 'failed', 'cancelled', 'unavailable'].includes(state);
const errorText = error => typeof error?.message === 'string' ? error.message : '任务请求失败，请重试。';

function readTask(body, expectedId) {
  const task = body?.task;
  if (!task || typeof task.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(task.id)
      || !taskStates.has(task.state) || expectedId && task.id !== expectedId) {
    const error = new Error('AI 任务状态返回格式无效，请刷新后核对。');
    error.code = 'invalid_task_response';
    throw error;
  }
  return task;
}

export async function submitAiTask(api, candidateId) {
  if (!Number.isSafeInteger(candidateId) || candidateId <= 0) throw new Error('候选人编号无效。');
  const response = await api('/api/ai/tasks', {action:'evaluate', data:{id:candidateId}});
  const task = readTask(await response.json());
  if (!terminal(task.state) && (typeof task.subscription_id !== 'string' || !task.subscription_id))
    throw new Error('AI 任务未返回本次订阅凭据，请刷新后核对后台任务。');
  return task;
}

export async function getAiTask(api, taskId) {
  const response = await api(`/api/ai/tasks/${encodeURIComponent(taskId)}`);
  return readTask(await response.json(), taskId);
}

export async function cancelAiTask(api, taskId, subscriptionId) {
  if (typeof subscriptionId !== 'string' || !subscriptionId) throw new Error('缺少本次任务的取消凭据。');
  const response = await api(`/api/ai/tasks/${encodeURIComponent(taskId)}/cancel`, {subscription_id:subscriptionId});
  return readTask(await response.json(), taskId);
}

export function aiTaskLabel(entry) {
  if (entry?.state === 'queued') return Number.isSafeInteger(entry.position) && entry.position > 0
    ? `排队中 · 第 ${entry.position} 位` : '排队中';
  return {waiting:'等待提交', submitting:'正在提交', running:'正在评估', succeeded:'已完成', failed:'评估失败',
    cancelled:'已停止等待', unavailable:'状态读取失败'}[entry?.state] || '等待提交';
}

// HTTP submissions are bounded independently of model concurrency. All accepted
// jobs live on the server; detaching a page never cancels those jobs.
export function createAiTaskBatch({api, targets, onUpdate = () => {}, pollInterval = 1000, maxInFlight = 50,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 50)
    throw new Error('本批任务窗口须为 1 至 50。');
  const seen = new Set();
  const entries = targets.map(target => {
    if (!Number.isSafeInteger(target.id) || target.id <= 0 || seen.has(target.id)) throw new Error('评估名单无效或重复。');
    seen.add(target.id);
    return {id:target.id, name:target.name || '', job_id:target.job_id, state:'waiting', taskId:'', position:null};
  });
  let stopping = false, detached = false, started = false;
  const subscriptions = new Map(), released = new Set();
  const snapshot = () => {
    const tasks = entries.map(entry => ({...entry}));
    const failures = tasks.filter(entry => ['failed','unavailable'].includes(entry.state));
    return {tasks, total:tasks.length, completed:tasks.filter(entry => terminal(entry.state)).length,
      success:tasks.filter(entry => entry.state === 'succeeded').length,
      reused:tasks.filter(entry => entry.state === 'succeeded' && entry.result?.cached).length,
      failed:failures.length, cancelled:tasks.filter(entry => entry.state === 'cancelled').length,
      waiting:tasks.filter(entry => entry.state === 'waiting').length,
      submitting:tasks.filter(entry => entry.state === 'submitting').length,
      queued:tasks.filter(entry => entry.state === 'queued').length,
      activeCount:tasks.filter(entry => entry.state === 'running').length,
      failures, running:tasks.some(entry => !terminal(entry.state)), stopping,
      stopped:stopping, detached};
  };
  const publish = () => { if (!detached) onUpdate(snapshot()); };
  const accept = (entry, task) => {
    entry.taskId = task.id;
    entry.state = task.state;
    entry.position = Number.isSafeInteger(task.position) ? task.position : null;
    entry.status = task.status;
    entry.result = task.result;
    entry.message = task.state === 'failed' ? task.result?.error || '评估失败，请查看候选人的诊断信息。'
      : task.state === 'cancelled' ? '本次排队任务已取消。' : '';
    delete entry.pollError;
  };
  const pool = async (items, action) => {
    let cursor = 0;
    await Promise.all(Array.from({length:Math.min(4, items.length)}, async () => {
      while (cursor < items.length) await action(items[cursor++]);
    }));
  };
  const release = async entry => {
    if (!entry.taskId || terminal(entry.state) || released.has(entry.taskId)) return;
    try {
      const task = await cancelAiTask(api, entry.taskId, subscriptions.get(entry.taskId));
      released.add(entry.taskId);
      accept(entry, task);
      // Another subscriber may still need this queued job. We stop waiting for
      // our released subscription without cancelling or claiming their work.
      if (task.state === 'queued') {
        entry.state = 'cancelled';
        entry.message = '已停止本次等待，共享任务仍由后台处理。';
      }
      delete entry.cancelError;
    } catch (error) { entry.cancelError = `停止请求未确认：${errorText(error)}`; }
    publish();
  };
  return {
    stop() { stopping = true; publish(); },
    detach() { detached = true; },
    async run() {
      if (started) throw new Error('此批任务已经开始。');
      started = true;
      publish();
      // Only a bounded rolling window is accepted at once. Observe completed
      // jobs before refilling it, so a large batch cannot outrun server retention.
      let capacityBlocked = false;
      const polledSincePause = new Set();
      const submit = async entry => {
        if (stopping || detached) return;
        entry.state = 'submitting';
        publish();
        try {
          const task = await submitAiTask(api, entry.id);
          if (task.subscription_id) subscriptions.set(task.id, task.subscription_id);
          accept(entry, task);
        } catch (error) {
          if (error.status === 503 && error.code === 'ai_queue_full') {
            // This explicit rejection guarantees the server did not accept a
            // job. Other submission errors may be ambiguous and are not retried.
            entry.state = 'waiting';
            entry.message = '后台队列已满，等待空位后自动提交。';
            capacityBlocked = true;
          } else { entry.state = 'failed'; entry.message = `提交未确认：${errorText(error)}`; }
        }
        publish();
      };
      while (entries.some(entry => !terminal(entry.state))) {
        if (stopping) {
          for (const entry of entries.filter(entry => entry.state === 'waiting')) {
            entry.state = 'cancelled'; entry.message = '已停止，未提交此候选人。';
          }
          publish();
          await pool(entries, release);
        }
        if (detached || entries.every(entry => terminal(entry.state))) break;
        const accepted = entries.filter(entry => entry.taskId && !terminal(entry.state));
        const submissions = stopping || capacityBlocked ? [] : entries.filter(entry => entry.state === 'waiting')
          .slice(0, Math.min(4, maxInFlight - accepted.length));
        const polling = accepted.filter(entry => !polledSincePause.has(entry.taskId));
        polling.forEach(entry => polledSincePause.add(entry.taskId));
        // Submission and status requests progress together; a full queue never
        // holds up observation of already accepted work.
        await Promise.all([pool(submissions, submit), pool(polling, async entry => {
          if (detached) return;
          try { accept(entry, await getAiTask(api, entry.taskId)); }
          catch (error) {
            if (error.code === 'invalid_task_response' || [403,404,410].includes(error.status)) {
              entry.state = 'unavailable'; entry.message = `无法继续查看任务：${errorText(error)}。后台任务可能仍在执行，请刷新列表核对。`;
            } else entry.pollError = `状态更新暂不可用，将继续重试：${errorText(error)}`;
          }
          publish();
        })]);
        if (detached || entries.every(entry => terminal(entry.state))) break;
        const active = entries.filter(entry => entry.taskId && !terminal(entry.state));
        const canSubmit = !stopping && !capacityBlocked && active.length < maxInFlight
          && entries.some(entry => entry.state === 'waiting');
        const canPoll = active.some(entry => !polledSincePause.has(entry.taskId));
        if (!canSubmit && !canPoll) {
          await pause(pollInterval);
          capacityBlocked = false;
          polledSincePause.clear();
        }
      }
      publish();
      return snapshot();
    },
  };
}
