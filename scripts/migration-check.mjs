import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
// 用 vite 自带的 esbuild 把 TS store 转成可在 node 直接跑的 ESM
const result = await build({
  entryPoints: [resolve(root, 'src/store.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  external: ['@reduxjs/toolkit'],
  absWorkingDir: root
});
mkdirSync(resolve(root, '.tmp-test'), { recursive: true });
writeFileSync(resolve(root, '.tmp-test/store.mjs'), result.outputFiles[0].text);

const { store } = await import(resolve(root, '.tmp-test/store.mjs'));

let failures = 0;
function assert(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else { failures += 1; console.error(`  ❌ ${name} ${detail}`); }
}
const state = () => store.getState().schema;

console.log('1) 发布 v2：按容量 2 切批，4 条快照 → 2 批排队');
store.dispatch({ type: 'schema/publishVersion' });
{
  const s = state();
  assert('生成 2 个批次', s.batches.length === 2, `got ${s.batches.length}`);
  assert('第 1 批排队', s.batches[0].status === 'queued', s.batches[0].status);
  assert('第 2 批排队', s.batches[1].status === 'queued', s.batches[1].status);
  assert('第 1 批容量=2', s.batches[0].items.length === 2);
  assert('第 2 批容量=2', s.batches[1].items.length === 2);
  assert('活跃版本是 v2', s.activeVersionId === 'v2');
}

console.log('2) 执行第 1 批：两条都可写（s1 财务缺预算科目 → 应阻塞）');
// s1 部门=财务，v2 规则 r1 要求 budgetCode 必填 → s1 阻塞
store.dispatch({ type: 'schema/runBatch', payload: { batchId: state().batches[0].id } });
{
  const batch = state().batches[0];
  assert('第 1 批因 s1 阻塞挂起', batch.status === 'blocked', batch.status);
  assert('checkpoint 停在 0（s1 没写入）', batch.checkpoint === 0, `cp=${batch.checkpoint}`);
  assert('s1 标记 blocked', batch.items[0].status === 'blocked');
  assert('s2 仍是 pending（后续快照排队等待）', batch.items[1].status === 'pending');
  assert('流水为空', state().journal.length === 0);
}

console.log('3) 容量闸门：第 2 批此时不能抢先执行（reducer 不拦截直接调用，但 executeBatch 可跑——验证业务上前序未完时后续仍 queued 的判定在 UI；这里验证第 2 批独立执行不串账）');
// 直接对第 2 批执行：s3 可写、s4 缺 amount 必填 → 写 1 条后阻塞
store.dispatch({ type: 'schema/runBatch', payload: { batchId: state().batches[1].id } });
{
  const b2 = state().batches[1];
  assert('第 2 批写 s3 后在 s4 阻塞', b2.status === 'blocked' && b2.checkpoint === 1, `${b2.status} cp=${b2.checkpoint}`);
  assert('流水仅 1 条（s3）', state().journal.length === 1 && state().journal[0].snapshotId === 's3');
  assert('s3 按 v2 字段投影', JSON.stringify(Object.keys(state().journal[0].record).sort()) === JSON.stringify(['amount', 'budgetCode', 'department', 'invoiceDate', 'name'].sort()));
}

console.log('4) 补齐 s1 的 budgetCode 后从断点续作：不重写任何旧记录');
{
  const beforeSeq = state().journal.length;
  store.dispatch({ type: 'schema/patchSnapshot', payload: { snapshotId: 's1', patch: { budgetCode: 'CW-2026' } } });
  const b1 = state().batches[0];
  assert('s1 补齐后批次回到排队', b1.status === 'queued', b1.status);
  store.dispatch({ type: 'schema/runBatch', payload: { batchId: b1.id } });
  assert('第 1 批完成', state().batches[0].status === 'done');
  assert('checkpoint=2', state().batches[0].checkpoint === 2);
  assert('流水新增恰好 2 条（s1、s2）', state().journal.length === beforeSeq + 2, `journal=${state().journal.length}`);
  assert('流水顺序 s1 在 s2 前', state().journal[1].snapshotId === 's1' && state().journal[2].snapshotId === 's2');
}

console.log('5) 重复点击执行/恢复：幂等，不重复写入');
{
  const n = state().journal.length;
  store.dispatch({ type: 'schema/resumeBatch', payload: state().batches[0].id });
  store.dispatch({ type: 'schema/runBatch', payload: { batchId: state().batches[0].id } });
  assert('流水条数不变', state().journal.length === n);
  const s1Count = state().journal.filter((e) => e.snapshotId === 's1').length;
  assert('s1 只有 1 条流水', s1Count === 1, `count=${s1Count}`);
}

console.log('6) 模拟中断：第 2 批 s4 补齐后执行时 crash，断点不推进；恢复后 s4 只写一次');
{
  store.dispatch({ type: 'schema/patchSnapshot', payload: { snapshotId: 's4', patch: { amount: '300' } } });
  const b2 = state().batches[1];
  assert('补齐后可恢复', b2.status === 'queued', b2.status);
  // 该批 checkpoint=1（s3 已写），crash 发生在 floor(2/2)=1 即 s4 上
  store.dispatch({ type: 'schema/runBatch', payload: { batchId: b2.id, crash: true } });
  assert('批次 failed', state().batches[1].status === 'failed');
  assert('断点仍是 1（s4 未入账）', state().batches[1].checkpoint === 1);
  const n = state().journal.length;
  store.dispatch({ type: 'schema/resumeBatch', payload: state().batches[1].id });
  assert('恢复后 done', state().batches[1].status === 'done');
  assert('只新增 1 条流水（s4）', state().journal.length === n + 1, `journal=${state().journal.length}`);
  assert('s4 只出现 1 次', state().journal.filter((e) => e.snapshotId === 's4').length === 1);
}

console.log('7) 再发布 v3：在途批次若无则全部完成；s1-s4 已写完 → 新计划为空批');
// 先在草稿上改规则（budgetCode 改为必填），验证旧流水仍按 v2 解释
{
  store.dispatch({ type: 'schema/updateField', payload: { id: 'budgetCode', required: true } });
  store.dispatch({ type: 'schema/publishVersion' });
  const s = state();
  assert('活跃版本 v3', s.activeVersionId === 'v3');
  const v2PlanBatches = s.batches.filter((b) => b.targetVersionId === 'v2');
  assert('v2 两批保持 done（未被作废）', v2PlanBatches.every((b) => b.status === 'done'));
  const s1Entry = s.journal.find((e) => e.snapshotId === 's1');
  assert('s1 流水仍标注 v2（按原版本解释）', s1Entry.targetVersionId === 'v2');
  // 全部快照都已写入过版本 → 新计划无批次
  const v3Batches = s.batches.filter((b) => b.targetVersionId === 'v3');
  assert('v3 无待迁批次（都已迁过）', v3Batches.length === 0, `got ${v3Batches.length}`);
}

console.log('8) 关键：新快照加入后再发布，v3 的在途批次被 v4 作废，已完成流水不动');
{
  // 手动塞一条 v1 新快照模拟"分批迁移期间又来了旧数据"——通过补丁方式直接进 state 不行，
  // 这里改为：先发布 v4 前制造在途批次。新增快照后为 v3 补建批次。
  // 用 replaceState 注入更简单：
  const s0 = state();
  store.dispatch({
    type: 'schema/replaceState',
    payload: { ...s0, snapshots: [...s0.snapshots, { id: 's5', versionId: 'v1', label: '新来的旧单', data: { name: '补录单', department: '市场', amount: '900' } }] }
  });
  store.dispatch({ type: 'schema/generateBatches' });
  const v3Batches = state().batches.filter((b) => b.targetVersionId === 'v3' && b.status !== 'void');
  assert('为 v3 补建 1 个在途批次（s5）', v3Batches.length === 1 && v3Batches[0].status === 'queued');
  const journalBefore = state().journal.length;
  store.dispatch({ type: 'schema/publishVersion' });
  const after = state();
  assert('活跃版本 v4', after.activeVersionId === 'v4');
  const v3Live = after.batches.filter((b) => b.targetVersionId === 'v3' && b.status !== 'void' && b.status !== 'done');
  assert('v3 在途批次被作废', v3Live.length === 0);
  const voided = after.batches.find((b) => b.targetVersionId === 'v3' && b.status === 'void');
  assert('作废原因写入', Boolean(voided?.voidReason?.includes('v4')));
  assert('已有流水条数不变', after.journal.length === journalBefore);
  const v4Batches = after.batches.filter((b) => b.targetVersionId === 'v4');
  assert('v4 重算批次包含 s5', v4Batches.length === 1 && v4Batches[0].items.some((i) => i.snapshotId === 's5'));
  assert('v4 批次冻结的是 v4 规则（budgetCode 必填）', v4Batches[0].frozen.fields.find((f) => f.id === 'budgetCode')?.required === true);
  // s5 部门=市场，v4 中 budgetCode 全量必填 → 阻塞
  const s5item = v4Batches[0].items.find((i) => i.snapshotId === 's5');
  assert('s5 按 v4 规则检出 budgetCode 必填缺口', s5item.issues.some((iss) => iss.code === 'REQUIRED_MISSING' && iss.message.includes('预算科目')));
}

console.log('');
if (failures === 0) console.log('🎉 全部断言通过');
else { console.error(`💥 ${failures} 条断言失败`); process.exit(1); }
