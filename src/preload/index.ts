import { contextBridge, ipcRenderer } from 'electron'
import type {
  ControleRunApi,
  EnvVarDraft,
  GitHubRunnerAction,
  GitHubRunnerInstallDraft,
  GitHubRunnerProgress,
  ProjectAction,
  ProjectDraft
} from '../shared/types'

const api: ControleRunApi = {
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
  removeGitHubRunner: (id: string, removalToken: string) => ipcRenderer.invoke('runner:remove', id, removalToken),
  onGitHubRunnerProgress: (callback: (progress: GitHubRunnerProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: GitHubRunnerProgress) => callback(progress)
    ipcRenderer.on('runner:progress', listener)
    return () => ipcRenderer.removeListener('runner:progress', listener)
  }
}

contextBridge.exposeInMainWorld('controleRun', api)
