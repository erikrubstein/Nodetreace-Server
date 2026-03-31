export const panelIds = ['preview', 'camera', 'search', 'templates', 'inspector', 'fields', 'settings', 'collaborators']

export const defaultPanelDock = {
  preview: 'left',
  camera: 'left',
  search: 'left',
  templates: 'left',
  inspector: 'right',
  fields: 'right',
  settings: 'right',
  collaborators: 'right',
}

export const defaultProjectSettings = {
  orientation: 'horizontal',
  horizontalGap: 72,
  verticalGap: 44,
  imageMode: 'square',
  layoutMode: 'compact',
}

export const defaultUserProjectUi = {
  theme: 'dark',
  showGrid: true,
  canvasTransform: null,
  selectedNodeIds: [],
  leftSidebarOpen: false,
  rightSidebarOpen: true,
  leftSidebarWidth: 340,
  rightSidebarWidth: 320,
  leftActivePanel: 'preview',
  rightActivePanel: 'inspector',
  panelDock: defaultPanelDock,
}
