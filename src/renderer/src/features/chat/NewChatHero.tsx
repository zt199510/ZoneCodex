import homeIcon from '../../assets/codex-home-icon.svg'

export function NewChatHero({
  projectName,
  disabled,
  onSelectProject
}: {
  projectName?: string
  disabled: boolean
  onSelectProject: () => void
}): React.JSX.Element {
  return (
    <div className="new-chat-hero">
      <img className="new-chat-icon" src={homeIcon} width={56} height={56} alt="" />
      <h1>
        {projectName ? (
          <>
            我们应该在
            <button
              type="button"
              className="new-chat-project"
              disabled={disabled}
              onClick={onSelectProject}
              title="选择项目"
            >
              {projectName}
            </button>
            中做些什么？
          </>
        ) : (
          '我们要构建什么？'
        )}
      </h1>
    </div>
  )
}
