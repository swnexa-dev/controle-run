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

export interface GitHubRunnerConfig {
  id: string
  name: string
  scope: GitHubRunnerScope
  targetUrl: string
  installPath: string
  workFolder: string
  labels: string[]
  serviceAccount: string
  serviceName?: string
  installedVersion: string
  projectGroupId?: string
  createdAt: string
}

export interface GitHubRunnerView extends GitHubRunnerConfig {
  serviceStatus: GitHubRunnerServiceStatus
  connectionStatus: GitHubRunnerConnectionStatus
  latestLogAt?: string
  error?: string
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
  entry?: string
  args?: string
  autoStart: boolean
}

export interface EnvVarDraft {
  key: string
  value: string
}

export type ProjectAction = 'start' | 'stop' | 'restart'

export interface ControleRunApi {
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
  getGitHubRunners(): Promise<GitHubRunnerState>
  getGitHubRunnerDefaults(): Promise<GitHubRunnerInstallDefaults>
  suggestGitHubRunnerPath(name: string): Promise<string>
  installGitHubRunner(draft: GitHubRunnerInstallDraft): Promise<GitHubRunnerState>
  actionGitHubRunner(id: string, action: GitHubRunnerAction): Promise<GitHubRunnerState>
  openGitHubRunnerLogs(id: string): Promise<void>
  removeGitHubRunner(id: string, removalToken: string): Promise<GitHubRunnerState>
  onGitHubRunnerProgress(callback: (progress: GitHubRunnerProgress) => void): () => void
}
