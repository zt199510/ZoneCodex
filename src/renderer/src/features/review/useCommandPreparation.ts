import { useCallback, useEffect, useRef, useState } from 'react'
import type { MessageCommandProposal } from '../../../../shared/command-proposal'
import type { CommandPreparationResult } from '../../../../shared/command-preparation'
type State = { status:'unbound'|'reading'|'selected'|'ready'|'conflict'|'error'; result?: Extract<CommandPreparationResult,{status:'selected'}>['info']; preparedId?: string; error?: string }
export function useCommandPreparation(proposal: MessageCommandProposal | null) {
  const [state,setState]=useState<State>({status:'unbound'}); const generation=useRef(0); const grant=useRef<string|null>(null)
  const source = proposal && { conversationId:proposal.conversationId, requestId:proposal.requestId, assistantId:proposal.assistantId, callId:proposal.callId, snapshotId:proposal.snapshotId, template:proposal.template as 'npm_typecheck' }
  const release=useCallback(async()=>{ const id=grant.current; grant.current=null; if(id) await window.api.releaseCommandDirectory(id) },[])
  const select=useCallback(async()=>{ if(!source) return; const n=++generation.current; setState({status:'reading'}); const r=await window.api.selectCommandDirectory(source, crypto.randomUUID()); if(n!==generation.current) { if(r.status==='selected') await window.api.releaseCommandDirectory(r.info.grantId); return } if(r.status==='selected'){ grant.current=r.info.grantId; setState({status:'selected',result:r.info}) } else if(r.status==='cancelled') setState({status: grant.current?'selected':'unbound'}); else if(r.status==='error') setState({status:'error',error:r.error}) },[source])
  const prepare=useCallback(async()=>{ if(!source||!grant.current) return; const r=await window.api.prepareCommand(source,grant.current,crypto.randomUUID()); if(r.status==='ready') setState(s=>({...s,status:'ready',preparedId:r.preparedId})); else if(r.status==='conflict'||r.status==='expired') { await release(); setState({status:'conflict',error:r.error}) } else if(r.status==='error') setState({status:'error',error:r.error}) },[source,release])
  useEffect(()=>{ generation.current++; void release(); setState({status:'unbound'}); },[proposal?.assistantId, proposal?.requestId, release])
  return { state, select, prepare, release }
}
