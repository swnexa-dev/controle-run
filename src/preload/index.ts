import { contextBridge, ipcRenderer } from 'electron'
import type {
  ControleRunApi,
  CloudflareTunnelAction,
  CloudflareTunnelDraft,
  EnvVarDraft,
  GitHubRunnerAction,
  GitHubRunnerInstallDraft,
  GitHubRunnerProgress,
  ProjectAction,
  ProjectDraft
} from '../shared/types'

const api: ControleRunApi = {
  clearAllData: (confirmation: string) => ipcRenderer.invoke('app:clear-data', confirmation),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  getState: () => ipcRenderer.invoke('state:get'),
  addProject: () => ipcRenderer.invoke('project:add'),
  removeProject: (groupId: string) => ipcRenderer.invoke('project:remove', groupId),
  refresh: () => ipcRenderer.invoke('projects:refresh'),
  configure: (draft: ProjectDraft) => ipcRenderer.invoke('project:configure', draft),
  action: (id: string, action: ProjectAction) => ipcRenderer.invoke('project:action', id, action),
  openFolder: (id: string) => ipcRenderer.invoke('project:open-folder', id),
  openUrl: (id: string) => ipcRenderer.invoke('project:open-url', id),
  readEnv: (id: string) => ipcRenderer.invoke('project:env-read', id),
  saveEnv: (id: string, variables: EnvVarDraft[]) => ipcRenderer.invoke('project:env-save', id, variables),
  getGitHubRunners: () => ipcRenderer.invoke('runner:state'),
  getGitHubRunnerDefaults: () => ipcRenderer.invoke('runner:defaults'),
  suggestGitHubRunnerPath: (name: string) => ipcRenderer.invoke('runner:suggest-path', name),
  installGitHubRunner: (draft: GitHubRunnerInstallDraft) => ipcRenderer.invoke('runner:install', draft),
  actionGitHubRunner: (id: string, action: GitHubRunnerAction) => ipcRenderer.invoke('runner:action', id, action),
  openGitHubRunnerLogs: (id: string) => ipcRenderer.invoke('runner:open-logs', id),
  prepareGitHubRunnerDeployment: (id: string, overwriteWorkflow = false) => ipcRenderer.invoke('runner:prepare-deployment', id, overwriteWorkflow),
  copyGitHubRunnerWorkflow: () => ipcRenderer.invoke('runner:copy-workflow'),
  openGitHubRunnerWorkflow: (id: string) => ipcRenderer.invoke('runner:open-workflow', id),
  removeGitHubRunner: (id: string, removalToken: string) => ipcRenderer.invoke('runner:remove', id, removalToken),
  onGitHubRunnerProgress: (callback: (progress: GitHubRunnerProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: GitHubRunnerProgress) => callback(progress)
    ipcRenderer.on('runner:progress', listener)
    return () => ipcRenderer.removeListener('runner:progress', listener)
  },
  getCloudflareTunnels: () => ipcRenderer.invoke('tunnel:state'),
  installCloudflared: () => ipcRenderer.invoke('tunnel:install-cloudflared'),
  addCloudflareTunnel: (draft: CloudflareTunnelDraft) => ipcRenderer.invoke('tunnel:add', draft),
  actionCloudflareTunnel: (id: string, action: CloudflareTunnelAction) => ipcRenderer.invoke('tunnel:action', id, action),
  removeCloudflareTunnel: (id: string) => ipcRenderer.invoke('tunnel:remove', id),
  openCloudflareTunnelLogs: (id: string) => ipcRenderer.invoke('tunnel:open-logs', id),
  openCloudflareTunnelUrl: (id: string) => ipcRenderer.invoke('tunnel:open-url', id),
  copyCloudflareTunnelUrl: (id: string) => ipcRenderer.invoke('tunnel:copy-url', id)
}

contextBridge.exposeInMainWorld('controleRun', api)
