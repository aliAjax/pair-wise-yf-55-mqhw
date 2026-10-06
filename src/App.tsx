import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Alert, AppBar, Box, Button, Card, CardContent, Chip, Collapse, Container, Divider,
  FormControl, Grid, InputLabel, LinearProgress, MenuItem,
  Paper, Select, Stack, Switch, Tab, Table, TableBody, TableCell, TableHead, TableRow,
  Tabs, TextField, Toolbar, Tooltip, Typography
} from '@mui/material';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  addField, addRule, generateBatches, patchSnapshot, publishVersion, reorderFields,
  runBatch, resumeBatch, updateField,
  type FormField, type LinkRule, type RootState
} from './store';
import {
  batchProgress, missingFieldIds, rulesSignature, validateSnapshot, versionLabel,
  type BatchStatus, type MigrationBatch, type MigrationItem
} from './migration/engine';

/* ------------------------------- 状态展示 ------------------------------- */

const BATCH_META: Record<BatchStatus, { label: string; color: 'default' | 'success' | 'warning' | 'error' | 'info' | 'secondary' }> = {
  queued: { label: '排队中', color: 'default' },
  running: { label: '执行中', color: 'info' },
  blocked: { label: '阻塞挂起', color: 'warning' },
  failed: { label: '中断待恢复', color: 'error' },
  done: { label: '已完成', color: 'success' },
  void: { label: '已作废', color: 'secondary' }
};

/* ------------------------------- 字段编排 ------------------------------- */

function SortableField({ field }: { field: FormField }) {
  const dispatch = useDispatch();
  const sortable = useSortable({ id: field.id });
  return (
    <Card ref={sortable.setNodeRef} variant="outlined"
      style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}>
      <CardContent sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', py: '12px !important', gap: 1 }}>
        <Box>
          <Typography fontWeight={700}>{field.label}</Typography>
          <Typography variant="caption" color="text.secondary">{field.type}{field.options ? ` · 选项 ${field.options.join('/')}` : ''}</Typography>
        </Box>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="caption" color="text.secondary">必填</Typography>
          <Switch size="small" checked={field.required}
            onChange={(event) => dispatch(updateField({ id: field.id, required: event.target.checked }))} />
          <Button size="small" {...sortable.attributes} {...sortable.listeners}>拖拽</Button>
        </Stack>
      </CardContent>
    </Card>
  );
}

function describeRule(rule: LinkRule, fields: FormField[]): string {
  const name = (id: string) => fields.find((field) => field.id === id)?.label ?? id;
  const cond = rule.operator === 'equals' ? `「${name(rule.fieldId)}」等于 ${rule.value}` : `「${name(rule.fieldId)}」非空`;
  return `${cond} 时${rule.effect === 'require' ? '要求必填' : '显示'}「${name(rule.targetId)}」`;
}

/* ------------------------------- 迁移账 ------------------------------- */

function BatchCard({ batch, prevDone }: { batch: MigrationBatch; prevDone: boolean }) {
  const dispatch = useDispatch();
  const { written, total } = batchProgress(batch);
  const meta = BATCH_META[batch.status];
  const live = batch.status !== 'done' && batch.status !== 'void';
  const canStart = prevDone && (batch.status === 'queued' || batch.status === 'blocked' || batch.status === 'failed');
  const versions = useSelector((root: RootState) => root.schema.versions);
  const frozenSignature = rulesSignature(batch.frozen.rules);
  const currentDraft = versions.find((version) => version.id.startsWith('draft-'));
  const draftSignature = currentDraft ? rulesSignature(currentDraft.rules) : '';
  const ruleDrifted = currentDraft?.id !== undefined && frozenSignature !== draftSignature;

  return (
    <Paper variant="outlined" sx={{ p: 2, opacity: batch.status === 'void' ? 0.55 : 1 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Chip size="small" label={meta.label} color={meta.color} />
          <Typography fontWeight={700}>批次 {batch.id.slice(-4)}</Typography>
          <Typography variant="caption" color="text.secondary">目标 {versionLabel(versions, batch.targetVersionId)}</Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary">{written}/{total} · 尝试 {batch.attempts} 次</Typography>
      </Stack>

      <LinearProgress
        variant="determinate"
        value={total ? (written / total) * 100 : 100}
        color={batch.status === 'failed' ? 'error' : batch.status === 'blocked' ? 'warning' : 'success'}
        sx={{ mb: 1.5, height: 8, borderRadius: 4 }}
      />

      <Stack spacing={1}>
        {batch.items.map((item, index) => (
          <ItemRow key={item.id} item={item} index={index} batch={batch} />
        ))}
      </Stack>

      {(batch.status === 'failed' || batch.status === 'blocked') && batch.lastError && (
        <Alert severity={batch.status === 'failed' ? 'error' : 'warning'} sx={{ mt: 1.5 }}>
          {batch.status === 'failed' ? '中断原因' : '挂起原因'}：{batch.lastError}
          {batch.status === 'failed' && `；断点停在第 ${batch.checkpoint + 1} 项，恢复从这里继续，前 ${batch.checkpoint} 项不会重写。`}
        </Alert>
      )}
      {batch.status === 'void' && batch.voidReason && (
        <Alert severity="info" sx={{ mt: 1.5 }}>{batch.voidReason}</Alert>
      )}
      {live && ruleDrifted && batch.status !== 'void' && (
        <Tooltip title="批次已冻结发布时的字段与规则副本，草稿上的规则改动不影响本批校验依据">
          <Alert severity="info" sx={{ mt: 1.5 }}>草稿规则已改动；本批仍按 {batch.targetVersionId} 发布时冻结的依赖校验。</Alert>
        </Tooltip>
      )}

      {live && (
        <Stack direction="row" spacing={1} mt={1.5}>
          <Button
            size="small" variant="contained"
            disabled={!canStart}
            onClick={() => dispatch(runBatch({ batchId: batch.id }))}>
            {batch.status === 'queued' ? '领取容量执行' : '从断点续作'}
          </Button>
          {batch.status === 'queued' && (
            <Button size="small" variant="outlined" color="error" disabled={!canStart}
              onClick={() => dispatch(runBatch({ batchId: batch.id, crash: true }))}>
              模拟执行中断
            </Button>
          )}
          {batch.status === 'failed' && (
            <Button size="small" variant="outlined" onClick={() => dispatch(resumeBatch(batch.id))}>恢复重试（幂等）</Button>
          )}
          {!prevDone && batch.status === 'queued' && (
            <Typography variant="caption" color="text.secondary" alignSelf="center">容量被前序批次占用，完成后自动可执行</Typography>
          )}
        </Stack>
      )}
    </Paper>
  );
}

function ItemRow({ item, index, batch }: { item: MigrationItem; index: number; batch: MigrationBatch }) {
  const dispatch = useDispatch();
  const snapshots = useSelector((root: RootState) => root.schema.snapshots);
  const snapshot = snapshots.find((entry) => entry.id === item.snapshotId);
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const color = item.status === 'written' ? 'success.main'
    : item.status === 'blocked' ? 'warning.main' : 'text.secondary';
  const missing = item.status === 'blocked' && snapshot
    ? missingFieldIds(snapshot.data, batch.frozen.fields, batch.frozen.rules)
    : [];

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="body2" color={color}>
          {index + 1}. {item.status === 'written' ? '✅' : item.status === 'blocked' ? '⏸' : '🕓'} {item.label}
          {item.attempts > 0 && <Typography component="span" variant="caption" color="text.secondary">（{item.attempts} 次尝试）</Typography>}
        </Typography>
        {item.status === 'blocked' && (
          <Button size="small" onClick={() => setOpen((v) => !v)}>{open ? '收起补齐' : '补齐字段'}</Button>
        )}
      </Stack>
      {item.issues.length > 0 && item.status !== 'written' && (
        <Stack direction="row" spacing={0.5} flexWrap="wrap" mt={0.5}>
          {item.issues.map((issue, i) => (
            <Chip key={i} size="small" variant="outlined"
              color={issue.level === 'blocker' ? 'warning' : 'default'} label={issue.message} />
          ))}
        </Stack>
      )}
      <Collapse in={open}>
        <Box sx={{ pl: 2, pt: 1 }}>
          <Stack spacing={1}>
            {missing.map((fieldId) => {
              const field = batch.frozen.fields.find((entry) => entry.id === fieldId);
              return (
                <TextField key={fieldId} size="small" label={`补齐：${field?.label ?? fieldId}`}
                  value={values[fieldId] ?? snapshot?.data[fieldId] ?? ''}
                  onChange={(event) => setValues((prev) => ({ ...prev, [fieldId]: event.target.value }))} />
              );
            })}
            <Button size="small" variant="outlined" disabled={missing.every((id) => !values[id]?.trim())}
              onClick={() => {
                const patch = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
                if (snapshot && Object.keys(patch).length) {
                  dispatch(patchSnapshot({ snapshotId: snapshot.id, patch }));
                  setValues({});
                  setOpen(false);
                }
              }}>
              保存并按批次冻结规则重新校验
            </Button>
          </Stack>
        </Box>
      </Collapse>
    </Box>
  );
}

function MigrationLedger() {
  const { plans, batches, versions } = useSelector((root: RootState) => root.schema);
  const dispatch = useDispatch();
  const orderedPlans = [...plans].reverse();

  if (plans.length === 0) {
    return (
      <Alert severity="info" sx={{ mt: 2 }}>
        还没有迁移账。发布新版本时会自动按当时规则切出待迁批次；也可以
        <Button size="small" sx={{ mx: 1 }} variant="outlined" onClick={() => dispatch(generateBatches())}>
          为当前正式版本补建批次
        </Button>
      </Alert>
    );
  }

  return (
    <Box mt={2}>
      <Alert severity="info" sx={{ mb: 2 }}>
        每批容量 2 条，后续快照排队；中断从断点恢复，写入走统一流水、按快照幂等去重。
      </Alert>
      {orderedPlans.map((plan) => {
        const planBatches = batches.filter((batch) => batch.planId === plan.id);
        const superseded = Boolean(plan.supersededAt);
        return (
          <Card key={plan.id} variant="outlined" sx={{ mb: 2, opacity: superseded && planBatches.every((b) => b.status === 'void') ? 0.75 : 1 }}>
            <CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1.5}>
                <Typography fontWeight={700}>
                  迁移账 {plan.id.slice(-4)} → {versionLabel(versions, plan.targetVersionId)}
                </Typography>
                <Stack direction="row" spacing={1}>
                  <Chip size="small" label={`容量 ${plan.batchSize}/批`} variant="outlined" />
                  {superseded && <Chip size="small" color="secondary" label="已被新版替代" />}
                </Stack>
              </Stack>
              <Stack spacing={1.5}>
                {planBatches.map((batch, index) => {
                  const prevDone = index === 0 || planBatches.slice(0, index).every((b) => b.status === 'done' || b.status === 'void');
                  return <BatchCard key={batch.id} batch={batch} prevDone={prevDone} />;
                })}
              </Stack>
            </CardContent>
          </Card>
        );
      })}
    </Box>
  );
}

/* ------------------------------- 写入流水 ------------------------------- */

function JournalView() {
  const { journal, versions } = useSelector((root: RootState) => root.schema);
  if (journal.length === 0) return <Alert severity="info" sx={{ mt: 2 }}>流水为空：批次写入后才会记账。</Alert>;
  return (
    <Box mt={2}>
      <Alert severity="success" sx={{ mb: 2 }}>流水是唯一写入入口：同一快照重复执行只会跳过，不产生第二条记录；记录永久标注解释版本。</Alert>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>#</TableCell><TableCell>快照</TableCell><TableCell>按哪个版本解释</TableCell>
            <TableCell>投影后的记录</TableCell><TableCell>写入时间</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {journal.map((entry) => (
            <TableRow key={entry.seq}>
              <TableCell>{entry.seq}</TableCell>
              <TableCell>{entry.label}</TableCell>
              <TableCell><Chip size="small" label={versionLabel(versions, entry.targetVersionId)} color="success" variant="outlined" /></TableCell>
              <TableCell><Typography variant="caption" component="span" fontFamily="monospace">{JSON.stringify(entry.record)}</Typography></TableCell>
              <TableCell><Typography variant="caption">{entry.writtenAt.slice(11, 19)}</Typography></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

/* ------------------------------- 旧数据快照 ------------------------------- */

function SnapshotList() {
  const { snapshots, versions, activeVersionId } = useSelector((root: RootState) => root.schema);
  const active = versions.find((version) => version.id === activeVersionId);
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" mb={1}>
        旧数据快照（共 {snapshots.length} 条）；按当前正式版本 {active?.label} 预校验：
      </Typography>
      <Stack spacing={1}>
        {snapshots.map((snapshot) => {
          const issues = active ? validateSnapshot(snapshot.data, active.fields, active.rules) : [];
          return (
            <Paper key={snapshot.id} variant="outlined" sx={{ p: 1.5 }}>
              <Typography variant="body2" fontWeight={700}>{snapshot.label}</Typography>
              <Typography variant="caption" component="div" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
                来源 {snapshot.versionId} · {JSON.stringify(snapshot.data)}
              </Typography>
              {issues.length > 0 ? (
                <Stack direction="row" spacing={0.5} flexWrap="wrap" mt={0.5}>
                  {issues.map((issue, i) => (
                    <Chip key={i} size="small" color={issue.level === 'blocker' ? 'warning' : 'default'} variant="outlined"
                      label={`${active?.id}：${issue.message}`} />
                  ))}
                </Stack>
              ) : (
                <Chip size="small" sx={{ mt: 0.5 }} color="success" label={`可直接迁入 ${active?.id}`} />
              )}
            </Paper>
          );
        })}
      </Stack>
    </Box>
  );
}

/* ------------------------------- 运行态表单 ------------------------------- */

function RuntimeForm({ version }: { version: { fields: FormField[]; rules: LinkRule[] } }) {
  const { register, handleSubmit, watch, formState: { errors }, reset } = useForm<Record<string, string>>({
    defaultValues: Object.fromEntries(version.fields.map((field) => [field.id, '']))
  });
  const [result, setResult] = useState<Record<string, string> | null>(null);
  const values = watch();

  const visible = (field: FormField) => {
    const rule = version.rules.find((item) => item.effect === 'show' && item.targetId === field.id);
    if (!rule) return true;
    return rule.operator === 'equals' ? values[rule.fieldId] === rule.value : Boolean(values[rule.fieldId]);
  };
  const dynamicRequired = (field: FormField) => {
    if (field.required) return '必填';
    const rule = version.rules.find((item) => item.effect === 'require' && item.targetId === field.id);
    if (!rule) return undefined;
    const hit = rule.operator === 'equals' ? values[rule.fieldId] === rule.value : Boolean(values[rule.fieldId]);
    return hit ? '联动必填' : undefined;
  };

  return (
    <Box key={JSON.stringify(version.fields.map((f) => f.id))} component="form" mt={2}
      onSubmit={handleSubmit((data) => {
        const cleaned = Object.fromEntries(version.fields.filter(visible).map((field) => [field.id, data[field.id] ?? '']));
        setResult(cleaned);
      })}>
      <Stack spacing={2}>
        {version.fields.filter(visible).map((field) => {
          const reqText = dynamicRequired(field);
          const error = errors[field.id];
          return (
            <TextField key={field.id} size="small" fullWidth
              label={`${field.label}${reqText ? `（${reqText}）` : ''}`}
              type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
              required={Boolean(reqText)}
              select={field.type === 'select'}
              {...register(field.id, {
                required: reqText ? `${field.label}${reqText === '联动必填' ? '在当前条件下必填' : ''}` : false
              })}
              error={Boolean(error)}
              helperText={error?.message as string | undefined}
              InputLabelProps={field.type === 'date' ? { shrink: true } : undefined}>
              {field.type === 'select' && field.options?.map((option) => <MenuItem key={option} value={option}>{option}</MenuItem>)}
            </TextField>
          );
        })}
        <Stack direction="row" spacing={1}>
          <Button type="submit" variant="contained">按本版本提交</Button>
          <Button onClick={() => { reset(); setResult(null); }}>重置</Button>
        </Stack>
      </Stack>
      {result && <Alert severity="success" sx={{ mt: 2 }}>运行态数据：{JSON.stringify(result)}</Alert>}
    </Box>
  );
}

/* ------------------------------- 主页面 ------------------------------- */

export default function App() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const draft = state.versions.find((item) => item.id === state.previewVersionId) ?? state.versions[0];
  const isDraft = draft.id.startsWith('draft-');
  const active = state.versions.find((item) => item.id === state.activeVersionId) ?? state.versions[0];
  const prior = [...state.versions]
    .filter((item) => /^v\d+$/.test(item.id) && item.id !== active.id)
    .at(-1);

  const [tab, setTab] = useState(1);
  const [newRuleTarget, setNewRuleTarget] = useState(draft.fields.at(-1)?.id ?? '');
  const sensors = useSensors(useSensor(PointerSensor));

  function dragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) {
      dispatch(reorderFields({ activeId: String(event.active.id), overId: String(event.over.id) }));
    }
  }

  const addedFields = draft.fields.filter((field) => !prior?.fields.some((old) => old.id === field.id));
  const droppedFields = prior?.fields.filter((field) => !draft.fields.some((next) => next.id === field.id)) ?? [];
  const addedRules = draft.rules.filter((rule) => !prior?.rules.some((old) => old.id === rule.id));
  const targetOptions = draft.fields;

  return (
    <Box minHeight="100vh" bgcolor="#f7f8fc">
      <AppBar position="sticky" color="primary">
        <Toolbar>
          <Typography variant="h6" flexGrow={1}>{t('title')}</Typography>
          <Typography variant="body2" sx={{ mr: 2, opacity: 0.85 }}>
            当前正式版本：{active.label} ｜ 编排中：{draft.label}
          </Typography>
          <Button color="inherit" variant="outlined" onClick={() => dispatch(publishVersion())}>{t('publish')}</Button>
        </Toolbar>
      </AppBar>
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <Grid container spacing={3}>
          {/* 左：字段 / 规则编排（只作用于草稿） */}
          <Grid size={{ xs: 12, lg: 7 }}>
            <Card>
              <CardContent>
                <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
                  <div>
                    <Typography variant="h6">字段编排 · {draft.label}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      拖动排序、切换必填；发布时冻结成新版本并生成待迁批次。历史版本保持只读。
                    </Typography>
                  </div>
                  <Button variant="contained" disabled={!isDraft} onClick={() => dispatch(addField())}>添加字段</Button>
                </Stack>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
                  <SortableContext items={draft.fields.map((field) => field.id)} strategy={verticalListSortingStrategy}>
                    <Stack>{draft.fields.map((field) => <SortableField key={field.id} field={field} />)}</Stack>
                  </SortableContext>
                </DndContext>

                <Divider sx={{ my: 3 }} />
                <Typography variant="h6" mb={1}>联动规则（发布时校验必填与联动的依据）</Typography>
                {draft.rules.length === 0 && <Typography variant="body2" color="text.secondary">暂无规则</Typography>}
                {draft.rules.map((rule) => (
                  <Alert key={rule.id} severity="info" sx={{ mb: 1 }}>{describeRule(rule, draft.fields)}</Alert>
                ))}
                <Stack direction="row" spacing={2} mt={2} alignItems="center">
                  <FormControl size="small" sx={{ minWidth: 220 }}>
                    <InputLabel>联动目标字段</InputLabel>
                    <Select label="联动目标字段" value={newRuleTarget || targetOptions[0]?.id || ''}
                      onChange={(event) => setNewRuleTarget(event.target.value)}>
                      {targetOptions.map((field) => <MenuItem key={field.id} value={field.id}>{field.label}</MenuItem>)}
                    </Select>
                  </FormControl>
                  <Button variant="outlined" disabled={!isDraft || !newRuleTarget && targetOptions.length === 0}
                    onClick={() => dispatch(addRule({
                      fieldId: 'department', operator: 'equals', value: '财务',
                      effect: 'require', targetId: newRuleTarget || targetOptions[0]?.id
                    }))}>
                    添加「财务 → 必填」联动
                  </Button>
                </Stack>
              </CardContent>
            </Card>
          </Grid>

          {/* 右：版本差异 / 迁移账 / 流水 / 快照 / 运行态 */}
          <Grid size={{ xs: 12, lg: 5 }}>
            <Card>
              <CardContent>
                <Tabs value={tab} onChange={(_, value) => setTab(value)} variant="scrollable">
                  <Tab label="版本差异" />
                  <Tab label="迁移账" />
                  <Tab label="写入流水" />
                  <Tab label="旧数据快照" />
                  <Tab label={t('runtime')} />
                </Tabs>

                {tab === 0 && (
                  <Box mt={2}>
                    <Typography fontWeight={700} mb={1}>{prior?.label ?? '—'} → {draft.label}</Typography>
                    <Stack direction="row" gap={1} flexWrap="wrap">
                      {addedFields.map((field) => <Chip key={field.id} size="small" label={`新增 ${field.label}${field.required ? '（必填）' : ''}`} color="success" variant="outlined" />)}
                      {droppedFields.map((field) => <Chip key={field.id} size="small" label={`删除 ${field.label}`} color="error" variant="outlined" />)}
                      {addedRules.map((rule) => <Chip key={rule.id} size="small" label={`新规则：${describeRule(rule, draft.fields)}`} color="info" variant="outlined" />)}
                      {addedFields.length + droppedFields.length + addedRules.length === 0 && <Chip size="small" label="与上一版无结构差异" variant="outlined" />}
                    </Stack>
                    <Alert severity="warning" sx={{ mt: 2 }}>
                      发布后旧版本即冻结：历史提交不会按新字段含义重新解释；规则再改也不影响已生成批次冻结的依赖。
                    </Alert>
                  </Box>
                )}

                {tab === 1 && <MigrationLedger />}
                {tab === 2 && <JournalView />}
                {tab === 3 && <SnapshotList />}
                {tab === 4 && (
                  <Box mt={2}>
                    <Alert severity="info" sx={{ mb: 2 }}>以下按当前正式版本 {active.label} 的必填与联动实时校验。</Alert>
                    <RuntimeForm version={active} />
                  </Box>
                )}
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      </Container>
    </Box>
  );
}
