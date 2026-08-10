import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowClockwise,
  ArrowSquareOut,
  Cloud,
  Copy,
  DownloadSimple,
  FileText,
  LinkSimple,
  Pause,
  Play,
  Plus,
  ShieldCheck,
  Trash,
  X
} from '@phosphor-icons/react'
import type {
  CloudflareTunnelAction,
  CloudflareTunnelDraft,
  CloudflareTunnelState,
  CloudflareTunnelView,
  ProjectView
} from '../shared/types'
import './cloudflare-tunnels.css'

const EMPTY: CloudflareTunnelState = { tunnels: [], cloudflaredInstalled: false }

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function AddTunnelModal({ projects, busy, onClose, onAdd }: {
  projects: ProjectView[]
  busy: boolean
  onClose(): void
  onAdd(draft: CloudflareTunnelDraft): Promise<void>
}) {
  const first = projects[0]
  const [draft, setDraft] = useState<CloudflareTunnelDraft>({
    name: first ? `${first.groupName}-${first.serviceType}` : '',
    projectId: first?.id || '',
    originUrl: first?.localUrl || '',
    mode: 'quick',
    protocol: 'auto',
    logLevel: 'info',
    autoStart: true
  })
  const [localError, setLocalError] = useState<string | null>(null)

  const selectProject = (projectId: string) => {
    const project = projects.find((item) => item.id === projectId)
    setDraft((current) => ({
      ...current,
      projectId,
      originUrl: project?.localUrl || current.originUrl,
      name: current.name || (project ? `${project.groupName}-${project.serviceType}` : '')
    }))
  }

  return <div className="modal-backdrop" onMouseDown={busy ? undefined : onClose}>
    <form className="modal tunnel-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={async (event) => {
      event.preventDefault()
      setLocalError(null)
      try { await onAdd(draft) } catch (error) { setLocalError(messageOf(error)) }
    }}>
      <div className="modal-title"><div><span>NOVO ACESSO EXTERNO</span><h2>Adicionar Cloudflare Tunnel</h2></div><button type="button" className="icon-button" disabled={busy} onClick={onClose}><X/></button></div>
      {localError && <p className="tunnel-form-error">{localError}</p>}
      <div className="tunnel-form-grid">
        <label>Nome do túnel<input required value={draft.name} disabled={busy} placeholder="meu-projeto" onChange={(event) => setDraft({ ...draft, name: event.target.value })}/></label>
        <label>Tipo<select value={draft.mode} disabled={busy} onChange={(event) => setDraft({ ...draft, mode: event.target.value as 'quick' | 'token' })}><option value="quick">Temporário — link automático</option><option value="token">Permanente — token Cloudflare</option></select></label>
      </div>
      <label>Serviço do projeto<select required value={draft.projectId} disabled={busy} onChange={(event) => selectProject(event.target.value)}><option value="">Selecione...</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.groupName} — {project.name}</option>)}</select></label>
      <label>Endereço local do serviço<input required value={draft.originUrl} disabled={busy} placeholder="http://localhost:3000" onChange={(event) => setDraft({ ...draft, originUrl: event.target.value })}/></label>
      {draft.mode === 'token' && <>
        <label>Token do túnel<input required type="password" autoComplete="off" value={draft.token || ''} disabled={busy} placeholder="Cole somente o token eyJ..." onChange={(event) => setDraft({ ...draft, token: event.target.value })}/></label>
        <label>Endereço público configurado <small className="optional">opcional</small><input value={draft.publicUrl || ''} disabled={busy} placeholder="https://app.seudominio.com" onChange={(event) => setDraft({ ...draft, publicUrl: event.target.value })}/></label>
        <p className="tunnel-help">No túnel permanente, configure no painel da Cloudflare um Public Hostname apontando para <strong>{draft.originUrl || 'o endereço local acima'}</strong>. O Controle Run mantém o conector ativo no servidor.</p>
      </>}
      {draft.mode === 'quick' && <p className="tunnel-help">O endereço <strong>trycloudflare.com</strong> será criado automaticamente. Ele muda quando o processo do túnel é recriado e é indicado para testes.</p>}
      <div className="tunnel-form-grid">
        <label>Protocolo<select value={draft.protocol} disabled={busy} onChange={(event) => setDraft({ ...draft, protocol: event.target.value as 'auto' | 'quic' | 'http2' })}><option value="auto">Automático</option><option value="quic">QUIC</option><option value="http2">HTTP/2</option></select></label>
        <label>Nível dos logs<select value={draft.logLevel} disabled={busy} onChange={(event) => setDraft({ ...draft, logLevel: event.target.value as 'debug' | 'info' | 'warn' | 'error' })}><option value="info">Informações</option><option value="warn">Avisos</option><option value="error">Somente erros</option><option value="debug">Diagnóstico detalhado</option></select></label>
      </div>
      <label className="toggle"><input type="checkbox" checked={draft.autoStart} disabled={busy} onChange={(event) => setDraft({ ...draft, autoStart: event.target.checked })}/> Iniciar automaticamente junto com o Controle Run</label>
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancelar</button><button className="button primary" disabled={busy}>{busy ? 'Preparando cloudflared...' : 'Adicionar e iniciar'}</button></div>
    </form>
  </div>
}

function TunnelCard({ tunnel, project, busy, onAction, onRemove, onLogs, onOpen, onCopy }: {
  tunnel: CloudflareTunnelView
  project?: ProjectView
  busy: boolean
  onAction(action: CloudflareTunnelAction): void
  onRemove(): void
  onLogs(): void
  onOpen(): void
  onCopy(): void
}) {
  const online = tunnel.status === 'online'
  const status = tunnel.connectionStatus === 'connected' ? 'CONECTADO' : tunnel.connectionStatus === 'connecting' ? 'CONECTANDO' : tunnel.connectionStatus === 'error' ? 'ERRO' : 'PARADO'
  return <article className={`tunnel-card ${online ? 'active' : ''}`}>
    <div className="tunnel-card-head"><div className="tunnel-mark"><Cloud weight="fill"/></div><div><h3>{tunnel.name}</h3><p>{project ? `${project.groupName} — ${project.name}` : 'Projeto não encontrado'}</p></div><span className={`status-pill ${tunnel.status}`}>{status}</span></div>
    <div className="tunnel-meta"><div><small>TIPO</small><strong>{tunnel.mode === 'quick' ? 'Temporário' : 'Permanente'}</strong></div><div><small>PROTOCOLO</small><strong>{tunnel.protocol.toUpperCase()}</strong></div><div><small>PID</small><strong>{tunnel.pid || '—'}</strong></div><div><small>REINÍCIOS</small><strong>{tunnel.restarts}</strong></div></div>
    <div className="tunnel-route"><small>ORIGEM LOCAL</small><strong>{tunnel.originUrl}</strong></div>
    <div className={`tunnel-route public ${tunnel.publicUrl ? '' : 'pending'}`}><div><small>ENDEREÇO PÚBLICO</small><strong>{tunnel.publicUrl || (online ? 'Aguardando endereço...' : 'Disponível após iniciar')}</strong></div><div>{tunnel.publicUrl && <><button className="icon-button" title="Copiar endereço" onClick={onCopy}><Copy/></button><button className="icon-button" title="Abrir endereço" onClick={onOpen}><ArrowSquareOut/></button></>}</div></div>
    {tunnel.error && <p className="tunnel-error">{tunnel.error}</p>}
    <div className="tunnel-actions"><button className="action-button" disabled={busy} onClick={() => onAction(online ? 'stop' : 'start')}>{online ? <Pause weight="fill"/> : <Play weight="fill"/>}{online ? 'Parar' : 'Iniciar'}</button><button className="action-button" disabled={busy || !online} onClick={() => onAction('restart')}><ArrowClockwise/>Reiniciar</button><button className="action-button push-right" disabled={busy} onClick={onLogs}><FileText/>Logs</button><button className="icon-button danger" disabled={busy} title="Excluir túnel" onClick={onRemove}><Trash/></button></div>
  </article>
}

export function CloudflareTunnelsPage({ projects, onError }: { projects: ProjectView[]; onError(message: string | null): void }) {
  const [state, setState] = useState(EMPTY)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [installing, setInstalling] = useState(false)
  const projectsById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])

  const refresh = async (silent = false) => {
    if (!silent) setLoading(true)
    try { setState(await window.controleRun.getCloudflareTunnels()); onError(null) }
    catch (error) { onError(messageOf(error)) }
    finally { if (!silent) setLoading(false) }
  }
  useEffect(() => {
    refresh()
    const timer = window.setInterval(() => refresh(true), 3000)
    return () => window.clearInterval(timer)
  }, [])

  const action = async (tunnel: CloudflareTunnelView, command: CloudflareTunnelAction) => {
    setBusyId(tunnel.id)
    try { setState(await window.controleRun.actionCloudflareTunnel(tunnel.id, command)); onError(null) }
    catch (error) { onError(messageOf(error)) }
    finally { setBusyId(null) }
  }
  const remove = async (tunnel: CloudflareTunnelView) => {
    const detail = tunnel.mode === 'token' ? ' O túnel da sua conta Cloudflare não será apagado; somente este conector local.' : ''
    if (!window.confirm(`Excluir ${tunnel.name} do Controle Run?${detail}`)) return
    setBusyId(tunnel.id)
    try { setState(await window.controleRun.removeCloudflareTunnel(tunnel.id)); onError(null) }
    catch (error) { onError(messageOf(error)) }
    finally { setBusyId(null) }
  }
  const install = async () => {
    setInstalling(true)
    try { setState(await window.controleRun.installCloudflared()); onError(null) }
    catch (error) { onError(messageOf(error)) }
    finally { setInstalling(false) }
  }
  const add = async (draft: CloudflareTunnelDraft) => {
    setInstalling(true)
    try { setState(await window.controleRun.addCloudflareTunnel(draft)); setAdding(false); onError(null) }
    catch (error) { throw error }
    finally { setInstalling(false) }
  }

  return <>
    <section className="tunnel-hero"><div><p className="eyebrow">ACESSO EXTERNO</p><h2>Cloudflare Tunnels</h2><p>Exponha serviços locais sem abrir portas no roteador ou no firewall.</p></div><div className="hero-actions">{!state.cloudflaredInstalled && <button className="button secondary" disabled={installing} onClick={install}><DownloadSimple/>{installing ? 'Instalando...' : 'Instalar cloudflared'}</button>}<button className="button primary" disabled={!projects.length || installing} onClick={() => setAdding(true)}><Plus/>Novo túnel</button><button className="button secondary" disabled={loading} onClick={() => refresh()}><ArrowClockwise className={loading ? 'spin' : ''}/>Atualizar</button></div></section>
    <section className={`cloudflared-banner ${state.cloudflaredInstalled ? 'ready' : ''}`}><ShieldCheck/><div><strong>{state.cloudflaredInstalled ? `cloudflared ${state.cloudflaredVersion || 'detectado'}` : 'cloudflared ainda não instalado'}</strong><span>{state.cloudflaredInstalled ? state.cloudflaredPath : 'O Controle Run pode baixar e validar o executável oficial da Cloudflare.'}</span></div></section>
    {!projects.length ? <section className="empty"><LinkSimple/><h3>Adicione um projeto primeiro</h3><p>Um túnel precisa ser associado a um serviço e ao endereço local que será publicado.</p></section> : !state.tunnels.length ? <section className="empty"><Cloud/><h3>Nenhum túnel configurado</h3><p>Use um túnel temporário para testes ou um token permanente criado no painel da Cloudflare.</p><button className="button primary" onClick={() => setAdding(true)}><Plus/>Adicionar túnel</button></section> : <section className="tunnel-grid">{state.tunnels.map((tunnel) => <TunnelCard key={tunnel.id} tunnel={tunnel} project={projectsById.get(tunnel.projectId)} busy={busyId === tunnel.id} onAction={(command) => action(tunnel, command)} onRemove={() => remove(tunnel)} onLogs={() => window.controleRun.openCloudflareTunnelLogs(tunnel.id).catch((error) => onError(messageOf(error)))} onOpen={() => window.controleRun.openCloudflareTunnelUrl(tunnel.id).catch((error) => onError(messageOf(error)))} onCopy={() => window.controleRun.copyCloudflareTunnelUrl(tunnel.id).catch((error) => onError(messageOf(error)))}/>)}</section>}
    {adding && <AddTunnelModal projects={projects} busy={installing} onClose={() => setAdding(false)} onAdd={add}/>}
  </>
}
