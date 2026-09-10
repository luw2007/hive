// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { FormEvent } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { ToastProvider } from '../../web/src/ui/useToast.js'
import { AddWorkerDialog } from '../../web/src/worker/AddWorkerDialog.js'
import { AgentCliPicker } from '../../web/src/worker/AddWorkerDialogFields.js'
import { useWorkerComposer } from '../../web/src/worker/useWorkerComposer.js'

const {
  createRoleTemplate,
  deleteRoleTemplate,
  listCommandPresets,
  listRoleTemplates,
  updateRoleTemplate,
} = vi.hoisted(() => ({
  createRoleTemplate: vi.fn(),
  deleteRoleTemplate: vi.fn(),
  listCommandPresets: vi.fn(),
  listRoleTemplates: vi.fn(),
  updateRoleTemplate: vi.fn(),
}))

vi.mock('../../web/src/api.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../web/src/api.js')>('../../web/src/api.js')
  return {
    ...actual,
    createRoleTemplate: (...args: unknown[]) => createRoleTemplate(...args),
    deleteRoleTemplate: (...args: unknown[]) => deleteRoleTemplate(...args),
    listCommandPresets: (...args: unknown[]) => listCommandPresets(...args),
    listRoleTemplates: (...args: unknown[]) => listRoleTemplates(...args),
    updateRoleTemplate: (...args: unknown[]) => updateRoleTemplate(...args),
  }
})

const Harness = () => {
  const composer = useWorkerComposer({
    createWorker: async () => ({ error: null, runId: null }),
    open: true,
    workers: [],
  })
  return (
    <ToastProvider>
      <AddWorkerDialog
        commandPresets={composer.commandPresets}
        commandPresetId={composer.commandPresetId}
        customRoleName={composer.customRoleName}
        creating={composer.creating}
        customTemplates={composer.customTemplates}
        onCustomRoleNameChange={composer.setCustomRoleName}
        onApplyMarketplaceImport={composer.applyMarketplaceImport}
        onClose={() => {}}
        onDeleteTemplate={composer.deleteTemplate}
        onNameChange={composer.setWorkerName}
        onPresetChange={composer.setCommandPresetId}
        onRandomName={composer.randomizeWorkerName}
        onRoleChange={composer.setWorkerRole}
        onRoleDescriptionChange={composer.setRoleDescription}
        onRoleDescriptionReset={composer.resetRoleDescription}
        onSaveAsTemplate={composer.saveAsTemplate}
        onStartupCommandChange={composer.setStartupCommand}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault()
        }}
        onTemplateChange={composer.selectTemplate}
        roleDescription={composer.roleDescription}
        roleDescriptionDefault={composer.roleDescriptionDefault}
        selectedTemplateId={composer.selectedTemplateId}
        startupCommand={composer.startupCommand}
        templateBusy={composer.templateBusy}
        workerName={composer.workerName}
        workerRole={composer.workerRole}
      />
    </ToastProvider>
  )
}

beforeEach(() => {
  listCommandPresets.mockResolvedValue([
    {
      id: 'claude',
      displayName: 'Claude Code',
      command: 'claude',
      args: [],
      available: true,
    },
  ])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Agent CLI picker', () => {
  test('renders built-in CLI logos on the left side of each preset card', () => {
    const onPresetChange = vi.fn()
    const presets = [
      {
        id: 'claude',
        displayName: 'Claude Code (CC)',
        command: 'claude',
        args: [],
        available: true,
      },
      { id: 'codex', displayName: 'Codex', command: 'codex', args: [], available: true },
      { id: 'opencode', displayName: 'OpenCode', command: 'opencode', args: [], available: true },
      { id: 'gemini', displayName: 'Gemini', command: 'gemini', args: [], available: true },
    ]

    render(
      <AgentCliPicker
        commandPresetId="claude"
        commandPresets={presets}
        onPresetChange={onPresetChange}
      />
    )

    for (const preset of presets) {
      const card = screen.getByTestId(`agent-radio-${preset.id}`)
      const logo = within(card).getByTestId('cli-agent-logo')
      expect(logo.getAttribute('data-command-preset')).toBe(preset.id)
    }
    expect(
      within(screen.getByTestId('agent-radio-generic')).getByTestId(
        'agent-radio-generic-generic-icon'
      )
    ).toBeInTheDocument()
  })
})
