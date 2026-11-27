"""Profile one saved resume with the configured model, using an isolated DB snapshot.

Calls the real model once (plus the application's existing bounded retries).
Production candidates, evaluation history, settings, and platform actions are untouched.
"""
import argparse
from contextlib import closing, contextmanager
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server
from evaluation_trace import trace_run


def profile(candidate_id=None):
    original_db = server.DB
    config = server.load_config(original_db.parent / 'ai-config.json')
    runtime = server.ai_runtime_config()
    log_directory = original_db.parent / 'evaluation-logs'
    traces = []

    def local_trace(_directory, operation, **metadata):
        return trace_run(log_directory, operation, **metadata)

    # sqlite backup is consistent even if the live application is still open.
    with tempfile.TemporaryDirectory(prefix='recruitment-timing-') as directory:
        snapshot = Path(directory) / 'profile.sqlite3'
        with closing(sqlite3.connect(original_db.as_uri() + '?mode=ro', uri=True)) as source:
            with closing(sqlite3.connect(snapshot)) as target:
                source.backup(target)
        with closing(sqlite3.connect(snapshot)) as target, target:
            if candidate_id is None:
                row = target.execute('''SELECT c.id FROM candidates c JOIN evaluations e ON e.candidate_id=c.id
                    WHERE c.deleted=0 ORDER BY e.id DESC LIMIT 1''').fetchone()
                if row is None:
                    raise ValueError('No saved evaluated candidate is available')
                candidate_id = row[0]
            if target.execute('SELECT 1 FROM candidates WHERE id=? AND deleted=0', (candidate_id,)).fetchone() is None:
                raise ValueError('Candidate not found')
            # Force a genuine request only in the disposable snapshot.
            target.execute('DELETE FROM evaluation_inputs WHERE evaluation_id IN '
                           '(SELECT id FROM evaluations WHERE candidate_id=?)', (candidate_id,))

        @contextmanager
        def capture_trace(_directory, operation, **metadata):
            with local_trace(_directory, operation, **metadata) as trace:
                if trace not in traces:
                    traces.append(trace)
                yield trace

        with patch.object(server, 'DB', snapshot), \
             patch.object(server, 'load_config', return_value=config), \
             patch.object(server, 'ai_runtime_config', return_value=runtime), \
             patch.object(server, 'trace_run', side_effect=capture_trace):
            task = server.submit_ai_request('/api/ai/evaluate', {'id':candidate_id})
            queue = server.ai_queue()
            try:
                status, _ = queue.wait(task['id'])
            finally:
                queue.shutdown(wait=True)

    trace = traces[0]
    if trace.path is None or trace.summary_path is None:
        raise RuntimeError('Timing files could not be written')
    records = [json.loads(line) for line in trace.path.read_text(encoding='utf-8').splitlines()]
    ending = next(row for row in reversed(records) if row['event'] == 'trace_end')
    stages = [row for row in records if row['event'] == 'stage_end']
    by_step = {}
    for row in stages:
        by_step[row['step']] = by_step.get(row['step'], 0) + row['self_duration_ms']
    calls = sum(row['step'] == 'http_request' for row in stages)
    attempts = sum(row['step'] == 'model_attempt' for row in stages)
    analysis = trace.path.with_suffix('.analysis.txt')
    total = ending['total_duration_ms']
    lines = [
        '单份简历评估耗时分析（真实模型调用）',
        '使用最近评估的已保存候选人，或命令行指定的候选人。',
        '候选人编号: %s' % candidate_id,
        '模型: %s' % config['model'],
        '评估代次: %s' % config.get('evaluation_epoch', 0),
        'HTTP结果: %s' % status,
        '验证方式: 一致性数据库快照；仅清除快照中该候选人的缓存关联，强制实际推理。',
        '保存阶段写入临时快照，测试结束自动清理；正式评估历史、配置及前端不变。',
        '提交准备: %.3f ms' % ending.get('submission_duration_ms', 0),
        '排队等待: %.3f ms' % ending['queue_wait_ms'],
        '执行总耗时: %.3f ms' % total,
        '服务端工作流总耗时: %.3f ms' % ending['end_to_end_ms'],
        '实际HTTP请求次数: %d；模型评估轮数: %d' % (calls, attempts),
        '', '耗时最大的阶段（自身耗时，已扣除嵌套子阶段）:',
    ]
    for step, duration in sorted(by_step.items(), key=lambda item:item[1], reverse=True)[:8]:
        lines.append('%s: %.3f ms，占执行时间 %.2f%%' % (step, duration, duration / total * 100 if total else 0))
    lines += ['', 'Token用量: ' + json.dumps(ending['usage_totals'], ensure_ascii=False),
              '详细逐阶段摘要: ' + str(trace.summary_path),
              '原始事件日志: ' + str(trace.path),
              '', 'HTTP等待包含网络、服务端排队与模型处理；非流式接口无法再拆开这些时间。',
              '本次仅为一份简历的单次样本，不能直接作为两个模型的平均性能比较。']
    analysis.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return {'candidate_id':candidate_id, 'model':config['model'], 'http_status':status,
            'total_ms':ending['end_to_end_ms'], 'analysis':str(analysis),
            'summary':str(trace.summary_path), 'events':str(trace.path)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate-id', type=int)
    args = parser.parse_args()
    print(json.dumps(profile(args.candidate_id), ensure_ascii=True))
