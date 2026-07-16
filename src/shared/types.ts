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
}
