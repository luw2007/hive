import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, ArrowRightLeft, Loader2, Trash2, X } from 'lucide-react'
import { useState } from 'react'

import { useI18n } from '../i18n.js'

type DeleteWorkerDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  workerName: string
  workerStatus: string
  onHandoff: () => Promise<void>
  onForceDelete: () => void
}

export const DeleteWorkerDialog = ({
  open,
  onOpenChange,
  workerName,
  workerStatus,
  onHandoff,
  onForceDelete,
}: DeleteWorkerDialogProps) => {
  const { t } = useI18n()
  const isWorking = workerStatus === 'working'
  const [handoffLoading, setHandoffLoading] = useState(false)
  const [handoffError, setHandoffError] = useState<string | null>(null)

  const handleHandoff = async () => {
    setHandoffLoading(true)
    setHandoffError(null)
    try {
      await onHandoff()
      onOpenChange(false)
    } catch (err) {
      setHandoffError(err instanceof Error ? err.message : String(err))
    } finally {
      setHandoffLoading(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!handoffLoading) onOpenChange(v) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content dialog-content--sm">
          <div className="flex items-start gap-3 mb-4">
            <span className="dialog-icon dialog-icon--danger">
              <AlertTriangle size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-sm font-semibold text-pri">
                {t('worker.deleteConfirm', { name: workerName })}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-sec">
                {isWorking
                  ? t('worker.deleteHandoffHint', { name: workerName })
                  : t('worker.deleteDescription', { name: workerName })}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label={t('common.close')} disabled={handoffLoading}>
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>
          {handoffError ? (
            <div className="mb-3 rounded bg-3 px-3 py-2 text-xs text-danger">
              {handoffError}
            </div>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" className="btn btn--ghost" disabled={handoffLoading}>
                {t('common.cancel')}
              </button>
            </Dialog.Close>
            {isWorking ? (
              <button
                type="button"
                className="btn btn--primary"
                disabled={handoffLoading}
                onClick={() => { void handleHandoff() }}
              >
                {handoffLoading ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <ArrowRightLeft size={12} aria-hidden />}
                {t('worker.handoffAndDelete')}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--danger"
              disabled={handoffLoading}
              onClick={() => { onForceDelete(); onOpenChange(false) }}
            >
              <Trash2 size={12} aria-hidden />
              {t('worker.forceDelete')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
