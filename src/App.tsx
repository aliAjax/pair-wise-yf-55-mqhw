import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, AppBar, Box, Button, Card, CardContent, Checkbox, Chip, Container, Divider, FormControl, FormControlLabel, Grid, InputLabel, MenuItem, Select, Stack, Tab, Tabs, TextField, Toolbar, Typography } from '@mui/material';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import { addField, addRule, publishVersion, reorderFields, runMigration, selectPreview, toggleFailInjection, useSchemaHistoryQuery, type FormField, type MigrationBatch, type MigrationItem, type RootState } from './store';

const runtimeSchema = z.object({
  name: z.string().min(2, '请输入申请名称'),
  department: z.string().min(1, '请选择部门'),
  amount: z.number().positive('金额必须大于0'),
  budgetCode: z.string().optional(),
  invoiceDate: z.string().optional()
}).superRefine((data, context) => {
  if (data.department === '财务' && !data.budgetCode) context.addIssue({ code: 'custom', path: ['budgetCode'], message: '财务部门必须填写预算科目' });
});

function SortableField({ field }: { field: FormField }) {
  const sortable = useSortable({ id: field.id });
  return (
    <Card ref={sortable.setNodeRef} variant="outlined" style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}>
      <CardContent sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', py: '14px !important' }}>
        <div><Typography fontWeight={700}>{field.label}</Typography><Typography variant="caption" color="text.secondary">{field.type} · {field.required ? '必填' : '选填'}</Typography></div>
        <Button size="small" {...sortable.attributes} {...sortable.listeners}>拖拽</Button>
      </CardContent>
    </Card>
  );
}

const ITEM_STATUS_META: Record<MigrationItem['status'], { label: string; color: 'default' | 'primary' | 'success' | 'error' | 'info' }> = {
  pending: { label: '待执行', color: 'default' },
  queued: { label: '排队中', color: 'info' },
  succeeded: { label: '已完成', color: 'success' },
  failed: { label: '失败', color: 'error' },
  voided: { label: '已作废', color: 'default' }
};

const BATCH_STATUS_META: Record<MigrationBatch['status'], { label: string; color: 'default' | 'primary' | 'success' }> = {
  open: { label: '进行中', color: 'primary' },
  completed: { label: '已完成', color: 'success' },
  voided: { label: '已作废', color: 'default' }
};

function MigrationLedger() {
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const active = state.versions.find((item) => item.id === state.previewVersionId) ?? state.versions[0];
  const snapshots = state.snapshots;
  const batches = state.migrationBatches.filter((batch) => batch.versionId === active.id);
  const items = state.migrationItems.filter((item) => item.toVersionId === active.id);
  const ledger = [...state.ledger].sort((a, b) => b.completedAt.localeCompare(a.completedAt));

  const counts = items.reduce(
    (acc, item) => { acc[item.status] += 1; return acc; },
    { pending: 0, queued: 0, succeeded: 0, failed: 0, voided: 0 } as Record<MigrationItem['status'], number>
  );

  if (batches.length === 0) {
    return (
      <Box mt={2}>
        <Alert severity="info">当前版本 {active.id} 没有待迁批次。发布新版本时会自动生成待迁批次，并按当前规则校验必填与联动。</Alert>
      </Box>
    );
  }

  return (
    <Box mt={2}>
      <Stack direction="row" gap={1} flexWrap="wrap" mb={2}>
        <Chip size="small" label={`待迁 ${counts.pending}`} />
        <Chip size="small" label={`排队 ${counts.queued}`} color="info" />
        <Chip size="small" label={`失败 ${counts.failed}`} color="error" />
        <Chip size="small" label={`已完成 ${counts.succeeded}`} color="success" />
        <Chip size="small" label={`已作废 ${counts.voided}`} />
      </Stack>

      {batches.map((batch) => {
        const batchItems = state.migrationItems
          .filter((item) => item.batchId === batch.id)
          .sort((a, b) => a.snapshotId.localeCompare(b.snapshotId));
        const done = batchItems.filter((item) => item.status === 'succeeded').length;
        const runnable = batchItems.some((item) => item.status === 'pending' || item.status === 'queued' || item.status === 'failed');
        const hasFailed = batchItems.some((item) => item.status === 'failed');
        const batchMeta = BATCH_STATUS_META[batch.status];
        return (
          <Card key={batch.id} variant="outlined" sx={{ mb: 1.5, opacity: batch.status === 'voided' ? 0.65 : 1 }}>
            <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography fontWeight={700}>批次 #{batch.index} · {batch.versionId}</Typography>
                <Stack direction="row" gap={0.5} alignItems="center">
                  <Chip size="small" variant="outlined" label={`${done}/${batchItems.length}`} />
                  <Chip size="small" label={batchMeta.label} color={batchMeta.color} />
                </Stack>
              </Stack>
              <Typography variant="caption" color="text.secondary">容量 {batch.capacity} 条/批 · 快照按顺序迁入，容量满后后续批次排队</Typography>

              {batch.status !== 'voided' && (
                <Stack direction="row" gap={1} mt={1}>
                  <Button
                    size="small"
                    variant="contained"
                    disabled={!runnable}
                    onClick={() => dispatch(runMigration(batch.id))}
                  >
                    {batch.status === 'completed' ? '重新执行' : hasFailed ? '重试（断点续作）' : '执行批次'}
                  </Button>
                </Stack>
              )}
              {batch.status === 'voided' && (
                <Alert severity="warning" sx={{ mt: 1, py: 0 }}>该批次未执行完毕，已在新版本发布时作废，待迁项按新规则重算。</Alert>
              )}

              <Stack mt={1} gap={0.5}>
                {batchItems.map((item) => {
                  const snapshot = snapshots.find((snap) => snap.id === item.snapshotId);
                  const meta = ITEM_STATUS_META[item.status];
                  return (
                    <Box key={item.id} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1 }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center">
                        <Typography variant="body2">{snapshot?.label ?? item.snapshotId}</Typography>
                        <Stack direction="row" gap={0.5} alignItems="center">
                          {item.attempts > 0 && <Chip size="small" variant="outlined" label={`第 ${item.attempts} 次`} />}
                          <Chip size="small" label={meta.label} color={meta.color} />
                        </Stack>
                      </Stack>
                      {item.status !== 'voided' && item.errors.length > 0 && (
                        <Alert severity="error" sx={{ mt: 0.5, py: 0 }}>{item.errors.join('；')}</Alert>
                      )}
                      {item.status === 'failed' && (
                        <Alert severity="error" sx={{ mt: 0.5, py: 0 }}>
                          {item.lastError}（断点：{item.checkpoint}）。重试只处理未完成项，已成功的不会重复写入。
                        </Alert>
                      )}
                      {item.status === 'succeeded' && (
                        <Typography variant="caption" color="success.main">
                          已写入 {item.migratedAt?.slice(0, 16).replace('T', ' ')} · 迁移账已登记，不重复写入
                        </Typography>
                      )}
                      {item.status !== 'succeeded' && item.status !== 'voided' && (
                        <FormControlLabel
                          control={<Checkbox size="small" checked={item.failInjected} onChange={() => dispatch(toggleFailInjection(item.id))} />}
                          label="模拟写入失败（中断后可从断点重试）"
                          sx={{ mt: 0.5, mr: 0 }}
                        />
                      )}
                    </Box>
                  );
                })}
              </Stack>
            </CardContent>
          </Card>
        );
      })}

      <Typography fontWeight={700} mt={2} mb={1}>迁移账分录</Typography>
      {ledger.length === 0 && <Typography variant="body2" color="text.secondary">暂无已完成分录。执行批次后，成功的快照会按目标版本写入迁移账。</Typography>}
      <Stack gap={0.5}>
        {ledger.map((entry) => {
          const snapshot = snapshots.find((snap) => snap.id === entry.snapshotId);
          return (
            <Alert key={entry.id} severity="success" sx={{ py: 0 }}>
              {snapshot?.label ?? entry.snapshotId} · {entry.fromVersionId} → {entry.toVersionId} · 按 {entry.toVersionId} 解释 · {entry.completedAt.slice(0, 16).replace('T', ' ')}
            </Alert>
          );
        })}
      </Stack>
      <Alert severity="info" sx={{ mt: 2 }}>已完成的分录按其完成时的版本解释，不随新版本发布而改变；未完成的待迁项在新版本发布时作废并重算。</Alert>
    </Box>
  );
}

export default function App() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const active = state.versions.find((item) => item.id === state.previewVersionId) ?? state.versions[0];
  const snapshots = state.snapshots;
  const [tab, setTab] = useState(0);
  const [migration, setMigration] = useState<string | null>(null);
  const [runtimeResult, setRuntimeResult] = useState<Record<string, unknown> | null>(null);
  const [newRuleTarget, setNewRuleTarget] = useState(active.fields.at(-1)?.id ?? 'budgetCode');
  const sensors = useSensors(useSensor(PointerSensor));
  const { data: history = [] } = useSchemaHistoryQuery(active.id);
  const form = useForm<z.infer<typeof runtimeSchema>>({ resolver: zodResolver(runtimeSchema), defaultValues: { name: '', department: '', amount: 0, budgetCode: '', invoiceDate: '' } });

  function dragEnd(event: DragEndEvent) { if (event.over && event.active.id !== event.over.id) dispatch(reorderFields({ activeId: String(event.active.id), overId: String(event.over.id) })); }
  function simulate(snapshotId: string) {
    const snapshot = snapshots.find((item) => item.id === snapshotId);
    if (!snapshot) return;
    const missing = active.fields.filter((field) => field.required && !snapshot.data[field.id]).map((field) => field.label);
    setMigration(missing.length ? `旧数据缺少新版本必填字段：${missing.join('、')}。迁移时需要补充或使用默认值。` : '旧数据可以直接迁移到当前版本。');
  }

  return (
    <Box minHeight="100vh" bgcolor="#f7f8fc">
      <AppBar position="sticky" color="primary"><Toolbar><Typography variant="h6" flexGrow={1}>{t('title')}</Typography><Button color="inherit" onClick={() => dispatch(publishVersion())}>{t('publish')}</Button></Toolbar></AppBar>
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, lg: 7 }}>
            <Card><CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}><div><Typography variant="h6">字段编排</Typography><Typography variant="body2" color="text.secondary">拖动调整字段顺序，发布后成为新的历史版本。</Typography></div><Button variant="contained" onClick={() => dispatch(addField())}>添加字段</Button></Stack>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}><SortableContext items={active.fields.map((field) => field.id)} strategy={verticalListSortingStrategy}><Stack>{active.fields.map((field) => <SortableField key={field.id} field={field} />)}</Stack></SortableContext></DndContext>
              <Divider sx={{ my: 3 }} />
              <Typography variant="h6" mb={1}>联动规则</Typography>
              {[...active.rules, ...state.rules].map((rule) => <Alert key={rule.id} severity="info" sx={{ mb: 1 }}>{rule.fieldId} {rule.operator === 'equals' ? '等于' : '非空'} {rule.value || ''} 时，{rule.effect === 'require' ? '要求' : '显示'} {rule.targetId}</Alert>)}
              <Stack direction="row" spacing={2} mt={2}><FormControl size="small" fullWidth><InputLabel>目标字段</InputLabel><Select label="目标字段" value={newRuleTarget} onChange={(event) => setNewRuleTarget(event.target.value)}>{active.fields.map((field) => <MenuItem key={field.id} value={field.id}>{field.label}</MenuItem>)}</Select></FormControl><Button variant="outlined" onClick={() => dispatch(addRule({ fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: newRuleTarget }))}>添加财务联动</Button></Stack>
            </CardContent></Card>
          </Grid>

          <Grid size={{ xs: 12, lg: 5 }}>
            <Card><CardContent>
              <Tabs value={tab} onChange={(_, value) => setTab(value)}><Tab label="版本差异" /><Tab label={t('simulate')} /><Tab label={t('runtime')} /><Tab label="迁移账" /></Tabs>
              {tab === 0 && <Box mt={2}><Typography fontWeight={700} mb={1}>v1 → {active.label}</Typography><Stack direction="row" gap={1} flexWrap="wrap">{active.fields.map((field) => <Chip key={field.id} label={`新增 ${field.label}`} color="success" variant="outlined" />)}</Stack><Alert severity="warning" sx={{ mt: 2 }}>旧版本解释保持冻结；过去提交的数据不会按新字段含义重新解释。</Alert><Typography mt={2} fontWeight={700}>其他历史版本</Typography>{history.map((version) => <Button key={version.id} fullWidth sx={{ justifyContent: 'space-between' }} onClick={() => dispatch(selectPreview(version.id))}>{version.label}<span>{version.createdAt}</span></Button>)}</Box>}
              {tab === 1 && <Box mt={2}><Typography fontWeight={700} mb={1}>选择旧数据快照</Typography>{snapshots.map((snapshot) => <Card key={snapshot.id} variant="outlined" sx={{ p: 2, mb: 1 }}><Typography>{snapshot.label}</Typography><Typography variant="body2" color="text.secondary" mb={1}>{JSON.stringify(snapshot.data)}</Typography><Button size="small" onClick={() => simulate(snapshot.id)}>模拟迁移</Button></Card>)}{migration && <Alert severity={migration.includes('缺少') ? 'warning' : 'success'}>{migration}</Alert>}</Box>}
              {tab === 2 && <Box component="form" mt={2} onSubmit={form.handleSubmit((values) => setRuntimeResult(values))}><Stack spacing={2}>{active.fields.map((field) => <TextField key={field.id} label={field.label} type={field.type === 'number' ? 'number' : 'text'} required={field.required} {...form.register(field.id as keyof z.infer<typeof runtimeSchema>, field.type === 'number' ? { valueAsNumber: true } : {})} error={Boolean(form.formState.errors[field.id as keyof typeof form.formState.errors])} helperText={form.formState.errors[field.id as keyof typeof form.formState.errors]?.message} />)}<Button type="submit" variant="contained">按当前版本提交</Button></Stack>{runtimeResult && <Alert severity="success" sx={{ mt: 2 }}>运行态数据：{JSON.stringify(runtimeResult)}</Alert>}<Alert severity="info" sx={{ mt: 2 }}>历史数据按创建时版本解释，不随字段新增而改变。</Alert></Box>}
              {tab === 3 && <MigrationLedger />}
            </CardContent></Card>
          </Grid>
        </Grid>
      </Container>
    </Box>
  );
}
