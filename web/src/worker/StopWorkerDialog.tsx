import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, Square, X } from 'lucide-react'

import { useI18n } from '../i18n.js'

type StopWorkerDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  workerName: string
  onConfirm: () => void
}

export const StopWorkerDialog = ({
  open,
  onOpenChange,
  workerName,
  onConfirm,
}: StopWorkerDialogProps) => {
  const { t } = useI18n()

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content dialog-content--sm">
          <div className="flex items-start gap-3 mb-4">
            <span className="dialog-icon dialog-icon--danger">
              <AlertTriangle size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-sm font-semibold text-pri">
                {t('worker.stopConfirm', { name: workerName })}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-sec">
                {t('worker.stopDescription')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label={t('common.close')}>
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" className="btn btn--ghost">
                {t('common.cancel')}
              </button>
            </Dialog.Close>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => { onConfirm(); onOpenChange(false) }}
            >
              <Square size={12} aria-hidden />
              {t('worker.stopSubmit')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
