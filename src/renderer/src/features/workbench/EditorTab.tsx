import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { basicSetup } from 'codemirror'
import { EditorState, Compartment, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { python } from '@codemirror/lang-python'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import type {
  EditorDocument,
  EditorDraft,
  PanelTab,
  WorkbenchContext
} from '../../../../shared/workbench'
import type { FileViewRequest } from '../../../../shared/file-view'

export type EditorHandle = { save: () => Promise<boolean>; reload: () => Promise<boolean> }
const editable = new Compartment()
function language(path: string): Extension {
  if (/\.[cm]?[jt]sx?$/i.test(path))
    return javascript({ typescript: /\.tsx?$/i.test(path), jsx: /x$/i.test(path) })
  if (/\.json$/i.test(path)) return json()
  if (/\.py$/i.test(path)) return python()
  if (/\.html?$/i.test(path)) return html()
  if (/\.css$/i.test(path)) return css()
  if (/\.md$/i.test(path)) return markdown()
  return []
}
export function EditorTab({
  tab,
  context,
  contextKey,
  draft,
  active,
  onDraft,
  register
}: {
  tab: Extract<PanelTab, { kind: 'file' }>
  context: WorkbenchContext
  contextKey: string
  draft?: EditorDraft
  active: boolean
  onDraft: (draft: EditorDraft | null) => void
  register: (handle: EditorHandle | null) => void
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const documentRef = useRef<EditorDocument | null>(null)
  const draftRef = useRef(draft)
  const latest = useRef({ context, contextKey, active, onDraft, draft, tab, register })
  useLayoutEffect(() => {
    latest.current = { context, contextKey, active, onDraft, draft, tab, register }
    draftRef.current = draft
  }, [context, contextKey, active, onDraft, draft, tab, register])
  const currentContext = useRef(contextKey)
  const generation = useRef(0)
  const attempted = useRef('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [compare, setCompare] = useState(false)
  const [diskText, setDiskText] = useState('')
  const dirty = !!draft
  const snapshot = tab.file.source.kind === 'snapshot'

  function replaceText(text: string, writable: boolean): void {
    const editor = view.current
    if (!editor) return
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: text },
      effects: editable.reconfigure([
        EditorState.readOnly.of(!writable),
        EditorView.editable.of(writable)
      ])
    })
    const line = Math.min(latest.current.tab.file.reference.startLine ?? 1, editor.state.doc.lines)
    editor.dispatch({
      effects: EditorView.scrollIntoView(editor.state.doc.line(line).from, { y: 'center' })
    })
  }
  async function load(force = false): Promise<boolean> {
    const mine = ++generation.current
    const captured = latest.current
    attempted.current = captured.contextKey
    setBusy(true)
    setError('')
    try {
      if (snapshot) {
        const request: FileViewRequest = {
          requestId: crypto.randomUUID(),
          conversationId: captured.context.conversationId,
          reference: captured.tab.file.reference,
          source: captured.tab.file.source
        }
        const result = await window.api.readFileView(request)
        if (mine !== generation.current || captured.contextKey !== latest.current.contextKey)
          return false
        if (result.status !== 'ready') throw new Error(result.error)
        documentRef.current = null
        replaceText(result.text, false)
      } else {
        const result = await window.api.readEditorFile(
          captured.context,
          captured.tab.file.reference.path
        )
        if (mine !== generation.current || captured.contextKey !== latest.current.contextKey) {
          if (result.ok) void window.api.releaseEditorFile(result.data.receipt)
          return false
        }
        if (!result.ok) throw new Error(result.error)
        if (documentRef.current) void window.api.releaseEditorFile(documentRef.current.receipt)
        result.data.text = result.data.text.replace(/\r\n?/g, '\n')
        documentRef.current = result.data
        const savedDraft = draftRef.current
        const diverged = !!savedDraft && savedDraft.fingerprint !== result.data.fingerprint
        setDiskText(result.data.text)
        setConflict(diverged)
        if (force) {
          draftRef.current = undefined
          captured.onDraft(null)
        }
        replaceText(
          force ? result.data.text : (savedDraft?.text ?? result.data.text),
          result.data.writable
        )
      }
      setLoaded(true)
      return true
    } catch (reason) {
      if (mine === generation.current)
        setError(reason instanceof Error ? reason.message : '文件读取失败')
      return false
    } finally {
      if (mine === generation.current) setBusy(false)
    }
  }
  async function save(): Promise<boolean> {
    if (!documentRef.current && !snapshot && !(await load())) return false
    const doc = documentRef.current
    const captured = latest.current
    const change = draftRef.current
    if (!change) return true
    if (
      !doc ||
      snapshot ||
      captured.contextKey !== currentContext.current ||
      change.fingerprint !== doc.fingerprint
    ) {
      setError('文件上下文已变化或存在冲突，请重新核验')
      return false
    }
    const mine = ++generation.current
    const text = view.current?.state.doc.toString() ?? change.text
    setBusy(true)
    setError('')
    try {
      const result = await window.api.saveEditorFile(
        captured.context,
        doc.receipt,
        change.fingerprint,
        text
      )
      if (mine !== generation.current || captured.contextKey !== latest.current.contextKey)
        return false
      if (!result.ok) {
        setConflict(!!result.conflict)
        throw new Error(result.error)
      }
      result.data.text = result.data.text.replace(/\r\n?/g, '\n')
      documentRef.current = result.data
      if (view.current?.state.doc.toString() === text) {
        draftRef.current = undefined
        captured.onDraft(null)
      } else
        captured.onDraft({
          text: view.current!.state.doc.toString(),
          baseline: result.data.text,
          fingerprint: result.data.fingerprint
        })
      setDiskText(result.data.text)
      return true
    } catch (reason) {
      if (mine === generation.current)
        setError(reason instanceof Error ? reason.message : '保存失败')
      return false
    } finally {
      if (mine === generation.current) setBusy(false)
    }
  }
  const actions = useRef({ save, load })
  useLayoutEffect(() => {
    actions.current = { save, load }
  })
  useEffect(() => {
    currentContext.current = contextKey
    view.current?.dispatch({
      effects: editable.reconfigure([EditorState.readOnly.of(true), EditorView.editable.of(false)])
    })
    const frame = requestAnimationFrame(() => {
      if (latest.current.active) void actions.current.load()
    })
    return () => {
      cancelAnimationFrame(frame)
      generation.current++
      if (documentRef.current) {
        void window.api.releaseEditorFile(documentRef.current.receipt)
        documentRef.current = null
      }
    }
  }, [contextKey])
  useEffect(() => {
    if (active && attempted.current !== contextKey) {
      const frame = requestAnimationFrame(() => void actions.current.load())
      return () => cancelAnimationFrame(frame)
    }
    return undefined
  }, [active, contextKey])
  useEffect(() => {
    const editor = view.current
    if (active && loaded && editor) {
      const line = Math.min(tab.file.reference.startLine ?? 1, editor.state.doc.lines)
      editor.dispatch({
        effects: EditorView.scrollIntoView(editor.state.doc.line(line).from, { y: 'center' })
      })
    }
  }, [active, loaded, tab.file.reference.startLine])
  useEffect(() => {
    if (!host.current) return
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: draftRef.current?.text ?? '',
        extensions: [
          basicSetup,
          language(tab.file.reference.path),
          editable.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
          keymap.of([
            {
              key: 'Mod-s',
              run: () => {
                void actions.current.save()
                return true
              }
            },
            indentWithTab
          ]),
          EditorView.updateListener.of((update) => {
            if (
              !update.docChanged ||
              !documentRef.current ||
              !update.transactions.some(
                (transaction) =>
                  transaction.isUserEvent('input') ||
                  transaction.isUserEvent('delete') ||
                  transaction.isUserEvent('undo') ||
                  transaction.isUserEvent('redo') ||
                  transaction.isUserEvent('move')
              )
            )
              return
            const doc = documentRef.current
            const text = update.state.doc.toString()
            const baseline = draftRef.current?.baseline ?? doc.text
            const fingerprint = draftRef.current?.fingerprint ?? doc.fingerprint
            const next = text === baseline ? null : { text, baseline, fingerprint }
            draftRef.current = next ?? undefined
            latest.current.onDraft(next)
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '13px' },
            '.cm-scroller': {
              overflow: 'auto',
              fontFamily: "Consolas, 'Cascadia Mono', monospace"
            },
            '.cm-gutters': { backgroundColor: '#fafafa', border: 'none', color: '#8d8e8f' }
          })
        ]
      })
    })
    view.current = editor
    latest.current.register({
      save: () => actions.current.save(),
      reload: () => actions.current.load(true)
    })
    return () => {
      latest.current.register(null)
      editor.destroy()
      view.current = null
    }
  }, [tab.id, tab.file.reference.path])
  return (
    <div className="panel-editor">
      <div className="panel-editor-toolbar">
        <span title={tab.file.reference.path}>{tab.file.reference.path}</span>
        <span>{snapshot ? '历史快照 · 只读' : dirty ? '未保存' : '已保存'}</span>
        {!snapshot && (
          <button
            type="button"
            disabled={busy || !loaded || !dirty || conflict}
            onClick={() => void save()}
          >
            保存
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (!dirty || window.confirm('重新读取将放弃此文件的未保存修改，继续？'))
              void load(true)
          }}
        >
          重新读取
        </button>
      </div>
      {error && (
        <p className="panel-error" role="alert">
          {error}
        </p>
      )}
      {conflict && (
        <div className="panel-conflict">
          <span>磁盘文件与编辑草稿的原版本不同，草稿已保留。</span>
          <button
            type="button"
            onClick={async () => {
              const captured = latest.current
              const mine = generation.current
              const result = await window.api.readEditorFile(
                latest.current.context,
                tab.file.reference.path
              )
              if (
                mine !== generation.current ||
                captured.contextKey !== latest.current.contextKey
              ) {
                if (result.ok) void window.api.releaseEditorFile(result.data.receipt)
                return
              }
              if (result.ok) {
                setDiskText(result.data.text)
                void window.api.releaseEditorFile(result.data.receipt)
                setCompare(true)
              } else setError(result.error)
            }}
          >
            比较版本
          </button>
        </div>
      )}
      {compare && (
        <div className="panel-compare">
          <section>
            <strong>原版本</strong>
            <pre>{draft?.baseline}</pre>
          </section>
          <section>
            <strong>当前磁盘</strong>
            <pre>{diskText}</pre>
          </section>
          <button type="button" onClick={() => setCompare(false)}>
            关闭比较
          </button>
        </div>
      )}
      <div className="panel-code-editor" ref={host} />
    </div>
  )
}
