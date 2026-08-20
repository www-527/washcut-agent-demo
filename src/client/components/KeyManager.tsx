import {useEffect, useState, type FormEvent} from 'react';
import type {EnvelopeContext, RelayKeyInput, RelayKeySummary, RelayKeyTestResult} from '../../shared/contracts';
import {
  activateRelayKey,
  createRelayKey,
  deleteRelayKey,
  fetchRelayModels,
  listRelayKeys,
  testRelayKey,
  updateRelayKey,
} from '../api';
import {CheckIcon, ShieldIcon, TrashIcon} from './Icons';
import {RelayChatTester} from './RelayChatTester';

type KeyManagerProps = {
  context: EnvelopeContext;
  onClose: () => void;
  onActiveKeyChange: (key?: RelayKeySummary) => void;
};

type KeyForm = {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  active: boolean;
};

const emptyForm: KeyForm = {
  name: '',
  baseUrl: 'https://',
  model: '',
  apiKey: '',
  active: true,
};

const sortKeys = (keys: RelayKeySummary[]) => [...keys].sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt.localeCompare(a.updatedAt));

export function KeyManager({context, onClose, onActiveKeyChange}: KeyManagerProps) {
  const [keys, setKeys] = useState<RelayKeySummary[]>([]);
  const [form, setForm] = useState<KeyForm>(emptyForm);
  const [editingId, setEditingId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelStatus, setModelStatus] = useState('');
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState('');
  const [testResults, setTestResults] = useState<Record<string, RelayKeyTestResult>>({});
  const [chatKey, setChatKey] = useState<RelayKeySummary>();

  useEffect(() => {
    let cancelled = false;
    void listRelayKeys(context).then((items) => {
      if (cancelled) return;
      setKeys(sortKeys(items));
      onActiveKeyChange(items.find((item) => item.active));
    }).catch((caught: unknown) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : '模型连接列表加载失败。');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [context, onActiveKeyChange]);

  const applySaved = (saved: RelayKeySummary) => {
    setKeys((current) => sortKeys([
      saved,
      ...current.filter((item) => item.keyId !== saved.keyId).map((item) => saved.active ? {...item, active: false} : item),
    ]));
    if (saved.active) onActiveKeyChange(saved);
  };

  const resetForm = () => {
    setEditingId(undefined);
    setForm(emptyForm);
    setAvailableModels([]);
    setModelStatus('');
    setError('');
  };

  const editKey = (key: RelayKeySummary) => {
    setEditingId(key.keyId);
    setForm({name: key.name, baseUrl: key.baseUrl, model: key.model, apiKey: '', active: key.active});
    setAvailableModels([]);
    setModelStatus('');
    setError('');
  };

  const fetchModels = async () => {
    setLoadingModels(true);
    setModelStatus('');
    setError('');
    try {
      const models = await fetchRelayModels({
        ...(editingId ? {keyId: editingId} : {}),
        baseUrl: form.baseUrl,
        ...(form.apiKey ? {apiKey: form.apiKey} : {}),
      }, context);
      setAvailableModels(models);
      setForm((current) => ({...current, model: models.includes(current.model) ? current.model : models[0]}));
      setModelStatus(`已从上游获取 ${models.length} 个模型`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '获取上游模型失败。');
    } finally {
      setLoadingModels(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (editingId && !form.apiKey && !form.name.trim()) return;
    setSaving(true);
    setError('');
    try {
      const saved = editingId
        ? await updateRelayKey(editingId, {
            name: form.name,
            baseUrl: form.baseUrl,
            model: form.model,
            active: form.active,
            ...(form.apiKey ? {apiKey: form.apiKey} : {}),
          }, context)
        : await createRelayKey(form as RelayKeyInput, context);
      applySaved(saved);
      resetForm();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '模型连接保存失败。');
    } finally {
      setSaving(false);
    }
  };

  const activate = async (keyId: string) => {
    setBusyId(keyId); setError('');
    try { applySaved(await activateRelayKey(keyId, context)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '模型连接启用失败。'); }
    finally { setBusyId(undefined); }
  };

  const test = async (keyId: string) => {
    setBusyId(keyId); setError('');
    try {
      const result = await testRelayKey(keyId, context);
      setTestResults((current) => ({...current, [keyId]: result}));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '连接测试失败。');
    } finally { setBusyId(undefined); }
  };

  const remove = async (key: RelayKeySummary) => {
    if (!window.confirm(`确认删除模型连接“${key.name}”？此操作无法撤销。`)) return;
    setBusyId(key.keyId); setError('');
    try {
      await deleteRelayKey(key.keyId, context);
      const next = await listRelayKeys(context);
      setKeys(sortKeys(next));
      onActiveKeyChange(next.find((item) => item.active));
      if (editingId === key.keyId) resetForm();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '模型连接删除失败。');
    } finally { setBusyId(undefined); }
  };

  const modelOptions = availableModels.includes(form.model) || !form.model ? availableModels : [form.model, ...availableModels];
  const canFetchModels = Boolean(form.baseUrl && (editingId || form.apiKey.length >= 8) && (!form.apiKey || form.apiKey.length >= 8));

  return (
    <div className="key-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="key-dialog" role="dialog" aria-modal="true" aria-labelledby="key-dialog-title">
        <header>
          <div><span className="key-dialog-icon"><ShieldIcon /></span><span><h2 id="key-dialog-title">模型连接</h2><p>凭据加密保存在服务端，浏览器只读取掩码和连接 ID。</p></span></div>
          <button className="key-dialog-close" type="button" onClick={onClose} aria-label="关闭模型连接设置">×</button>
        </header>

        <div className="key-dialog-body">
          <div className="key-list-column">
            <div className="key-section-title"><strong>已保存的模型连接</strong><span>{keys.length} 个配置</span></div>
            {loading ? <div className="key-empty">正在读取服务端配置…</div> : keys.length ? <div className="key-list">{keys.map((key) => (
              <article className={`key-card${key.active ? ' active' : ''}`} key={key.keyId}>
                <div className="key-card-heading">
                  <span><strong>{key.name}</strong>{key.active ? <em><CheckIcon />当前使用</em> : null}</span>
                  <code>{key.maskedKey}</code>
                </div>
                <dl><div><dt>Base URL</dt><dd>{key.baseUrl}</dd></div><div><dt>模型</dt><dd>{key.model}</dd></div></dl>
                {testResults[key.keyId] ? <p className={`key-test-result ${testResults[key.keyId].ok ? 'success' : 'failed'}`}>{testResults[key.keyId].message} · {testResults[key.keyId].latencyMs}ms</p> : null}
                <div className="key-card-actions">
                  {!key.active ? <button type="button" disabled={Boolean(busyId)} onClick={() => void activate(key.keyId)}>设为当前</button> : null}
                  <button type="button" disabled={Boolean(busyId)} onClick={() => void test(key.keyId)}>{busyId === key.keyId ? '处理中…' : '测试连接'}</button>
                  <button type="button" disabled={Boolean(busyId)} onClick={() => setChatKey(key)}>对话测试</button>
                  <button type="button" disabled={Boolean(busyId)} onClick={() => editKey(key)}>编辑</button>
                  <button className="key-delete-button" type="button" disabled={Boolean(busyId)} onClick={() => void remove(key)} aria-label={`删除 ${key.name}`}><TrashIcon /></button>
                </div>
              </article>
            ))}</div> : <div className="key-empty"><strong>还没有模型连接</strong><span>添加后可设为当前，用于素材理解与排序。</span></div>}
          </div>

          <form className="key-form" onSubmit={save}>
            <div className="key-section-title"><strong>{editingId ? '编辑模型连接' : '添加模型连接'}</strong>{editingId ? <button type="button" onClick={resetForm}>取消编辑</button> : null}</div>
            <label><span>连接名称</span><input required maxLength={40} value={form.name} onChange={(event) => setForm((current) => ({...current, name: event.target.value}))} placeholder="例如：生产模型连接" /></label>
            <label><span>服务地址</span><input required type="url" value={form.baseUrl} onChange={(event) => setForm((current) => ({...current, baseUrl: event.target.value}))} placeholder="https://api.example.com" /><small>可填写域名根、/v1 或完整 /v1/responses</small></label>
            <div className="key-model-field">
              <div className="key-field-heading"><label htmlFor="relay-model-select">模型</label><button type="button" disabled={!canFetchModels || loadingModels} onClick={() => void fetchModels()}>{loadingModels ? '正在获取…' : '获取模型'}</button></div>
              <select id="relay-model-select" required value={form.model} disabled={!availableModels.length || loadingModels} onChange={(event) => setForm((current) => ({...current, model: event.target.value}))}>
                {!modelOptions.length ? <option value="">请先从上游获取模型</option> : null}
                {modelOptions.map((model) => <option value={model} key={model}>{model}</option>)}
              </select>
              <small className={modelStatus ? 'success' : ''}>{modelStatus || (editingId ? `当前保存模型：${form.model}。点击获取可刷新上游列表。` : '填写 Base URL 和 API Key 后获取上游模型。')}</small>
            </div>
            <label><span>API Key</span><input required={!editingId} minLength={editingId ? undefined : 8} maxLength={500} type="password" autoComplete="new-password" value={form.apiKey} onChange={(event) => setForm((current) => ({...current, apiKey: event.target.value}))} placeholder={editingId ? '留空则保留原凭据' : '输入模型服务 API Key'} /></label>
            <label className="key-active-option"><input type="checkbox" checked={form.active} onChange={(event) => setForm((current) => ({...current, active: event.target.checked}))} /><span>保存后设为当前模型连接</span></label>
            <div className="key-security-note"><ShieldIcon /><span>API Key 不会出现在任务合同、日志或 API 响应中。服务端使用 AES-256-GCM 加密保存。</span></div>
            {error ? <div className="key-form-error" role="alert">{error}</div> : null}
            <button className="key-save-button" type="submit" disabled={saving}>{saving ? '正在安全保存…' : editingId ? '保存修改' : '添加并保存连接'}</button>
          </form>
        </div>
      </section>
      {chatKey ? <RelayChatTester relayKey={chatKey} context={context} onClose={() => setChatKey(undefined)} /> : null}
    </div>
  );
}
