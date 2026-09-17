import { useEffect, useRef } from 'react'
import type { ConversationController } from './useConversation'
import { useCloseGuard } from './useCloseGuard'

export function CloseGuard({ conversation }: {
    conversation: ConversationController
}): React.JSX.Element {
    const guard = useCloseGuard(conversation)
    const dialog = useRef<HTMLDialogElement>(null)
    const stayButton = useRef<HTMLButtonElement>(null)

    useEffect(() => {
        if (guard.open) {
            dialog.current?.showModal()
            stayButton.current?.focus()
        } else dialog.current?.close()
    }, [guard.open])

    return <>
        {!guard.open && guard.message && <p className="close-feedback" role="status">{guard.message}</p>}
        <dialog ref={dialog} className="confirm-dialog close-dialog" aria-labelledby="close-title"
            onCancel={(event) => {
                event.preventDefault()
                guard.choose(false)
            }}>
            <h2 id="close-title">关闭窗口</h2>
            <p role="status">{guard.message}</p>
            <div className="dialog-actions">
                <button className="quiet-button" ref={stayButton} disabled={guard.busy}
                    onClick={() => guard.choose(false)}>继续编辑</button>
                <button className="quiet-button" disabled={guard.busy}
                    onClick={() => guard.choose(true)}>不保存并关闭</button>
                <button className="quiet-button" disabled={guard.busy || !conversation.storage.ready}
                    onClick={() => { void guard.saveAndClose() }}>
                    {guard.busy ? '请稍候…' : '保存并关闭'}
                </button>
            </div>
        </dialog>
    </>
}
