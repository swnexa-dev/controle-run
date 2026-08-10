import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowClockwise, ArrowLeft, ArrowSquareOut, CaretRight, FolderOpen, GearSix, Hammer, Pause, Play, Plus, Pulse, Trash, X } from '@phosphor-icons/react'
import type { AppState, EnvVarDraft, ProjectAction, ProjectDraft, ProjectView } from '../shared/types'
import './style.css'
import './groups.css'
import './build.css'
import './window-titlebar.css'
import { GitHubRunnersPage } from './github-runners'
import { CloudflareTunnelsPage } from './cloudflare-tunnels'
import './button-effects.css'

const EMPTY: AppState = { projectPaths: [], projects: [] }
const formatBytes = (value: number) => value ? `${(value / 1048576).toFixed(value > 104857600 ? 0 : 1)} MB` : '0 MB'
function formatUptime(ms: number) {
  if (!ms) return '—'
  const minutes = Math.floor(ms / 60000), days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60)
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}min` : `${minutes}min`
}

function ConfigModal({ project, onClose, onSave }: { project: ProjectView; onClose(): void; onSave(draft: ProjectDraft, variables: EnvVarDraft[]): void }) {
  const [draft, setDraft] = useState<ProjectDraft>({
    id: project.id,
    name: project.name,
    mode: project.mode,
    npmScript: project.npmScript,
    buildScript: project.buildScript,
    buildOnDeploy: project.buildOnDeploy,
    installDependenciesOnDeploy: project.installDependenciesOnDeploy,
    entry: project.entry,
    args: project.args,
    autoStart: project.autoStart
  })
  const [variables, setVariables] = useState<EnvVarDraft[]>([])
  const [envLoading, setEnvLoading] = useState(true)
  const [envError, setEnvError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    window.controleRun.readEnv(project.id)
      .then((items) => { if (active) setVariables(items.length ? items : [{ key: '', value: '' }]) })
      .catch((error) => { if (active) setEnvError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (active) setEnvLoading(false) })
    return () => { active = false }
  }, [project.id])
  const updateVariable = (index: number, patch: Partial<EnvVarDraft>) => setVariables((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item))
  const removeVariable = (index: number) => setVariables((items) => items.filter((_item, itemIndex) => itemIndex !== index))
  return <div className="modal-backdrop" onMouseDown={onClose}>
    <form className="modal env-modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSave(draft, variables) }}>
      <div className="modal-title"><div><span>CONFIGURAÇÃO · {project.groupName}</span><h2>{project.name}</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={20}/></button></div>
      <label>Nome exibido<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}/></label>
      <label>Forma de inicialização<select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as 'npm' | 'script' })}><option value="npm">Script do package.json</option><option value="script">Arquivo JavaScript direto</option></select></label>
      {draft.mode === 'npm'
        ? <label>Script NPM<select value={draft.npmScript || ''} onChange={(e) => setDraft({ ...draft, npmScript: e.target.value })}><option value="">Selecione...</option>{project.availableScripts.map((script) => <option key={script}>{script}</option>)}</select></label>
        : <label>Arquivo de entrada<input placeholder="dist/index.js" value={draft.entry || ''} onChange={(e) => setDraft({ ...draft, entry: e.target.value })}/></label>}
      <label>Argumentos opcionais<input placeholder="--port 3000" value={draft.args || ''} onChange={(e) => setDraft({ ...draft, args: e.target.value })}/></label>
      <label className="toggle"><input type="checkbox" checked={draft.autoStart} onChange={(e) => setDraft({ ...draft, autoStart: e.target.checked })}/> Iniciar automaticamente ao abrir</label>
      <section className="build-settings">
        <div><span>BUILD</span><p>Compile este serviço antes de reiniciá-lo em um deploy.</p></div>
        <label>Script de build<select value={draft.buildScript || ''} onChange={(e) => {
          const buildScript = e.target.value || undefined
          setDraft({ ...draft, buildScript, buildOnDeploy: Boolean(buildScript) })
        }}><option value="">Não executar build</option>{project.availableScripts.map((script) => <option key={script}>{script}</option>)}</select></label>
        <label className="toggle"><input type="checkbox" disabled={!draft.buildScript} checked={draft.buildOnDeploy} onChange={(e) => setDraft({ ...draft, buildOnDeploy: e.target.checked })}/> Executar build automaticamente nos deploys</label>
        <label className="toggle"><input type="checkbox" disabled={!draft.buildScript || !draft.buildOnDeploy} checked={draft.installDependenciesOnDeploy} onChange={(e) => setDraft({ ...draft, installDependenciesOnDeploy: e.target.checked })}/> Instalar dependências quando o lockfile mudar</label>
      </section>
      <section className="env-editor">
        <div className="env-editor-head"><div><span>VARIÁVEIS .ENV</span><p>{project.path}\.env</p></div><button type="button" className="action-button" onClick={() => setVariables([...variables, { key: '', value: '' }])}><Plus/>Adicionar</button></div>
        {envError && <p className="env-message">{envError}</p>}
        {envLoading ? <p className="env-message">Carregando .env...</p> : <div className="env-rows">
          {variables.map((item, index) => <div className="env-row" key={index}>
            <input placeholder="CHAVE" value={item.key} onChange={(e) => updateVariable(index, { key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })}/>
            <input placeholder="valor" value={item.value} onChange={(e) => updateVariable(index, { value: e.target.value })}/>
            <button type="button" className="icon-button danger" title="Remover variável" onClick={() => removeVariable(index)}><Trash/></button>
          </div>)}
        </div>}
      </section>
      <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancelar</button><button className="button primary">Salvar configuração</button></div>
    </form>
  </div>
}

function ProjectCard({ project, busy, onAction, onConfigure, onOpen, onOpenUrl }: { project: ProjectView; busy: boolean; onAction(action: ProjectAction): void; onConfigure(): void; onOpen(): void; onOpenUrl(): void }) {
  const online = project.status === 'online', configured = Boolean(project.npmScript || project.entry)
  return <article className={`project-card ${online ? 'active' : ''}`}>
    <div className="card-head"><div className={`status-dot ${project.status}`}/><div className="project-identity"><h3>{project.name}</h3>{project.packageName && project.packageName.toLowerCase() !== project.name.toLowerCase() && <small>{project.packageName}</small>}<button onClick={onOpen} title={project.path}>{project.path}</button></div><span className={`status-pill ${project.status}`}>{online ? 'ONLINE' : project.status === 'errored' ? 'ERRO' : 'PAUSADO'}</span></div>
    <div className="metrics"><div><small>CPU</small><strong>{project.cpu.toFixed(1)}%</strong></div><div><small>MEMÓRIA</small><strong>{formatBytes(project.memory)}</strong></div><div><small>TEMPO ONLINE</small><strong>{formatUptime(project.uptime)}</strong></div><div><small>REINÍCIOS</small><strong>{project.restarts}</strong></div></div>
    <div className="process-meta"><span>PID {project.pid || '—'}</span><span>Node {project.nodeVersion || '—'}</span><span>{project.mode === 'npm' ? `npm run ${project.npmScript || '—'}` : project.entry || 'Não configurado'}</span></div>
    <div className={`service-link ${project.localUrl ? '' : 'muted'}`}><div><small>ACESSO LOCAL</small><strong>{project.localUrl || 'Link não detectado'}</strong></div><button className="icon-button" title="Abrir no navegador" disabled={!project.localUrl} onClick={onOpenUrl}><ArrowSquareOut/></button></div>
    <div className="card-actions"><button className="action-button" disabled={busy || !configured} onClick={() => onAction(online ? 'stop' : 'start')}>{online ? <Pause weight="fill"/> : <Play weight="fill"/>}{online ? 'Pausar' : 'Iniciar'}</button><button className="action-button" disabled={busy || !online} onClick={() => onAction('restart')}><ArrowClockwise/>Reiniciar</button>{project.buildScript && <button className="action-button" disabled={busy} title={`npm run ${project.buildScript}`} onClick={() => onAction('build-restart')}><Hammer/>Build + reiniciar</button>}<button className="action-button push-right" onClick={onConfigure}><GearSix/>Configurar</button></div>
  </article>
}

function ProjectFolderCard({ group, onOpen, onRemove }: { group: { id: string; name: string; services: ProjectView[] }; onOpen(): void; onRemove(): void }) {
  const online = group.services.filter((service) => service.status === 'online').length
  const errored = group.services.filter((service) => service.status === 'errored').length
  const cpu = group.services.reduce((total, service) => total + service.cpu, 0)
  const memory = group.services.reduce((total, service) => total + service.memory, 0)
  const rootPath = group.services[0]?.groupPath || ''
  return <article className={`folder-card ${online ? 'active' : ''}`} onClick={onOpen}>
    <div className="folder-card-head">
      <div className="folder-mark"><FolderOpen weight="fill"/></div>
      <div className="folder-title"><span>PASTA PRINCIPAL</span><h3>{group.name}</h3><p title={rootPath}>{rootPath}</p></div>
      <button className="icon-button danger" title="Remover projeto" onClick={(event) => { event.stopPropagation(); onRemove() }}><Trash/></button>
    </div>
    <div className="folder-metrics">
      <div><small>SERVIÇOS</small><strong>{group.services.length}</strong></div>
      <div><small>ONLINE</small><strong className="green">{online}</strong></div>
      <div><small>ERROS</small><strong>{errored}</strong></div>
      <div><small>CPU</small><strong>{cpu.toFixed(1)}%</strong></div>
      <div><small>MEMÓRIA</small><strong>{formatBytes(memory)}</strong></div>
    </div>
    <div className="folder-card-footer"><span>Ver backend, frontend e configurações</span><CaretRight weight="bold"/></div>
  </article>
}

function App() {
  const [state, setState] = useState(EMPTY), [loading, setLoading] = useState(true), [busyId, setBusyId] = useState<string | null>(null), [editing, setEditing] = useState<ProjectView | null>(null), [selectedGroupId, setSelectedGroupId] = useState<string | null>(null), [error, setError] = useState<string | null>(null)
  const [activePage, setActivePage] = useState<'projects' | 'runners' | 'tunnels'>('projects')
  const refresh = useCallback(async () => { try { setState(await window.controleRun.refresh()); setError(null) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } }, [])
  useEffect(() => { window.controleRun.getState().then(setState).catch((e) => setError(String(e))).finally(() => setLoading(false)) }, [])
  useEffect(() => { if (!state.projectPaths.length) return; const timer = window.setInterval(refresh, 3000); return () => window.clearInterval(timer) }, [state.projectPaths.length, refresh])
  const groups = useMemo(() => {
    const grouped = new Map<string, { id: string; name: string; services: ProjectView[] }>()
    for (const service of state.projects) {
      const group = grouped.get(service.groupId) || { id: service.groupId, name: service.groupName, services: [] }
      group.services.push(service)
      grouped.set(service.groupId, group)
    }
    return [...grouped.values()]
  }, [state.projects])
  const selectedGroup = useMemo(() => groups.find((group) => group.id === selectedGroupId) || null, [groups, selectedGroupId])
  const totals = useMemo(() => ({ online: state.projects.filter((p) => p.status === 'online').length, cpu: state.projects.reduce((n, p) => n + p.cpu, 0), memory: state.projects.reduce((n, p) => n + p.memory, 0) }), [state.projects])
  useEffect(() => { if (selectedGroupId && !selectedGroup) setSelectedGroupId(null) }, [selectedGroupId, selectedGroup])
  async function addProject() { setLoading(true); try { setState(await window.controleRun.addProject()); setError(null) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setLoading(false) } }
  async function removeProject(groupId: string, name: string) { if (!window.confirm(`Remover ${name} do Controle Run? Os arquivos da pasta não serão apagados.`)) return; setLoading(true); try { setState(await window.controleRun.removeProject(groupId)); setError(null) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setLoading(false) } }
  async function action(project: ProjectView, command: ProjectAction) { setBusyId(project.id); try { setState(await window.controleRun.action(project.id, command)); setError(null) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusyId(null) } }
  async function save(draft: ProjectDraft, variables: EnvVarDraft[]) { setBusyId(draft.id); try { await window.controleRun.saveEnv(draft.id, variables); setState(await window.controleRun.configure(draft)); setEditing(null); setError(null) } catch (e) { setError(String(e)) } finally { setBusyId(null) } }
  return <main>
    <div className="window-titlebar" aria-hidden="true"><span>CONTROLE RUN</span><i/></div>
    <header><div className="header-left"><div className="brand"><div className="brand-mark"><Pulse weight="bold"/></div><div><h1>Controle <span>Run</span></h1><p>PROCESS MANAGER</p></div></div><nav className="app-nav"><button className={activePage === 'projects' ? 'active' : ''} onClick={() => setActivePage('projects')}>Projetos</button><button className={activePage === 'runners' ? 'active' : ''} onClick={() => { setActivePage('runners'); setSelectedGroupId(null) }}>Runners GitHub</button><button className={activePage === 'tunnels' ? 'active' : ''} onClick={() => { setActivePage('tunnels'); setSelectedGroupId(null) }}>Túneis</button></nav></div></header>
    {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError(null)}><X/></button></div>}
    {activePage === 'projects' ? <>
      {selectedGroup ? <section className="detail-hero"><button className="back-button" onClick={() => setSelectedGroupId(null)}><ArrowLeft/>Voltar</button><div><p className="eyebrow">DETALHES DO PROJETO</p><h2>{selectedGroup.name}</h2><p>{selectedGroup.services[0]?.groupPath}</p></div><div className="hero-actions"><button className="button secondary" onClick={() => window.controleRun.openFolder(selectedGroup.services[0].id)}><FolderOpen/>Abrir pasta</button><button className="button secondary" onClick={refresh} disabled={!state.projectPaths.length}><ArrowClockwise className={loading ? 'spin' : ''}/>Atualizar</button></div></section> : <section className="hero"><div><p className="eyebrow">VISÃO GERAL</p><h2>Seus projetos, sob controle.</h2><p>Adicione pastas de projetos e abra uma pasta para ver frontend e backend separadamente.</p></div><div className="hero-actions"><button className="button primary" onClick={addProject}><Plus/>Adicionar projeto</button><button className="button secondary" onClick={refresh} disabled={!state.projectPaths.length}><ArrowClockwise className={loading ? 'spin' : ''}/>Atualizar</button></div></section>}
      {state.projectPaths.length > 0 && !selectedGroup && <section className="summary"><div><small>PROJETOS</small><strong>{groups.length}</strong></div><div><small>SERVIÇOS ONLINE</small><strong className="green">{totals.online}/{state.projects.length}</strong></div><div><small>CPU TOTAL</small><strong>{totals.cpu.toFixed(1)}%</strong></div><div><small>MEMÓRIA TOTAL</small><strong>{formatBytes(totals.memory)}</strong></div></section>}
      {!state.projectPaths.length ? <section className="empty"><div className="empty-icon"><FolderOpen/></div><h3>Adicione seu primeiro projeto</h3><p>Escolha a pasta do projeto. Dentro dela, o Controle Run encontrará frontend e backend e administrará os dois serviços separadamente.</p><button className="button primary" onClick={addProject}><Plus/>Adicionar projeto</button></section> : state.projects.length === 0 ? <section className="empty"><h3>Nenhum serviço encontrado</h3><p>As pastas adicionadas não estão mais disponíveis. Verifique os caminhos dos projetos.</p></section> : selectedGroup ? <section className="project-group detail-panel"><div className="group-heading"><div><span>SERVIÇOS</span><h3>Backend e frontend</h3><p className="group-path">Gerencie cada parte do projeto separadamente.</p></div><div className="group-controls"><small>{selectedGroup.services.filter((service) => service.status === 'online').length}/{selectedGroup.services.length} online</small><button className="icon-button danger" title="Remover projeto" onClick={() => removeProject(selectedGroup.id, selectedGroup.name)}><Trash/></button></div></div><div className="project-grid">{selectedGroup.services.map((project) => <ProjectCard key={project.id} project={project} busy={busyId === project.id} onAction={(command) => action(project, command)} onConfigure={() => setEditing(project)} onOpen={() => window.controleRun.openFolder(project.id)} onOpenUrl={() => window.controleRun.openUrl(project.id)}/>)}</div></section> : <section className="folder-grid">{groups.map((group) => <ProjectFolderCard key={group.id} group={group} onOpen={() => setSelectedGroupId(group.id)} onRemove={() => removeProject(group.id, group.name)}/>)}</section>}
    </> : activePage === 'runners' ? <GitHubRunnersPage projectGroups={groups.map((group) => ({ id: group.id, name: group.name }))} onError={setError}/> : <CloudflareTunnelsPage projects={state.projects} onError={setError}/>}
    <footer><span><i/> PM2 LOCAL</span><span>ORQUESTRAÇÃO LOCAL-FIRST</span></footer>
    {editing && <ConfigModal project={editing} onClose={() => setEditing(null)} onSave={save}/>} 
  </main>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>)
