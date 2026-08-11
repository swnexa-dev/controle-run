export type ProcessStatus = 'online' | 'stopped' | 'errored' | 'launching' | 'unknown'

export interface ProjectConfig {
  id: string
  groupId: string
  groupName: string
  groupPath: string
  serviceType: 'frontend' | 'backend' | 'root'
  name: string
  path: string
  pm2Name: string
  mode: 'npm' | 'script'
  npmScript?: string
  npmCommand?: string
  buildScript?: string
  buildOnDeploy: boolean
  installDependenciesOnDeploy: boolean
  entry?: string
  args?: string
  autoStart: boolean
  detected: boolean
}

export interface ProjectView extends ProjectConfig {
  packageName?: string
  availableScripts: string[]
  localUrl?: string
  status: ProcessStatus
  cpu: number
  memory: number
  uptime: number
  restarts: number
  pid?: number
  nodeVersion?: string
  version?: string
  error?: string
}

export interface AppState {
  projectPaths: string[]
  projects: ProjectView[]
}

export type GitHubRunnerScope = 'organization' | 'repository'
export type GitHubRunnerServiceStatus = 'running' | 'stopped' | 'missing' | 'unknown'
export type GitHubRunnerConnectionStatus = 'connected' | 'offline' | 'unknown'
export type GitHubRunnerAction = 'start' | 'stop' | 'restart'

export type CloudflareTunnelMode = 'quick' | 'token'
export type CloudflareTunnelProtocol = 'auto' | 'quic' | 'http2'
export type CloudflareTunnelAction = 'start' | 'stop' | 'restart'

export interface CloudflareTunnelConfig {
  id: string
  name: string
  projectId: string
  originUrl: string
  publicUrl?: string
  mode: CloudflareTunnelMode
  protocol: CloudflareTunnelProtocol
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  autoStart: boolean
  createdAt: string
}

export interface StoredCloudflareTunnelConfig extends CloudflareTunnelConfig {
  encryptedToken?: string
}

export interface CloudflareTunnelView extends CloudflareTunnelConfig {
  status: ProcessStatus
  connectionStatus: 'connected' | 'connecting' | 'offline' | 'error'
  hasToken: boolean
  pid?: number
  uptime: number
  restarts: number
  logPath: string
  error?: string
}

export interface CloudflareTunnelDraft {
  name: string
  projectId: string
  originUrl: string
  publicUrl?: string
  mode: CloudflareTunnelMode
  token?: string
  protocol: CloudflareTunnelProtocol
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  autoStart: boolean
}

export interface CloudflareTunnelState {
  tunnels: CloudflareTunnelView[]
  cloudflaredInstalled: boolean
  cloudflaredVersion?: string
  cloudflaredPath?: string
}

export interface GitHubRunnerConfig {
  id: string
  name: string
  scope: GitHubRunnerScope
  targetUrl: string
  installPath: string
  workFolder: string
  labels: string[]
  routingLabel?: string
  serviceAccount: string
  serviceName?: string
  managementId?: string
  installedVersion: string
  projectGroupId?: string
  createdAt: string
}

export interface GitHubRunnerView extends GitHubRunnerConfig {
  serviceStatus: GitHubRunnerServiceStatus
  connectionStatus: GitHubRunnerConnectionStatus
  deployment: GitHubRunnerDeploymentView
  latestLogAt?: string
  error?: string
}

export type GitHubRunnerDeploymentState = 'ready' | 'not-configured' | 'workflow-missing' | 'workflow-outdated' | 'invalid'

export interface GitHubRunnerDeploymentView {
  state: GitHubRunnerDeploymentState
  repository?: string
  projectPath?: string
  workflowPath?: string
  configuredAt?: string
  lastDeployAt?: string
  lastDeployCommit?: string
  lastDeployStatus?: 'success' | 'failed'
  lastDeployMessage?: string
}

export interface GitHubRunnerPrepareDeploymentResult {
  state: GitHubRunnerState
  repository: string
  projectPath: string
  workflowPath: string
  workflowCreated: boolean
}

export interface GitHubRunnerState {
  runners: GitHubRunnerView[]
}

export interface GitHubRunnerInstallDefaults {
  name: string
  installPath: string
  workFolder: string
  currentWindowsAccount: string
}

export interface GitHubRunnerInstallDraft {
  name: string
  scope: GitHubRunnerScope
  targetUrl: string
  registrationToken: string
  installPath: string
  workFolder: string
  labels: string[]
  serviceAccount: 'network-service' | 'custom'
  windowsAccount?: string
  windowsPassword?: string
  projectGroupId?: string
}

export interface GitHubRunnerProgress {
  stage: 'validating' | 'downloading' | 'verifying' | 'elevating' | 'configuring' | 'complete'
  message: string
}

export interface ProjectDraft {
  id: string
  name: string
  mode: 'npm' | 'script'
  npmScript?: string
  buildScript?: string
  buildOnDeploy: boolean
  installDependenciesOnDeploy: boolean
  entry?: string
  args?: string
  autoStart: boolean
}

export interface EnvVarDraft {
  key: string
  value: string
}

export type ProjectAction = 'start' | 'stop' | 'restart' | 'build-restart' | 'permanent-stop' | 'reset-restarts'

export interface ControleRunApi {
  clearAllData(confirmation: string): Promise<AppState>
  quitApp(): Promise<void>
  getState(): Promise<AppState>
  addProject(): Promise<AppState>
  removeProject(groupId: string): Promise<AppState>
  refresh(): Promise<AppState>
  configure(draft: ProjectDraft): Promise<AppState>
  action(id: string, action: ProjectAction): Promise<AppState>
  openFolder(id: string): Promise<void>
  openUrl(id: string): Promise<void>
  readEnv(id: string): Promise<EnvVarDraft[]>
  saveEnv(id: string, variables: EnvVarDraft[]): Promise<void>
  getProjectLogs(id: string): Promise<string>
  getGitHubRunners(): Promise<GitHubRunnerState>
  getGitHubRunnerDefaults(): Promise<GitHubRunnerInstallDefaults>
  suggestGitHubRunnerPath(name: string): Promise<string>
  installGitHubRunner(draft: GitHubRunnerInstallDraft): Promise<GitHubRunnerState>
  actionGitHubRunner(id: string, action: GitHubRunnerAction): Promise<GitHubRunnerState>
  openGitHubRunnerLogs(id: string): Promise<void>
  prepareGitHubRunnerDeployment(id: string, overwriteWorkflow?: boolean): Promise<GitHubRunnerPrepareDeploymentResult>
  copyGitHubRunnerWorkflow(): Promise<void>
  openGitHubRunnerWorkflow(id: string): Promise<void>
  removeGitHubRunner(id: string, removalToken: string): Promise<GitHubRunnerState>
  onGitHubRunnerProgress(callback: (progress: GitHubRunnerProgress) => void): () => void
  getCloudflareTunnels(): Promise<CloudflareTunnelState>
  installCloudflared(): Promise<CloudflareTunnelState>
  addCloudflareTunnel(draft: CloudflareTunnelDraft): Promise<CloudflareTunnelState>
  actionCloudflareTunnel(id: string, action: CloudflareTunnelAction): Promise<CloudflareTunnelState>
  removeCloudflareTunnel(id: string): Promise<CloudflareTunnelState>
  openCloudflareTunnelLogs(id: string): Promise<void>
  openCloudflareTunnelUrl(id: string): Promise<void>
  copyCloudflareTunnelUrl(id: string): Promise<void>
}
