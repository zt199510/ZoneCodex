import { useCallback, useRef, useState } from 'react'

export type Operation = 'loading' | 'idle' | 'generating' | 'saving' | 'selecting'

export type OperationControl = {
  operation: Operation
  begin: (next: Exclude<Operation, 'loading' | 'idle'>) => boolean
  finish: (expected: Operation) => void
  isIdle: () => boolean
  getOperation: () => Operation
}

// state 驱动界面，ref 同步互斥；一次只允许一个会改变会话的操作。
export function useOperation(): OperationControl {
  const [operation, setOperation] = useState<Operation>('loading')
  const current = useRef<Operation>('loading')

  const begin = useCallback((next: Exclude<Operation, 'loading' | 'idle'>): boolean => {
    if (current.current !== 'idle') return false
    current.current = next
    setOperation(next)
    return true
  }, [])

  const finish = useCallback((expected: Operation): void => {
    if (current.current !== expected) return
    current.current = 'idle'
    setOperation('idle')
  }, [])

  const isIdle = useCallback(() => current.current === 'idle', [])
  // return { operation, begin, finish, isIdle }

  const getOperation = useCallback(() => current.current, [])
  return { operation, begin, finish, isIdle, getOperation }
}
