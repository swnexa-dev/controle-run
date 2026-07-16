import { contextBridge, ipcRenderer } from 'electron'
import type { ControleRunApi, EnvVarDraft, ProjectAction, ProjectDraft } from '../shared/types'

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
  saveEnv: (id: string, variables: EnvVarDraft[]) => ipcRenderer.invoke('project:env-save', id, variables)
}

contextBridge.exposeInMainWorld('controleRun', api)
