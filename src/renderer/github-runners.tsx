import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowClockwise,
  CheckCircle,
  Copy,
  FileCode,
  FolderOpen,
  GithubLogo,
  HardDrives,
  Pause,
  Play,
  Plus,
  RocketLaunch,
  ShieldCheck,
  Trash,
  WarningCircle,
  X
} from '@phosphor-icons/react'
import type {
  GitHubRunnerAction,
  GitHubRunnerInstallDefaults,
  GitHubRunnerInstallDraft,
  GitHubRunnerProgress,
  GitHubRunnerPrepareDeploymentResult,
  GitHubRunnerState,
  GitHubRunnerView
} from '../shared/types'
import './github-runners.css'
import './github-deployment.css'

interface ProjectGroupOption { id: string; name: string }

interface RunnerPageProps {
  projectGroups: ProjectGroupOption[]
  onError(message: string | null): void
}

const EMPTY_STATE: GitHubRunnerState = { runners: [] }

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function InstallRunnerModal({
  defaults,
  groups,
  progress,
  installing,
  onClose,
  onInstall
}: {
  defaults: GitHubRunnerInstallDefaults
  groups: ProjectGroupOption[]
  progress: GitHubRunnerProgress | null
  installing: boolean
  onClose(): void
  onInstall(draft: GitHubRunnerInstallDraft): Promise<void>
}) {
  const [name, setName] = useState(defaults.name)
  const [scope, setScope] = useState<'organization' | 'repository'>('organization')
  const [targetUrl, setTargetUrl] = useState('')
  const [registrationToken, setRegistrationToken] = useState('')
  const [installPath, setInstallPath] = useState(defaults.installPath)
  const [pathEdited, setPathEdited] = useState(false)
  const [workFolder, setWorkFolder] = useState(defaults.workFolder)
  const [labels, setLabels] = useState('deploy,controle-run')
  const [serviceAccount, setServiceAccount] = useState<'network-service' | 'custom'>('network-service')
  const [windowsAccount, setWindowsAccount] = useState(defaults.currentWindowsAccount)
  const [windowsPassword, setWindowsPassword] = useState('')
  const [projectGroupId, setProjectGroupId] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (pathEdited) return
    const timer = window.setTimeout(() => {
      window.controleRun.suggestGitHubRunnerPath(name).then(setInstallPath).catch(() => undefined)
    }, 150)
    return () => window.clearTimeout(timer)
  }, [name, pathEdited])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setLocalError(null)
    try {
      await onInstall({
        name,
        scope,
        targetUrl,
        registrationToken,
        installPath,
        workFolder,
        labels: labels.split(',').map((item) => item.trim()).filter(Boolean),
        serviceAccount,
        windowsAccount: serviceAccount === 'custom' ? windowsAccount : undefined,
        windowsPassword: serviceAccount === 'custom' ? windowsPassword : undefined,
        projectGroupId: projectGroupId || undefined
      })
    } catch (error) {
      setLocalError(messageOf(error))
    }
  }

  return <div className="modal-backdrop" onMouseDown={installing ? undefined : onClose}>
    <form className="modal runner-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={submit}>
      <div className="modal-title">
        <div><span>GITHUB ACTIONS</span><h2>Instalar novo runner</h2></div>
        <button type="button" className="icon-button" disabled={installing} onClick={onClose}><X/></button>
      </div>

      <div className="runner-form-grid">
        <label>Escopo
          <select value={scope} disabled={installing} onChange={(event) => {
            const nextScope = event.target.value as typeof scope
            setScope(nextScope)
            if (nextScope === 'organization') setProjectGroupId('')
          }}>
            <option value="organization">Organização — vários repositórios</option>
            <option value="repository">Repositório — acesso isolado</option>
          </select>
        </label>
        <label>Nome do runner
          <input value={name} disabled={installing} onChange={(event) => setName(event.target.value)}/>
        </label>
      </div>

      <label>URL do {scope === 'organization' ? 'GitHub da organização' : 'repositório'}
        <input
          placeholder={scope === 'organization' ? 'https://github.com/swnexa-dev' : 'https://github.com/swnexa-dev/teste1'}
          value={targetUrl}
          disabled={installing}
          onChange={(event) => setTargetUrl(event.target.value)}
        />
      </label>
      <label>Token temporário de registro
        <input type="password" autoComplete="off" placeholder="Cole o token gerado em Settings › Actions › Runners" value={registrationToken} disabled={installing} onChange={(event) => setRegistrationToken(event.target.value)}/>
        <small className="field-help">Usado somente durante o registro. O Controle Run não salva esse valor.</small>
      </label>

      <div className="runner-form-grid">
        <label>Diretório de instalação
          <input value={installPath} disabled={installing} onChange={(event) => { setInstallPath(event.target.value); setPathEdited(true) }}/>
        </label>
        <label>Pasta de trabalho
          <input value={workFolder} disabled={installing} onChange={(event) => setWorkFolder(event.target.value)}/>
        </label>
      </div>
      <label>Labels adicionais
        <input placeholder="deploy,windows,producao" value={labels} disabled={installing} onChange={(event) => setLabels(event.target.value)}/>
      </label>

      <label>Conta do serviço do Windows
        <select value={serviceAccount} disabled={installing} onChange={(event) => setServiceAccount(event.target.value as typeof serviceAccount)}>
          <option value="network-service">Network Service — isolado para builds</option>
          <option value="custom">Conta Windows específica — acesso a projetos/PM2</option>
        </select>
      </label>
      {serviceAccount === 'network-service'
        ? <div className="runner-notice compact"><ShieldCheck/><span>Mais isolado. Use uma conta específica se o workflow precisar acessar as pastas do usuário ou o mesmo ambiente PM2.</span></div>
        : <div className="runner-form-grid">
          <label>Conta Windows
            <input value={windowsAccount} disabled={installing} onChange={(event) => setWindowsAccount(event.target.value)}/>
          </label>
          <label>Senha da conta
            <input type="password" autoComplete="off" value={windowsPassword} disabled={installing} onChange={(event) => setWindowsPassword(event.target.value)}/>
          </label>
        </div>}

      <label>Projeto para deploy automático <small className="optional">opcional</small>
        <select value={projectGroupId} disabled={installing || scope !== 'repository'} onChange={(event) => {
          const groupId = event.target.value
          setProjectGroupId(groupId)
          if (groupId) setServiceAccount('custom')
        }}>
          <option value="">{scope === 'repository' ? 'Nenhum projeto específico' : 'Disponível para runner de repositório'}</option>
          {groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}
        </select>
        {scope === 'repository' && <small className="field-help">Ao escolher um projeto, o app usa a conta Windows específica necessária para acessar o clone e o PM2.</small>}
      </label>

      {(localError || progress) && <div className={`runner-progress ${localError ? 'failed' : ''}`}>
        {localError ? <WarningCircle/> : <ArrowClockwise className={installing ? 'spin' : ''}/>}<span>{localError || progress?.message}</span>
      </div>}
      <div className="modal-actions">
        <button type="button" className="button secondary" disabled={installing} onClick={onClose}>Cancelar</button>
        <button className="button primary" disabled={installing}>{installing ? 'Configurando...' : 'Instalar como serviço'}</button>
      </div>
    </form>
  </div>
}

function RemoveRunnerModal({ runner, removing, onClose, onRemove }: { runner: GitHubRunnerView; removing: boolean; onClose(): void; onRemove(token: string): Promise<void> }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  return <div className="modal-backdrop" onMouseDown={removing ? undefined : onClose}>
    <form className="modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={async (event) => {
      event.preventDefault()
      setError(null)
      try { await onRemove(token) } catch (cause) { setError(messageOf(cause)) }
    }}>
      <div className="modal-title"><div><span>REMOÇÃO SEGURA</span><h2>Remover {runner.name}</h2></div><button type="button" className="icon-button" disabled={removing} onClick={onClose}><X/></button></div>
      <p className="runner-modal-copy">No GitHub, abra o runner em <strong>Settings › Actions › Runners › Remove</strong> e copie o token temporário. O serviço será desregistrado antes da pasta ser apagada.</p>
      <label>Token temporário de remoção<input type="password" autoComplete="off" value={token} disabled={removing} onChange={(event) => setToken(event.target.value)}/></label>
      {error && <div className="runner-progress failed"><WarningCircle/><span>{error}</span></div>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={removing} onClick={onClose}>Cancelar</button><button className="button danger-button" disabled={removing}>{removing ? 'Removendo...' : 'Desregistrar e remover'}</button></div>
    </form>
  </div>
}

function RunnerCard({ runner, groupName, busy, onAction, onLogs, onPrepare, onWorkflow, onRemove }: {
  runner: GitHubRunnerView
  groupName?: string
  busy: boolean
  onAction(action: GitHubRunnerAction): void
  onLogs(): void
  onPrepare(): void
  onWorkflow(): void
  onRemove(): void
}) {
  const running = runner.serviceStatus === 'running'
  const connected = runner.connectionStatus === 'connected'
  const statusLabel = connected ? 'CONECTADO' : running ? 'SERVIÇO ATIVO' : runner.serviceStatus === 'missing' ? 'AUSENTE' : 'PARADO'
  const deployReady = runner.deployment.state === 'ready'
  const deployLabel = deployReady ? 'DEPLOY PRONTO'
    : runner.deployment.state === 'workflow-missing' ? 'WORKFLOW AUSENTE'
      : runner.deployment.state === 'workflow-outdated' ? 'WORKFLOW ALTERADO'
        : runner.deployment.state === 'invalid' ? 'RECONFIGURAR' : 'NÃO CONFIGURADO'
  return <article className={`runner-card ${running ? 'active' : ''}`}>
    <div className="runner-card-head">
      <div className="runner-logo"><GithubLogo weight="fill"/></div>
      <div className="runner-title"><h3>{runner.name}</h3><p>{runner.targetUrl}</p></div>
      <span className={`runner-status ${connected ? 'connected' : running ? 'running' : ''}`}>{statusLabel}</span>
    </div>
    <div className="runner-facts">
      <div><small>ESCOPO</small><strong>{runner.scope === 'organization' ? 'Organização' : 'Repositório'}</strong></div>
      <div><small>VERSÃO</small><strong>{runner.installedVersion}</strong></div>
      <div><small>SERVIÇO</small><strong>{runner.serviceStatus}</strong></div>
      <div><small>PROJETO</small><strong>{groupName || 'Compartilhado'}</strong></div>
    </div>
    <div className="runner-path"><HardDrives/><span title={runner.installPath}>{runner.installPath}</span></div>
    <div className="runner-labels"><span>self-hosted</span><span>Windows</span><span>X64</span>{runner.labels.map((label) => <span key={label}>{label}</span>)}</div>
    <div className={`runner-deploy ${deployReady ? 'ready' : ''}`}>
      <div className="runner-deploy-icon">{deployReady ? <CheckCircle weight="fill"/> : <RocketLaunch/>}</div>
      <div>
        <strong>{deployLabel}</strong>
        <span>{deployReady
          ? `${runner.deployment.repository} → ${runner.deployment.projectPath}`
          : runner.scope !== 'repository' ? 'Disponível para runners isolados por repositório.'
            : !runner.projectGroupId ? 'Associe este runner a um projeto.'
              : 'Prepare o executor e o workflow padrão.'}</span>
        {runner.deployment.lastDeployAt && <small className={runner.deployment.lastDeployStatus === 'failed' ? 'failed' : ''}>
          Último deploy: {runner.deployment.lastDeployStatus === 'success' ? 'sucesso' : 'falhou'} · {new Date(runner.deployment.lastDeployAt).toLocaleString('pt-BR')}
        </small>}
      </div>
    </div>
    {runner.error && <p className="runner-card-error">{runner.error}</p>}
    <div className="card-actions runner-actions">
      <button className="action-button" disabled={busy} onClick={() => onAction(running ? 'stop' : 'start')}>{running ? <Pause weight="fill"/> : <Play weight="fill"/>}{running ? 'Parar' : 'Iniciar'}</button>
      <button className="action-button" disabled={busy || !running} onClick={() => onAction('restart')}><ArrowClockwise/>Reiniciar</button>
      <button className="action-button push-right" onClick={onLogs}><FolderOpen/>Logs</button>
      {runner.scope === 'repository' && runner.projectGroupId && <button className="action-button" disabled={busy} onClick={onPrepare}><RocketLaunch/>{deployReady ? 'Reconfigurar' : 'Preparar deploy'}</button>}
      {runner.deployment.workflowPath && runner.deployment.state !== 'not-configured' && <button className="icon-button" title="Mostrar workflow" onClick={onWorkflow}><FileCode/></button>}
      <button className="icon-button danger" title="Remover runner" disabled={busy} onClick={onRemove}><Trash/></button>
    </div>
  </article>
}

function DeploymentReadyModal({ result, onClose }: { result: GitHubRunnerPrepareDeploymentResult; onClose(): void }) {
  return <div className="modal-backdrop" onMouseDown={onClose}>
    <section className="modal deployment-ready-modal" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-title"><div><span>DEPLOY AUTOMÁTICO</span><h2>Projeto preparado</h2></div><button type="button" className="icon-button" onClick={onClose}><X/></button></div>
      <div className="deployment-success"><CheckCircle weight="fill"/><div><strong>Executor configurado e runner reiniciado</strong><span>O workflow padrão foi {result.workflowCreated ? 'gravado' : 'validado'} no clone local.</span></div></div>
      <div className="deployment-result"><small>REPOSITÓRIO</small><strong>{result.repository}</strong><small>PROJETO NO SERVIDOR</small><strong>{result.projectPath}</strong><small>ARQUIVO PARA COMMIT</small><strong>{result.workflowPath}</strong></div>
      <p>Agora faça commit e push do arquivo <code>.github/workflows/controle-run.yml</code>. Depois disso, todo push em <code>main</code> ou <code>master</code> atualizará este servidor.</p>
      <div className="modal-actions"><button type="button" className="button primary" onClick={onClose}>Entendi</button></div>
    </section>
  </div>
}

export function GitHubRunnersPage({ projectGroups, onError }: RunnerPageProps) {
  const [state, setState] = useState(EMPTY_STATE)
  const [loading, setLoading] = useState(true)
  const [defaults, setDefaults] = useState<GitHubRunnerInstallDefaults | null>(null)
  const [showInstall, setShowInstall] = useState(false)
  const [removing, setRemoving] = useState<GitHubRunnerView | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [progress, setProgress] = useState<GitHubRunnerProgress | null>(null)
  const [prepared, setPrepared] = useState<GitHubRunnerPrepareDeploymentResult | null>(null)
  const [copied, setCopied] = useState(false)

  const groupNames = useMemo(() => new Map(projectGroups.map((group) => [group.id, group.name])), [projectGroups])
  async function refresh() {
    try { setState(await window.controleRun.getGitHubRunners()); onError(null) }
    catch (error) { onError(messageOf(error)) }
    finally { setLoading(false) }
  }
  useEffect(() => { refresh() }, [])
  useEffect(() => {
    const stop = window.controleRun.onGitHubRunnerProgress(setProgress)
    return stop
  }, [])
  useEffect(() => {
    const timer = window.setInterval(refresh, 5000)
    return () => window.clearInterval(timer)
  }, [])

  async function openInstall() {
    try { setDefaults(await window.controleRun.getGitHubRunnerDefaults()); setProgress(null); setShowInstall(true); onError(null) }
    catch (error) { onError(messageOf(error)) }
  }
  async function install(draft: GitHubRunnerInstallDraft) {
    setBusyId('install')
    setProgress({ stage: 'validating', message: 'Preparando instalação...' })
    try { setState(await window.controleRun.installGitHubRunner(draft)); setShowInstall(false); onError(null) }
    finally { setBusyId(null) }
  }
  async function action(runner: GitHubRunnerView, command: GitHubRunnerAction) {
    setBusyId(runner.id)
    try { setState(await window.controleRun.actionGitHubRunner(runner.id, command)); onError(null) }
    catch (error) { onError(messageOf(error)) }
    finally { setBusyId(null) }
  }
  async function remove(token: string) {
    if (!removing) return
    setBusyId(removing.id)
    try { setState(await window.controleRun.removeGitHubRunner(removing.id, token)); setRemoving(null); onError(null) }
    finally { setBusyId(null) }
  }
  async function prepare(runner: GitHubRunnerView, overwriteWorkflow = false) {
    if (!overwriteWorkflow && !window.confirm(`Preparar o deploy automático de ${runner.name}? O runner será reiniciado e o workflow padrão será criado no projeto associado.`)) return
    setBusyId(runner.id)
    try {
      const result = await window.controleRun.prepareGitHubRunnerDeployment(runner.id, overwriteWorkflow)
      setState(result.state)
      setPrepared(result)
      onError(null)
    } catch (error) {
      const message = messageOf(error)
      if (!overwriteWorkflow && message.includes('Confirme a substituição') && window.confirm(`${message}\n\nDeseja substituir o arquivo pelo modelo padrão?`)) {
        setBusyId(null)
        return prepare(runner, true)
      }
      onError(message)
    } finally { setBusyId(null) }
  }
  async function copyWorkflow() {
    try {
      await window.controleRun.copyGitHubRunnerWorkflow()
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
      onError(null)
    } catch (error) { onError(messageOf(error)) }
  }

  return <>
    <section className="runner-hero">
      <div><p className="eyebrow">INFRAESTRUTURA</p><h2>GitHub Actions Runners</h2><p>Instale e mantenha agentes de automação como serviços independentes do Windows.</p></div>
      <div className="hero-actions"><button className="button secondary" onClick={copyWorkflow}><Copy/>{copied ? 'Workflow copiado' : 'Copiar workflow padrão'}</button><button className="button primary" onClick={openInstall}><Plus/>Novo runner</button><button className="button secondary" onClick={refresh}><ArrowClockwise className={loading ? 'spin' : ''}/>Atualizar</button></div>
    </section>
    <div className="runner-notice"><ShieldCheck/><div><strong>Credenciais temporárias e instalação verificada</strong><span>Tokens e senhas não são persistidos. O pacote oficial é validado por SHA-256 antes da configuração.</span></div></div>
    {!state.runners.length
      ? <section className="empty runner-empty"><div className="empty-icon"><GithubLogo/></div><h3>Nenhum runner cadastrado</h3><p>Adicione um runner de organização para atender vários repositórios ou use um runner isolado por repositório.</p><button className="button primary" onClick={openInstall}><Plus/>Instalar primeiro runner</button></section>
      : <section className="runner-grid">{state.runners.map((runner) => <RunnerCard
        key={runner.id}
        runner={runner}
        groupName={runner.projectGroupId ? groupNames.get(runner.projectGroupId) : undefined}
        busy={busyId === runner.id}
        onAction={(command) => action(runner, command)}
        onLogs={() => window.controleRun.openGitHubRunnerLogs(runner.id).catch((error) => onError(messageOf(error)))}
        onPrepare={() => prepare(runner)}
        onWorkflow={() => window.controleRun.openGitHubRunnerWorkflow(runner.id).catch((error) => onError(messageOf(error)))}
        onRemove={() => setRemoving(runner)}
      />)}</section>}
    {showInstall && defaults && <InstallRunnerModal defaults={defaults} groups={projectGroups} progress={progress} installing={busyId === 'install'} onClose={() => setShowInstall(false)} onInstall={install}/>} 
    {removing && <RemoveRunnerModal runner={removing} removing={busyId === removing.id} onClose={() => setRemoving(null)} onRemove={remove}/>} 
    {prepared && <DeploymentReadyModal result={prepared} onClose={() => setPrepared(null)}/>}
  </>
}
